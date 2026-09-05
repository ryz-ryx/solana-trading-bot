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

  const prompt = `You are a Solana meme coin risk evaluator. Respond ONLY in JSON with no extra text.

Token:
- Mint: ${token.mint}
- Symbol: ${token.symbol}
- Name: ${token.name}
- Liquidity USD: $${token.liquidityUsd}
- Dev Wallet: ${token.devWallet}
- pump.fun: ${token.pumpFun}
- Age: ${token.ageSeconds}s

INSTANT FAIL (score=0): mint authority enabled, freeze authority enabled, liquidity<$5000, suspicious bundling.
PASS (score>=80): locked liquidity, dev holding<5%, top10 holders<20%, active social narrative.

Return exactly:
{"score":<0-100>,"recommendation":"BUY" or "SKIP","reason":"<15 words max>","red_flags":["flag1","flag2"]}`;

  try {
    const raw = await ask(analysisModel, prompt, 2500);
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    const score: number = Math.min(100, Math.max(0, parsed.score ?? 40));
    const rec: 'BUY' | 'SKIP' = parsed.recommendation === 'BUY' ? 'BUY' : 'SKIP';
    return {
      score,
      recommendation: rec,
      reason:     parsed.reason   ?? 'No reason',
      red_flags:  Array.isArray(parsed.red_flags) ? parsed.red_flags : [],
      rugRisk:    100 - score,
      confidence: score / 100,
      sentiment:  rec === 'BUY' ? 'bullish' : 'bearish',
      reasoning:  parsed.reason ?? 'No reason',
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
