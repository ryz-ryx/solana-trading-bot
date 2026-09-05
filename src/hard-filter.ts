/**
 * Hard security filter — runs BEFORE Gemini.
 * Uses Helius RPC only (works from GitHub Actions datacenter IPs).
 * Returns in < 500ms or times out to PASS (don't block sniper on slow RPC).
 */
import axios from 'axios';
import { CONFIG } from './config';

const RPC = `https://mainnet.helius-rpc.com/?api-key=${CONFIG.helius.apiKey}`;
const PUMP_PROGRAM = CONFIG.sniper.pumpFunProgram;

export interface HardFilterResult {
  pass:    boolean;
  reasons: string[];
  checks:  Record<string, string>; // for logging
}

// ── RPC helpers ──────────────────────────────────────────────────────────────

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const { data } = await axios.post(RPC, {
    jsonrpc: '2.0', id: 1, method, params,
  }, { timeout: 3000 });
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

async function getMintInfo(mint: string): Promise<{
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: string;
  decimals: number;
} | null> {
  try {
    const result = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]) as any;
    const info = result?.value?.data?.parsed?.info;
    if (!info) return null;
    return {
      mintAuthority:  info.mintAuthority  ?? null,
      freezeAuthority: info.freezeAuthority ?? null,
      supply:   info.supply   ?? '0',
      decimals: info.decimals ?? 9,
    };
  } catch {
    return null;
  }
}

async function getTopHolders(mint: string): Promise<Array<{ address: string; amount: number }>> {
  try {
    const result = await rpc('getTokenLargestAccounts', [mint]) as any;
    return (result?.value ?? []).map((h: any) => ({
      address: h.address,
      amount:  Number(h.amount),
    }));
  } catch {
    return [];
  }
}

async function getDevBalance(devWallet: string, mint: string, totalSupply: number): Promise<number> {
  if (!devWallet || totalSupply === 0) return 0;
  try {
    const result = await rpc('getTokenAccountsByOwner', [
      devWallet,
      { mint },
      { encoding: 'jsonParsed' },
    ]) as any;
    const accounts = result?.value ?? [];
    const total = accounts.reduce((sum: number, acc: any) => {
      return sum + Number(acc.account?.data?.parsed?.info?.tokenAmount?.amount ?? 0);
    }, 0);
    return total / totalSupply;
  } catch {
    return 0;
  }
}

// ── Main filter ───────────────────────────────────────────────────────────────

export async function hardFilter(params: {
  mint:       string;
  devWallet:  string;
  pumpFun:    boolean;
  ageSeconds: number;
}): Promise<HardFilterResult> {
  const { mint, devWallet, pumpFun, ageSeconds } = params;
  const reasons: string[] = [];
  const checks:  Record<string, string> = {};

  // Wrap everything in a global 4s timeout — if RPC is slow, pass through to Gemini
  const run = async (): Promise<HardFilterResult> => {
    // 1. Fetch mint account info
    const mintInfo = await getMintInfo(mint);
    if (!mintInfo) {
      checks.mint_info = 'unavailable';
      // Can't verify — let Gemini decide
      return { pass: true, reasons: [], checks };
    }

    const supply = Number(mintInfo.supply);
    checks.supply = supply.toString();

    // 2. Freeze authority — must be null (no exceptions)
    checks.freeze_authority = mintInfo.freezeAuthority ?? 'null';
    if (mintInfo.freezeAuthority) {
      reasons.push(`Freeze authority enabled: ${mintInfo.freezeAuthority.slice(0, 8)}...`);
    }

    // 3. Mint authority — allow pump.fun bonding curve, reject unknown authorities
    checks.mint_authority = mintInfo.mintAuthority ?? 'null';
    if (mintInfo.mintAuthority) {
      // pump.fun tokens on the bonding curve have a mint authority — this is expected
      // but we still flag non-pump tokens with mint authority enabled
      if (!pumpFun) {
        reasons.push(`Mint authority enabled on non-pump token: ${mintInfo.mintAuthority.slice(0, 8)}...`);
      } else {
        checks.mint_authority = 'pump_bonding_curve_ok';
      }
    }

    // 4. Top 10 holder concentration
    // Skip for pump.fun tokens < 60s old: bonding curve holds 80-100% of supply at launch
    // (that's normal — supply distributes as trades happen)
    if (supply > 0 && !(pumpFun && ageSeconds < 60)) {
      const holders = await getTopHolders(mint);
      if (holders.length > 0) {
        const top10Total = holders.slice(0, 10).reduce((s, h) => s + h.amount, 0);
        const top10Pct   = (top10Total / supply) * 100;
        checks.top10_pct = `${top10Pct.toFixed(1)}%`;
        if (top10Pct > 30) {
          reasons.push(`Top 10 holders own ${top10Pct.toFixed(1)}% of supply (>30%)`);
        }

        // 5. Dev wallet holding
        const devPct = await getDevBalance(devWallet, mint, supply);
        checks.dev_pct = `${(devPct * 100).toFixed(1)}%`;
        if (devPct > 0.05) {
          reasons.push(`Dev wallet holds ${(devPct * 100).toFixed(1)}% of supply (>5%)`);
        }

        // 6. Bundling risk — top N holders bought in same slot (heuristic: top 5 hold > 15% each)
        const top5 = holders.slice(0, 5);
        const suspicioulyLargeHolders = top5.filter(h => (h.amount / supply) > 0.10);
        if (suspicioulyLargeHolders.length >= 3) {
          checks.bundling = `${suspicioulyLargeHolders.length} wallets each >10%`;
          reasons.push(`Bundling risk: ${suspicioulyLargeHolders.length} wallets each hold >10%`);
        } else {
          checks.bundling = 'ok';
        }
      } else {
        checks.top10_pct = 'no_holder_data';
      }
    } else if (pumpFun && ageSeconds < 60) {
      checks.top10_pct = 'skipped_new_pump_token';
    }

    return { pass: reasons.length === 0, reasons, checks };
  };

  // Global timeout — on timeout, let token through (don't block sniper on slow RPC)
  return Promise.race([
    run(),
    new Promise<HardFilterResult>(resolve =>
      setTimeout(() => resolve({ pass: true, reasons: [], checks: { timeout: '4s' } }), 4000)
    ),
  ]);
}
