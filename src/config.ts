import * as dotenv from 'dotenv';
dotenv.config();

function require_env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing env var: ${key}`);
  return val;
}

export const CONFIG = {
  helius: {
    apiKey: require_env('HELIUS_API_KEY'),
    rpcUrl: () => `https://mainnet.helius-rpc.com/?api-key=${require_env('HELIUS_API_KEY')}`,
    wsUrl:  () => `wss://mainnet.helius-rpc.com/?api-key=${require_env('HELIUS_API_KEY')}`,
  },
  supabase: {
    url:        require_env('SUPABASE_URL'),
    serviceKey: require_env('SUPABASE_SERVICE_KEY'),
  },
  discord: {
    webhookUrl: require_env('DISCORD_WEBHOOK_URL'),
  },
  gemini: {
    apiKey: require_env('GEMINI_API_KEY'),
    model:  'gemini-1.5-flash',
  },
  wallets: {
    // Wallet roles: 1=sniper, 2=copy-trade, 3=kol, 4=reserve
    privateKeys: [
      require_env('WALLET1'),
      require_env('WALLET2'),
      require_env('WALLET3'),
      require_env('WALLET4'),
    ],
  },
  trading: {
    // Paper trading capital per wallet (SOL) — simulated
    startingCapitalSol: 10,
    // Max position size as % of wallet
    maxPositionPct: 0.03,      // 3% per trade
    // Stop loss %
    stopLossPct: 0.20,         // -20%
    // Take profit levels
    takeProfitLevels: [2.0, 5.0, 10.0], // 2x, 5x, 10x
    // Sell % at each take profit
    takeProfitSellPct: [0.33, 0.33, 0.34],
    // Max daily loss before pausing
    maxDailyLossPct: 0.10,     // -10% of wallet
    // Slippage model for meme coins
    slippageMin: 0.05,
    slippageMax: 0.15,
  },
  sniper: {
    // pump.fun program ID
    pumpFunProgram: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    // Max rug score to consider buying
    maxRugScore: 40,
    // Min initial liquidity USD
    minLiquidityUsd: 5000,
    // Max token age in seconds to still snipe
    maxTokenAgeSecs: 120,
  },
  copyTrade: {
    // Target wallets to copy — add addresses here after research
    targetWallets: (process.env.COPY_WALLETS || '').split(',').filter(Boolean),
    // Delay after detecting trade (ms) — simulates realistic execution
    executionDelayMs: 2000,
    // Only copy if position size > X SOL
    minPositionSol: 0.1,
  },
  kol: {
    // Twitter handles to track — no @ prefix
    handles: (process.env.KOL_HANDLES || '').split(',').filter(Boolean),
    // Nitter instances for scraping (no API needed)
    nitterInstances: [
      'https://nitter.privacydev.net',
      'https://nitter.poast.org',
    ],
  },
} as const;
