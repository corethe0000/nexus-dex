//offers, takes and accepts: small messages signed with the EVM wallet (EIP-712), so the relay can check who sent
//them but never needs a key or holds funds. Every client checks the signatures itself too.
//
//maker posts an Offer -> taker sends a Take (with its hashlock) -> maker's agent signs an Accept -> taker locks first.
//The agent is a key the maker's page makes and keeps, named in the offer, so staying online needs no wallet popups.
//The take id is the swap id and the nexusRef of the EVM lock.
import { hashTypedData, recoverTypedDataAddress, toHex, type Address, type Hex } from 'viem';
import type { SwapRecord } from '../swap/runner';
import type { Role } from '../swap/types';

export const domain = { name: 'Nexus DEX', version: '1' } as const;

export const types = {
  Offer: [
    { name: 'maker', type: 'address' },
    { name: 'agent', type: 'address' }, //session key of the maker's page: signs alive beats and accepts, holds nothing
    { name: 'nexusAccount', type: 'string' }, //maker's account on Nexus: sends if makerGives nexus, else receives
    { name: 'nexusGenesis', type: 'string' },
    { name: 'makerGivesNexus', type: 'bool' },
    { name: 'nexusToken', type: 'string' }, //'0' = NXS, else the token address
    { name: 'nexusAmount', type: 'uint256' },
    { name: 'evmChainId', type: 'uint256' },
    { name: 'evmToken', type: 'address' },
    { name: 'evmAmount', type: 'uint256' },
    { name: 'expires', type: 'uint64' },
    { name: 'nonce', type: 'uint64' },
  ],
  Take: [
    { name: 'offerId', type: 'bytes32' },
    { name: 'taker', type: 'address' },
    { name: 'agent', type: 'address' }, //key of the taker's page; may sign instead of the taker when the taker only receives
    { name: 'nexusAccount', type: 'string' },
    { name: 'nexusGenesis', type: 'string' },
    { name: 'hashlock', type: 'bytes32' },
    { name: 'expires', type: 'uint64' },
  ],
  Accept: [{ name: 'takeId', type: 'bytes32' }],
  //the maker's agent: the taker of this accepted take never locked, the offer may open again
  Void: [{ name: 'takeId', type: 'bytes32' }],
  Cancel: [{ name: 'offerId', type: 'bytes32' }],
  Alive: [
    { name: 'agent', type: 'address' },
    { name: 'at', type: 'uint64' },
  ],
} as const;

export interface Offer {
  maker: Address;
  agent: Address;
  nexusAccount: string;
  nexusGenesis: string;
  makerGivesNexus: boolean;
  nexusToken: string;
  nexusAmount: bigint;
  evmChainId: bigint;
  evmToken: Address;
  evmAmount: bigint;
  expires: bigint;
  nonce: bigint;
}

export interface Take {
  offerId: Hex;
  taker: Address;
  agent: Address;
  nexusAccount: string;
  nexusGenesis: string;
  hashlock: Hex;
  expires: bigint;
}

export type Kind = keyof typeof types;
type MessageOf<K extends Kind> = K extends 'Offer' ? Offer : K extends 'Take' ? Take : K extends 'Accept' | 'Void' ? { takeId: Hex } : K extends 'Cancel' ? { offerId: Hex } : { agent: Address; at: bigint };

export function typed<K extends Kind>(kind: K, message: MessageOf<K>) {
  return { domain, types, primaryType: kind, message } as const;
}

export function idOf<K extends Kind>(kind: K, message: MessageOf<K>): Hex {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return hashTypedData(typed(kind, message) as any);
}

export async function signerOf<K extends Kind>(kind: K, message: MessageOf<K>, signature: Hex): Promise<Address> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return recoverTypedDataAddress({ ...(typed(kind, message) as any), signature });
}

//who may sign an offer or take: the EVM address itself, or the page's agent key when that address only RECEIVES
//USDT/USDC. Such a side sends no EVM transaction in the swap (anyone may send the claim, it pays the fixed recipient),
//so it needs no wallet at all ("receive only"). A side that pays USDT/USDC always signs with its own wallet.
export function offerSignerOk(o: Offer, by: Address): boolean {
  const b = by.toLowerCase();
  return b === o.maker.toLowerCase() || (o.makerGivesNexus && b === o.agent.toLowerCase());
}

export function takeSignerOk(t: Take, o: Offer, by: Address): boolean {
  const b = by.toLowerCase();
  return b === t.taker.toLowerCase() || (!o.makerGivesNexus && b === t.agent.toLowerCase());
}

//--- JSON form (bigints as decimal strings) ---

export type Json<T> = { [P in keyof T]: T[P] extends bigint ? string : T[P] };

//what the relay hands out
export interface OfferOut {
  id: Hex;
  offer: Json<Offer>;
  sig: Hex;
  postedAt: number;
}

//void: accepted, but the taker never locked and the maker let the offer go again
export type TakeStatus = 'waiting' | 'accepted' | 'lapsed' | 'void';

export interface TakeOut {
  id: Hex;
  status: TakeStatus;
  take: Json<Take>;
  sig: Hex;
  acceptBy: number;
  acceptSig?: Hex;
  offer: OfferOut;
}

export function offerToJson(o: Offer): Json<Offer> {
  return { ...o, nexusAmount: o.nexusAmount.toString(), evmChainId: o.evmChainId.toString(), evmAmount: o.evmAmount.toString(), expires: o.expires.toString(), nonce: o.nonce.toString() };
}

//input from the network: only the known fields, each of its type (anything else throws)
function str(v: unknown): string {
  if (typeof v !== 'string' || v.length > 200) {
    throw new Error('bad field');
  }
  return v;
}

function uint(v: unknown): bigint {
  if (!/^[0-9]{1,40}$/.test(str(v))) {
    throw new Error('bad number');
  }
  return BigInt(v as string);
}

export function offerFromJson(j: Json<Offer>): Offer {
  if (typeof j.makerGivesNexus !== 'boolean') {
    throw new Error('bad field');
  }
  return {
    maker: str(j.maker) as Address,
    agent: str(j.agent) as Address,
    nexusAccount: str(j.nexusAccount),
    nexusGenesis: str(j.nexusGenesis),
    makerGivesNexus: j.makerGivesNexus,
    nexusToken: str(j.nexusToken),
    nexusAmount: uint(j.nexusAmount),
    evmChainId: uint(j.evmChainId),
    evmToken: str(j.evmToken) as Address,
    evmAmount: uint(j.evmAmount),
    expires: uint(j.expires),
    nonce: uint(j.nonce),
  };
}

export function takeToJson(t: Take): Json<Take> {
  return { ...t, expires: t.expires.toString() };
}

export function takeFromJson(j: Json<Take>): Take {
  return {
    offerId: str(j.offerId) as Hex,
    taker: str(j.taker) as Address,
    agent: str(j.agent) as Address,
    nexusAccount: str(j.nexusAccount),
    nexusGenesis: str(j.nexusGenesis),
    hashlock: str(j.hashlock) as Hex,
    expires: uint(j.expires),
  };
}

const hex64 = /^0x[0-9a-fA-F]{64}$/;
const addr = /^0x[0-9a-fA-F]{40}$/;
const base58 = /^[1-9A-HJ-NP-Za-km-z]{40,60}$/;
const genesis = /^[0-9a-fA-F]{64}$/;
const maxUint = 2n ** 128n;
const maxNexus = 2n ** 64n;

//shape and range checks of an offer (signature checked separately); null = fine
export function offerProblem(o: Offer, now: number): string | null {
  if (!addr.test(o.maker) || !addr.test(o.agent) || !addr.test(o.evmToken)) {
    return 'bad EVM address';
  }
  if (!base58.test(o.nexusAccount) || !genesis.test(o.nexusGenesis)) {
    return 'bad Nexus account or genesis';
  }
  if (o.nexusToken !== '0' && !base58.test(o.nexusToken)) {
    return 'bad Nexus token';
  }
  //Nexus amounts are 64 bit: a bigger one could never be locked there
  if (o.nexusAmount <= 0n || o.evmAmount <= 0n || o.nexusAmount >= maxNexus || o.evmAmount >= maxUint) {
    return 'bad amount';
  }
  if (o.expires <= BigInt(now)) {
    return 'offer expired';
  }
  return null;
}

export function takeProblem(t: Take, now: number): string | null {
  if (!hex64.test(t.offerId) || !hex64.test(t.hashlock)) {
    return 'bad offer id or hashlock';
  }
  if (!addr.test(t.taker) || !addr.test(t.agent)) {
    return 'bad EVM address';
  }
  if (!base58.test(t.nexusAccount) || !genesis.test(t.nexusGenesis)) {
    return 'bad Nexus account or genesis';
  }
  if (t.expires <= BigInt(now)) {
    return 'take expired';
  }
  return null;
}

//the swap both sides run once the maker accepted: taker = initiator, it locks what it gives
export function swapRecord(offer: Offer, take: Take, role: Role, secret?: string): SwapRecord {
  const id = idOf('Take', take);
  const takerGivesNexus = !offer.makerGivesNexus;
  const nexusSender = takerGivesNexus ? { genesis: take.nexusGenesis, account: take.nexusAccount } : { genesis: offer.nexusGenesis, account: offer.nexusAccount };
  const nexusRecipient = takerGivesNexus ? { genesis: offer.nexusGenesis, account: offer.nexusAccount } : { genesis: take.nexusGenesis, account: take.nexusAccount };
  return {
    id,
    role,
    initiatorChain: takerGivesNexus ? 'nexus' : 'evm',
    hashlock: take.hashlock.slice(2).toLowerCase(),
    createdAt: Math.floor(Date.now() / 1000),
    secret,
    nexus: { sender: nexusSender.genesis, recipient: nexusRecipient.genesis, from: nexusSender.account, to: nexusRecipient.account, amount: offer.nexusAmount.toString(), token: offer.nexusToken },
    evm: {
      sender: takerGivesNexus ? offer.maker : take.taker,
      recipient: takerGivesNexus ? take.taker : offer.maker,
      token: offer.evmToken,
      amount: offer.evmAmount.toString(),
      nexusRef: id,
    },
    log: [],
  };
}

//a fresh nonce for offers (unique per maker; the relay refuses a repeated offer id)
export function newNonce(): bigint {
  return BigInt(toHex(crypto.getRandomValues(new Uint8Array(8))));
}

//--- checks a client makes itself, not trusting the relay (security review 2026-11-13) ---

//maker: a take the relay hands over is for my offer, made and signed by the taker (or its agent when it only
//receives), and not expired. The swap is then built from MY copy of the offer, never the relay's.
export async function takeProblemForMaker(mine: Offer, myId: Hex, t: { id: Hex; take: Json<Take>; sig: Hex }, now: number): Promise<string | null> {
  const take = takeFromJson(t.take);
  if (take.offerId.toLowerCase() !== myId.toLowerCase()) {
    return 'take for another offer';
  }
  if (idOf('Take', take).toLowerCase() !== t.id.toLowerCase()) {
    return 'take id does not match its terms';
  }
  const shape = takeProblem(take, now);
  if (shape) {
    return shape;
  }
  const by = await signerOf('Take', take, t.sig).catch(() => null);
  return by && takeSignerOk(take, mine, by) ? null : 'take not signed by the taker';
}

//maker: a take with a hashlock one of my swaps already has. The Nexus lock names no swap, so one lock of the taker
//would pass the checks of two swaps with the same hashlock and the same amount, and the maker would pay twice
export function hashlockUsed(t: { take: Json<Take> }, swaps: Iterable<{ hashlock: string }>): boolean {
  const h = t.take.hashlock.replace(/^0x/i, '').toLowerCase();
  for (const s of swaps) {
    if (s.hashlock.replace(/^0x/i, '').toLowerCase() === h) {
      return true;
    }
  }
  return false;
}

//taker: the offer is what its id says and is signed by its maker (or its agent when the maker only receives)
export async function offerProblemForTaker(o: OfferOut, now = Math.floor(Date.now() / 1000)): Promise<string | null> {
  const offer = offerFromJson(o.offer);
  if (idOf('Offer', offer).toLowerCase() !== o.id.toLowerCase()) {
    return 'offer id does not match its terms';
  }
  //the relay runs these too, but a relay is not trusted
  const shape = offerProblem(offer, now);
  if (shape) {
    return shape;
  }
  const by = await signerOf('Offer', offer, o.sig).catch(() => null);
  return by && offerSignerOk(offer, by) ? null : 'offer not signed by its maker';
}

//taker: "accepted" only counts when the maker's agent signed the accept of exactly this take
export async function acceptOk(offer: Offer, takeId: Hex, acceptSig: Hex | undefined): Promise<boolean> {
  if (!acceptSig) {
    return false;
  }
  const by = await signerOf('Accept', { takeId }, acceptSig).catch(() => null);
  return !!by && by.toLowerCase() === offer.agent.toLowerCase();
}
