import axios from 'axios';
import { CONFIG } from './config';
import type { Token, WalletTrade } from './types';

const BASE = 'https://api.helius.xyz/v0';
const key  = CONFIG.helius.apiKey;

// ── Token metadata ───────────────────────────────────────────────────────────
export async function getTokenMetadata(mints: string[]): Promise<Partial<Token>[]> {
  try {
    const { data } = await axios.post(
      `${BASE}/token-metadata?api-key=${key}`,
      { mintAccounts: mints, includeOffChain: true, disableCache: false }
    );
    return data.map((t: any) => ({
      mint:    t.account,
      symbol:  t.onChainMetadata?.metadata?.data?.symbol ?? 'UNKNOWN',
      name:    t.onChainMetadata?.metadata?.data?.name   ?? 'Unknown',
      decimals: t.onChainAccountInfo?.accountInfo?.data?.parsed?.info?.decimals ?? 9,
    }));
  } catch (e: any) {
    console.error('getTokenMetadata error:', e.message);
    return [];
  }
}

// ── Enhanced transaction history for a wallet ────────────────────────────────
export async function getWalletTransactions(address: string, limit = 20): Promise<WalletTrade[]> {
  try {
    const { data } = await axios.get(
      `${BASE}/addresses/${address}/transactions?api-key=${key}&limit=${limit}&type=SWAP`
    );
    const trades: WalletTrade[] = [];
    for (const tx of data ?? []) {
      const swap = tx.events?.swap;
      if (!swap) continue;
      const isBuy = swap.nativeInput && swap.tokenOutputs?.length;
      const isSell = swap.tokenInputs?.length && swap.nativeOutput;
      if (!isBuy && !isSell) continue;
      const tokenInfo = isBuy ? swap.tokenOutputs?.[0] : swap.tokenInputs?.[0];
      if (!tokenInfo) continue;
      trades.push({
        wallet:      address,
        tokenMint:   tokenInfo.mint,
        tokenSymbol: tokenInfo.symbol ?? 'UNKNOWN',
        action:      isBuy ? 'buy' : 'sell',
        amountSol:   isBuy
          ? (swap.nativeInput?.amount ?? 0) / 1e9
          : (swap.nativeOutput?.amount ?? 0) / 1e9,
        signature:   tx.signature,
        timestamp:   tx.timestamp * 1000,
      });
    }
    return trades;
  } catch (e: any) {
    console.error('getWalletTransactions error:', e.message);
    return [];
  }
}

// ── Token price via DAS ──────────────────────────────────────────────────────
export async function getTokenPrice(mint: string): Promise<number> {
  try {
    const { data } = await axios.post(
      `https://mainnet.helius-rpc.com/?api-key=${key}`,
      {
        jsonrpc: '2.0', id: 1,
        method: 'getAsset',
        params: { id: mint },
      }
    );
    return data?.result?.token_info?.price_info?.price_per_token ?? 0;
  } catch {
    return 0;
  }
}

// ── New pump.fun token detection (poll-based for GitHub Actions) ──────────────
export async function getRecentPumpFunTokens(since: number): Promise<Array<{
  mint: string; name: string; symbol: string; devWallet: string; timestamp: number;
}>> {
  try {
    const { data } = await axios.get(
      `${BASE}/addresses/${CONFIG.sniper.pumpFunProgram}/transactions` +
      `?api-key=${key}&limit=50&type=COMPRESSED_NFT_MINT`
    );
    const results: any[] = [];
    for (const tx of data ?? []) {
      if (tx.timestamp * 1000 < since) continue;
      const mint = tx.tokenTransfers?.[0]?.mint;
      if (!mint) continue;
      results.push({
        mint,
        name:      tx.description ?? 'Unknown',
        symbol:    'NEW',
        devWallet: tx.feePayer,
        timestamp: tx.timestamp * 1000,
      });
    }
    return results;
  } catch (e: any) {
    console.error('getRecentPumpFunTokens error:', e.message);
    return [];
  }
}

// ── Liquidity check via pool accounts ───────────────────────────────────────
export async function getTokenLiquidity(mint: string): Promise<number> {
  try {
    const { data } = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`
    );
    const pairs = data?.pairs ?? [];
    if (!pairs.length) return 0;
    return Math.max(...pairs.map((p: any) => p.liquidity?.usd ?? 0));
  } catch {
    return 0;
  }
}

// ── SOL price ────────────────────────────────────────────────────────────────
export async function getSolPrice(): Promise<number> {
  try {
    const { data } = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'
    );
    return data?.solana?.usd ?? 0;
  } catch {
    return 150; // fallback
  }
}
