import { getTokenLiquidity } from './helius';
import { analyzeToken } from './gemini';
import { hardFilter } from './hard-filter';
import { CONFIG } from './config';
import type { Token, GeminiAnalysis } from './types';

export interface FilterResult {
  pass: boolean;
  rugScore: number;
  reasons: string[];
  gemini: GeminiAnalysis | null;
}

function quickFilter(token: {
  symbol: string;
  name: string;
  liquidityUsd: number;
  ageSeconds: number;
  mint: string;
}): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (token.liquidityUsd < CONFIG.sniper.minLiquidityUsd) {
    reasons.push(`Liquidity too low: $${token.liquidityUsd}`);
  }
  if (token.ageSeconds < (CONFIG.trading as any).minTokenAgeSecs) {
    reasons.push(`Token too young: ${token.ageSeconds}s (min 10s)`);
  }
  if (token.ageSeconds > CONFIG.sniper.maxTokenAgeSecs) {
    reasons.push(`Token too old: ${token.ageSeconds}s`);
  }
  if (token.mint.length < 32 || token.mint.length > 44) {
    reasons.push('Invalid mint address length');
  }

  return { pass: reasons.length === 0, reasons };
}

function calculateRugScore(liquidity: number, ageSeconds: number, geminiRisk: number): number {
  let score = 0;

  if (liquidity < 1000)       score += 40;
  else if (liquidity < 5000)  score += 30;
  else if (liquidity < 10000) score += 20;
  else if (liquidity < 50000) score += 10;

  if (ageSeconds < 10)       score += 20;
  else if (ageSeconds < 30)  score += 15;
  else if (ageSeconds < 60)  score += 10;
  else if (ageSeconds < 120) score += 5;

  score += Math.round(geminiRisk * 0.4);

  return Math.min(100, score);
}

export async function filterToken(token: {
  mint: string;
  symbol: string;
  name: string;
  devWallet: string;
  pumpFun: boolean;
  ageSeconds: number;
}): Promise<FilterResult> {
  // 1. Fetch live liquidity
  const liquidityUsd = await getTokenLiquidity(token.mint);
  // pump.fun bonding curve tokens always show $0 DEX liquidity — use neutral value for scoring
  const effectiveLiquidity = (token.pumpFun && liquidityUsd === 0) ? 5000 : liquidityUsd;

  // 2. Quick sanity checks (age, liquidity, mint format)
  const quick = quickFilter({ ...token, liquidityUsd: effectiveLiquidity });
  if (!quick.pass) {
    return { pass: false, rugScore: 100, reasons: quick.reasons, gemini: null };
  }

  // 3. Hard security filter via Helius RPC (freeze authority, top holders, dev %, bundling)
  const hard = await hardFilter({
    mint:       token.mint,
    devWallet:  token.devWallet,
    pumpFun:    token.pumpFun,
    ageSeconds: token.ageSeconds,
  });

  console.log(`[HardFilter] ${token.symbol} checks:`, hard.checks);

  if (!hard.pass) {
    console.log(`[HardFilter] REJECT ${token.symbol}:`, hard.reasons);
    return { pass: false, rugScore: 100, reasons: hard.reasons, gemini: null };
  }

  // 4. Gemini AI analysis — pass computed metrics from hard filter
  const top10Raw = hard.checks.top10_pct ?? '';
  const devRaw   = hard.checks.dev_pct   ?? '';
  const txCount  = 0; // placeholder — extend if tx count plumbed through
  const metrics  = {
    top10Pct: parseFloat(top10Raw) || 0,
    devPct:   parseFloat(devRaw)   || 0,
    txCount,
  };
  const gemini = await analyzeToken({ ...token, liquidityUsd, metrics });

  // 5. Final rug score
  const rugScore = calculateRugScore(effectiveLiquidity, token.ageSeconds, gemini.rugRisk);

  const pass = rugScore <= CONFIG.sniper.maxRugScore
    && gemini.recommendation === 'BUY'
    && gemini.score >= 60;

  const reasons: string[] = [];
  if (rugScore > CONFIG.sniper.maxRugScore) reasons.push(`Rug score too high: ${rugScore}`);
  if (gemini.recommendation !== 'BUY') reasons.push(`Gemini says: SKIP | flags: ${gemini.red_flags.join(', ')}`);

  return { pass, rugScore, reasons, gemini };
}
