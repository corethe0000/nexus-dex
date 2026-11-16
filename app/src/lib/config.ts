//where the site finds its services: config.json next to the page (set per deployment) and the relay's /api/info
//(chains, tokens, swap contracts, timing). Nothing here is a secret.
import type { Address } from 'viem';
import type { Timing } from '@nexus-dex/core/src/swap/timing';
import { T } from './i18n';
import { pinInfo } from './pins';
import type { NetId } from './prefs';
import { walletCore } from './module';

export interface SiteConfig {
  relay: string;
  nexusNode: string;
  //other public Nexus nodes asked before this page locks EVM coins against a Nexus lock (a lying nexusNode could
  //show a lock that does not exist); none = only nexusNode is asked
  witnessNodes?: string[];
  nexusNetwork: string;
  evmRpc: Record<string, string>; //chain id -> RPC the page reads with (the user's wallet only signs)
  walletRpc?: Record<string, string>; //chain id -> RPC given to the wallet when it adds the chain (MetaMask takes only https or localhost); default evmRpc
  explorers: Record<string, string>; //chain id -> block explorer base URL
  nexusExplorer?: string; //Nexus explorer base URL (transactions at /scan/<txid>)
  nexusTokens?: { token: string; ticker: string; decimals: number }[]; //Nexus tokens offered on the Nexus market (besides NXS and the user's own)
  walletConnectProjectId?: string; //from WalletConnect (cloud.reown.com); without it the WalletConnect choice is hidden
  keepers?: string[]; //independent keepers (service/src/keeper.ts) asked together with the relay to collect for receive-only sellers
  //what the site itself fixes, not taken from the offer service on trust (a service that lies could otherwise send
  //coins into its own contract or make one side act too late); see lib/pins.ts
  swapContracts?: Record<string, string>; //chain id -> the NexusSwap address
  timing?: 'default' | 'test'; //the swap times (core/src/swap/timing.ts)
  minConfirmations?: Record<string, number>; //'nexus' or chain id -> at least this many
  tokens?: Record<string, { address: string; symbol: string; decimals: number; usd?: number | string }[]>; //chain id -> the only tokens shown, as named here
}


export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
  maxAmount?: string; //largest offer the service takes, base units (a careful start on mainnet)
  usd?: number | string; //its dollar value: fixed (1 = a stablecoin) or a price feed id, then the price comes from /api/price
}

export interface ChainInfo {
  name: string;
  swap: Address;
  fromBlock: string;
  confirmations: number;
  finalDelay: number;
  tokens: TokenInfo[];
}

export interface RelayInfo {
  nexus: { finalDelay: number; confirmations: number };
  chains: Record<string, ChainInfo>;
  timing: Timing;
  now: number;
}

const absolute = (u: string) => new URL(u, window.location.href).toString().replace(/\/$/, '');

//config.json holds one profile per network: {"networks": {"mainnet": {...}, "testnet": {...}}}. A network without a
//relay is not live yet. An old file with a single profile counts as the testnet.
interface ConfigFile extends Partial<SiteConfig> {
  networks?: Partial<Record<NetId, Partial<SiteConfig>>>;
}

export async function loadSite(net: NetId): Promise<SiteConfig | null> {
  const file = (window.dexConfig ?? (await (await fetch('./config.json', { cache: 'no-store' })).json())) as ConfigFile;
  const raw = file.networks ? file.networks[net] : net === 'testnet' ? file : undefined;
  if (!raw?.relay || !raw.nexusNode) {
    return null;
  }
  return {
    relay: absolute(raw.relay),
    nexusNode: raw.nexusNode === walletCore ? walletCore : absolute(raw.nexusNode),
    witnessNodes: (raw.witnessNodes ?? []).map(absolute),
    nexusNetwork: raw.nexusNetwork ?? '',
    evmRpc: Object.fromEntries(Object.entries(raw.evmRpc ?? {}).map(([k, v]) => [k, absolute(v)])),
    walletRpc: raw.walletRpc,
    explorers: raw.explorers ?? {},
    nexusExplorer: raw.nexusExplorer?.replace(/\/$/, ''),
    keepers: (raw.keepers ?? []).map(absolute),
    nexusTokens: raw.nexusTokens ?? [],
    walletConnectProjectId: raw.walletConnectProjectId,
    swapContracts: raw.swapContracts,
    timing: raw.timing,
    minConfirmations: raw.minConfirmations,
    tokens: raw.tokens,
  };
}

//on the testnet the ribbon already says so: chains show by the name of the network they stand in for
const testnetNames: Record<string, string> = { '97': 'BSC', '11155111': 'Ethereum', '80002': 'Polygon', '31337': 'Local chain' };

export async function loadInfo(site: SiteConfig, net: NetId): Promise<RelayInfo> {
  const res = await fetch(`${site.relay}/api/info`);
  if (!res.ok) {
    throw new Error(`The offer service answered ${res.status}.`);
  }
  const { t } = T();
  const info = pinInfo((await res.json()) as RelayInfo, site, { swapMismatch: t.cfgSwapMismatch, timingBad: t.cfgTimingBad });
  if (net === 'testnet') {
    for (const [id, c] of Object.entries(info.chains)) {
      c.name = testnetNames[id] ?? c.name.replace(/\s*test(net)?$/i, '');
    }
  }
  return info;
}

export function tokenOf(info: RelayInfo, chainId: string, address: string): TokenInfo | undefined {
  return info.chains[chainId]?.tokens.find((t) => t.address.toLowerCase() === address.toLowerCase());
}
