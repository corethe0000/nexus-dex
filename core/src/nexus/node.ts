//minimal Nexus node client for the swap: reads without login, submits transactions signed here
import { accountStateOf } from '../../../../wallet/src/lib/profile-chain';
import { addressOfMemory, sequenceKey, signTx, type AccountState } from '../../../../wallet/src/lib/tritium';
import { parseSlot, slotAddress, type SlotState } from './htlc';

export interface Credentials {
  username: string;
  password: string;
  pin: string;
}

const feeIntervalSeconds = 10;

export class NexusNode {
  constructor(
    readonly url: string,
    private readonly auth?: { user: string; password: string },
  ) {}

  async call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.auth) {
      headers.Authorization = 'Basic ' + btoa(`${this.auth.user}:${this.auth.password}`);
    }
    const res = await fetch(`${this.url}/${method}`, { method: 'POST', headers, body: JSON.stringify(params) });
    const body = await res.json();
    if (body.error) {
      throw new NodeError(method, body.error.code, body.error.message);
    }
    return body.result as T;
  }

  //account or token register as an AccountState (balance in the token's smallest units; a token's own register
  //carries tokenInfo, else a debit from it fails "pre-state verification")
  async accountState(address: string): Promise<AccountState & { decimals: number }> {
    const { state, decimals } = await accountStateOf((m, p) => this.call(m, p), address);
    return { ...state, decimals };
  }

  //the profile's reveal slot, null when it was never created
  async slot(genesis: string): Promise<SlotState | null> {
    const r = await this.call('register/get/any', { address: addressOfMemory(slotAddress(genesis)) }).catch((e) => {
      if (e instanceof NodeError) {
        return null;
      }
      throw e;
    });
    return r ? parseSlot(r) : null;
  }

  async tip(): Promise<{ height: number; timestamp: number }> {
    const info = await this.call('ledger/get/info');
    return { height: info.height, timestamp: info.timestamp };
  }

  async transaction(txid: string): Promise<any | null> {
    return this.call('ledger/get/transaction', { hash: txid, verbose: 'summary' }).catch((e) => {
      if (e instanceof NodeError) {
        return null;
      }
      throw e;
    });
  }

  //signs contracts as the next transaction of the profile's sigchain and submits it; timestamp only for tests
  async submit(who: Credentials, genesis: string, contracts: (ts: number) => Uint8Array[], timestamp?: number): Promise<string> {
    const [last] = await this.call('ledger/list/transactions', { genesis, limit: 1 });
    const prev = await this.call('ledger/get/transaction', { hash: last.txid, verbose: 'summary' });
    let ts = timestamp;
    if (ts === undefined) {
      const wait = prev.timestamp + feeIntervalSeconds + 1 - Math.floor(Date.now() / 1000);
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait * 1000));
      }
      ts = Math.max(Math.floor(Date.now() / 1000), prev.timestamp);
    }
    const key = await sequenceKey(who.username, who.password, who.pin, prev.sequence + 1);
    const nextKey = await sequenceKey(who.username, who.password, who.pin, prev.sequence + 2);
    const signed = signTx({ txid: prev.txid, sequence: prev.sequence, timestamp: prev.timestamp, genesis }, contracts, ts, key, nextKey);
    const r = await this.call('ledger/submit/transaction', { data: signed.data });
    if (r?.hash !== signed.txid) {
      throw new Error(`node returned ${r?.hash}, built ${signed.txid}`);
    }
    return signed.txid;
  }

  async waitConfirmed(txid: string, confirmations = 1, timeoutMs = 600000): Promise<any> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const tx = await this.transaction(txid);
      if (tx && tx.confirmations >= confirmations) {
        return tx;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error(`not confirmed in time: ${txid}`);
  }
}

export class NodeError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(`${method}: ${code} ${message}`);
  }
}
