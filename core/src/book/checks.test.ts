//what a client checks itself instead of trusting the relay (security review 2026-11-13): the maker's take check, the
//taker's offer check and the accept signature
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { acceptOk, hashlockUsed, idOf, offerProblemForTaker, offerToJson, takeProblemForMaker, takeToJson, typed, type Kind, type Offer, type Take } from './offer';

const maker = privateKeyToAccount(generatePrivateKey());
const agent = privateKeyToAccount(generatePrivateKey());
const taker = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const sign = (who: typeof maker, kind: Kind, message: unknown): Promise<Hex> => who.signTypedData(typed(kind, message as any) as any);
const now = 1_800_000_000;

//maker sells 100 NXS units for 50 USDT units
const offer: Offer = {
  maker: maker.address,
  agent: agent.address,
  nexusAccount: '8BoheBPAFeWSKKSzWuQLxVbVz8wbKW6ZVLmgLU2mmUA9xp5FHkb',
  nexusGenesis: 'a1'.repeat(32),
  makerGivesNexus: true,
  nexusToken: '0',
  nexusAmount: 100n,
  evmChainId: 31337n,
  evmToken: '0x0000000000000000000000000000000000000001',
  evmAmount: 50n,
  expires: BigInt(now + 3600),
  nonce: 7n,
};
const offerId = idOf('Offer', offer);
const take: Take = { offerId, taker: taker.address, agent: taker.address, nexusAccount: '8CekfnBTnqNDLZAcwVCQP9ge2jbxnAeh2MbVmpKtKtJVkNnahzM', nexusGenesis: 'b2'.repeat(32), hashlock: `0x${'11'.repeat(32)}`, expires: BigInt(now + 600) };
const takeId = idOf('Take', take);

describe('maker checks a take itself', () => {
  it('a take of my offer signed by the taker: fine', async () => {
    expect(await takeProblemForMaker(offer, offerId, { id: takeId, take: takeToJson(take), sig: await sign(taker, 'Take', take) }, now)).toBeNull();
  });
  it('signed by someone else: refused', async () => {
    expect(await takeProblemForMaker(offer, offerId, { id: takeId, take: takeToJson(take), sig: await sign(stranger, 'Take', take) }, now)).toBe('take not signed by the taker');
  });
  it('for another offer, or terms changed under its id, or expired: refused', async () => {
    const other = { ...take, offerId: `0x${'22'.repeat(32)}` as Hex };
    expect(await takeProblemForMaker(offer, offerId, { id: idOf('Take', other), take: takeToJson(other), sig: await sign(taker, 'Take', other) }, now)).toBe('take for another offer');
    const changed = { ...take, nexusAccount: 'SomeOtherAccount' };
    expect(await takeProblemForMaker(offer, offerId, { id: takeId, take: takeToJson(changed), sig: await sign(taker, 'Take', take) }, now)).toBe('take id does not match its terms');
    expect(await takeProblemForMaker(offer, offerId, { id: takeId, take: takeToJson(take), sig: await sign(taker, 'Take', take) }, now + 601)).toBe('take expired');
  });
});

describe('taker checks the offer and the accept', () => {
  it('the offer as signed: fine; other terms under the same id: refused', async () => {
    const sig = await sign(maker, 'Offer', offer);
    expect(await offerProblemForTaker({ id: offerId, offer: offerToJson(offer), sig, postedAt: now })).toBeNull();
    const cheaper = { ...offer, nexusAmount: 1n };
    expect(await offerProblemForTaker({ id: offerId, offer: offerToJson(cheaper), sig, postedAt: now })).toBe('offer id does not match its terms');
    expect(await offerProblemForTaker({ id: offerId, offer: offerToJson(offer), sig: await sign(stranger, 'Offer', offer), postedAt: now })).toBe('offer not signed by its maker');
  });
  it('accepted only with the maker agent signature on this take', async () => {
    expect(await acceptOk(offer, takeId, await sign(agent, 'Accept', { takeId }))).toBe(true);
    expect(await acceptOk(offer, takeId, await sign(stranger, 'Accept', { takeId }))).toBe(false);
    expect(await acceptOk(offer, takeId, await sign(agent, 'Accept', { takeId: `0x${'33'.repeat(32)}` }))).toBe(false);
    expect(await acceptOk(offer, takeId, undefined)).toBe(false);
  });
});

describe('maker refuses a hashlock it has seen', () => {
  it('a take with the hashlock of an earlier swap (any case, with or without 0x): refused; a new one: fine', () => {
    const t = { take: takeToJson(take) };
    expect(hashlockUsed(t, [{ hashlock: '11'.repeat(32) }])).toBe(true);
    expect(hashlockUsed(t, [{ hashlock: `0X${'11'.repeat(32).toUpperCase()}` }])).toBe(true);
    expect(hashlockUsed(t, [{ hashlock: '12'.repeat(32) }])).toBe(false);
    expect(hashlockUsed(t, [])).toBe(false);
  });
});
