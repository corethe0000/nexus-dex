//sign in with the Nexus Wallet browser extension: the site never sees password or PIN. Each Nexus step of a swap
//(set up, lock, collect, take back) opens the wallet's window, which shows the step and asks for the PIN
//(nexus_swapStep in wallet/src/lib/swap-step.ts). Needs the wallet's "sign in this browser" mode.
import type { NexusNode } from '@nexus-dex/core/src/nexus/node';
import { toHexBytes } from '@nexus-dex/core/src/nexus/bytes';
import { marketOf, type NexusSigner } from '@nexus-dex/core/src/nexus/signer';
import type { DappConnectInfo, DappNetwork, SwapStep } from '../../../../wallet/sdk/src/index';
import { T } from './i18n';
import { refresh, type NexusNet, type NexusProfile } from './nexus';

interface Provider {
  isNexusWallet?: boolean;
  request(args: { method: string; params?: unknown }): Promise<any>;
  on(event: string, fn: (data: unknown) => void): unknown;
  removeListener(event: string, fn: (data: unknown) => void): unknown;
}

//the wallet adds window.nexus at document start; give it a moment on slow starts
export async function findExtension(waitMs = 1500): Promise<Provider | null> {
  const get = () => ((window as unknown as { nexus?: Provider }).nexus?.isNexusWallet ? (window as unknown as { nexus: Provider }).nexus : null);
  if (get()) {
    return get();
  }
  await new Promise<void>((r) => {
    const done = () => r();
    window.addEventListener('nexus#initialized', done, { once: true });
    setTimeout(done, waitMs);
  });
  return get();
}

//the wallet's error codes in words, in the page's language at the time of the error
function errorText(code: number): string | undefined {
  const { t } = T();
  const text: Record<number, string> = {
    4001: t.conExtRejected,
    4100: t.conExtNotConnected,
    4200: t.conExtCoreLogin,
    4900: t.conExtLocked,
    [-32002]: t.conExtBusy,
  };
  return text[code];
}

async function call<R>(p: Provider, method: string, params?: unknown): Promise<R> {
  try {
    return await p.request({ method, params });
  } catch (e) {
    const code = (e as { code?: number }).code;
    const known = code !== undefined ? errorText(code) : undefined;
    //the code goes along: the swap runner tells "nothing was sent" (refused, locked, not connected) from other errors
    throw Object.assign(new Error(known ? known : (e as Error).message), { code });
  }
}

//digits after the point of a price sent to the wallet
const priceDigits = 12;

//base units as a plain decimal string, no separators
function decimalOf(units: bigint, decimals: number): string {
  const s = units.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

export function extensionSigner(p: Provider, genesis: string): NexusSigner {
  const step = async (s: SwapStep) => (await call<{ txid: string }>(p, 'nexus_swapStep', s)).txid;
  return {
    genesis,
    createSlot: () => step({ step: 'setup' }),
    lock: (s) => step({ step: 'lock', from: s.from, to: s.to, amount: s.amount.toString(), recipient: s.terms.recipient, hashlock: toHexBytes(s.terms.hashlock), deadline: s.terms.deadline }),
    reveal: (secret, lock) => {
      if (!lock) {
        throw new Error('the wallet needs the lock a reveal is for');
      }
      return step({ step: 'reveal', secret: toHexBytes(secret), txid: lock.txid, contract: lock.contract });
    },
    claim: (s) => step({ step: 'claim', txid: s.lockTxid, contract: s.contract }),
    refund: (s) => step({ step: 'refund', txid: s.lockTxid, contract: s.contract }),
    //incoming payments are collected in the wallet itself (its list of payments to claim)
    collect: async () => {
      throw new Error(T().t.conExtCollect);
    },
    //the wallet's market requests: it picks the accounts and shows the order in its window
    market: {
      //amount and price as exact decimal strings (a float of a large amount loses its last digits)
      place: async (o) => {
        const amount = decimalOf(o.give.amount, o.give.decimals);
        const price = decimalOf((o.want.amount * 10n ** BigInt(o.give.decimals + priceDigits)) / (o.give.amount * 10n ** BigInt(o.want.decimals)), priceDigits);
        return (await call<{ txid: string }>(p, 'nexus_placeOrder', { market: marketOf(o.give.token, o.want.token), side: 'sell', amount, price })).txid;
      },
      fill: async (o) => (await call<{ txid: string }>(p, 'nexus_fillOrder', { market: o.market, txid: o.txid })).txid,
      cancel: async (o) => (await call<{ txid: string }>(p, 'nexus_cancelOrder', { market: o.market, txid: o.txid })).txid,
    },
  };
}

const netName = (n: NexusNet) => (n.private ? 'private' : n.testnet ? 'testnet' : 'mainnet');

//connects (the wallet asks the user once per site) and reads the profile from this site's node
//onChange: the wallet switched or logged out the account, the page signs out
export async function signInWithExtension(node: NexusNode, net: NexusNet, onChange: () => void): Promise<NexusProfile> {
  const p = await findExtension();
  if (!p) {
    throw new Error(T().t.conExtNotFound);
  }
  const walletNet = await call<DappNetwork>(p, 'nexus_getNetwork');
  if (walletNet.network !== netName(net)) {
    const { t, f } = T();
    throw new Error(f(t.conExtWrongNet, { wallet: walletNet.network, site: netName(net) }));
  }
  const info = await call<DappConnectInfo>(p, 'nexus_connect');
  const changed = (data: unknown) => {
    const now = data as DappConnectInfo | null;
    if (!now || now.genesis !== info.genesis) {
      p.removeListener('accountsChanged', changed);
      p.removeListener('disconnect', changed);
      onChange();
    }
  };
  p.on('accountsChanged', changed);
  p.on('disconnect', changed);
  const profile: NexusProfile = { username: info.username, genesis: info.genesis, accounts: [], slotReady: false, signer: extensionSigner(p, info.genesis), via: 'extension' };
  await refresh(node, profile);
  return profile;
}
