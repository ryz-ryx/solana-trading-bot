import { getTokenLiquidity } from './helius';
import { analyzeToken } from './gemini';
import { CONFIG } from './config';
import type { Token, GeminiAnalysis } from './types';

export interface FilterResult {
  pass: boolean;
  rugScore: number;
  reasons: string[];
  gemini: GeminiAnalysis | null;
}

// Hard rules checked before calling Gemini (saves API quota)
function hardFilter(token: {
  mint: string;
  symbol: string;
  name: string;
  liquidityUsd: number;
  ageSeconds: number;
}): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (token.liquidityUsd < CONFIG.sniper.minLiquidityUsd) {
    reasons.push(`Liquidity too low: $${token.liquidityUsd}`);
  }
  if (token.ageSeconds > CONFIG.sniper.maxTokenAgeSecs) {
    reasons.push(`Token too old: ${token.ageSeconds}s`);
  }

  // Obvious rug name patterns
  const rugPatterns = /(?:elon|trump|doge|shib|safe|moon|inu|cum|scam|test|rugme)/i;
  if (rugPatterns.test(token.name) && token.liquidityUsd < 10000) {
    reasons.push(`Suspicious name pattern: ${token.name}`);
  }

  // Mint address sanity check
  if (token.mint.length < 32 || token.mint.length > 44) {
    reasons.push('Invalid mint address length');
  }

  return { pass: reasons.length === 0, reasons };
}

function calculateRugScore(liquidity: number, ageSeconds: number, geminiRisk: number): number {
  let score = 0;

  // Liquidity score (0-40 points)
  if (liquidity < 1000)  score += 40;
  else if (liquidity < 5000)  score += 30;
  else if (liquidity < 10000) score += 20;
  else if (liquidity < 50000) score += 10;

  // Age score (0-20 points)
  if (ageSeconds < 10)  score += 20;
  else if (ageSeconds < 30)  score += 15;
  else if (ageSeconds < 60)  score += 10;
  else if (ageSeconds < 120) score += 5;

  // Gemini AI risk (0-40 points, scaled)
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

  // 2. Hard filter first (no AI cost)
  const hard = hardFilter({ ...token, liquidityUsd });
  if (!hard.pass) {
    return {
      pass: false,
      rugScore: 100,
      reasons: hard.reasons,
      gemini: null,
    };
  }

  // 3. Gemini AI analysis
  const gemini = await analyzeToken({ ...token, liquidityUsd });

  // 4. Final rug score
  const rugScore = calculateRugScore(liquidityUsd, token.ageSeconds, gemini.rugRisk);

  const pass = rugScore <= CONFIG.sniper.maxRugScore
    && gemini.recommendation === 'BUY'
    && gemini.score >= 80;

  const reasons: string[] = [];
  if (rugScore > CONFIG.sniper.maxRugScore) reasons.push(`Rug score too high: ${rugScore}`);
  if (gemini.recommendation !== 'BUY') reasons.push(`Gemini says: SKIP | flags: ${gemini.red_flags.join(', ')}`);
  

  return { pass, rugScore, reasons, gemini };
}
