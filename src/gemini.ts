import { GoogleGenerativeAI } from '@google/generative-ai';
import { CONFIG } from './config';
import type { GeminiAnalysis, KOLSignal } from './types';

const genAI = new GoogleGenerativeAI(CONFIG.gemini.apiKey);

const analysisModel = genAI.getGenerativeModel({
  model: CONFIG.gemini.model,
  generationConfig: {
    temperature:     0.0,
    maxOutputTokens: 150,
    responseMimeType: 'application/json',
  },
});

const generalModel = genAI.getGenerativeModel({
  model: CONFIG.gemini.model,
  generationConfig: { temperature: 0.1, maxOutputTokens: 200 },
});

// Timeout wrapper — defaults to fallback value if Gemini is too slow
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  const timer = new Promise<T>((_, reject) =>
    setTimeout(() => reject(new Error('Gemini timeout')), ms)
  );
  return Promise.race([promise, timer]).catch(() => fallback);
}

async function ask(model: typeof analysisModel, prompt: string, timeoutMs: number): Promise<string> {
  try {
    const result = await withTimeout(model.generateContent(prompt), timeoutMs, null);
    if (!result) return '{}';
    return result.response.text();
  } catch (e: any) {
    console.error('Gemini error:', e.message);
    return '{}';
  }
}

// ── Token rug/quality analysis ───────────────────────────────────────────────
export async function analyzeToken(token: {
  mint: string;
  symbol: string;
  name: string;
  liquidityUsd: number;
  devWallet: string;
  pumpFun: boolean;
  ageSeconds: number;
  metrics?: { top10Pct: number; devPct: number; txCount: number };
}): Promise<GeminiAnalysis> {
  const SKIP_FALLBACK: GeminiAnalysis = {
    score:          30,
    recommendation: 'SKIP',
    reason:         'Gemini unavailable',
    red_flags:      ['api_timeout'],
    rugRisk:        70,
    confidence:     0.3,
    sentiment:      'bearish',
    reasoning:      'Gemini unavailable',
  };

  const BUY_FALLBACK: GeminiAnalysis = {
    score:          60,
    recommendation: 'BUY',
    reason:         'Gemini unavailable — default pass',
    red_flags:      [],
    rugRisk:        40,
    confidence:     0.5,
    sentiment:      'neutral',
    reasoning:      'Gemini unavailable',
  };

  const m = token.metrics;
  const volLiqRatio = (m && token.liquidityUsd > 0) ? (m.txCount * 0.05 / token.liquidityUsd).toFixed(2) : 'N/A';
  const prompt = `You are a Solana meme coin sniper evaluating a pump.fun launch.
Respond ONLY with valid JSON — no markdown, no extra text.

TOKEN:
  symbol: ${token.symbol}
  age: ${token.ageSeconds}s
  platform: ${token.pumpFun ? 'pump.fun bonding curve' : 'DEX'}
  DEX liquidity: $${token.liquidityUsd} ${token.pumpFun ? '(bonding curve — $0 DEX liquidity is NORMAL)' : ''}
  top-10 holders: ${m ? m.top10Pct.toFixed(1) + '%' : 'unknown'}
  dev wallet %: ${m ? m.devPct.toFixed(1) + '%' : 'unknown'}
  recent tx count: ${m ? m.txCount : 'unknown'}
  vol/liq ratio: ${volLiqRatio}

INSTANT FAIL → riskScore=95: freeze authority set, bundling (3+ wallets each >10%), dev>10%.
GREEN SIGNALS → riskScore<40: dev<3%, top10<20%, active tx flow, pump.fun bonding curve active.

Return exactly this JSON:
{"decision":"BUY" or "SKIP","riskScore":<0-100 lower=safer>,"reasoning":"<20 words>","flags":["flag1"]}`;

  try {
    const raw = await ask(analysisModel, prompt, 2500);
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    // Support both new format {decision,riskScore,reasoning,flags} and legacy
    const rawScore: number = parsed.riskScore ?? (100 - (parsed.score ?? 40));
    const score: number = Math.min(100, Math.max(0, 100 - rawScore)); // convert riskScore → quality score
    const rec: 'BUY' | 'SKIP' = (parsed.decision === 'BUY' || parsed.recommendation === 'BUY') ? 'BUY' : 'SKIP';
    const reason = parsed.reasoning ?? parsed.reason ?? 'No reason';
    return {
      score,
      recommendation: rec,
      reason,
      red_flags:  Array.isArray(parsed.flags) ? parsed.flags : (Array.isArray(parsed.red_flags) ? parsed.red_flags : []),
      rugRisk:    100 - score,
      confidence: score / 100,
      sentiment:  rec === 'BUY' ? 'bullish' : 'bearish',
      reasoning:  reason,
    };
  } catch {
    // If Gemini is down, use BUY fallback so new tokens aren't all blocked
    return BUY_FALLBACK;
  }
}

// ── KOL tweet analysis ───────────────────────────────────────────────────────
export async function analyzeTweet(tweet: {
  handle: string;
  content: string;
}): Promise<{ tokenSymbol: string | null; tokenMint: string | null; sentiment: string; isAlpha: boolean }> {
  const prompt = `You are a Solana meme coin alpha detector. Analyze this KOL tweet.

Handle: @${tweet.handle}
Tweet: "${tweet.content}"

Respond ONLY with valid JSON, no markdown:
{"tokenSymbol":"<ticker or null>","tokenMint":"<mint address or null>","sentiment":"<bullish|neutral|bearish>","isAlpha":<true|false>}`;

  try {
    const raw = await ask(generalModel, prompt, 3000);
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return { tokenSymbol: null, tokenMint: null, sentiment: 'neutral', isAlpha: false };
  }
}

// ── Copy trade validation ─────────────────────────────────────────────────────
export async function validateCopyTrade(trade: {
  walletAddress: string;
  tokenMint: string;
  tokenSymbol: string;
  amountSol: number;
  action: string;
}): Promise<{ shouldCopy: boolean; reasoning: string; confidence: number }> {
  const prompt = `A tracked smart money wallet just traded. Should we copy?

Wallet: ${trade.walletAddress}
Token: ${trade.tokenSymbol} (${trade.tokenMint})
Action: ${trade.action.toUpperCase()}
Amount: ${trade.amountSol} SOL

Respond ONLY with valid JSON, no markdown:
{"shouldCopy":<true|false>,"reasoning":"<1 sentence>","confidence":<0.0-1.0>}`;

  try {
    const raw = await ask(generalModel, prompt, 3000);
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return { shouldCopy: false, reasoning: 'Validation failed', confidence: 0 };
  }
}
