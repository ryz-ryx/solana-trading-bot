import axios from 'axios';
import { CONFIG } from './config';
import type { PaperTrade, Signal } from './types';

const COLORS = {
  buy:     0x00ff88,
  sell:    0xff4444,
  profit:  0x00ff88,
  loss:    0xff4444,
  info:    0x5865f2,
  warning: 0xffa500,
};

async function send(payload: object) {
  try {
    await axios.post(CONFIG.discord.webhookUrl, payload);
  } catch (e: any) {
    console.error('Discord send error:', e.message);
  }
}

export async function notifySignal(signal: Signal, tokenName: string) {
  await send({
    embeds: [{
      title: `🎯 ${signal.strategy.toUpperCase()} SIGNAL — ${tokenName}`,
      color: signal.signalType === 'buy' ? COLORS.buy : COLORS.sell,
      fields: [
        { name: 'Action',     value: signal.signalType.toUpperCase(), inline: true },
        { name: 'Confidence', value: `${(signal.confidence * 100).toFixed(0)}%`, inline: true },
        { name: 'Rug Score',  value: `${signal.rugScore}/100`, inline: true },
        { name: 'Source',     value: signal.source, inline: false },
        { name: 'Mint',       value: `\`${signal.tokenMint}\``, inline: false },
        ...(signal.geminiAnalysis ? [{
          name: '🤖 Gemini',
          value: signal.geminiAnalysis.reasoning.slice(0, 200),
          inline: false,
        }] : []),
      ],
      footer: { text: `Paper Trading • ${new Date().toUTCString()}` },
    }],
  });
}

export async function notifyTrade(trade: PaperTrade) {
  const isBuy = trade.action === 'buy';
  const pnlStr = trade.pnlSol !== undefined
    ? `${trade.pnlSol >= 0 ? '+' : ''}${trade.pnlSol.toFixed(4)} SOL (${trade.pnlPct?.toFixed(1)}%)`
    : '';

  await send({
    embeds: [{
      title: `${isBuy ? '🟢 BUY' : '🔴 SELL'} — ${trade.tokenSymbol} [W${trade.walletId}]`,
      color: isBuy ? COLORS.buy : (trade.pnlSol ?? 0) >= 0 ? COLORS.profit : COLORS.loss,
      fields: [
        { name: 'Strategy',  value: trade.strategy,                          inline: true },
        { name: 'Amount',    value: `${trade.amountSol.toFixed(4)} SOL`,     inline: true },
        { name: 'Price',     value: `${trade.priceSol.toFixed(8)} SOL`,      inline: true },
        { name: 'Slippage',  value: `${(trade.slippagePct * 100).toFixed(1)}%`, inline: true },
        ...(pnlStr ? [{ name: 'PnL', value: pnlStr, inline: true }] : []),
        { name: 'Mint',      value: `\`${trade.tokenMint}\``,                inline: false },
      ],
      footer: { text: `Paper Trading • ${new Date().toUTCString()}` },
    }],
  });
}

export async function notifyDailyReport(stats: {
  date: string;
  totalTrades: number;
  winRate: number;
  totalPnlSol: number;
  bestTrade: number;
  worstTrade: number;
  portfolioValueSol: number;
}) {
  const profitable = stats.totalPnlSol >= 0;
  await send({
    embeds: [{
      title: `📊 Daily Report — ${stats.date}`,
      color: profitable ? COLORS.profit : COLORS.loss,
      fields: [
        { name: 'Total PnL',   value: `${stats.totalPnlSol >= 0 ? '+' : ''}${stats.totalPnlSol.toFixed(4)} SOL`, inline: true },
        { name: 'Win Rate',    value: `${(stats.winRate * 100).toFixed(1)}%`,    inline: true },
        { name: 'Trades',      value: `${stats.totalTrades}`,                    inline: true },
        { name: 'Best Trade',  value: `+${stats.bestTrade.toFixed(4)} SOL`,      inline: true },
        { name: 'Worst Trade', value: `${stats.worstTrade.toFixed(4)} SOL`,      inline: true },
        { name: 'Portfolio',   value: `${stats.portfolioValueSol.toFixed(4)} SOL`, inline: true },
      ],
      footer: { text: 'Paper Trading Bot' },
    }],
  });
}

export async function notifyError(context: string, error: string) {
  await send({
    embeds: [{
      title: `⚠️ Error — ${context}`,
      color: COLORS.warning,
      description: `\`\`\`${error.slice(0, 1000)}\`\`\``,
      footer: { text: new Date().toUTCString() },
    }],
  });
}
