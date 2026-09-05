export type Strategy = 'sniper' | 'copy_trade' | 'kol';
export type Action = 'buy' | 'sell';

export interface Token {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  pumpFun: boolean;
  liquidityUsd: number;
  marketCapUsd: number;
  devWallet: string;
  rugScore: number; // 0-100, higher = riskier
  createdAt: string;
}

export interface Signal {
  id?: string;
  strategy: Strategy;
  tokenMint: string;
  signalType: Action;
  confidence: number; // 0-1
  source: string;
  rugScore: number;
  geminiAnalysis?: GeminiAnalysis;
}

export interface PaperTrade {
  walletId: number;
  strategy: Strategy;
  tokenMint: string;
  tokenSymbol: string;
  action: Action;
  amountSol: number;
  tokenAmount?: number;
  priceSol: number;
  priceUsd?: number;
  slippagePct: number;
  signalId?: string;
  pnlSol?: number;
  pnlPct?: number;
}

export interface PortfolioPosition {
  walletId: number;
  tokenMint: string;
  tokenSymbol: string;
  amount: number;
  avgEntrySol: number;
  updatedAt?: string;
}

export interface GeminiAnalysis {
  rugRisk: number;       // 0-100
  sentiment: string;     // 'bullish' | 'bearish' | 'neutral'
  reasoning: string;
  recommendation: 'buy' | 'skip' | 'sell';
  confidence: number;    // 0-1
}

export interface PumpFunEvent {
  mint: string;
  name: string;
  symbol: string;
  devWallet: string;
  initialBuyAmount: number;
  timestamp: number;
}

export interface WalletTrade {
  wallet: string;
  tokenMint: string;
  tokenSymbol: string;
  action: Action;
  amountSol: number;
  signature: string;
  timestamp: number;
}

export interface KOLSignal {
  handle: string;
  platform: string;
  content: string;
  tokenMint?: string;
  tokenSymbol?: string;
  timestamp: number;
}

export interface BacktestResult {
  strategy: Strategy;
  totalTrades: number;
  winRate: number;
  totalPnlSol: number;
  avgPnlPerTrade: number;
  maxDrawdown: number;
  sharpeRatio: number;
  profitFactor: number;
}

export interface MonteCarloResult {
  runs: number;
  profitableRuns: number;
  profitRate: number; // target: 0.90+
  medianFinalPnl: number;
  p5FinalPnl: number;  // worst 5%
  p95FinalPnl: number; // best 5%
}
