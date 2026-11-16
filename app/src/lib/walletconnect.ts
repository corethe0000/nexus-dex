//WalletConnect v2: a wallet on a phone (or in another app) connects by scanning a QR code and signs there; the page
//talks to it through WalletConnect's relay. Needs a project id from WalletConnect (config walletConnectProjectId).
//The library is loaded only when someone picks it, so the page stays small for everyone else.
import type { EIP1193Provider } from 'viem';
import type { RelayInfo, SiteConfig } from './config';
import type { WalletOption } from './evm';
import { T } from './i18n';

export const walletConnectId = 'walletconnect';

type Provider = Awaited<ReturnType<typeof import('@walletconnect/ethereum-provider').EthereumProvider.init>>;
let current: Provider | null = null;

async function provider(site: SiteConfig, info: RelayInfo): Promise<Provider> {
  if (current) {
    return current;
  }
  const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
  const ids = Object.keys(info.chains).map(Number);
  current = await EthereumProvider.init({
    projectId: site.walletConnectProjectId!,
    optionalChains: ids as [number, ...number[]],
    showQrModal: false,
    rpcMap: Object.fromEntries(ids.map((id) => [id, site.walletRpc?.[id] ?? site.evmRpc[id] ?? ''])),
    metadata: { name: 'Nexus DEX', description: T().t.conWcDescription, url: window.location.origin, icons: [] },
  });
  return current;
}

const option = (p: Provider): WalletOption => ({ id: walletConnectId, name: p.session?.peer.metadata.name ? `${p.session.peer.metadata.name} (WalletConnect)` : 'WalletConnect', provider: p as unknown as EIP1193Provider });

//a new connection: onUri gets the pairing link to show as a QR code (and to open on a phone)
export async function connectWalletConnect(site: SiteConfig, info: RelayInfo, onUri: (uri: string) => void): Promise<WalletOption> {
  const p = await provider(site, info);
  p.on('display_uri', onUri);
  try {
    await p.connect();
  } finally {
    p.removeListener('display_uri', onUri);
  }
  return option(p);
}

//after a reload: the session WalletConnect kept, without a new QR code
export async function restoreWalletConnect(site: SiteConfig, info: RelayInfo): Promise<WalletOption | null> {
  if (!site.walletConnectProjectId) {
    return null;
  }
  const p = await provider(site, info);
  return p.session ? option(p) : null;
}

export async function disconnectWalletConnect() {
  await current?.disconnect().catch(() => {});
}
