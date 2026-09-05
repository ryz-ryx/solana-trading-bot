import { GoogleGenerativeAI } from '@google/generative-ai';
import { CONFIG } from './config';
import type { GeminiAnalysis, KOLSignal } from './types';

const genAI = new GoogleGenerativeAI(CONFIG.gemini.apiKey);
const model  = genAI.getGenerativeModel({ model: CONFIG.gemini.model });

async function ask(prompt: string): Promise<string> {
  try {
    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (e: any) {
    console.error('Gemini error:', e.message);
    return '{}';
  }
}

// ── Rug pull risk analysis ───────────────────────────────────────────────────
export async function analyzeToken(token: {
  mint: string;
  symbol: string;
  name: string;
  liquidityUsd: number;
  devWallet: string;
  pumpFun: boolean;
  ageSeconds: number;
}): Promise<GeminiAnalysis> {
  const prompt = `
You are a Solana meme coin trading risk analyst. Analyze this new token for rug pull risk and trading potential.

Token Data:
- Mint: ${token.mint}
- Symbol: ${token.symbol}
- Name: ${token.name}
- Liquidity (USD): $${token.liquidityUsd}
- Dev Wallet: ${token.devWallet}
- On pump.fun: ${token.pumpFun}
- Age: ${token.ageSeconds} seconds old

Risk factors to consider:
1. Low liquidity (<$5000 = very risky)
2. Token age (newer = riskier for rug)
3. Name/symbol patterns (excessive hype words = risky)
4. pump.fun tokens graduate at ~$69k market cap

Respond ONLY with valid JSON, no markdown:
{
  "rugRisk": <0-100, higher=more risky>,
  "sentiment": "<bullish|neutral|bearish>",
  "reasoning": "<2 sentence max>",
  "recommendation": "<buy|skip|sell>",
  "confidence": <0.0-1.0>
}`;

  try {
    const raw = await ask(prompt);
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      rugRisk:        Math.min(100, Math.max(0, parsed.rugRisk ?? 50)),
      sentiment:      parsed.sentiment ?? 'neutral',
      reasoning:      parsed.reasoning ?? 'No analysis available',
      recommendation: parsed.recommendation ?? 'skip',
      confidence:     Math.min(1, Math.max(0, parsed.confidence ?? 0.5)),
    };
  } catch {
    return { rugRisk: 80, sentiment: 'neutral', reasoning: 'Analysis failed', recommendation: 'skip', confidence: 0 };
  }
}

// ── KOL tweet analysis ───────────────────────────────────────────────────────
export async function analyzeTweet(tweet: {
  handle: string;
  content: string;
}): Promise<{ tokenSymbol: string | null; tokenMint: string | null; sentiment: string; isAlpha: boolean }> {
  const prompt = `
You are a Solana meme coin alpha detector. Analyze this tweet from a crypto KOL.

Handle: @${tweet.handle}
Tweet: "${tweet.content}"

Determine if this tweet contains actionable Solana meme coin alpha.

Respond ONLY with valid JSON, no markdown:
{
  "tokenSymbol": "<ticker symbol if mentioned, or null>",
  "tokenMint": "<Solana mint address if mentioned, or null>",
  "sentiment": "<bullish|neutral|bearish>",
  "isAlpha": <true if this is a clear token call/shill, false otherwise>
}`;

  try {
    const raw = await ask(prompt);
    const cleaned = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { tokenSymbol: null, tokenMint: null, sentiment: 'neutral', isAlpha: false };
  }
}

// ── Copy trade validation ────────────────────────────────────────────────────
export async function validateCopyTrade(trade: {
  walletAddress: string;
  tokenMint: string;
  tokenSymbol: string;
  amountSol: number;
  action: string;
}): Promise<{ shouldCopy: boolean; reasoning: string; confidence: number }> {
  const prompt = `
A tracked smart money wallet just made a trade. Should we copy it?

Wallet: ${trade.walletAddress}
Token: ${trade.tokenSymbol} (${trade.tokenMint})
Action: ${trade.action.toUpperCase()}
Amount: ${trade.amountSol} SOL

Consider:
- Is this a reasonable position size?
- meme coin trades carry high risk
- We copy with a 2 second delay (price may have moved)

Respond ONLY with valid JSON, no markdown:
{
  "shouldCopy": <true|false>,
  "reasoning": "<1 sentence>",
  "confidence": <0.0-1.0>
}`;

  try {
    const raw = await ask(prompt);
    const cleaned = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { shouldCopy: false, reasoning: 'Validation failed', confidence: 0 };
  }
}
