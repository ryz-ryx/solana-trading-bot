import { createClient } from '@supabase/supabase-js';
import { CONFIG } from './config';
import type { PaperTrade, PortfolioPosition, Signal, Token } from './types';

export const db = createClient(CONFIG.supabase.url, CONFIG.supabase.serviceKey);

// ── Tokens ──────────────────────────────────────────────────────────────────
export async function upsertToken(token: Partial<Token> & { mint: string }) {
  const { error } = await db.from('tokens').upsert({
    mint: token.mint,
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals ?? 9,
    pump_fun: token.pumpFun ?? false,
    liquidity_usd: token.liquidityUsd,
    market_cap_usd: token.marketCapUsd,
    dev_wallet: token.devWallet,
    rug_score: token.rugScore,
  }, { onConflict: 'mint' });
  if (error) console.error('upsertToken error:', error.message);
}

// ── Signals ──────────────────────────────────────────────────────────────────
export async function insertSignal(signal: Signal): Promise<string | null> {
  const { data, error } = await db.from('signals').insert({
    strategy: signal.strategy,
    token_mint: signal.tokenMint,
    signal_type: signal.signalType,
    confidence: signal.confidence,
    source: signal.source,
    rug_score: signal.rugScore,
    gemini_analysis: signal.geminiAnalysis,
  }).select('id').single();
  if (error) { console.error('insertSignal error:', error.message); return null; }
  return data?.id ?? null;
}

// ── Paper Trades ─────────────────────────────────────────────────────────────
export async function insertTrade(trade: PaperTrade): Promise<string | null> {
  const { data, error } = await db.from('paper_trades').insert({
    wallet_id:    trade.walletId,
    strategy:     trade.strategy,
    token_mint:   trade.tokenMint,
    token_symbol: trade.tokenSymbol,
    action:       trade.action,
    amount_sol:   trade.amountSol,
    token_amount: trade.tokenAmount,
    price_sol:    trade.priceSol,
    price_usd:    trade.priceUsd,
    slippage_pct: trade.slippagePct,
    signal_id:    trade.signalId,
    pnl_sol:      trade.pnlSol,
    pnl_pct:      trade.pnlPct,
  }).select('id').single();
  if (error) { console.error('insertTrade error:', error.message); return null; }
  return data?.id ?? null;
}

export async function getOpenPositions(walletId: number): Promise<PortfolioPosition[]> {
  const { data, error } = await db
    .from('portfolio')
    .select('*')
    .eq('wallet_id', walletId)
    .gt('amount', 0);
  if (error) { console.error('getOpenPositions error:', error.message); return []; }
  return (data ?? []).map(r => ({
    walletId: r.wallet_id,
    tokenMint: r.token_mint,
    tokenSymbol: r.token_symbol,
    amount: r.amount,
    avgEntrySol: r.avg_entry_sol,
  }));
}

export async function upsertPortfolio(pos: PortfolioPosition) {
  const { error } = await db.from('portfolio').upsert({
    wallet_id:    pos.walletId,
    token_mint:   pos.tokenMint,
    token_symbol: pos.tokenSymbol,
    amount:       pos.amount,
    avg_entry_sol: pos.avgEntrySol,
    updated_at:   new Date().toISOString(),
  }, { onConflict: 'wallet_id,token_mint' });
  if (error) console.error('upsertPortfolio error:', error.message);
}

export async function getDailyPnl(walletId: number, date: string): Promise<number> {
  const { data, error } = await db
    .from('paper_trades')
    .select('pnl_sol')
    .eq('wallet_id', walletId)
    .eq('action', 'sell')
    .gte('created_at', `${date}T00:00:00Z`)
    .lte('created_at', `${date}T23:59:59Z`);
  if (error) return 0;
  return (data ?? []).reduce((sum, r) => sum + (r.pnl_sol ?? 0), 0);
}

export async function getTradeHistory(strategy?: string, limit = 100) {
  let query = db.from('paper_trades').select('*').order('created_at', { ascending: false }).limit(limit);
  if (strategy) query = query.eq('strategy', strategy);
  const { data, error } = await query;
  if (error) { console.error('getTradeHistory error:', error.message); return []; }
  return data ?? [];
}

export async function getCopyWallets(): Promise<string[]> {
  const { data } = await db.from('copy_wallets').select('address').eq('active', true);
  return (data ?? []).map(r => r.address);
}

export async function getKOLHandles(): Promise<Array<{ handle: string; platform: string }>> {
  const { data } = await db.from('kol_watchlist').select('handle, platform').eq('active', true);
  return data ?? [];
}
