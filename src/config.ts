import * as dotenv from 'dotenv';
dotenv.config();

function require_env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing env var: ${key}`);
  return val;
}

function optional_env(key: string, fallback = ''): string {
  return process.env[key] ?? fallback;
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
    model:  'gemini-2.0-flash-exp',
  },
  wallets: {
    // Each workflow only passes the wallet it needs — no hard require at load time
    get: (n: 1 | 2 | 3 | 4): string => require_env(`WALLET${n}`),
  },
  trading: {
    startingCapitalSol:  10,
    maxPositionPct:      0.03,
    stopLossPct:         0.20,
    takeProfitLevels:    [2.0, 5.0, 10.0],
    takeProfitSellPct:   [0.33, 0.33, 0.34],
    maxDailyLossPct:     0.10,
    slippageMin:         0.05,
    slippageMax:         0.15,
  },
  sniper: {
    pumpFunProgram: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    maxRugScore:    40,
    minLiquidityUsd: 0,
    maxTokenAgeSecs: 120,
  },
  copyTrade: {
    targetWallets:    optional_env('COPY_WALLETS').split(',').filter(Boolean),
    executionDelayMs: 2000,
    minPositionSol:   0.1,
  },
  kol: {
    handles: optional_env('KOL_HANDLES').split(',').filter(Boolean),
    nitterInstances: [
      'https://nitter.privacydev.net',
      'https://nitter.poast.org',
    ],
  },
} as const;
