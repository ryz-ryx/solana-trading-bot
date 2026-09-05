import { CONFIG } from './config';
import { insertTrade, upsertPortfolio, getOpenPositions, getDailyPnl } from './supabase';
import { notifyTrade } from './discord';
import type { PaperTrade, PortfolioPosition, Strategy } from './types';

// Simulate realistic slippage for meme coins
function simulateSlippage(): number {
  const { slippageMin, slippageMax } = CONFIG.trading;
  return slippageMin + Math.random() * (slippageMax - slippageMin);
}

// Apply slippage to price
function applySlippage(price: number, action: 'buy' | 'sell'): number {
  const slippage = simulateSlippage();
  // Buy: you pay more; Sell: you receive less
  return action === 'buy' ? price * (1 + slippage) : price * (1 - slippage);
}

export async function executePaperBuy(params: {
  walletId: number;
  strategy: Strategy;
  tokenMint: string;
  tokenSymbol: string;
  currentPriceSol: number;
  signalId?: string;
  confidence: number;
}): Promise<{ success: boolean; trade?: PaperTrade; reason?: string }> {
  const { walletId, strategy, tokenMint, tokenSymbol, currentPriceSol, signalId, confidence } = params;

  // Check daily loss limit
  const today = new Date().toISOString().split('T')[0];
  const dailyPnl = await getDailyPnl(walletId, today);
  const maxDailyLoss = CONFIG.trading.startingCapitalSol * CONFIG.trading.maxDailyLossPct * -1;
  if (dailyPnl < maxDailyLoss) {
    return { success: false, reason: `Daily loss limit hit: ${dailyPnl.toFixed(4)} SOL` };
  }

  // Check not already holding this token
  const positions = await getOpenPositions(walletId);
  if (positions.some(p => p.tokenMint === tokenMint)) {
    return { success: false, reason: 'Already holding this token' };
  }

  // Position sizing: scale with confidence, max 3% of capital
  const positionPct = CONFIG.trading.maxPositionPct * confidence;
  const amountSol = CONFIG.trading.startingCapitalSol * positionPct;

  // Apply slippage
  const slippagePct = simulateSlippage();
  const executedPriceSol = currentPriceSol * (1 + slippagePct);
  const tokenAmount = amountSol / executedPriceSol;

  const trade: PaperTrade = {
    walletId,
    strategy,
    tokenMint,
    tokenSymbol,
    action: 'buy',
    amountSol,
    tokenAmount,
    priceSol: executedPriceSol,
    slippagePct,
    signalId,
  };

  // Persist trade
  await insertTrade(trade);

  // Update portfolio
  await upsertPortfolio({
    walletId,
    tokenMint,
    tokenSymbol,
    amount: tokenAmount,
    avgEntrySol: executedPriceSol,
  });

  // Discord notification
  await notifyTrade(trade);

  console.log(`[W${walletId}] BUY ${tokenSymbol}: ${amountSol.toFixed(4)} SOL @ ${executedPriceSol.toFixed(8)}`);
  return { success: true, trade };
}

export async function executePaperSell(params: {
  walletId: number;
  strategy: Strategy;
  tokenMint: string;
  tokenSymbol: string;
  currentPriceSol: number;
  sellPct?: number; // default 1.0 = 100%
  signalId?: string;
  reason?: string;
}): Promise<{ success: boolean; trade?: PaperTrade; reason?: string }> {
  const { walletId, strategy, tokenMint, tokenSymbol, currentPriceSol, sellPct = 1.0, signalId } = params;

  const positions = await getOpenPositions(walletId);
  const position = positions.find(p => p.tokenMint === tokenMint);
  if (!position || position.amount <= 0) {
    return { success: false, reason: 'No position found' };
  }

  const sellAmount = position.amount * sellPct;
  const slippagePct = simulateSlippage();
  const executedPriceSol = currentPriceSol * (1 - slippagePct);
  const receivedSol = sellAmount * executedPriceSol;
  const costBasis = sellAmount * position.avgEntrySol;
  const pnlSol = receivedSol - costBasis;
  const pnlPct = (pnlSol / costBasis) * 100;

  const trade: PaperTrade = {
    walletId,
    strategy,
    tokenMint,
    tokenSymbol,
    action: 'sell',
    amountSol: receivedSol,
    tokenAmount: sellAmount,
    priceSol: executedPriceSol,
    slippagePct,
    signalId,
    pnlSol,
    pnlPct,
  };

  await insertTrade(trade);

  // Update portfolio
  const remaining = position.amount - sellAmount;
  await upsertPortfolio({
    walletId,
    tokenMint,
    tokenSymbol,
    amount: remaining,
    avgEntrySol: position.avgEntrySol,
  });

  await notifyTrade(trade);

  console.log(`[W${walletId}] SELL ${tokenSymbol}: ${receivedSol.toFixed(4)} SOL | PnL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct.toFixed(1)}%)`);
  return { success: true, trade };
}

// Check stop loss / take profit for all open positions
export async function checkExitConditions(
  walletId: number,
  strategy: Strategy,
  getCurrentPrice: (mint: string) => Promise<number>
): Promise<void> {
  const positions = await getOpenPositions(walletId);

  for (const pos of positions) {
    if (pos.amount <= 0) continue;
    const currentPrice = await getCurrentPrice(pos.tokenMint);
    if (currentPrice <= 0) continue;

    const pnlPct = ((currentPrice - pos.avgEntrySol) / pos.avgEntrySol) * 100;

    // Stop loss
    if (pnlPct <= -CONFIG.trading.stopLossPct * 100) {
      console.log(`[W${walletId}] STOP LOSS ${pos.tokenSymbol}: ${pnlPct.toFixed(1)}%`);
      await executePaperSell({
        walletId, strategy,
        tokenMint: pos.tokenMint,
        tokenSymbol: pos.tokenSymbol,
        currentPriceSol: currentPrice,
        reason: 'stop_loss',
      });
      continue;
    }

    // Take profit levels
    const { takeProfitLevels, takeProfitSellPct } = CONFIG.trading;
    for (let i = takeProfitLevels.length - 1; i >= 0; i--) {
      const targetMultiple = takeProfitLevels[i];
      if (currentPrice >= pos.avgEntrySol * targetMultiple) {
        console.log(`[W${walletId}] TAKE PROFIT ${pos.tokenSymbol} at ${targetMultiple}x`);
        await executePaperSell({
          walletId, strategy,
          tokenMint: pos.tokenMint,
          tokenSymbol: pos.tokenSymbol,
          currentPriceSol: currentPrice,
          sellPct: takeProfitSellPct[i],
          reason: `take_profit_${targetMultiple}x`,
        });
        break;
      }
    }
  }
}
