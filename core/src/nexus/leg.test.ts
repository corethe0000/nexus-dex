//NexusLeg.accountsProblem: a lock is only usable when both accounts hold the agreed token and belong to the agreed
//profiles (security review 2026-11-13: a DEBIT from an account of a worthless token passes every byte check)
import { describe, expect, it } from 'vitest';
import { NexusLeg, parseContracts, type NexusLockExpect } from './leg';
import type { NexusNode } from './node';

const sender = 'a1'.repeat(32);
const recipient = 'b2'.repeat(32);
const accounts: Record<string, { token: string; owner: string }> = {
  senderNxs: { token: '0', owner: sender },
  senderFake: { token: 'FakeTokenAddr', owner: sender },
  recipientNxs: { token: '0', owner: recipient },
  someoneElse: { token: '0', owner: 'c3'.repeat(32) },
};
const node = { accountState: async (a: string) => (accounts[a] ? { ...accounts[a], balance: 0n, created: 0, modified: 0, decimals: 6 } : Promise.reject(new Error('no such register'))) } as unknown as NexusNode;
const leg = new NexusLeg(node, 1);
const expect_ = (from: string, to: string, token?: string): NexusLockExpect => ({ terms: { sender, recipient, hashlock: new Uint8Array(32) }, from, to, amount: 100n, token });

describe('Nexus lock accounts', () => {
  it('agreed token and owners: fine', async () => {
    expect(await leg.accountsProblem(expect_('senderNxs', 'recipientNxs', '0'))).toBeNull();
  });
  it('sender pays from an account of another token: refused', async () => {
    expect(await leg.accountsProblem(expect_('senderFake', 'recipientNxs', '0'))).toBe('lock is in another token than agreed');
  });
  it('an account of someone else: refused', async () => {
    expect(await leg.accountsProblem(expect_('senderNxs', 'someoneElse', '0'))).toBe('lock account belongs to someone else');
  });
  it('an account that does not exist: refused', async () => {
    expect(await leg.accountsProblem(expect_('nothing', 'recipientNxs', '0'))).toBe('account not readable');
  });
  it('records from before the agreed token was kept: both accounts must hold the same token', async () => {
    expect(await leg.accountsProblem(expect_('senderNxs', 'recipientNxs'))).toBeNull();
    expect(await leg.accountsProblem(expect_('senderFake', 'recipientNxs'))).toBe('lock is in another token than agreed');
  });
});

describe('raw transactions from a node', () => {
  it('a length past the end is refused, not read beyond', () => {
    //message byte, 1 contract, op of 5 bytes but only 2 there
    expect(() => parseContracts('01' + '01' + '05' + 'aabb')).toThrow(/cut short/);
    expect(() => parseContracts('01')).toThrow(/cut short/);
    expect(parseContracts('01' + '01' + '02aabb' + '00' + '00')).toEqual([{ op: Uint8Array.from([0xaa, 0xbb]), condition: new Uint8Array(0) }]);
  });
});
