import { db } from './supabase';
import { notifyError } from './discord';
import type { BacktestResult, Strategy } from './types';

interface RawTrade {
  strategy: string;
  action: string;
  amount_sol: number;
  pnl_sol: number | null;
  pnl_pct: number | null;
  created_at: string;
  slippage_pct: number;
}

async function fetchTrades(strategy?: Strategy): Promise<RawTrade[]> {
  let query = db
    .from('paper_trades')
    .select('strategy,action,amount_sol,pnl_sol,pnl_pct,created_at,slippage_pct')
    .eq('action', 'sell')
    .order('created_at', { ascending: true });
  if (strategy) query = query.eq('strategy', strategy);
  const { data, error } = await query;
  if (error) throw new Error(`fetchTrades: ${error.message}`);
  return data ?? [];
}

function calcSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  return stdDev === 0 ? 0 : (mean / stdDev) * Math.sqrt(365); // annualised
}

function calcMaxDrawdown(pnlCurve: number[]): number {
  let peak = 0, maxDD = 0, running = 0;
  for (const pnl of pnlCurve) {
    running += pnl;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function calcProfitFactor(trades: RawTrade[]): number {
  const wins  = trades.filter(t => (t.pnl_sol ?? 0) > 0).reduce((s, t) => s + (t.pnl_sol ?? 0), 0);
  const losses = trades.filter(t => (t.pnl_sol ?? 0) < 0).reduce((s, t) => s + Math.abs(t.pnl_sol ?? 0), 0);
  return losses === 0 ? wins > 0 ? Infinity : 1 : wins / losses;
}

export async function runBacktest(strategy?: Strategy): Promise<BacktestResult[]> {
  const allTrades = await fetchTrades(strategy);
  const strategies = strategy
    ? [strategy]
    : [...new Set(allTrades.map(t => t.strategy))] as Strategy[];

  const results: BacktestResult[] = [];

  for (const strat of strategies) {
    const trades = allTrades.filter(t => t.strategy === strat);
    if (trades.length === 0) continue;

    const wins   = trades.filter(t => (t.pnl_sol ?? 0) > 0);
    const pnls   = trades.map(t => t.pnl_sol ?? 0);
    const total  = pnls.reduce((a, b) => a + b, 0);

    const result: BacktestResult = {
      strategy:        strat,
      totalTrades:     trades.length,
      winRate:         wins.length / trades.length,
      totalPnlSol:     total,
      avgPnlPerTrade:  total / trades.length,
      maxDrawdown:     calcMaxDrawdown(pnls),
      sharpeRatio:     calcSharpe(pnls),
      profitFactor:    calcProfitFactor(trades),
    };

    console.log(`\n── ${strat.toUpperCase()} BACKTEST ──`);
    console.log(`Trades:       ${result.totalTrades}`);
    console.log(`Win Rate:     ${(result.winRate * 100).toFixed(1)}%`);
    console.log(`Total PnL:    ${result.totalPnlSol.toFixed(4)} SOL`);
    console.log(`Avg/Trade:    ${result.avgPnlPerTrade.toFixed(4)} SOL`);
    console.log(`Max Drawdown: ${result.maxDrawdown.toFixed(4)} SOL`);
    console.log(`Sharpe:       ${result.sharpeRatio.toFixed(2)}`);
    console.log(`Profit Factor:${result.profitFactor.toFixed(2)}`);

    results.push(result);
  }

  return results;
}

async function main() {
  console.log(`[Backtest] Running at ${new Date().toISOString()}`);
  await runBacktest();
  console.log('[Backtest] Done');
}

main().catch(async (err) => {
  console.error('[Backtest] Fatal:', err);
  await notifyError('Backtest', err.message);
  process.exit(1);
});
