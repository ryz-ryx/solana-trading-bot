import axios from 'axios';
import { analyzeTweet } from './gemini';
import { getTokenPrice } from './helius';
import { filterToken } from './rug-filter';
import { executePaperBuy, checkExitConditions } from './paper-trade';
import { insertSignal, upsertToken, getKOLHandles } from './supabase';
import { notifySignal, notifyError } from './discord';
import { CONFIG } from './config';

const WALLET_ID = 3; // KOL tracker uses wallet 3

// Scrape tweets via Nitter (no API key needed)
async function scrapeTweets(handle: string): Promise<Array<{ content: string; timestamp: number }>> {
  for (const instance of CONFIG.kol.nitterInstances) {
    try {
      const { data } = await axios.get(`${instance}/${handle}/rss`, {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      // Parse RSS items
      const items: Array<{ content: string; timestamp: number }> = [];
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;

      while ((match = itemRegex.exec(data)) !== null) {
        const item = match[1];
        const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/);
        const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
        if (!titleMatch) continue;

        const content = titleMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const timestamp = pubDateMatch ? new Date(pubDateMatch[1]).getTime() : Date.now();

        // Only last 20 minutes
        if (Date.now() - timestamp > 20 * 60 * 1000) continue;
        items.push({ content, timestamp });
      }

      return items;
    } catch (e: any) {
      console.log(`[KOL] Nitter instance ${instance} failed: ${e.message}`);
    }
  }
  return [];
}

async function processHandle(handle: string) {
  console.log(`[KOL] Checking @${handle}`);
  const tweets = await scrapeTweets(handle);

  if (tweets.length === 0) {
    console.log(`[KOL] No recent tweets from @${handle}`);
    return;
  }

  for (const tweet of tweets) {
    console.log(`[KOL] @${handle}: "${tweet.content.slice(0, 80)}..."`);

    const analysis = await analyzeTweet({ handle, content: tweet.content });

    if (!analysis.isAlpha) {
      console.log(`[KOL] Not alpha, skipping`);
      continue;
    }

    const tokenMint = analysis.tokenMint;
    if (!tokenMint) {
      console.log(`[KOL] Alpha detected but no mint address found: ${analysis.tokenSymbol}`);
      continue;
    }

    // Run rug filter
    const filter = await filterToken({
      mint:      tokenMint,
      symbol:    analysis.tokenSymbol ?? 'UNKNOWN',
      name:      analysis.tokenSymbol ?? 'Unknown',
      devWallet: '',
      pumpFun:   false,
      ageSeconds: 0,
    });

    if (!filter.pass) {
      console.log(`[KOL] Rug filter failed: ${filter.reasons.join(', ')}`);
      continue;
    }

    const price = await getTokenPrice(tokenMint);
    if (price <= 0) {
      console.log(`[KOL] No price found for ${tokenMint}`);
      continue;
    }

    await upsertToken({
      mint:     tokenMint,
      symbol:   analysis.tokenSymbol ?? 'UNKNOWN',
      name:     analysis.tokenSymbol ?? 'Unknown',
      pumpFun:  false,
      rugScore: filter.rugScore,
    });

    const confidence = analysis.sentiment === 'bullish' ? 0.75 : 0.5;

    const signalId = await insertSignal({
      strategy:       'kol',
      tokenMint,
      signalType:     'buy',
      confidence,
      source:         `@${handle} on Twitter`,
      rugScore:       filter.rugScore,
      geminiAnalysis: filter.gemini ?? undefined,
    });

    await notifySignal({
      strategy:       'kol',
      tokenMint,
      signalType:     'buy',
      confidence,
      source:         `@${handle}: "${tweet.content.slice(0, 100)}"`,
      rugScore:       filter.rugScore,
    }, analysis.tokenSymbol ?? tokenMint);

    await executePaperBuy({
      walletId:        WALLET_ID,
      strategy:        'kol',
      tokenMint,
      tokenSymbol:     analysis.tokenSymbol ?? 'UNKNOWN',
      currentPriceSol: price,
      signalId:        signalId ?? undefined,
      confidence,
    });
  }
}

async function main() {
  console.log(`[KOL] Starting at ${new Date().toISOString()}`);

  // Get handles from DB + config
  const dbHandles  = await getKOLHandles();
  const cfgHandles = CONFIG.kol.handles.map(h => ({ handle: h, platform: 'twitter' }));
  const all = [...dbHandles, ...cfgHandles.filter(c => !dbHandles.some(d => d.handle === c.handle))];

  if (all.length === 0) {
    console.log('[KOL] No KOL handles configured. Add to kol_watchlist table or KOL_HANDLES env var.');
    return;
  }

  console.log(`[KOL] Tracking ${all.length} handles`);
  for (const kol of all) {
    await processHandle(kol.handle);
  }

  // Check exits
  await checkExitConditions(WALLET_ID, 'kol', getTokenPrice);

  console.log('[KOL] Done');
}

async function runLoop() {
  const end = Date.now() + 6 * 60 * 60 * 1000;
  while (Date.now() < end) {
    await main();
    const wait = Math.min(300_000, end - Date.now());
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
}

runLoop().catch(async (err) => {
  console.error('[KOL] Fatal error:', err);
  await notifyError('KOL Tracker', err.message);
  process.exit(1);
});
