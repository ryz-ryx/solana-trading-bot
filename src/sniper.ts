import axios from 'axios';
import { getTokenPrice } from './helius';
import { filterToken } from './rug-filter';
import { executePaperBuy, checkExitConditions } from './paper-trade';
import { insertSignal, upsertToken } from './supabase';
import { notifySignal, notifyError } from './discord';

const WALLET_ID = 1;

// pump.fun public API — real-time, works from datacenter IPs
async function getPumpFunNewTokens(sinceMs: number) {
  try {
    const { data } = await axios.get('https://frontend-api.pump.fun/coins', {
      params: { sort: 'created_timestamp', order: 'DESC', limit: 50 },
      headers: { 'Accept': 'application/json' },
      timeout: 10000,
    });
    const coins = Array.isArray(data) ? data : [];
    return coins
      .filter((c: any) => (c.created_timestamp * 1000) >= sinceMs)
      .map((c: any) => ({
        mint:         c.mint,
        symbol:       c.symbol ?? 'UNKNOWN',
        name:         c.name ?? 'Unknown',
        priceUsd:     parseFloat(c.usd_market_cap ?? 0) / Math.max(1, parseFloat(c.total_supply ?? 1e9)),
        liquidityUsd: parseFloat(c.virtual_sol_reserves ?? 0) * 150, // approx
        marketCapUsd: parseFloat(c.usd_market_cap ?? 0),
        createdAt:    (c.created_timestamp ?? 0) * 1000,
        devWallet:    c.creator ?? '',
        insiderRatio: 0,
        lpBurned:     false,
        renounced:    false,
        honeypot:     false,
      }));
  } catch (e: any) {
    console.error('[PumpFun] API error:', e.message);
    return [];
  }
}

async function main() {
  console.log(`[Sniper] Starting scan at ${new Date().toISOString()}`);

  // Look back 6 min to cover the 5-min cron interval with overlap
  const since = Date.now() - 360_000;
  const newTokens = await getPumpFunNewTokens(since);
  console.log(`[Sniper] Found ${newTokens.length} new tokens via pump.fun API`);

  for (const token of newTokens) {
    if (!token.mint) continue;

    if (token.liquidityUsd < 3000) {
      console.log(`[Sniper] ${token.symbol} — low liquidity $${token.liquidityUsd.toFixed(0)}, skip`);
      continue;
    }

    const ageSeconds = (Date.now() - token.createdAt) / 1000;

    const filter = await filterToken({
      mint:      token.mint,
      symbol:    token.symbol,
      name:      token.name,
      devWallet: token.devWallet,
      pumpFun:   true,
      ageSeconds,
    });

    console.log(`[Sniper] ${token.symbol} (${token.mint.slice(0, 8)}...) — rug: ${filter.rugScore} — ${filter.pass ? 'PASS' : 'FAIL'}`);

    if (!filter.pass) {
      console.log(`  Rejected: ${filter.reasons.join(', ')}`);
      continue;
    }

    await upsertToken({
      mint:         token.mint,
      symbol:       token.symbol,
      name:         token.name,
      pumpFun:      true,
      devWallet:    token.devWallet,
      rugScore:     filter.rugScore,
      liquidityUsd: token.liquidityUsd,
      marketCapUsd: token.marketCapUsd,
    });

    const confidence = Math.min(0.95, filter.gemini?.confidence ?? 0.5);

    const signalId = await insertSignal({
      strategy:       'sniper',
      tokenMint:      token.mint,
      signalType:     'buy',
      confidence,
      source:         `pump.fun | liq:$${Math.round(token.liquidityUsd)}`,
      rugScore:       filter.rugScore,
      geminiAnalysis: filter.gemini ?? undefined,
    });

    await notifySignal(
      { strategy: 'sniper', tokenMint: token.mint, signalType: 'buy', confidence,
        source: `pump.fun API`, rugScore: filter.rugScore, geminiAnalysis: filter.gemini ?? undefined },
      `${token.name} ($${token.marketCapUsd.toFixed(0)} mcap)`
    );

    const price = token.priceUsd > 0 ? token.priceUsd : await getTokenPrice(token.mint);
    if (price <= 0) {
      console.log(`[Sniper] Could not get price for ${token.symbol}, skipping`);
      continue;
    }

    await executePaperBuy({
      walletId:        WALLET_ID,
      strategy:        'sniper',
      tokenMint:       token.mint,
      tokenSymbol:     token.symbol,
      currentPriceSol: price,
      signalId:        signalId ?? undefined,
      confidence,
    });
  }

  await checkExitConditions(WALLET_ID, 'sniper', getTokenPrice);
  console.log('[Sniper] Scan complete');
}

main().catch(async (err) => {
  console.error('[Sniper] Fatal error:', err);
  await notifyError('Sniper', err.message);
  process.exit(1);
});
