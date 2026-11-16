//the order book of the relay: signed offers, takes and accepts. It holds no keys and no funds; it only checks
//signatures, keeps one take per offer at a time and hides offers of makers that are not online.
import type { Address, Hex } from 'viem';
import { idOf, offerFromJson, offerProblem, offerSignerOk, offerToJson, signerOf, takeFromJson, takeProblem, takeSignerOk, takeToJson, type Json, type Offer, type OfferOut, type Take, type TakeOut, type TakeStatus } from '../../core/src/book/offer';

export type { OfferOut, TakeOut };

export interface BookSettings {
  chains: Record<string, { tokens: Address[]; limits?: Record<string, bigint> }>; //evm chain id -> allowed tokens; limits: lowercase token -> largest offer (base units), for a careful start on mainnet
  aliveWindow: number; //an offer shows only while its maker said "alive" within this many seconds
  acceptWindow: number; //the maker must accept a take within this many seconds, else the offer opens again
  aliveSkew: number; //an alive message may be this far off the relay clock
  maxOffersPerMaker: number;
}

//longest an offer may stay up (the site offers a week at most; a little more for clocks)
const maxOfferLife = 8 * 86400;
//the whole book at most: open offers, offers kept at all (taken ones stay while their swap runs), takes kept
const maxLiveOffers = 5000;
const maxKeptOffers = 20000;
const maxKeptTakes = 20000;

export const defaultBookSettings: Omit<BookSettings, 'chains'> = { aliveWindow: 90, acceptWindow: 60, aliveSkew: 60, maxOffersPerMaker: 50 };

type OfferStatus = 'open' | 'reserved' | 'filled' | 'cancelled';

interface OfferEntry {
  offer: Offer;
  sig: Hex;
  by?: Address; //who signed it (the maker, or its agent for a receive-only maker); counts for the quota
  postedAt: number;
  status: OfferStatus;
  takeId?: Hex;
}

interface TakeEntry {
  take: Take;
  sig: Hex;
  at: number;
  acceptBy: number;
  status: TakeStatus;
  acceptSig?: Hex;
}

export interface Snapshot {
  offers: { id: Hex; offer: Json<Offer>; sig: Hex; by?: Address; postedAt: number; status: OfferStatus; takeId?: Hex }[];
  takes: { id: Hex; take: Json<Take>; sig: Hex; at: number; acceptBy: number; status: TakeStatus; acceptSig?: Hex }[];
  alive: [Address, number][];
}

export class BookError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const lower = (a: string) => a.toLowerCase() as Address;

//an accepted take stays this long (14 days): the watcher's giveUpAfter is 2 x the taker's lock (2 days by default)
const keepAccepted = 1209600;

//input from the network: anything that does not even parse is a bad request, not a relay error
function parse<T>(what: string, f: () => T): T {
  try {
    return f();
  } catch {
    throw new BookError(`bad ${what}`);
  }
}

async function signer(f: () => Promise<Address>): Promise<Address> {
  try {
    return lower(await f());
  } catch {
    throw new BookError('bad signature', 401);
  }
}

export class Book {
  private offers = new Map<Hex, OfferEntry>();
  private takes = new Map<Hex, TakeEntry>();
  private alive = new Map<Address, number>();

  constructor(
    readonly settings: BookSettings,
    private onChange: () => void = () => {},
  ) {}

  //an offer shows while the page of its maker (its agent key) said alive lately
  private isAlive(agent: Address, now: number): boolean {
    return now - (this.alive.get(lower(agent)) ?? 0) <= this.settings.aliveWindow;
  }

  //a waiting take past its accept time lets the offer go back to open
  sweep(now: number) {
    let changed = false;
    for (const [id, t] of this.takes) {
      if (t.status === 'waiting' && now > t.acceptBy) {
        t.status = 'lapsed';
        const o = this.offers.get(t.take.offerId);
        if (o && o.status === 'reserved' && o.takeId === id) {
          o.status = 'open';
          o.takeId = undefined;
        }
        changed = true;
      }
    }
    //old takes are forgotten (else the watcher goes through every swap ever made on each round): a lapsed one a day
    //after its accept time, an accepted one once its swap is long over (locks last a day at most)
    for (const [id, t] of this.takes) {
      if (((t.status === 'lapsed' || t.status === 'void') && now > t.acceptBy + 86400) || (t.status === 'accepted' && now > t.at + keepAccepted)) {
        this.takes.delete(id);
        changed = true;
      }
    }
    const takenOffers = new Set([...this.takes.values()].map((t) => t.take.offerId));
    for (const [id, o] of this.offers) {
      //expired and never taken: forget it a day later; a filled one once its take is gone
      if (((o.status === 'open' || o.status === 'cancelled') && Number(o.offer.expires) + 86400 < now && !takenOffers.has(id)) || (o.status === 'filled' && !takenOffers.has(id))) {
        this.offers.delete(id);
        changed = true;
      }
    }
    //agents silent longer than the alive window are offline anyway
    for (const [a, at] of this.alive) {
      if (now - at > this.settings.aliveWindow) {
        this.alive.delete(a);
      }
    }
    if (changed) {
      this.onChange();
    }
  }

  async post(json: Json<Offer>, sig: Hex, now: number): Promise<Hex> {
    const offer = parse('offer', () => offerFromJson(json));
    const problem = parse('offer', () => offerProblem(offer, now));
    if (problem) {
      throw new BookError(problem);
    }
    const chain = this.settings.chains[offer.evmChainId.toString()];
    if (!chain) {
      throw new BookError('EVM chain not supported here');
    }
    if (!chain.tokens.some((t) => lower(t) === lower(offer.evmToken))) {
      throw new BookError('token not supported here');
    }
    const limit = chain.limits?.[lower(offer.evmToken)];
    if (limit !== undefined && offer.evmAmount > limit) {
      throw new BookError('offer above the size limit of this service');
    }
    if (Number(offer.expires) > now + maxOfferLife) {
      throw new BookError('offer runs too long (a week at most)');
    }
    const by = await signer(() => signerOf('Offer', offer, sig));
    if (!offerSignerOk(offer, by)) {
      throw new BookError('signature is not the maker', 401);
    }
    const id = idOf('Offer', offer);
    if (this.offers.has(id)) {
      throw new BookError('offer already posted', 409);
    }
    const live = [...this.offers.values()].filter((o) => o.status === 'open' || o.status === 'reserved');
    //signing keys cost nothing, so the per-maker quota alone does not bound the book
    if (live.length >= maxLiveOffers || this.offers.size >= maxKeptOffers) {
      throw new BookError('the book is full, try again later', 503);
    }
    //counted by who signed: a receive-only offer (signed by an agent) can name any maker address, so counting by maker
    //would let anyone fill another maker's quota
    if (live.filter((o) => lower(o.by ?? o.offer.maker) === by).length >= this.settings.maxOffersPerMaker) {
      throw new BookError('too many open offers', 429);
    }
    //an agent key belongs to one maker: an offer naming another maker's agent would keep that maker's offers listed
    //(its alive beat) while it is away
    if (live.some((o) => lower(o.offer.agent) === lower(offer.agent) && lower(o.offer.maker) !== lower(offer.maker))) {
      throw new BookError('this agent key belongs to another maker', 409);
    }
    this.offers.set(id, { offer, sig, by, postedAt: now, status: 'open' });
    this.alive.set(lower(offer.agent), now);
    this.onChange();
    return id;
  }

  async cancel(offerId: Hex, sig: Hex): Promise<void> {
    const o = this.offers.get(offerId);
    if (!o) {
      throw new BookError('no such offer', 404);
    }
    const by = await signer(() => signerOf('Cancel', { offerId }, sig));
    if (by !== lower(o.offer.maker) && by !== lower(o.offer.agent)) {
      throw new BookError('signature is not the maker', 401);
    }
    if (o.status === 'filled') {
      throw new BookError('offer already taken', 409);
    }
    o.status = 'cancelled';
    this.onChange();
  }

  //the maker's page calls this every few seconds, signed by its agent key; the answer is the takes waiting for it
  async beat(agent: Address, at: number, sig: Hex, now: number): Promise<TakeOut[]> {
    if (Math.abs(now - at) > this.settings.aliveSkew) {
      throw new BookError('alive time too far from the relay clock');
    }
    if ((await signer(() => signerOf('Alive', { agent, at: BigInt(at) }, sig))) !== lower(agent)) {
      throw new BookError('signature is not the agent', 401);
    }
    this.alive.set(lower(agent), now);
    this.sweep(now);
    return [...this.takes.entries()].filter(([, t]) => t.status === 'waiting' && lower(this.offers.get(t.take.offerId)!.offer.agent) === lower(agent)).map(([id]) => this.takeOut(id)!);
  }

  list(now: number): OfferOut[] {
    this.sweep(now);
    return [...this.offers.entries()].filter(([, o]) => o.status === 'open' && Number(o.offer.expires) > now && this.isAlive(o.offer.agent, now)).map(([id, o]) => ({ id, offer: offerToJson(o.offer), sig: o.sig, postedAt: o.postedAt }));
  }

  async take(json: Json<Take>, sig: Hex, now: number): Promise<{ id: Hex; acceptBy: number }> {
    const take = parse('take', () => takeFromJson(json));
    const problem = parse('take', () => takeProblem(take, now));
    if (problem) {
      throw new BookError(problem);
    }
    this.sweep(now);
    const o = this.offers.get(take.offerId);
    if (!o || o.status !== 'open' || Number(o.offer.expires) <= now || !this.isAlive(o.offer.agent, now)) {
      throw new BookError('offer not available', 409);
    }
    if (!takeSignerOk(take, o.offer, await signer(() => signerOf('Take', take, sig)))) {
      throw new BookError('signature is not the taker', 401);
    }
    if (lower(take.taker) === lower(o.offer.maker) || take.nexusGenesis.toLowerCase() === o.offer.nexusGenesis.toLowerCase()) {
      throw new BookError('cannot take your own offer');
    }
    //one waiting take per taker: a taker cannot block many offers at once
    for (const t of this.takes.values()) {
      if (t.status === 'waiting' && lower(t.take.taker) === lower(take.taker)) {
        throw new BookError('you already have a take waiting', 429);
      }
      //one Nexus lock could back two swaps with the same hashlock (the makers check this too)
      if (lower(t.take.hashlock) === lower(take.hashlock)) {
        throw new BookError('hashlock already used, make a new secret', 409);
      }
    }
    const id = idOf('Take', take);
    if (this.takes.has(id)) {
      throw new BookError('take already sent', 409);
    }
    if (this.takes.size >= maxKeptTakes) {
      throw new BookError('the book is full, try again later', 503);
    }
    const acceptBy = now + this.settings.acceptWindow;
    this.takes.set(id, { take, sig, at: now, acceptBy, status: 'waiting' });
    o.status = 'reserved';
    o.takeId = id;
    this.onChange();
    return { id, acceptBy };
  }

  async accept(takeId: Hex, sig: Hex, now: number): Promise<void> {
    const t = this.takes.get(takeId);
    if (!t) {
      throw new BookError('no such take', 404);
    }
    const o = this.offers.get(t.take.offerId)!;
    if ((await signer(() => signerOf('Accept', { takeId }, sig))) !== lower(o.offer.agent)) {
      throw new BookError("signature is not the maker's agent", 401);
    }
    this.sweep(now);
    if (t.status !== 'waiting' || o.takeId !== takeId || o.status !== 'reserved') {
      throw new BookError(`take is ${t.status}`, 409);
    }
    t.status = 'accepted';
    t.acceptSig = sig;
    o.status = 'filled';
    this.alive.set(lower(o.offer.agent), now);
    this.onChange();
  }

  //the maker's agent gives up on an accepted take whose taker never locked (its own swap aborted before any lock):
  //the offer opens again while it runs. Only the maker's side can say so; it is the side that would have waited
  async void(takeId: Hex, sig: Hex, now: number): Promise<void> {
    const t = this.takes.get(takeId);
    if (!t) {
      throw new BookError('no such take', 404);
    }
    const o = this.offers.get(t.take.offerId)!;
    if ((await signer(() => signerOf('Void', { takeId }, sig))) !== lower(o.offer.agent)) {
      throw new BookError("signature is not the maker's agent", 401);
    }
    if (t.status === 'void') {
      return;
    }
    if (t.status !== 'accepted') {
      throw new BookError(`take is ${t.status}`, 409);
    }
    t.status = 'void';
    if (o.status === 'filled' && o.takeId === takeId) {
      o.status = 'open';
      o.takeId = undefined;
    }
    this.onChange();
  }

  takeOut(id: Hex): TakeOut | null {
    const t = this.takes.get(id);
    if (!t) {
      return null;
    }
    const o = this.offers.get(t.take.offerId)!;
    return { id, status: t.status, take: takeToJson(t.take), sig: t.sig, acceptBy: t.acceptBy, acceptSig: t.acceptSig, offer: { id: t.take.offerId, offer: offerToJson(o.offer), sig: o.sig, postedAt: o.postedAt } };
  }

  accepted(): TakeOut[] {
    return [...this.takes.entries()].filter(([, t]) => t.status === 'accepted').map(([id]) => this.takeOut(id)!);
  }

  snapshot(): Snapshot {
    return {
      offers: [...this.offers.entries()].map(([id, o]) => ({ id, offer: offerToJson(o.offer), sig: o.sig, by: o.by, postedAt: o.postedAt, status: o.status, takeId: o.takeId })),
      takes: [...this.takes.entries()].map(([id, t]) => ({ id, take: takeToJson(t.take), sig: t.sig, at: t.at, acceptBy: t.acceptBy, status: t.status, acceptSig: t.acceptSig })),
      alive: [...this.alive.entries()],
    };
  }

  //an entry saved by an older relay that no longer parses is dropped, not the whole book; returns how many
  restore(s: Snapshot): number {
    let dropped = 0;
    const parsed = <T, R>(list: T[], f: (x: T) => R): R[] =>
      list.flatMap((x) => {
        try {
          return [f(x)];
        } catch {
          dropped++;
          return [];
        }
      });
    this.offers = new Map(parsed(s.offers ?? [], (o) => [o.id, { offer: offerFromJson(o.offer), sig: o.sig, by: o.by, postedAt: o.postedAt, status: o.status, takeId: o.takeId }] as const));
    const takes = parsed(s.takes ?? [], (t) => [t.id, { take: takeFromJson(t.take), sig: t.sig, at: t.at, acceptBy: t.acceptBy, status: t.status, acceptSig: t.acceptSig }] as const);
    //takeOut needs the offer of each take
    this.takes = new Map(takes.filter(([, t]) => this.offers.has(t.take.offerId) || (dropped++, false)));
    this.alive = new Map(s.alive ?? []);
    return dropped;
  }
}
