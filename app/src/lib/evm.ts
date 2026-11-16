//EVM wallets in the browser (MetaMask, Binance Wallet, Trust, ...): found through EIP-6963 announcements, with the
//old window.ethereum as fallback. The wallet only signs; the page reads the chain through its own RPC.
import { createPublicClient, createWalletClient, custom, defineChain, getAddress, http, isAddress, type Address, type Chain, type EIP1193Provider, type PublicClient, type WalletClient } from 'viem';
import type { ChainInfo, SiteConfig } from './config';
import { T } from './i18n';

export interface WalletOption {
  id: string;
  name: string;
  icon?: string;
  provider: EIP1193Provider;
}

const found = new Map<string, WalletOption>();

export function discoverWallets(onChange: (list: WalletOption[]) => void): () => void {
  const announce = (e: Event) => {
    const d = (e as CustomEvent).detail as { info: { uuid: string; name: string; icon: string; rdns: string }; provider: EIP1193Provider };
    found.set(d.info.rdns || d.info.uuid, { id: d.info.rdns || d.info.uuid, name: d.info.name, icon: d.info.icon, provider: d.provider });
    onChange([...found.values()]);
  };
  window.addEventListener('eip6963:announceProvider', announce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  const legacy = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (legacy && found.size === 0) {
    found.set('injected', { id: 'injected', name: T().t.conBrowserWallet, provider: legacy });
  }
  onChange([...found.values()]);
  return () => window.removeEventListener('eip6963:announceProvider', announce);
}

//gas coin per chain id, with the symbol wallets expect for that chain: MetaMask checks it against its chain list
//and, on a mismatch ("BNB" for BSC testnet), shows no balance and then refuses transactions as "insufficient funds"
const gasCoin: Record<string, string> = { '1': 'ETH', '56': 'BNB', '97': 'tBNB', '137': 'POL', '80002': 'POL', '11155111': 'SepoliaETH' };

//chain names as wallets list them (a different name gives a warning when the site adds the chain)
const walletChainName: Record<string, string> = { '56': 'BNB Smart Chain', '97': 'BNB Smart Chain Testnet', '137': 'Polygon Mainnet', '80002': 'Polygon Amoy', '11155111': 'Sepolia' };

export const gasCoinOf = (id: string) => gasCoin[id] ?? 'ETH';

export function chainOf(id: string, c: ChainInfo, rpc: string): Chain {
  const coin = gasCoinOf(id);
  return defineChain({ id: Number(id), name: c.name, nativeCurrency: { name: coin, symbol: coin, decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
}

export function readClient(site: SiteConfig, id: string, c: ChainInfo): PublicClient {
  const rpc = site.evmRpc[id];
  if (!rpc) {
    throw new Error(`no RPC set for chain ${id}`);
  }
  return createPublicClient({ chain: chainOf(id, c, rpc), transport: http(rpc) }) as PublicClient;
}

//wallet null = receive only: an address the user typed in, for selling Nexus coins without any EVM wallet here. It
//signs nothing; the relay's watcher collects the USDT/USDC for it (Desk, Relay.claim)
export interface EvmSession {
  wallet: WalletOption | null;
  address: Address;
  chainId: number;
}

export function receiveOnly(address: string, chainId: number): EvmSession {
  if (!isAddress(address, { strict: false })) {
    throw new Error(T().t.conNotEvmAddress);
  }
  return { wallet: null, address: getAddress(address), chainId };
}

export async function connect(w: WalletOption): Promise<EvmSession> {
  const [address] = (await w.provider.request({ method: 'eth_requestAccounts' })) as Address[];
  if (!address) {
    throw new Error(T().t.conNoAddress);
  }
  const chainId = Number(await w.provider.request({ method: 'eth_chainId' }));
  return { wallet: w, address, chainId };
}

//after a reload: the wallet picked last time, if the site is still connected to it (eth_accounts never prompts)
//per network: a receiving address typed on testnet must never come back on mainnet
let lastWalletKey = 'nexus-dex:wallet:mainnet';
export function setWalletScope(net: string) {
  lastWalletKey = `nexus-dex:wallet:${net}`;
}
const receivePrefix = 'receive:';

export function rememberWallet(w: WalletOption | EvmSession | null) {
  try {
    if (w && 'provider' in w) {
      localStorage.setItem(lastWalletKey, w.id);
    } else if (w) {
      localStorage.setItem(lastWalletKey, receivePrefix + w.address);
    } else {
      localStorage.removeItem(lastWalletKey);
    }
  } catch {
    //storage blocked: the user connects by hand after a reload
  }
}

//firstChain: the chain a receive-only address starts on (it has no chain of its own)
export async function reconnect(list: WalletOption[], firstChain: number): Promise<EvmSession | null> {
  let id: string | null = null;
  try {
    id = localStorage.getItem(lastWalletKey);
  } catch {
    return null;
  }
  if (id?.startsWith(receivePrefix)) {
    try {
      return receiveOnly(id.slice(receivePrefix.length), firstChain);
    } catch {
      return null;
    }
  }
  const w = list.find((x) => x.id === id);
  if (!w) {
    return null;
  }
  const [address] = ((await w.provider.request({ method: 'eth_accounts' }).catch(() => [])) as Address[]) ?? [];
  if (!address) {
    return null;
  }
  const chainId = Number(await w.provider.request({ method: 'eth_chainId' }));
  return { wallet: w, address, chainId };
}

//asks the wallet to use this chain, adding it first if the wallet does not know it
export async function useChain(s: EvmSession, site: SiteConfig, id: string, c: ChainInfo): Promise<void> {
  if (!s.wallet) {
    s.chainId = Number(id);
    return;
  }
  const hex = `0x${Number(id).toString(16)}` as const;
  try {
    await s.wallet.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) {
      throw e;
    }
    const rpc = site.walletRpc?.[id] ?? site.evmRpc[id]!;
    const chain = chainOf(id, c, rpc);
    await s.wallet.provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: hex, chainName: walletChainName[id] ?? c.name, nativeCurrency: chain.nativeCurrency, rpcUrls: [rpc] }] });
    await s.wallet.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
    //MetaMask grants a site per chain: a chain added after the connect is not covered (signing there fails "not
    //authorized", eth_requestAccounts does not prompt again). Asking for the permission again shows one connect
    //prompt that includes the new chain (seen with MetaMask in nexus-win 2026-11-12).
    await s.wallet.provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
  }
  const [address] = (await s.wallet.provider.request({ method: 'eth_requestAccounts' })) as Address[];
  if (address && address.toLowerCase() !== s.address.toLowerCase()) {
    const { t, f } = T();
    throw new Error(f(t.conOtherAccount, { address, expected: s.address }));
  }
  s.chainId = Number(id);
}

export function signer(s: EvmSession, site: SiteConfig, id: string, c: ChainInfo): WalletClient {
  if (!s.wallet) {
    throw new Error(T().t.conNeedsSigner);
  }
  return createWalletClient({ account: s.address, chain: chainOf(id, c, site.evmRpc[id] ?? ''), transport: custom(s.wallet.provider) });
}

//which wallet this network remembered (a wallet id, or receive:0x... for a receive-only address)
export function rememberedWallet(): string | null {
  try {
    return localStorage.getItem(lastWalletKey);
  } catch {
    return null;
  }
}
