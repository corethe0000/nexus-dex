//Nexus hash lock on the private chain (nexus-dev, nexus-private on 7080), about 5 minutes:
//NEXUS_NODE=http://127.0.0.1:7080 npx vitest run src/nexus/htlc.int.test.ts
import { describe, expect, it } from 'vitest';
import { nameContract } from '../../../../wallet/src/lib/tritium';
import { claimContract, hashOf, lockContract, newSecret, refundContract, revealContract, slotCreateContracts, type NexusLockTerms } from './htlc';
import { NexusNode, type Credentials } from './node';

const url = process.env.NEXUS_NODE;
const alice: Credentials & { account: string } = { username: 'alice', password: 'alicepass1', pin: '1111', account: '8BoheBPAFeWSKKSzWuQLxVbVz8wbKW6ZVLmgLU2mmUA9xp5FHkb' }; //alice:testt
const bob: Credentials & { account: string } = { username: 'bob', password: 'bobpass12', pin: '2222', account: '8CekfnBTnqNDLZAcwVCQP9ge2jbxnAeh2MbVmpKtKtJVkNnahzM' }; //bob:testt
const amount = 3n;
const shortLock = 180;

const outcome = (p: Promise<unknown>) => p.then(() => 'ACCEPTED', (e) => String(e.message));
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

describe.skipIf(!url)('Nexus hash lock: reveal slot + ledger.timestamp deadline', () => {
  const node = new NexusNode(url!);

  it('claims only with the secret before the deadline, refunds after it even without any reveal, refuses a backdated late claim', async () => {
    const b0 = await node.accountState(bob.account);
    if (!(await node.slot(b0.owner))) {
      const tx = await node.submit(bob, b0.owner, (ts) => slotCreateContracts(b0.owner, ts));
      await node.waitConfirmed(tx);
      console.log('created bob reveal slot', tx);
    }
    console.log('bob slot', JSON.stringify(await node.slot(b0.owner), (_, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v)));

    const a = await node.accountState(alice.account);
    const now = Math.max(Math.floor(Date.now() / 1000), (await node.tip()).timestamp);
    const s = [newSecret(), newSecret(), newSecret()];
    const terms: NexusLockTerms[] = [
      { recipient: b0.owner, sender: a.owner, hashlock: hashOf(s[0]!), deadline: now + 3600 }, //claimed
      { recipient: b0.owner, sender: a.owner, hashlock: hashOf(s[1]!), deadline: now + shortLock }, //revealed in time, claim too late
      { recipient: b0.owner, sender: a.owner, hashlock: hashOf(s[2]!), deadline: now + shortLock }, //never revealed
    ];
    const lockTx = await node.submit(alice, a.owner, (ts) => {
      let state = a;
      return terms.map((t) => {
        const out = lockContract({ address: alice.account, state }, bob.account, amount, t, ts);
        state = { ...state, balance: state.balance - amount, modified: ts };
        return out;
      });
    });
    await node.waitConfirmed(lockTx);
    console.log('lock', lockTx);

    const bobClaim = async (contract: number, timestamp?: number) => {
      const b = await node.accountState(bob.account);
      return node.submit(bob, b.owner, (ts) => [claimContract(lockTx, contract, { address: bob.account, state: b }, alice.account, amount, ts)], timestamp);
    };
    const bobReveal = async (secret: Uint8Array) => {
      const slot = (await node.slot(b0.owner))!;
      const tx = await node.submit(bob, b0.owner, (ts) => [revealContract(b0.owner, slot, secret, ts)]);
      return node.waitConfirmed(tx);
    };

    const noSecret = await outcome(bobClaim(0));
    console.log('claim without the secret in the slot:', noSecret);
    expect(noSecret).not.toBe('ACCEPTED');

    const aLocked = await node.accountState(alice.account);
    const early = await outcome(node.submit(alice, a.owner, (ts) => [refundContract(lockTx, 2, { address: alice.account, state: aLocked }, amount, ts)]));
    console.log('refund before the deadline:', early);
    expect(early).not.toBe('ACCEPTED');

    //reveal and claim in one transaction: does the condition see the write of the same transaction?
    const bNow = await node.accountState(bob.account);
    const slotNow = (await node.slot(b0.owner))!;
    const oneTx = await outcome(
      node.submit(bob, b0.owner, (ts) => [revealContract(b0.owner, slotNow, s[0]!, ts), claimContract(lockTx, 0, { address: bob.account, state: bNow }, alice.account, amount, ts)]).then((tx) => node.waitConfirmed(tx)),
    );
    console.log('reveal + claim in one transaction:', oneTx);
    if (oneTx !== 'ACCEPTED') {
      await bobReveal(s[0]!);
      const claimTx = await bobClaim(0);
      await node.waitConfirmed(claimTx);
      console.log('reveal, then claim: accepted', claimTx);
    }
    expect(same((await node.slot(b0.owner))!.value, s[0]!)).toBe(true);
    expect((await node.accountState(bob.account)).balance).toBe(b0.balance + amount);

    //lock 1: bob reveals before the deadline, then tries to claim after it with the reveal's timestamp
    const reveal1 = await bobReveal(s[1]!);
    const revealTs = reveal1.timestamp as number;
    expect(revealTs).toBeLessThan(terms[1]!.deadline);
    const waitMs = (terms[1]!.deadline + 5 - Math.floor(Date.now() / 1000)) * 1000;
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
    //the private chain makes blocks only for transactions: a filler so a block after the deadline exists
    const aFill = await node.accountState(alice.account);
    const filler = await node.submit(alice, a.owner, (ts) => [nameContract(aFill.owner, 'fill-' + Date.now(), new Uint8Array(32), false, ts)]);
    await node.waitConfirmed(filler);
    const tip = await node.tip();
    expect(tip.timestamp).toBeGreaterThanOrEqual(terms[1]!.deadline);

    const [lastBob] = await node.call('ledger/list/transactions', { genesis: b0.owner, limit: 1 });
    const lastBobTs = (await node.transaction(lastBob.txid)).timestamp as number;
    expect(lastBobTs).toBeLessThan(terms[1]!.deadline);
    const late = await outcome(bobClaim(1, lastBobTs));
    console.log('claim after the deadline with timestamp', lastBobTs, '< deadline', terms[1]!.deadline, ':', late);
    expect(late).not.toBe('ACCEPTED');

    //refunds of lock 1 (revealed, unclaimed) and lock 2 (never revealed)
    const aNow = await node.accountState(alice.account);
    const refundTx = await node.submit(alice, a.owner, (ts) => {
      const after = { ...aNow, balance: aNow.balance + amount, modified: ts };
      return [refundContract(lockTx, 1, { address: alice.account, state: aNow }, amount, ts), refundContract(lockTx, 2, { address: alice.account, state: after }, amount, ts)];
    });
    await node.waitConfirmed(refundTx);
    expect((await node.accountState(alice.account)).balance).toBe(aNow.balance + 2n * amount);
    console.log('refunds after the deadline: accepted', refundTx);
  }, 1500000);
});
