//one swap between a Nexus leg and an EVM leg. The taker is always the initiator: it makes the secret, locks first
//(long deadline) and claims the maker's lock first, which reveals the secret to the maker.

//what the engine sees of one lock. claiming/refunding = this side sent that transaction and it is not final yet
export type LockStatus = 'none' | 'pending' | 'confirmed' | 'claiming' | 'claimed' | 'refunding' | 'refunded';

export interface LockView {
  status: LockStatus;
  ref?: string; //nexus: txid:contract, evm: lock id
  //terms read back from the chain, checked against what was agreed
  amount?: string;
  hashlock?: string; //hex, memory order
  deadline?: number; //on the clock of the lock's own chain
  recipientOk?: boolean; //recipient and token/account are the agreed ones
  problem?: string; //why recipientOk is false, in words
  slotReady?: boolean; //nexus: the recipient's reveal slot exists (else the refund path could throw)
  closedBy?: string; //nexus: the CREDIT that claimed or refunded it, once seen
}

export interface SwapView {
  initiatorLock: LockView;
  participantLock: LockView;
  //per chain: its current time (newest block, not the newest final one) and how long a transaction sent now takes
  //until it is final there (inclusion + finality, with headroom)
  initiatorChain: ChainTime;
  participantChain: ChainTime;
  //this side's own lock, while not made yet: on Nexus, does the recipient's reveal slot exist? undefined on EVM
  recipientSlotReady?: boolean;
  secret?: string; //hex: the initiator always has it; the participant once it is seen on a chain
  //initiator: the secret has been handed to a signer (reveal or claim sent, or a wallet asked): from then on the
  //participant may know it, so the only safe move is to claim, up to the participant lock's deadline
  disclosed?: boolean;
}

export interface ChainTime {
  now: number;
  finalDelay: number;
  //a claim on this chain from sending until final, when it is more than one transaction (Nexus: reveal, then claim);
  //default finalDelay
  claimDelay?: number;
  //the time a lock's refund condition sees, when it lags `now`: on Nexus ledger.timestamp = time of the newest block,
  //so a refund passes only once a block after the deadline exists (blocks come when they come)
  ledgerNow?: number;
  //a floor for "how late is it" where guessing too early is the danger (is there still time to reveal the secret,
  //how long does their lock still run): the local clock minus a tolerance. A stalled chain or a node behind the tip
  //shows an old block time; then this one is later
  floor?: number;
}

//the later of the chain's time and the floor
export const latest = (c: ChainTime) => Math.max(c.now, c.floor ?? c.now);

export type Role = 'initiator' | 'participant';

export type Result = 'swapped' | 'refunded' | 'lost';

export type Action =
  | { kind: 'lock'; deadline: number }
  | { kind: 'claim' } //initiator: claim the participant lock (reveals); participant: claim the initiator lock with the secret
  | { kind: 'refund' }
  | { kind: 'wait'; reason: string; until?: number }
  | { kind: 'done'; result: Result; reason?: string }
  | { kind: 'abort'; reason: string }; //stop without locking: nothing of this side is at risk
