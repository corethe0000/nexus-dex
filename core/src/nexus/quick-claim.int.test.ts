//the claim can follow the reveal before the reveal is in a block (task 45817b54; reveal and claim in ONE transaction
//does not work: the condition reads the slot as it was before the transaction). Private chain:
//NEXUS_NODE=http://127.0.0.1:7080 npx vitest run src/nexus/quick-claim.int.test.ts
import { describe, expect, it } from 'vitest';
import { claimContract, hashOf, lockContract, newSecret, revealContract, type NexusLockTerms } from './htlc';
import { NexusNode, type Credentials } from './node';

const url = process.env.NEXUS_NODE;
const alice: Credentials & { account: string } = { username: 'alice', password: 'alicepass1', pin: '1111', account: '8BoheBPAFeWSKKSzWuQLxVbVz8wbKW6ZVLmgLU2mmUA9xp5FHkb' };
const bob: Credentials & { account: string } = { username: 'bob', password: 'bobpass12', pin: '2222', account: '8CekfnBTnqNDLZAcwVCQP9ge2jbxnAeh2MbVmpKtKtJVkNnahzM' };
const amount = 2n;
const outcome = (p: Promise<unknown>) => p.then((v) => `ACCEPTED ${v}`, (e) => String(e.message));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!url)('claim right after the reveal', () => {
  const node = new NexusNode(url!);

  it('reveal, then claim while the reveal waits for its block', async () => {
    const b0 = await node.accountState(bob.account);
    const a = await node.accountState(alice.account);
    const now = Math.max(Math.floor(Date.now() / 1000), (await node.tip()).timestamp);
    const secret = newSecret();
    const terms: NexusLockTerms = { recipient: b0.owner, sender: a.owner, hashlock: hashOf(secret), deadline: now + 3600 };
    const lockTx = await node.submit(alice, a.owner, (ts) => [lockContract({ address: alice.account, state: a }, bob.account, amount, terms, ts)]);
    await node.waitConfirmed(lockTx);
    const slot = (await node.slot(b0.owner))!;
    const reveal = await node.submit(bob, b0.owner, (ts) => [revealContract(b0.owner, slot, secret, ts)]);
    const seen = await node.slot(b0.owner);
    console.log('slot right after the reveal was accepted shows the secret:', !!seen && seen.value.every((x, i) => x === secret[i]));
    const results: string[] = [];
    for (const wait of [0, 11000]) {
      await sleep(wait);
      const confirmed = (await node.transaction(reveal))?.confirmations ?? 0;
      const b = await node.accountState(bob.account);
      const r = await outcome(node.submit(bob, b.owner, (ts) => [claimContract(lockTx, 0, { address: bob.account, state: b }, alice.account, amount, ts)]));
      console.log(`claim ${wait / 1000} s after the reveal (reveal confirmations ${confirmed}):`, r);
      results.push(r);
      if (r.startsWith('ACCEPTED')) {
        break;
      }
    }
    //accepted while the reveal still waits for its block: the runner claims this way (runner.ts pendingSeen 'reveal')
    expect(results.some((r) => r.startsWith('ACCEPTED'))).toBe(true);
  }, 15 * 60 * 1000);
});
