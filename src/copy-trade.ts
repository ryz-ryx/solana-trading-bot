import { getWalletTransactions, getTokenPrice } from './helius';
import { validateCopyTrade } from './gemini';
import { filterToken } from './rug-filter';
import { executePaperBuy, executePaperSell, checkExitConditions } from './paper-trade';
import { insertSignal, upsertToken, getCopyWallets } from './supabase';
import { notifySignal, notifyError } from './discord';
import { CONFIG } from './config';

const WALLET_ID = 2; // Copy trade uses wallet 2

// Track processed signatures to avoid duplicates (in-memory per run)
const processed = new Set<string>();

async function processTrade(walletAddress: string, trade: {
  tokenMint: string; tokenSymbol: string;
  action: 'buy' | 'sell'; amountSol: number;
  signature: string; timestamp: number;
}) {
  if (processed.has(trade.signature)) return;
  processed.add(trade.signature);

  // Skip tiny trades
  if (trade.amountSol < CONFIG.copyTrade.minPositionSol) {
    console.log(`[CopyTrade] Skip small trade: ${trade.amountSol} SOL`);
    return;
  }

  console.log(`[CopyTrade] ${walletAddress.slice(0, 8)}... ${trade.action.toUpperCase()} ${trade.tokenSymbol} ${trade.amountSol} SOL`);

  // Simulate execution delay
  await new Promise(r => setTimeout(r, CONFIG.copyTrade.executionDelayMs));

  const price = await getTokenPrice(trade.tokenMint);
  if (price <= 0) {
    console.log(`[CopyTrade] No price for ${trade.tokenMint}, skipping`);
    return;
  }

  if (trade.action === 'buy') {
    // Run rug filter before copying buys
    const ageSeconds = (Date.now() - trade.timestamp) / 1000;
    const filter = await filterToken({
      mint:      trade.tokenMint,
      symbol:    trade.tokenSymbol,
      name:      trade.tokenSymbol,
      devWallet: walletAddress,
      pumpFun:   false,
      ageSeconds,
    });

    if (!filter.pass) {
      console.log(`[CopyTrade] Rug filter failed: ${filter.reasons.join(', ')}`);
      return;
    }

    // Gemini validation
    const validation = await validateCopyTrade({
      walletAddress,
      tokenMint:   trade.tokenMint,
      tokenSymbol: trade.tokenSymbol,
      amountSol:   trade.amountSol,
      action:      trade.action,
    });

    if (!validation.shouldCopy) {
      console.log(`[CopyTrade] Gemini rejected: ${validation.reasoning}`);
      return;
    }

    await upsertToken({
      mint:     trade.tokenMint,
      symbol:   trade.tokenSymbol,
      name:     trade.tokenSymbol,
      pumpFun:  false,
      rugScore: filter.rugScore,
    });

    const signalId = await insertSignal({
      strategy:       'copy_trade',
      tokenMint:      trade.tokenMint,
      signalType:     'buy',
      confidence:     validation.confidence,
      source:         walletAddress,
      rugScore:       filter.rugScore,
      geminiAnalysis: filter.gemini ?? undefined,
    });

    await notifySignal({
      strategy:       'copy_trade',
      tokenMint:      trade.tokenMint,
      signalType:     'buy',
      confidence:     validation.confidence,
      source:         `Copying ${walletAddress.slice(0, 8)}...`,
      rugScore:       filter.rugScore,
    }, trade.tokenSymbol);

    await executePaperBuy({
      walletId:        WALLET_ID,
      strategy:        'copy_trade',
      tokenMint:       trade.tokenMint,
      tokenSymbol:     trade.tokenSymbol,
      currentPriceSol: price,
      signalId:        signalId ?? undefined,
      confidence:      validation.confidence,
    });

  } else {
    // Mirror sells
    await executePaperSell({
      walletId:        WALLET_ID,
      strategy:        'copy_trade',
      tokenMint:       trade.tokenMint,
      tokenSymbol:     trade.tokenSymbol,
      currentPriceSol: price,
      reason:          `copying_${walletAddress.slice(0, 8)}`,
    });
  }
}

async function main() {
  console.log(`[CopyTrade] Starting at ${new Date().toISOString()}`);

  // Get target wallets from DB + config
  const dbWallets  = await getCopyWallets();
  const cfgWallets = CONFIG.copyTrade.targetWallets;
  const wallets    = [...new Set([...dbWallets, ...cfgWallets])];

  if (wallets.length === 0) {
    console.log('[CopyTrade] No target wallets configured. Add wallets to copy_wallets table.');
    return;
  }

  console.log(`[CopyTrade] Monitoring ${wallets.length} wallets`);

  for (const wallet of wallets) {
    const trades = await getWalletTransactions(wallet, 10);
    // Only process trades from last 6 minutes (cron runs every 5 min)
    const recent = trades.filter(t => Date.now() - t.timestamp < 360_000);
    for (const trade of recent) {
      await processTrade(wallet, trade);
    }
  }

  // Check exits for existing positions
  await checkExitConditions(WALLET_ID, 'copy_trade', getTokenPrice);

  console.log('[CopyTrade] Done');
}

main().catch(async (err) => {
  console.error('[CopyTrade] Fatal error:', err);
  await notifyError('CopyTrade', err.message);
  process.exit(1);
});
