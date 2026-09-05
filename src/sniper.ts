import axios from 'axios';
import { getTokenPrice } from './helius';
import { filterToken } from './rug-filter';
import { executePaperBuy, checkExitConditions } from './paper-trade';
import { insertSignal, upsertToken } from './supabase';
import { notifySignal, notifyError } from './discord';
import { CONFIG } from './config';

const WALLET_ID = 1;
const key = process.env.HELIUS_API_KEY!;
const BASE = 'https://api.helius.xyz/v0';
const PUMP_PROGRAM = CONFIG.sniper.pumpFunProgram;

// Query Helius for recent pump.fun program transactions (no type filter = all txns)
async function getRecentPumpTokens(since: number): Promise<Array<{
  mint: string; name: string; symbol: string; devWallet: string; timestamp: number;
}>> {
  try {
    const { data } = await axios.get(
      `${BASE}/addresses/${PUMP_PROGRAM}/transactions`,
      { params: { 'api-key': key, limit: 100 }, timeout: 15000 }
    );
    const seen = new Set<string>();
    const results: any[] = [];
    for (const tx of data ?? []) {
      const tsMs = (tx.timestamp ?? 0) * 1000;
      if (tsMs < since) continue;
      // Look for token transfers that initialise a new mint
      const transfers = tx.tokenTransfers ?? [];
      for (const tr of transfers) {
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
    console.log(`[Sniper] Helius returned ${data?.length ?? 0} txns → ${results.length} unique token mints`);
    return results;
  } catch (e: any) {
    console.error('[Sniper] Helius fetch error:', e.message);
    return [];
  }
}

async function main() {
  console.log(`[Sniper] Starting scan at ${new Date().toISOString()}`);

  // 10-min window to ensure we don't miss tokens between 5-min cron runs
  const since = Date.now() - 600_000;
  const newTokens = await getRecentPumpTokens(since);
  console.log(`[Sniper] Processing ${newTokens.length} tokens`);

  for (const token of newTokens) {
    const ageSeconds = (Date.now() - token.timestamp) / 1000;

      
    }

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
      liquidityUsd: 0,
    });

    const confidence = Math.min(0.95, filter.gemini?.confidence ?? 0.5);

    const signalId = await insertSignal({
      strategy:       'sniper',
      tokenMint:      token.mint,
      signalType:     'buy',
      confidence,
      source:         `pump.fun | liq:unknown`,
      rugScore:       filter.rugScore,
      geminiAnalysis: filter.gemini ?? undefined,
    });

    await notifySignal(
      { strategy: 'sniper', tokenMint: token.mint, signalType: 'buy', confidence,
        source: `pump.fun | liq:unknown`, rugScore: filter.rugScore,
        geminiAnalysis: filter.gemini ?? undefined },
      `${token.name}`
    );

    const price = await getTokenPrice(token.mint);
    if (price <= 0) {
      console.log(`[Sniper] No price for ${token.symbol}, skip`);
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
