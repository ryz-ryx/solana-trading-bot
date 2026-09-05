import { db, getOpenPositions } from './supabase';
import { getTokenPrice, getSolPrice } from './helius';
import { notifyDailyReport, notifyError } from './discord';

async function main() {
  console.log(`[DailyReport] Running at ${new Date().toISOString()}`);
  const today = new Date().toISOString().split('T')[0];

  const { data: trades } = await db
    .from('paper_trades')
    .select('pnl_sol,action')
    .eq('action', 'sell')
    .gte('created_at', `${today}T00:00:00Z`);

  const sells = trades ?? [];
  const pnls  = sells.map((t: any) => t.pnl_sol ?? 0);
  const wins  = pnls.filter((p: number) => p > 0);
  const totalPnl = pnls.reduce((a: number, b: number) => a + b, 0);
  const winRate  = sells.length > 0 ? wins.length / sells.length : 0;

  // Estimate portfolio value from open positions
  let portfolioValueSol = 0;
  for (let wid = 1; wid <= 3; wid++) {
    const positions = await getOpenPositions(wid);
    for (const pos of positions) {
      if (pos.amount <= 0) continue;
      const price = await getTokenPrice(pos.tokenMint);
      portfolioValueSol += pos.amount * price;
    }
  }

  await notifyDailyReport({
    date: today,
    totalTrades:      sells.length,
    winRate,
    totalPnlSol:      totalPnl,
    bestTrade:        pnls.length > 0 ? Math.max(...pnls) : 0,
    worstTrade:       pnls.length > 0 ? Math.min(...pnls) : 0,
    portfolioValueSol,
  });

  console.log('[DailyReport] Sent');
}

main().catch(async (err) => {
  console.error('[DailyReport] Fatal:', err);
  await notifyError('DailyReport', err.message);
  process.exit(1);
});
