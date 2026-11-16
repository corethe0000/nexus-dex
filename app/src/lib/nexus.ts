//the user's Nexus profile in this page: found and checked with the node's public API, transactions signed here.
//Username, password and PIN stay in this page's memory only (never stored, never sent): a reload asks again.
import { checkCredentials, findGenesis, scanOwnRegisters, accountTypes, type NodeCall } from '../../../../wallet/src/lib/profile-chain';
import { NexusNode } from '@nexus-dex/core/src/nexus/node';
import { slotFee } from '@nexus-dex/core/src/nexus/htlc';
import { localSigner, type NexusSigner } from '@nexus-dex/core/src/nexus/signer';
import { T } from './i18n';

export interface NexusAccount {
  address: string;
  name?: string;
  token: string; //'0' = NXS
  ticker: string;
  decimals: number;
  balance: bigint; //base units
}

export interface NexusProfile {
  username: string;
  genesis: string;
  accounts: NexusAccount[];
  slotReady: boolean;
  signer: NexusSigner; //signs the swap steps: in this page, or in the Nexus browser wallet
  via: 'page' | 'extension';
}

export interface NexusNet {
  testnet: boolean;
  private: boolean;
  hybrid: boolean;
}

export async function network(node: NexusNode): Promise<NexusNet> {
  const info = await node.call<any>('system/get/info');
  return { testnet: !!info.testnet, private: !!info.private, hybrid: !!info.hybrid };
}

//the swap's reveal slot costs a name fee; the core charges no fees only on hybrid / private chains (Transaction::Cost)
export const slotFeeOn = (net: NexusNet) => (net.private || net.hybrid ? 0n : slotFee);

export async function signIn(node: NexusNode, username: string, password: string, pin: string): Promise<NexusProfile> {
  const call: NodeCall = (m, p) => node.call(m, p);
  const name = username.trim();
  const net = await network(node);
  const { genesis, auth } = await findGenesis(call, name, net.testnet || net.private);
  await checkCredentials(name, password, pin, auth);
  const p: NexusProfile = { username: name, genesis, accounts: [], slotReady: false, signer: localSigner(node, { username: name, password, pin }, genesis, slotFeeOn(net)), via: 'page' };
  await refresh(node, p);
  return p;
}

export async function refresh(node: NexusNode, p: NexusProfile): Promise<void> {
  const scan = await scanOwnRegisters((m, q) => node.call(m, q), p.genesis);
  const accounts = await Promise.all(
    scan.registers
      .filter((r) => accountTypes.has(r.type) && r.type !== 'TRUST')
      .map(async (r) => {
        const s = await node.accountState(r.address).catch(() => null);
        if (!s) {
          return null;
        }
        const t = s.token === '0' ? null : await node.call<any>('register/get/any', { address: s.token }).catch(() => null);
        return { address: r.address, name: r.name, token: s.token, ticker: s.token === '0' ? 'NXS' : (t?.ticker ?? t?.name ?? 'token'), decimals: s.decimals, balance: s.balance } as NexusAccount;
      }),
  );
  p.accounts = accounts.filter((a): a is NexusAccount => !!a);
  p.slotReady = (await node.slot(p.genesis)) !== null;
}

//creates the reveal slot (once per profile); the fee comes from the first NXS account that has it
export async function createSlot(p: NexusProfile, net: NexusNet): Promise<string> {
  const fee = slotFeeOn(net);
  const payer = fee > 0n ? p.accounts.find((a) => a.token === '0' && a.balance >= fee) : undefined;
  if (fee > 0n && !payer) {
    throw new Error(T().t.conSetupCost);
  }
  return p.signer.createSlot(payer?.address);
}

//the profile's accounts in one token, ordinary accounts first: a token's own register (its address is the token id)
//holds the supply its creator has not handed out, and pays only when no ordinary account can
export function accountsFor(p: NexusProfile | null, token: string): NexusAccount[] {
  return (p?.accounts ?? []).filter((a) => a.token === token).sort((a, b) => Number(a.address === a.token) - Number(b.address === b.token));
}

//the largest amount one payment can take: ordinary accounts first, the token's own register only without them
export function spendable(p: NexusProfile | null, token: string): bigint {
  const list = accountsFor(p, token);
  const ordinary = list.filter((a) => a.address !== a.token);
  return (ordinary.length ? ordinary : list).reduce((m, a) => (a.balance > m ? a.balance : m), 0n);
}
