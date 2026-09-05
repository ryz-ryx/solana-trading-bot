import { runBacktest } from './backtest';
import { notifyError } from './discord';
import type { MonteCarloResult, Strategy } from './types';

// Resample trades with replacement (bootstrap)
function bootstrapRun(pnls: number[], numTrades: number): number {
  let total = 0;
  for (let i = 0; i < numTrades; i++) {
    total += pnls[Math.floor(Math.random() * pnls.length)];
  }
  return total;
}

export async function runMonteCarlo(
  strategy?: Strategy,
  runs = 10_000
): Promise<MonteCarloResult[]> {
  const backtests = await runBacktest(strategy);
  const results: MonteCarloResult[] = [];

  for (const bt of backtests) {
    if (bt.totalTrades < 5) {
      console.log(`[MonteCarlo] ${bt.strategy}: Not enough trades (${bt.totalTrades} < 5), skipping`);
      continue;
    }

    // Rebuild per-trade PnL array from backtest summary via DB
    const { db } = await import('./supabase');
    const { data } = await db
      .from('paper_trades')
      .select('pnl_sol')
      .eq('strategy', bt.strategy)
      .eq('action', 'sell');

    const pnls = (data ?? []).map((r: any) => r.pnl_sol ?? 0);
    if (pnls.length === 0) continue;

    const finalValues: number[] = [];
    for (let i = 0; i < runs; i++) {
      finalValues.push(bootstrapRun(pnls, pnls.length));
    }

    finalValues.sort((a, b) => a - b);
    const profitable = finalValues.filter(v => v > 0).length;
    const profitRate = profitable / runs;

    const result: MonteCarloResult = {
      runs,
      profitableRuns: profitable,
      profitRate,
      medianFinalPnl: finalValues[Math.floor(runs * 0.5)],
      p5FinalPnl:     finalValues[Math.floor(runs * 0.05)],
      p95FinalPnl:    finalValues[Math.floor(runs * 0.95)],
    };

    console.log(`\n── ${bt.strategy.toUpperCase()} MONTE CARLO (${runs.toLocaleString()} runs) ──`);
    console.log(`Profit Rate:  ${(profitRate * 100).toFixed(1)}% ${profitRate >= 0.9 ? '✅ TARGET MET' : '❌ BELOW TARGET'}`);
    console.log(`Median PnL:   ${result.medianFinalPnl.toFixed(4)} SOL`);
    console.log(`5th pct:      ${result.p5FinalPnl.toFixed(4)} SOL`);
    console.log(`95th pct:     ${result.p95FinalPnl.toFixed(4)} SOL`);

    results.push(result);
  }

  return results;
}

async function main() {
  console.log(`[MonteCarlo] Running at ${new Date().toISOString()}`);
  await runMonteCarlo(undefined, 10_000);
  console.log('[MonteCarlo] Done');
}

main().catch(async (err) => {
  console.error('[MonteCarlo] Fatal:', err);
  await notifyError('MonteCarlo', err.message);
  process.exit(1);
});
