import { getRecentPumpFunTokens, getTokenPrice } from './helius';
import { filterToken } from './rug-filter';
import { executePaperBuy, checkExitConditions } from './paper-trade';
import { insertSignal, upsertToken } from './supabase';
import { notifySignal, notifyError } from './discord';

const WALLET_ID = 1; // Sniper uses wallet 1

async function main() {
  console.log(`[Sniper] Starting scan at ${new Date().toISOString()}`);

  // Scan last 2 minutes of pump.fun launches
  const since = Date.now() - 120_000;
  const newTokens = await getRecentPumpFunTokens(since);
  console.log(`[Sniper] Found ${newTokens.length} new tokens`);

  for (const token of newTokens) {
    const ageSeconds = (Date.now() - token.timestamp) / 1000;

    // Run rug filter
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

    // Store token
    await upsertToken({
      mint:      token.mint,
      symbol:    token.symbol,
      name:      token.name,
      pumpFun:   true,
      devWallet: token.devWallet,
      rugScore:  filter.rugScore,
    });

    // Create signal
    const signalId = await insertSignal({
      strategy:       'sniper',
      tokenMint:      token.mint,
      signalType:     'buy',
      confidence:     filter.gemini?.confidence ?? 0.5,
      source:         `pump.fun launch`,
      rugScore:       filter.rugScore,
      geminiAnalysis: filter.gemini ?? undefined,
    });

    await notifySignal(
      {
        strategy:       'sniper',
        tokenMint:      token.mint,
        signalType:     'buy',
        confidence:     filter.gemini?.confidence ?? 0.5,
        source:         'pump.fun launch',
        rugScore:       filter.rugScore,
        geminiAnalysis: filter.gemini ?? undefined,
      },
      token.name
    );

    // Get current price and execute paper buy
    const price = await getTokenPrice(token.mint);
    if (price <= 0) {
      console.log(`[Sniper] Could not get price for ${token.symbol}, skipping`);
      continue;
    }

    await executePaperBuy({
      walletId:   WALLET_ID,
      strategy:   'sniper',
      tokenMint:  token.mint,
      tokenSymbol: token.symbol,
      currentPriceSol: price,
      signalId:   signalId ?? undefined,
      confidence: filter.gemini?.confidence ?? 0.5,
    });
  }

  // Check exits for existing positions
  await checkExitConditions(WALLET_ID, 'sniper', getTokenPrice);

  console.log('[Sniper] Scan complete');
}

main().catch(async (err) => {
  console.error('[Sniper] Fatal error:', err);
  await notifyError('Sniper', err.message);
  process.exit(1);
});
