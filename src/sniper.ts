import { getTokenPrice } from './helius';
import { getGmgnNewTokens, getGmgnTokenSecurity } from './gmgn';
import { filterToken } from './rug-filter';
import { executePaperBuy, checkExitConditions } from './paper-trade';
import { insertSignal, upsertToken } from './supabase';
import { notifySignal, notifyError } from './discord';

const WALLET_ID = 1; // Sniper uses wallet 1

async function main() {
  console.log(`[Sniper] Starting scan at ${new Date().toISOString()}`);

  // Use GMGN for richer new token data (includes security metrics)
  const allNewTokens = await getGmgnNewTokens();

  // Only tokens created in last 2 minutes
  const since = Date.now() - 120_000;
  const newTokens = allNewTokens.filter(t => t.createdAt >= since);
  console.log(`[Sniper] Found ${newTokens.length} tokens in last 2 min (of ${allNewTokens.length} total)`);

  for (const token of newTokens) {
    // Early reject: honeypot or no liquidity
    if (token.honeypot) {
      console.log(`[Sniper] ${token.symbol} — HONEYPOT, skip`);
      continue;
    }
    if (token.liquidityUsd < 5000) {
      console.log(`[Sniper] ${token.symbol} — low liquidity $${token.liquidityUsd.toFixed(0)}, skip`);
      continue;
    }
    // High insider ratio = coordinated dump
    if (token.insiderRatio > 0.3) {
      console.log(`[Sniper] ${token.symbol} — insider ratio ${(token.insiderRatio * 100).toFixed(0)}%, skip`);
      continue;
    }

    const ageSeconds = (Date.now() - token.createdAt) / 1000;

    // Run rug filter (Gemini AI scoring)
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

    // Store token with GMGN enriched data
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

    // Confidence boosted if LP burned + renounced
    const securityBonus = (token.lpBurned ? 0.1 : 0) + (token.renounced ? 0.05 : 0);
    const confidence = Math.min(0.95, (filter.gemini?.confidence ?? 0.5) + securityBonus);

    const signalId = await insertSignal({
      strategy:       'sniper',
      tokenMint:      token.mint,
      signalType:     'buy',
      confidence,
      source:         `pump.fun | liq:$${Math.round(token.liquidityUsd)} insider:${(token.insiderRatio * 100).toFixed(0)}%`,
      rugScore:       filter.rugScore,
      geminiAnalysis: filter.gemini ?? undefined,
    });

    await notifySignal(
      {
        strategy:       'sniper',
        tokenMint:      token.mint,
        signalType:     'buy',
        confidence,
        source:         `pump.fun | liq:$${Math.round(token.liquidityUsd)} | LP burned:${token.lpBurned}`,
        rugScore:       filter.rugScore,
        geminiAnalysis: filter.gemini ?? undefined,
      },
      `${token.name} ($${token.marketCapUsd.toFixed(0)} mcap)`
    );

    // Use GMGN price first, fall back to Helius DAS
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

  // Check exits for existing positions
  await checkExitConditions(WALLET_ID, 'sniper', getTokenPrice);

  console.log('[Sniper] Scan complete');
}

main().catch(async (err) => {
  console.error('[Sniper] Fatal error:', err);
  await notifyError('Sniper', err.message);
  process.exit(1);
});
