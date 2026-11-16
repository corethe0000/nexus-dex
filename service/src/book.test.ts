import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { idOf, newNonce, offerFromJson, offerToJson, swapRecord, takeFromJson, takeToJson, typed, type Kind, type Offer, type Take } from '../../core/src/book/offer';
import { Book, BookError, defaultBookSettings } from './book';

//throwaway keys for this test only
const maker = privateKeyToAccount('0x1111111111111111111111111111111111111111111111111111111111111111');
const taker = privateKeyToAccount('0x2222222222222222222222222222222222222222222222222222222222222222');
const other = privateKeyToAccount('0x3333333333333333333333333333333333333333333333333333333333333333');
const agent = privateKeyToAccount('0x4444444444444444444444444444444444444444444444444444444444444444'); //the maker page's session key
const usdt = '0x00000000000000000000000000000000000000aa';
const t0 = 1_800_000_000;

const sign = (who: typeof maker, kind: Kind, message: any): Promise<Hex> => who.signTypedData(typed(kind, message) as any);

function newBook() {
  return new Book({ ...defaultBookSettings, chains: { '56': { tokens: [usdt] } } });
}

function offer(o: Partial<Offer> = {}): Offer {
  return {
    maker: maker.address,
    agent: agent.address,
    nexusAccount: '8BoheBPAFeWSKKSzWuQLxVbVz8wbKW6ZVLmgLU2mmUA9xp5FHkb',
    nexusGenesis: 'a1'.repeat(32),
    makerGivesNexus: true,
    nexusToken: '0',
    nexusAmount: 100_000000n,
    evmChainId: 56n,
    evmToken: usdt,
    evmAmount: 25_000000n,
    expires: BigInt(t0 + 3600),
    nonce: newNonce(),
    ...o,
  };
}

function take(offerId: Hex, t: Partial<Take> = {}): Take {
  return {
    offerId,
    taker: taker.address,
    agent: taker.address,
    nexusAccount: '8CekfnBTnqNDLZAcwVCQP9ge2jbxnAeh2MbVmpKtKtJVkNnahzM',
    nexusGenesis: 'b2'.repeat(32),
    hashlock: `0x${'cd'.repeat(32)}`,
    expires: BigInt(t0 + 600),
    ...t,
  };
}

async function posted(b: Book, o = offer()) {
  return b.post(offerToJson(o), await sign(maker, 'Offer', o), t0);
}

async function rejects(p: Promise<unknown>, status: number) {
  const e = await p.then(
    () => null,
    (x) => x,
  );
  expect(e).toBeInstanceOf(BookError);
  expect((e as BookError).status).toBe(status);
}

describe('order book', () => {
  it('lists an offer while its maker is online', async () => {
    const b = newBook();
    const id = await posted(b);
    expect(b.list(t0 + 10).map((o) => o.id)).toEqual([id]);
    expect(b.list(t0 + 200)).toEqual([]); //maker silent
    const at = t0 + 200;
    await b.beat(agent.address, at, await sign(agent, 'Alive', { agent: agent.address, at: BigInt(at) }), at);
    expect(b.list(at + 1).map((o) => o.id)).toEqual([id]);
    expect(b.list(t0 + 3600)).toEqual([]); //expired
  });

  it('refuses offers that are not signed by the maker, unsupported, expired or repeated', async () => {
    const b = newBook();
    const o = offer();
    await rejects(b.post(offerToJson(o), await sign(other, 'Offer', o), t0), 401);
    const bad = offer({ evmToken: '0x00000000000000000000000000000000000000bb' });
    await rejects(b.post(offerToJson(bad), await sign(maker, 'Offer', bad), t0), 400);
    const old = offer({ expires: BigInt(t0 - 1) });
    await rejects(b.post(offerToJson(old), await sign(maker, 'Offer', old), t0), 400);
    const wrongChain = offer({ evmChainId: 137n });
    await rejects(b.post(offerToJson(wrongChain), await sign(maker, 'Offer', wrongChain), t0), 400);
    await posted(b, o);
    await rejects(b.post(offerToJson(o), await sign(maker, 'Offer', o), t0), 409);
  });

  it('turns junk into a bad request, not a crash', async () => {
    const b = newBook();
    await rejects(b.post({ maker: 'x' } as any, `0x${'00'.repeat(65)}`, t0), 400);
    await rejects(b.take({ offerId: 5 } as any, `0x${'00'.repeat(65)}`, t0), 400);
    const o = offer();
    await rejects(b.post(offerToJson(o), `0x${'00'.repeat(65)}`, t0), 401);
  });

  it('take reserves the offer; one waiting take per taker; only the maker accepts', async () => {
    const b = newBook();
    const id = await posted(b);
    const id2 = await posted(b);
    const tk = take(id);
    await rejects(b.take(takeToJson(tk), await sign(other, 'Take', tk), t0 + 1), 401);
    const own = take(id, { taker: maker.address });
    await rejects(b.take(takeToJson(own), await sign(maker, 'Take', own), t0 + 1), 400);
    const r = await b.take(takeToJson(tk), await sign(taker, 'Take', tk), t0 + 1);
    expect(r.acceptBy).toBe(t0 + 1 + defaultBookSettings.acceptWindow);
    expect(b.list(t0 + 2).map((o) => o.id)).toEqual([id2]);
    const tk2 = take(id2);
    await rejects(b.take(takeToJson(tk2), await sign(taker, 'Take', tk2), t0 + 2), 429);
    const tk3 = take(id, { taker: other.address });
    await rejects(b.take(takeToJson(tk3), await sign(other, 'Take', tk3), t0 + 2), 409);
    //another taker on the free offer with a hashlock already in use: refused (one Nexus lock could back both)
    const same = take(id2, { taker: other.address, agent: other.address });
    await rejects(b.take(takeToJson(same), await sign(other, 'Take', same), t0 + 2), 409);
    //the maker's page sees it when it beats; a beat signed by the maker's wallet instead of the agent is refused
    const at = t0 + 5;
    await rejects(b.beat(agent.address, at, await sign(maker, 'Alive', { agent: agent.address, at: BigInt(at) }), at), 401);
    const waiting = await b.beat(agent.address, at, await sign(agent, 'Alive', { agent: agent.address, at: BigInt(at) }), at);
    expect(waiting.map((w) => w.id)).toEqual([r.id]);
    await rejects(b.accept(r.id, await sign(taker, 'Accept', { takeId: r.id }), t0 + 6), 401);
    await rejects(b.accept(r.id, await sign(maker, 'Accept', { takeId: r.id }), t0 + 6), 401);
    await b.accept(r.id, await sign(agent, 'Accept', { takeId: r.id }), t0 + 6);
    expect(b.takeOut(r.id)!.status).toBe('accepted');
    expect(b.accepted().map((a) => a.id)).toEqual([r.id]);
    await rejects(b.cancel(id, await sign(maker, 'Cancel', { offerId: id })), 409);
  });

  it('a take not accepted in time lapses and the offer opens again', async () => {
    const b = newBook();
    const id = await posted(b);
    const tk = take(id);
    const r = await b.take(takeToJson(tk), await sign(taker, 'Take', tk), t0 + 1);
    const late = t0 + 2 + defaultBookSettings.acceptWindow;
    await rejects(b.accept(r.id, await sign(agent, 'Accept', { takeId: r.id }), late), 409);
    expect(b.takeOut(r.id)!.status).toBe('lapsed');
    expect(b.list(late).map((o) => o.id)).toEqual([id]);
    //a day later the lapsed take is forgotten
    b.sweep(r.acceptBy + 86401);
    expect(b.takeOut(r.id)).toBeNull();
  });

  it('an accepted swap is forgotten after 14 days, with its filled offer', async () => {
    const b = newBook();
    const id = await posted(b);
    const tk = take(id);
    const r = await b.take(takeToJson(tk), await sign(taker, 'Take', tk), t0 + 1);
    await b.beat(agent.address, t0 + 2, await sign(agent, 'Alive', { agent: agent.address, at: BigInt(t0 + 2) }), t0 + 2);
    await b.accept(r.id, await sign(agent, 'Accept', { takeId: r.id }), t0 + 3);
    b.sweep(t0 + 13 * 86400);
    expect(b.accepted().map((a) => a.id)).toEqual([r.id]);
    b.sweep(t0 + 15 * 86400);
    expect(b.accepted()).toEqual([]);
    expect(b.snapshot().offers.map((o) => o.id)).not.toContain(id);
  });

  it('cancel by the maker or its agent only', async () => {
    const b = newBook();
    const id = await posted(b);
    await rejects(b.cancel(id, await sign(other, 'Cancel', { offerId: id })), 401);
    await b.cancel(id, await sign(maker, 'Cancel', { offerId: id }));
    expect(b.list(t0 + 1)).toEqual([]);
    const id2 = await posted(b);
    await b.cancel(id2, await sign(agent, 'Cancel', { offerId: id2 }));
    expect(b.list(t0 + 1)).toEqual([]);
  });

  it('receive only: the agent key may sign only for a side that gets USDT/USDC', async () => {
    const b = newBook();
    //maker sells NXS (gets USDT): its agent may sign the offer
    const sells = offer({ makerGivesNexus: true });
    const sellId = await b.post(offerToJson(sells), await sign(agent, 'Offer', sells), t0);
    //maker buys NXS (pays USDT): only its own wallet
    const buys = offer({ makerGivesNexus: false });
    await rejects(b.post(offerToJson(buys), await sign(agent, 'Offer', buys), t0), 401);
    const buyId = await posted(b, buys);
    //taker of a buy offer gives NXS (gets USDT): a page key named in the take may sign it
    const pageKey = other;
    const tk = take(buyId, { agent: pageKey.address });
    await b.take(takeToJson(tk), await sign(pageKey, 'Take', tk), t0 + 1);
    //taker of a sell offer pays USDT: the page key is not enough
    const tk2 = take(sellId, { taker: other.address, agent: agent.address });
    await rejects(b.take(takeToJson(tk2), await sign(agent, 'Take', tk2), t0 + 1), 401);
  });

  it('refuses offers above a token size limit, takes ones up to it', async () => {
    const b = new Book({ ...defaultBookSettings, chains: { '56': { tokens: [usdt], limits: { [usdt]: 25_000000n } } } });
    const big = offer({ evmAmount: 25_000001n });
    await rejects(b.post(offerToJson(big), await sign(maker, 'Offer', big), t0), 400);
    const ok = offer({ evmAmount: 25_000000n });
    await b.post(offerToJson(ok), await sign(maker, 'Offer', ok), t0);
  });

  it('void: the maker agent opens the offer again when the taker never locked', async () => {
    const b = newBook();
    const id = await posted(b);
    const tk = take(id);
    const r = await b.take(takeToJson(tk), await sign(taker, 'Take', tk), t0 + 1);
    await rejects(b.void(r.id, await sign(agent, 'Void', { takeId: r.id }), t0 + 2), 409); //not accepted yet
    await b.accept(r.id, await sign(agent, 'Accept', { takeId: r.id }), t0 + 3);
    await rejects(b.void(r.id, await sign(taker, 'Void', { takeId: r.id }), t0 + 4), 401);
    await rejects(b.void(r.id, await sign(maker, 'Void', { takeId: r.id }), t0 + 4), 401);
    await b.void(r.id, await sign(agent, 'Void', { takeId: r.id }), t0 + 4);
    expect(b.takeOut(r.id)!.status).toBe('void');
    expect(b.accepted()).toEqual([]);
    expect(b.list(t0 + 5).map((o) => o.id)).toEqual([id]);
    //another taker can take it now
    const tk2 = take(id, { taker: other.address, agent: other.address, hashlock: `0x${'ef'.repeat(32)}` });
    await b.take(takeToJson(tk2), await sign(other, 'Take', tk2), t0 + 6);
  });

  it('the offer quota counts who signed, not the maker an offer names', async () => {
    const b = new Book({ ...defaultBookSettings, maxOffersPerMaker: 2, chains: { '56': { tokens: [usdt] } } });
    //someone else's receive-only offers name our maker (signed by their own agent key)
    for (let i = 0; i < 2; i++) {
      const o = offer({ agent: other.address });
      await b.post(offerToJson(o), await sign(other, 'Offer', o), t0);
    }
    const third = offer({ agent: other.address });
    await rejects(b.post(offerToJson(third), await sign(other, 'Offer', third), t0), 429);
    //the real maker can still post
    const mine = offer({ agent: taker.address });
    await b.post(offerToJson(mine), await sign(maker, 'Offer', mine), t0);
  });

  it("an offer cannot name another maker's agent key", async () => {
    const b = newBook();
    await posted(b);
    const thief = offer({ maker: other.address });
    await rejects(b.post(offerToJson(thief), await sign(other, 'Offer', thief), t0), 409);
  });

  it('keeps only the known fields of an offer and a take', async () => {
    const o = offerToJson(offer());
    const parsed = offerFromJson({ ...o, extra: 'x'.repeat(5000) } as any);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(o).sort());
    expect(() => offerFromJson({ ...o, nexusAccount: 5 } as any)).toThrow();
    expect(() => offerFromJson({ ...o, nexusAmount: '-1' } as any)).toThrow();
    expect(() => offerFromJson({ ...o, makerGivesNexus: 'yes' } as any)).toThrow();
    const tk = takeToJson(take(`0x${'aa'.repeat(32)}`));
    expect(Object.keys(takeFromJson({ ...tk, more: {} } as any)).sort()).toEqual(Object.keys(tk).sort());
  });

  it('forgets makers that went silent', async () => {
    const b = newBook();
    await posted(b);
    expect(b.snapshot().alive.length).toBe(1);
    b.sweep(t0 + defaultBookSettings.aliveWindow + 1);
    expect(b.snapshot().alive.length).toBe(0);
  });

  it('survives a restart', async () => {
    const b = newBook();
    const id = await posted(b);
    const tk = take(id);
    const r = await b.take(takeToJson(tk), await sign(taker, 'Take', tk), t0 + 1);
    const b2 = newBook();
    b2.restore(JSON.parse(JSON.stringify(b.snapshot())));
    await b2.accept(r.id, await sign(agent, 'Accept', { takeId: r.id }), t0 + 3);
    expect(b2.accepted().map((a) => a.id)).toEqual([r.id]);
  });

  it('a saved entry of an older relay that no longer parses is dropped, the rest stays', async () => {
    const b = newBook();
    const id = await posted(b);
    const tk = take(id);
    await b.take(takeToJson(tk), await sign(taker, 'Take', tk), t0 + 1);
    const s = JSON.parse(JSON.stringify(b.snapshot()));
    delete s.takes[0].take.agent;
    const b2 = newBook();
    expect(b2.restore(s)).toBe(1);
    expect(b2.snapshot().offers.map((o) => o.id)).toEqual([id]);
    expect(b2.snapshot().takes.length).toBe(0);
  });
});

describe('swap terms from an offer and a take', () => {
  it('taker gives what the maker asks: maker sells NXS for USDT', () => {
    const o = offer({ makerGivesNexus: true });
    const tk = take(idOf('Offer', o));
    const r = swapRecord(o, tk, 'initiator');
    expect(r.initiatorChain).toBe('evm'); //the taker locks USDT first
    expect(r.evm.sender).toBe(taker.address);
    expect(r.evm.recipient).toBe(maker.address);
    expect(r.nexus.from).toBe(o.nexusAccount);
    expect(r.nexus.to).toBe(tk.nexusAccount);
    expect(r.nexus.sender).toBe(o.nexusGenesis);
    expect(r.evm.nexusRef).toBe(idOf('Take', tk));
    expect(r.hashlock).toBe('cd'.repeat(32));
  });

  it('maker buys NXS with USDT', () => {
    const o = offer({ makerGivesNexus: false });
    const tk = take(idOf('Offer', o));
    const r = swapRecord(o, tk, 'participant');
    expect(r.initiatorChain).toBe('nexus');
    expect(r.evm.sender).toBe(maker.address);
    expect(r.evm.recipient).toBe(taker.address);
    expect(r.nexus.from).toBe(tk.nexusAccount);
    expect(r.nexus.recipient).toBe(o.nexusGenesis);
  });
});
