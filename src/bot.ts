/**
 * Unified bot — runs Sniper, CopyTrade, and KOL Tracker in parallel.
 * All three strategies share one 30-second scan loop for the duration of the
 * GitHub Actions job (6 hours).
 */
import axios from 'axios';
import { getTokenPrice, getWalletTransactions } from './helius';
import { analyzeToken, analyzeTweet, validateCopyTrade } from './gemini';
import { filterToken } from './rug-filter';
import { executePaperBuy, executePaperSell, checkExitConditions } from './paper-trade';
import { insertSignal, upsertToken, getCopyWallets, getKOLHandles } from './supabase';
import { notifySignal, notifyError } from './discord';
import { CONFIG } from './config';

// ── Wallet IDs ────────────────────────────────────────────────────────────────
const SNIPER_WALLET    = 1;
const COPYTRADE_WALLET = 2;
const KOL_WALLET       = 3;

// ── Shared constants ──────────────────────────────────────────────────────────
const key          = process.env.HELIUS_API_KEY!;
const BASE         = 'https://api.helius.xyz/v0';
const PUMP_PROGRAM = CONFIG.sniper.pumpFunProgram;
const SCAN_INTERVAL = 30_000; // 30 seconds between scans

const TOKEN_BLACKLIST = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
]);

// ── SNIPER ────────────────────────────────────────────────────────────────────
const sniperProcessed = new Set<string>();

async function getRecentPumpTokens(since: number): Promise<Array<{
  mint: string; name: string; symbol: string; devWallet: string; timestamp: number;
}>> {
  try {
    const { data } = await axios.get(
      `${BASE}/addresses/${PUMP_PROGRAM}/transactions`,
      { params: { 'api-key': key, limit: 100 }, timeout: 15000 },
    );
    const seen = new Set<string>();
    const results: Array<{ mint: string; name: string; symbol: string; devWallet: string; timestamp: number }> = [];
    for (const tx of data ?? []) {
      const tsMs = (tx.timestamp ?? 0) * 1000;
      if (tsMs < since) continue;
      for (const tr of tx.tokenTransfers ?? []) {
        const mint = tr.mint;
        if (!mint || seen.has(mint)) continue;
        seen.add(mint);
        results.push({
          mint,
          name:      tx.description ?? 'Unknown',
          symbol:    tr.symbol ?? 'NEW',
          devWallet: tx.feePayer ?? '',
          timestamp: tsMs,
        });
      }
    }
    console.log(`[Sniper] Helius returned ${data?.length ?? 0} txns → ${results.length} unique mints`);
    return results;
  } catch (e: any) {
    console.error('[Sniper] Helius fetch error:', e.message);
    return [];
  }
}

async function runSniper() {
  const since = Date.now() - 600_000;
  const tokens = await getRecentPumpTokens(since);

  for (const token of tokens) {
    if (!token.mint || TOKEN_BLACKLIST.has(token.mint)) continue;
    if (sniperProcessed.has(token.mint)) continue;
    sniperProcessed.add(token.mint);

    const ageSeconds = (Date.now() - token.timestamp) / 1000;
    const filter = await filterToken({
      mint: token.mint, symbol: token.symbol, name: token.name,
      devWallet: token.devWallet, pumpFun: true, ageSeconds,
    });

    console.log(`[Sniper] ${token.symbol} age:${ageSeconds.toFixed(0)}s rug:${filter.rugScore} — ${filter.pass ? 'PASS' : 'FAIL'}`);
    if (!filter.pass) { console.log(`  Rejected: ${filter.reasons.join(', ')}`); continue; }

    await upsertToken({ mint: token.mint, symbol: token.symbol, name: token.name,
      pumpFun: true, devWallet: token.devWallet, rugScore: filter.rugScore, liquidityUsd: 0 });

    const confidence = Math.min(0.95, filter.gemini?.confidence ?? 0.5);
    const signalId = await insertSignal({ strategy: 'sniper', tokenMint: token.mint,
      signalType: 'buy', confidence, source: 'pump.fun | helius',
      rugScore: filter.rugScore, geminiAnalysis: filter.gemini ?? undefined });

    await notifySignal({ strategy: 'sniper', tokenMint: token.mint, signalType: 'buy',
      confidence, source: 'pump.fun | helius', rugScore: filter.rugScore,
      geminiAnalysis: filter.gemini ?? undefined }, token.name);

    const price = await getTokenPrice(token.mint);
    if (price <= 0) { console.log(`[Sniper] No price for ${token.symbol}, skip`); continue; }

    await executePaperBuy({ walletId: SNIPER_WALLET, strategy: 'sniper',
      tokenMint: token.mint, tokenSymbol: token.symbol,
      currentPriceSol: price, signalId: signalId ?? undefined, confidence });
  }

  await checkExitConditions(SNIPER_WALLET, 'sniper', getTokenPrice);
}

// ── COPY TRADE ────────────────────────────────────────────────────────────────
const copyProcessed = new Set<string>();

async function processCopyTrade(walletAddress: string, trade: {
  tokenMint: string; tokenSymbol: string;
  action: 'buy' | 'sell'; amountSol: number;
  signature: string; timestamp: number;
}) {
  if (copyProcessed.has(trade.signature)) return;
  copyProcessed.add(trade.signature);

  if (trade.amountSol < CONFIG.copyTrade.minPositionSol) return;

  console.log(`[CopyTrade] ${walletAddress.slice(0, 8)}... ${trade.action.toUpperCase()} ${trade.tokenSymbol} ${trade.amountSol} SOL`);
  await new Promise(r => setTimeout(r, CONFIG.copyTrade.executionDelayMs));

  const price = await getTokenPrice(trade.tokenMint);
  if (price <= 0) return;

  if (trade.action === 'buy') {
    const ageSeconds = (Date.now() - trade.timestamp) / 1000;
    const filter = await filterToken({ mint: trade.tokenMint, symbol: trade.tokenSymbol,
      name: trade.tokenSymbol, devWallet: walletAddress, pumpFun: false, ageSeconds });

    if (!filter.pass) { console.log(`[CopyTrade] Rug filter failed: ${filter.reasons.join(', ')}`); return; }

    const validation = await validateCopyTrade({ walletAddress, tokenMint: trade.tokenMint,
      tokenSymbol: trade.tokenSymbol, amountSol: trade.amountSol, action: trade.action });

    if (!validation.shouldCopy) { console.log(`[CopyTrade] Gemini rejected: ${validation.reasoning}`); return; }

    await upsertToken({ mint: trade.tokenMint, symbol: trade.tokenSymbol,
      name: trade.tokenSymbol, pumpFun: false, rugScore: filter.rugScore });

    const signalId = await insertSignal({ strategy: 'copy_trade', tokenMint: trade.tokenMint,
      signalType: 'buy', confidence: validation.confidence, source: walletAddress,
      rugScore: filter.rugScore, geminiAnalysis: filter.gemini ?? undefined });

    await notifySignal({ strategy: 'copy_trade', tokenMint: trade.tokenMint, signalType: 'buy',
      confidence: validation.confidence, source: `Copying ${walletAddress.slice(0, 8)}...`,
      rugScore: filter.rugScore }, trade.tokenSymbol);

    await executePaperBuy({ walletId: COPYTRADE_WALLET, strategy: 'copy_trade',
      tokenMint: trade.tokenMint, tokenSymbol: trade.tokenSymbol,
      currentPriceSol: price, signalId: signalId ?? undefined, confidence: validation.confidence });

  } else {
    await executePaperSell({ walletId: COPYTRADE_WALLET, strategy: 'copy_trade',
      tokenMint: trade.tokenMint, tokenSymbol: trade.tokenSymbol,
      currentPriceSol: price, reason: `copying_${walletAddress.slice(0, 8)}` });
  }
}

async function runCopyTrade() {
  const dbWallets  = await getCopyWallets();
  const cfgWallets = CONFIG.copyTrade.targetWallets;
  const wallets    = [...new Set([...dbWallets, ...cfgWallets])];

  if (wallets.length === 0) {
    console.log('[CopyTrade] No target wallets configured');
    return;
  }

  console.log(`[CopyTrade] Monitoring ${wallets.length} wallets`);
  for (const wallet of wallets) {
    const trades = await getWalletTransactions(wallet, 10);
    const recent = trades.filter(t => Date.now() - t.timestamp < 360_000);
    for (const trade of recent) await processCopyTrade(wallet, trade);
  }

  await checkExitConditions(COPYTRADE_WALLET, 'copy_trade', getTokenPrice);
}

// ── KOL TRACKER ───────────────────────────────────────────────────────────────
async function scrapeTweets(handle: string): Promise<Array<{ content: string; timestamp: number }>> {
  for (const instance of CONFIG.kol.nitterInstances) {
    try {
      const { data } = await axios.get(`${instance}/${handle}/rss`,
        { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });

      const items: Array<{ content: string; timestamp: number }> = [];
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(data)) !== null) {
        const item = match[1];
        const titleMatch   = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/);
        const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
        if (!titleMatch) continue;
        const content   = titleMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const timestamp = pubDateMatch ? new Date(pubDateMatch[1]).getTime() : Date.now();
        if (Date.now() - timestamp > 20 * 60 * 1000) continue;
        items.push({ content, timestamp });
      }
      return items;
    } catch (e: any) {
      console.log(`[KOL] Nitter ${instance} failed: ${e.message}`);
    }
  }
  return [];
}

async function processKOLHandle(handle: string) {
  console.log(`[KOL] Checking @${handle}`);
  const tweets = await scrapeTweets(handle);
  if (tweets.length === 0) return;

  for (const tweet of tweets) {
    const analysis = await analyzeTweet({ handle, content: tweet.content });
    if (!analysis.isAlpha || !analysis.tokenMint) continue;

    const filter = await filterToken({ mint: analysis.tokenMint,
      symbol: analysis.tokenSymbol ?? 'UNKNOWN', name: analysis.tokenSymbol ?? 'Unknown',
      devWallet: '', pumpFun: false, ageSeconds: 0 });

    if (!filter.pass) { console.log(`[KOL] Rug filter: ${filter.reasons.join(', ')}`); continue; }

    const price = await getTokenPrice(analysis.tokenMint);
    if (price <= 0) continue;

    await upsertToken({ mint: analysis.tokenMint, symbol: analysis.tokenSymbol ?? 'UNKNOWN',
      name: analysis.tokenSymbol ?? 'Unknown', pumpFun: false, rugScore: filter.rugScore });

    const confidence = analysis.sentiment === 'bullish' ? 0.75 : 0.5;
    const signalId   = await insertSignal({ strategy: 'kol', tokenMint: analysis.tokenMint,
      signalType: 'buy', confidence, source: `@${handle} on Twitter`,
      rugScore: filter.rugScore, geminiAnalysis: filter.gemini ?? undefined });

    await notifySignal({ strategy: 'kol', tokenMint: analysis.tokenMint, signalType: 'buy',
      confidence, source: `@${handle}: "${tweet.content.slice(0, 100)}"`,
      rugScore: filter.rugScore }, analysis.tokenSymbol ?? analysis.tokenMint);

    await executePaperBuy({ walletId: KOL_WALLET, strategy: 'kol',
      tokenMint: analysis.tokenMint, tokenSymbol: analysis.tokenSymbol ?? 'UNKNOWN',
      currentPriceSol: price, signalId: signalId ?? undefined, confidence });
  }
}

async function runKOL() {
  const dbHandles  = await getKOLHandles();
  const cfgHandles = CONFIG.kol.handles.map(h => ({ handle: h, platform: 'twitter' }));
  const all = [...dbHandles, ...cfgHandles.filter(c => !dbHandles.some(d => d.handle === c.handle))];

  if (all.length === 0) { console.log('[KOL] No handles configured'); return; }

  console.log(`[KOL] Tracking ${all.length} handles`);
  for (const kol of all) await processKOLHandle(kol.handle);
  await checkExitConditions(KOL_WALLET, 'kol', getTokenPrice);
}

// ── MAIN LOOP ─────────────────────────────────────────────────────────────────
async function scan() {
  console.log(`\n[Bot] Scan at ${new Date().toISOString()}`);
  // Run all three strategies in parallel
  const results = await Promise.allSettled([
    runSniper(),
    runCopyTrade(),
    runKOL(),
  ]);

  for (const [i, r] of results.entries()) {
    if (r.status === 'rejected') {
      const name = ['Sniper', 'CopyTrade', 'KOL'][i];
      console.error(`[Bot] ${name} error:`, r.reason?.message ?? r.reason);
    }
  }
}

async function runLoop() {
  const end = Date.now() + 6 * 60 * 60 * 1000;
  while (Date.now() < end) {
    await scan();
    const wait = Math.min(SCAN_INTERVAL, end - Date.now());
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
  console.log('[Bot] 6-hour window complete');
}

runLoop().catch(async (err) => {
  console.error('[Bot] Fatal error:', err);
  await notifyError('Bot', err.message);
  process.exit(1);
});
