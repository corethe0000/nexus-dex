//DEX phase 0 spike: hash locked DEBIT on Nexus, claimable only once SK256(state of register A) == H
//runs from a copy in the wallet tree (imports ./tritium): cp to ~/wallet/src/lib/dex-hashlock.int.test.ts in nexus-dev, then
//TRITIUM_NODE=http://127.0.0.1:7080 npx vitest run src/lib/dex-hashlock.int.test.ts
import { describe, expect, it } from 'vitest';
import { creditContract, debitContract, memoryOfHex, sequenceKey, signTx, sk256, sk64, type AccountState } from './tritium';

const node = process.env.TRITIUM_NODE;
const maker = { user: 'alice', pass: 'alicepass1', pin: '1111', account: '8BoheBPAFeWSKKSzWuQLxVbVz8wbKW6ZVLmgLU2mmUA9xp5FHkb' }; //alice:testt
const taker = { user: 'bob', pass: 'bobpass12', pin: '2222', account: '8CekfnBTnqNDLZAcwVCQP9ge2jbxnAeh2MbVmpKtKtJVkNnahzM' }; //bob:testt
const lockSeconds = 900;
const amount = 5n;
const feeIntervalSeconds = 10;

const c = { u64: 0x73, u256: 0x74, eq: 0x80, lt: 0x81, gt: 0x82, add: 0x90, and: 0xa0, or: 0xa1, group: 0xa2, ungroup: 0xa3, callerGenesis: 0xc0, callerTs: 0xc1, contractTs: 0xcb, regState: 0xb4, sk256: 0xe0 };

class Bytes {
  private out: number[] = [];
  u8(v: number) { this.out.push(v & 0xff); return this; }
  u64(v: bigint) { for (let i = 0; i < 8; i++) { this.out.push(Number((v >> BigInt(8 * i)) & 0xffn)); } return this; }
  raw(b: Uint8Array) { this.out.push(...b); return this; }
  vec(b: Uint8Array) { if (b.length >= 253) { throw new Error('vec too long'); } return this.u8(b.length).raw(b); }
  bytes() { return Uint8Array.from(this.out); }
}

//(taker AND SK256(state of A) == H AND before expiry) OR (maker AND after expiry)
function hashlockCondition(takerGenesis: string, makerGenesis: string, register: Uint8Array, hash: Uint8Array, seconds: number): Uint8Array {
  const w = new Bytes();
  const expiry = (cmp: number) => w.u8(c.contractTs).u8(c.add).u8(c.u64).u64(BigInt(seconds)).u8(cmp).u8(c.callerTs);
  w.u8(c.group).u8(c.callerGenesis).u8(c.eq).u8(c.u256).raw(memoryOfHex(takerGenesis));
  w.u8(c.and).u8(c.u256).raw(register).u8(c.regState).u8(c.sk256).u8(c.eq).u8(c.u256).raw(hash);
  w.u8(c.and);
  expiry(c.gt);
  w.u8(c.ungroup).u8(c.or).u8(c.group).u8(c.callerGenesis).u8(c.eq).u8(c.u256).raw(memoryOfHex(makerGenesis)).u8(c.and);
  expiry(c.lt);
  return w.u8(c.ungroup).bytes();
}

//OP::CREATE of a READONLY register holding the secret
function secretRegister(genesis: string, address: Uint8Array, data: Uint8Array, ts: number): Uint8Array {
  const readonly = 0x01;
  const op = new Bytes().u8(0x02).raw(address).u8(readonly).vec(data).bytes();
  const state = new Bytes().u8(1).u8(readonly).raw(memoryOfHex(genesis)).u64(BigInt(ts)).u64(BigInt(ts)).vec(data).bytes();
  return new Bytes().vec(op).vec(new Uint8Array(0)).vec(new Bytes().u8(0x02).u64(sk64(state)).bytes()).bytes();
}

async function call(method: string, params: Record<string, unknown> = {}) {
  const res = await fetch(`${node}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
  const body = await res.json();
  if (body.error) {
    throw new Error(`${method}: ${body.error.code} ${body.error.message}`);
  }
  return body.result;
}

async function accountState(address: string): Promise<AccountState> {
  const a = await call('register/get/any', { address });
  const t = await call('register/get/any', { address: a.token });
  return { owner: a.owner, created: a.created, modified: a.modified, balance: BigInt(Math.round(a.balance * 10 ** t.decimals)), token: a.token };
}

async function submitAs(who: typeof maker, genesis: string, contracts: (ts: number) => Uint8Array[]): Promise<string> {
  const [last] = await call('ledger/list/transactions', { genesis, limit: 1 });
  const prev = await call('ledger/get/transaction', { hash: last.txid, verbose: 'summary' });
  const wait = prev.timestamp + feeIntervalSeconds + 1 - Math.floor(Date.now() / 1000);
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  const key = await sequenceKey(who.user, who.pass, who.pin, prev.sequence + 1);
  const nextKey = await sequenceKey(who.user, who.pass, who.pin, prev.sequence + 2);
  const signed = signTx({ txid: prev.txid, sequence: prev.sequence, timestamp: prev.timestamp, genesis }, contracts, Math.max(Math.floor(Date.now() / 1000), prev.timestamp), key, nextKey);
  const r = await call('ledger/submit/transaction', { data: signed.data });
  expect(r?.hash).toBe(signed.txid);
  return signed.txid;
}

async function confirmed(txid: string) {
  for (let i = 0; i < 120; i++) {
    const tx = await call('ledger/get/transaction', { hash: txid, verbose: 'summary' }).catch(() => null);
    if (tx?.confirmations > 0) {
      return tx;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`not confirmed: ${txid}`);
}

describe.skipIf(!node)('DEX hashlock on Nexus', () => {
  it('claims only with the secret in the register', async () => {
    const m = await accountState(maker.account);
    const t0 = await accountState(taker.account);
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const hash = sk256(secret);
    const wrongHash = sk256(crypto.getRandomValues(new Uint8Array(32)));
    const register = crypto.getRandomValues(new Uint8Array(32));
    register[31] = 0xd1;

    //contract 0 = right hash, contract 1 = a hash nobody can meet
    const lockTx = await submitAs(maker, m.owner, (ts) => {
      const first = debitContract({ from: { address: maker.account, state: m }, to: taker.account, amount, condition: hashlockCondition(t0.owner, m.owner, register, hash, lockSeconds) }, ts);
      const after = { ...m, balance: m.balance - amount, modified: ts };
      const second = debitContract({ from: { address: maker.account, state: after }, to: taker.account, amount, condition: hashlockCondition(t0.owner, m.owner, register, wrongHash, lockSeconds) }, ts);
      return [first, second];
    });
    console.log('lock', lockTx);
    console.log('conditions', JSON.stringify((await confirmed(lockTx)).contracts.map((x: { conditions?: string }) => x.conditions)));

    const claim = async (contract: number) => {
      const t = await accountState(taker.account);
      return submitAs(taker, t.owner, (ts) => [creditContract({ debitTxid: lockTx, contract, to: { address: taker.account, state: t }, from: maker.account, amount }, ts)]);
    };

    const early = await claim(0).then(() => 'ACCEPTED', (e) => String(e.message));
    console.log('claim before the secret register:', early);
    expect(early).not.toBe('ACCEPTED');

    const regTx = await submitAs(taker, t0.owner, (ts) => [secretRegister(t0.owner, register, secret, ts)]);
    await confirmed(regTx);
    console.log('secret register', regTx);

    const wrong = await claim(1).then(() => 'ACCEPTED', (e) => String(e.message));
    console.log('claim of the wrong hash lock:', wrong);
    expect(wrong).not.toBe('ACCEPTED');

    const claimTx = await claim(0);
    await confirmed(claimTx);
    const t1 = await accountState(taker.account);
    expect(t1.balance).toBe(t0.balance + amount);
    console.log('claim with the secret: accepted', claimTx);
  }, 1200000);
});
