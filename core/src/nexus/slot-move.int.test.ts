//the reveal slot is a name and can be transferred (security review 2026-11-14): the lock is claimable only while the
//recipient owns the slot, and the secret is found when it was written while another profile held the slot. Private chain:
//  NEXUS_NODE=http://127.0.0.1:7080 EVM_RPC=http://127.0.0.1:8545 CONTRACTS=$HOME/dex/contracts/out npx vitest run src/nexus/slot-move.int.test.ts
import { describe, expect, it } from 'vitest';
import { claimContract as claimRegister, memoryOfHex, nameState, nameWriteContract, stateAfter, transferContract } from '../../../../wallet/src/lib/tritium';
import { alice, bob, ensureSlot, haveLocal, localChains } from '../testing/local';
import { claimContract, hashOf, lockContract, newSecret, slotAddress, slotName } from './htlc';
import { NexusLeg } from './leg';
import { localSigner } from './signer';

const amount = 2n;
const gap = () => new Promise((r) => setTimeout(r, 11000));
const outcome = (p: Promise<unknown>) => p.then(() => 'ACCEPTED', (e) => String(e.message));
const asName = (s: { created: number; modified: number; value: Uint8Array }) => ({ created: s.created, modified: s.modified, address: s.value });
const hex = (b: Uint8Array | null) => (b ? Buffer.from(b).toString('hex') : null);

describe.skipIf(!haveLocal)('reveal slot moved to another profile', () => {
  it('no claim while another profile holds the slot; the secret is found after it came back', async () => {
    const { node } = localChains();
    const aliceG = await ensureSlot(node, alice);
    const bobG = (await node.accountState(bob.account)).owner;
    const slot = slotAddress(aliceG);
    const raw = async (txid: string) => (await node.call('ledger/get/transaction', { hash: txid, format: 'raw' })).data as string;
    const confirmed = async (p: Promise<string>) => {
      const tx = await p;
      await node.waitConfirmed(tx);
      await gap();
      return tx;
    };

    //bob locks three amounts for alice, one per way back
    const secrets = [newSecret(), newSecret(), newSecret()];
    const start = Math.floor(Date.now() / 1000);
    const now = Math.max(Math.floor(Date.now() / 1000), (await node.tip()).timestamp);
    const terms = secrets.map((s) => ({ recipient: aliceG, sender: bobG, hashlock: hashOf(s), deadline: now + 3600 }));
    const b0 = await node.accountState(bob.account);
    const lockTx = await confirmed(
      node.submit(bob, bobG, (ts) => {
        let state = b0;
        return terms.map((t) => {
          const out = lockContract({ address: bob.account, state }, alice.account, amount, t, ts);
          state = { ...state, balance: state.balance - amount, modified: ts };
          return out;
        });
      }),
    );
    const aliceClaim = async (contract: number) => {
      const a = await node.accountState(alice.account);
      return node.submit(alice, aliceG, (ts) => [claimContract(lockTx, contract, { address: alice.account, state: a }, bob.account, amount, ts)]);
    };
    //alice hands the slot to bob, bob takes it and writes the secret into it
    //to: bob, or the wildcard address with a condition only bob meets (then nothing names bob before he claims it)
    const handOver = async (secret: Uint8Array, wildcard = false) => {
      const s0 = (await node.slot(aliceG))!;
      const to = wildcard ? 'f'.repeat(64) : bobG;
      const onlyBob = wildcard ? Uint8Array.from([0xc0, 0x80, 0x74, ...memoryOfHex(bobG)]) : new Uint8Array(0);
      const out = await confirmed(node.submit(alice, aliceG, (ts) => [transferContract(aliceG, slot, to, nameState(aliceG, slotName, asName(s0)), onlyBob, ts)]));
      const pending = stateAfter(await raw(out), slot);
      await confirmed(node.submit(bob, bobG, (ts) => [claimRegister(bobG, out, 0, slot, pending, ts)]));
      const s1 = (await node.slot(aliceG))!;
      await confirmed(node.submit(bob, bobG, (ts) => [nameWriteContract(bobG, slotName, asName(s1), secret, ts, aliceG)]));
    };
    //alice claims, then writes the slot again to hide the secret; the other side looks for it from the claim
    const claimAndHide = async (contract: number) => {
      const claimTx = await confirmed(aliceClaim(contract));
      await confirmed(localSigner(node, alice, aliceG).reveal(newSecret()));
      return claimTx;
    };

    //way back 1: a forced transfer, nothing about it in alice's sigchain
    await handOver(secrets[0]!);
    const held = await outcome(aliceClaim(0).then((tx) => node.waitConfirmed(tx)));
    console.log('claim while bob holds the slot:', held);
    expect(held).not.toBe('ACCEPTED');
    const s2 = (await node.slot(aliceG))!;
    await confirmed(node.submit(bob, bobG, (ts) => [transferContract(bobG, slot, aliceG, nameState(bobG, slotName, asName(s2)), new Uint8Array(0), ts, true)]));
    const claim0 = await claimAndHide(0);
    expect(hex(await new NexusLeg(node, 1).findSecret(aliceG, terms[0]!.hashlock, true, claim0))).toBe(hex(secrets[0]!));

    //way back 2: bob sends it back and alice claims the register
    await handOver(secrets[1]!);
    const s3 = (await node.slot(aliceG))!;
    const back = await confirmed(node.submit(bob, bobG, (ts) => [transferContract(bobG, slot, aliceG, nameState(bobG, slotName, asName(s3)), new Uint8Array(0), ts)]));
    const pending = stateAfter(await raw(back), slot);
    await confirmed(node.submit(alice, aliceG, (ts) => [claimRegister(aliceG, back, 0, slot, pending, ts)]));
    const claim1 = await claimAndHide(1);
    expect(hex(await new NexusLeg(node, 1).findSecret(aliceG, terms[1]!.hashlock, true, claim1))).toBe(hex(secrets[1]!));

    //way back 3: through the wildcard address and a forced transfer: no trail, found by reading the blocks since the start
    await handOver(secrets[2]!, true);
    const s4 = (await node.slot(aliceG))!;
    await confirmed(node.submit(bob, bobG, (ts) => [transferContract(bobG, slot, aliceG, nameState(bobG, slotName, asName(s4)), new Uint8Array(0), ts, true)]));
    const claim2 = await claimAndHide(2);
    expect(await new NexusLeg(node, 1).findSecret(aliceG, terms[2]!.hashlock, true, claim2)).toBeNull();
    expect(hex(await new NexusLeg(node, 1).findSecret(aliceG, terms[2]!.hashlock, true, claim2, start - 60))).toBe(hex(secrets[2]!));
  }, 15 * 60 * 1000);
});
