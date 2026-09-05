import axios from 'axios';
import type { Token } from './types';

const BASE = 'https://gmgn.ai/defi/quotation/v1';
const WALLET_BASE = 'https://gmgn.ai/api/v1';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Referer': 'https://gmgn.ai/',
};

// ── New tokens from pump.fun via GMGN ────────────────────────────────────────
export async function getGmgnNewTokens(): Promise<Array<{
  mint: string; symbol: string; name: string;
  priceUsd: number; liquidityUsd: number; marketCapUsd: number;
  createdAt: number; devWallet: string;
  insiderRatio: number; bundleRatio: number; top10Pct: number;
  lpBurned: boolean; renounced: boolean; honeypot: boolean;
}>> {
  try {
    const { data } = await axios.get(
      `${BASE}/tokens/sol/new`,
      {
        headers: HEADERS,
        params: {
          limit: 50,
          orderby: 'created_timestamp',
          direction: 'desc',
          filters: ['pump'],
        },
        timeout: 10000,
      }
    );
    const tokens = data?.data?.tokens ?? data?.tokens ?? [];
    return tokens.map((t: any) => ({
      mint:         t.address ?? t.mint,
      symbol:       t.symbol ?? 'UNKNOWN',
      name:         t.name ?? 'Unknown',
      priceUsd:     parseFloat(t.price ?? 0),
      liquidityUsd: parseFloat(t.liquidity ?? 0),
      marketCapUsd: parseFloat(t.market_cap ?? 0),
      createdAt:    (t.created_timestamp ?? t.open_timestamp ?? 0) * 1000,
      devWallet:    t.creator ?? t.dev_address ?? '',
      insiderRatio: parseFloat(t.insider_rate ?? t.rat_trader_amount_rate ?? 0),
      bundleRatio:  parseFloat(t.bundle_rate ?? 0),
      top10Pct:     parseFloat(t.top10_holder_rate ?? 0),
      lpBurned:     t.burn_status === 'burn' || t.is_burned === true,
      renounced:    t.renounced === true || t.is_renounced === true,
      honeypot:     t.is_honeypot === true,
    }));
  } catch (e: any) {
    console.error('[GMGN] getNewTokens error:', e.message);
    return [];
  }
}

// ── Trending tokens (1h momentum) ────────────────────────────────────────────
export async function getGmgnTrending(): Promise<Array<{
  mint: string; symbol: string; name: string;
  priceUsd: number; change1h: number; volume1h: number; liquidityUsd: number;
}>> {
  try {
    const { data } = await axios.get(
      `${BASE}/rank/sol/swaps/1h`,
      {
        headers: HEADERS,
        params: { orderby: 'swaps', direction: 'desc', limit: 20 },
        timeout: 10000,
      }
    );
    const tokens = data?.data?.rank ?? data?.rank ?? [];
    return tokens.map((t: any) => ({
      mint:         t.address ?? t.mint,
      symbol:       t.symbol ?? 'UNKNOWN',
      name:         t.name ?? 'Unknown',
      priceUsd:     parseFloat(t.price ?? 0),
      change1h:     parseFloat(t.price_change_percent1h ?? 0),
      volume1h:     parseFloat(t.volume1h ?? 0),
      liquidityUsd: parseFloat(t.liquidity ?? 0),
    }));
  } catch (e: any) {
    console.error('[GMGN] getTrending error:', e.message);
    return [];
  }
}

// ── Token security info ───────────────────────────────────────────────────────
export async function getGmgnTokenSecurity(mint: string): Promise<{
  lpBurned: boolean; renounced: boolean; honeypot: boolean;
  insiderRatio: number; top10Pct: number; devHoldingPct: number;
} | null> {
  try {
    const { data } = await axios.get(
      `${BASE}/tokens/sol/${mint}`,
      { headers: HEADERS, timeout: 8000 }
    );
    const t = data?.data ?? data;
    return {
      lpBurned:      t?.burn_status === 'burn' || t?.is_burned === true,
      renounced:     t?.renounced === true,
      honeypot:      t?.is_honeypot === true,
      insiderRatio:  parseFloat(t?.insider_rate ?? t?.rat_trader_amount_rate ?? 0),
      top10Pct:      parseFloat(t?.top10_holder_rate ?? 0),
      devHoldingPct: parseFloat(t?.dev_token_burn_amount ?? t?.creator_token_status ?? 0),
    };
  } catch {
    return null;
  }
}

// ── Smart money wallet stats ──────────────────────────────────────────────────
export async function getGmgnWalletStats(address: string, period = '7d'): Promise<{
  winRate: number; pnlSol: number; pnlUsd: number;
  totalTrades: number; avgHoldTime: number;
} | null> {
  try {
    const { data } = await axios.get(
      `${WALLET_BASE}/wallet_stat/sol/${address}/${period}`,
      { headers: HEADERS, timeout: 8000 }
    );
    const s = data?.data ?? data;
    return {
      winRate:      parseFloat(s?.winrate ?? s?.win_rate ?? 0),
      pnlSol:       parseFloat(s?.realized_profit ?? 0),
      pnlUsd:       parseFloat(s?.realized_profit_usd ?? 0),
      totalTrades:  parseInt(s?.buy_30d ?? s?.total_trade_count ?? 0),
      avgHoldTime:  parseFloat(s?.avg_holding_peroid ?? 0),
    };
  } catch {
    return null;
  }
}

// ── Smart money top wallets list ──────────────────────────────────────────────
export async function getGmgnSmartWallets(limit = 20): Promise<Array<{
  address: string; winRate: number; pnl7dUsd: number; tags: string[];
}>> {
  try {
    const { data } = await axios.get(
      `${WALLET_BASE}/smartmoney/sol/wallets`,
      {
        headers: HEADERS,
        params: { orderby: 'pnl_7d', direction: 'desc', limit },
        timeout: 10000,
      }
    );
    const wallets = data?.data?.wallets ?? data?.wallets ?? [];
    return wallets.map((w: any) => ({
      address: w.address ?? w.wallet,
      winRate: parseFloat(w.winrate ?? w.win_rate ?? 0),
      pnl7dUsd: parseFloat(w.pnl_7d_usd ?? w.realized_profit ?? 0),
      tags: w.tags ?? [],
    }));
  } catch (e: any) {
    console.error('[GMGN] getSmartWallets error:', e.message);
    return [];
  }
}

// ── DexScreener fallback: new pump.fun pairs (works from datacenter IPs) ──────
export async function getDexScreenerNewPairs(sinceMs: number): Promise<Array<{
  mint: string; symbol: string; name: string;
  priceUsd: number; liquidityUsd: number; marketCapUsd: number;
  createdAt: number; devWallet: string;
  insiderRatio: number; bundleRatio: number; top10Pct: number;
  lpBurned: boolean; renounced: boolean; honeypot: boolean;
}>> {
  try {
    const { data } = await axios.get(
      'https://api.dexscreener.com/latest/dex/search',
      { params: { q: 'pump' }, timeout: 10000 }
    );
    const pairs = data?.pairs ?? [];
    return pairs
      .filter((p: any) =>
        p.chainId === 'solana' &&
        p.pairCreatedAt &&
        p.pairCreatedAt >= sinceMs &&
        p.baseToken?.address
      )
      .map((p: any) => ({
        mint:         p.baseToken.address,
        symbol:       p.baseToken.symbol ?? 'UNKNOWN',
        name:         p.baseToken.name ?? 'Unknown',
        priceUsd:     parseFloat(p.priceUsd ?? 0),
        liquidityUsd: p.liquidity?.usd ?? 0,
        marketCapUsd: p.fdv ?? p.marketCap ?? 0,
        createdAt:    p.pairCreatedAt,
        devWallet:    '',
        insiderRatio: 0,
        bundleRatio:  0,
        top10Pct:     0,
        lpBurned:     false,
        renounced:    false,
        honeypot:     false,
      }));
  } catch (e: any) {
    console.error('[DexScreener] getNewPairs error:', e.message);
    return [];
  }
}
