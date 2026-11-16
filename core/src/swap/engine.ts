//the swap engine: looks at both locks and the chain clocks and says what this side does next. Pure, no I/O, so
//every timing case is unit tested. The runner calls it again after every change and on a timer.
import { participantDeadline, type Timing } from './timing';
import { latest, type Action, type LockView, type Role, type SwapView } from './types';

export interface Agreed {
  initiatorAmount: string; //what the initiator locks (base units of its chain/token)
  participantAmount: string;
  hashlock: string; //hex, from the initiator
}

export function decide(role: Role, v: SwapView, a: Agreed, t: Timing): Action {
  return role === 'initiator' ? initiatorStep(v, a, t) : participantStep(v, a, t);
}

function lockProblem(l: LockView, amount: string, hashlock: string): string | null {
  if (l.amount !== amount) {
    return `locked ${l.amount}, agreed ${amount}`;
  }
  if (l.hashlock !== hashlock) {
    return 'lock has another hash';
  }
  if (!l.recipientOk) {
    return l.problem ?? 'lock pays someone else';
  }
  if (l.slotReady === false) {
    return 'recipient has no reveal slot';
  }
  if (l.deadline === undefined) {
    return 'lock has no deadline';
  }
  return null;
}

function initiatorStep(v: SwapView, a: Agreed, t: Timing): Action {
  const mine = v.initiatorLock;
  const theirs = v.participantLock;
  const myClock = v.initiatorChain.now;
  const myLedger = v.initiatorChain.ledgerNow ?? myClock;
  const their = v.participantChain;

  switch (mine.status) {
    case 'none':
      if (theirs.status !== 'none') {
        return { kind: 'abort', reason: 'participant locked before the initiator' };
      }
      if (v.recipientSlotReady === false) {
        return { kind: 'abort', reason: 'the other side has no reveal slot on Nexus' };
      }
      return { kind: 'lock', deadline: myClock + t.initiatorLock };
    case 'pending':
      return { kind: 'wait', reason: 'own lock not final yet' };
    case 'refunding':
      return { kind: 'wait', reason: 'refund not final yet' };
    case 'refunded':
      return theirs.status === 'claimed' ? { kind: 'done', result: 'swapped' } : { kind: 'done', result: 'refunded' };
    case 'claiming':
    case 'claimed':
      //only possible with the secret, which only I had: so I claimed (or am claiming) theirs
      if (theirs.status === 'claimed') {
        return { kind: 'done', result: 'swapped' };
      }
      if (theirs.status === 'claiming') {
        return { kind: 'wait', reason: 'own claim not final yet' };
      }
      if (theirs.status === 'refunded') {
        return { kind: 'done', result: 'lost', reason: 'participant refunded after the secret was out' };
      }
      return { kind: 'claim' };
    case 'confirmed':
      break;
  }

  //my lock is final and open
  const myDeadline = mine.deadline!;
  switch (theirs.status) {
    case 'claimed':
      return { kind: 'done', result: 'swapped' };
    case 'claiming':
      return { kind: 'wait', reason: 'own claim not final yet' };
    case 'pending':
      //a lock that stays pending (dropped, or replaced on its own chain) must not keep mine away past its deadline
      return refundWhenDue(myLedger, myDeadline, t, 'participant lock not final yet');
    case 'confirmed': {
      const problem = lockProblem(theirs, a.participantAmount, a.hashlock);
      if (problem) {
        //never reveal into a wrong lock; my lock comes back after its deadline
        return refundWhenDue(myLedger, myDeadline, t, `participant lock not usable: ${problem}`);
      }
      //once the secret is out, claiming is the only safe move, whatever time is left: a refund would leave the
      //participant both locks
      if (v.disclosed) {
        if (claimOpen(their, theirs.deadline!)) {
          return { kind: 'claim' };
        }
        return refundWhenDue(myLedger, myDeadline, t, 'the secret is out but the participant lock ran out');
      }
      //the claim reveals the secret the moment it is sent, so all of it must be final before their deadline for sure
      if (latest(their) + (their.claimDelay ?? their.finalDelay) + t.claimMargin < theirs.deadline!) {
        return { kind: 'claim' };
      }
      return refundWhenDue(myLedger, myDeadline, t, 'too late to claim the participant lock safely');
    }
    default:
      //none, refunding, refunded
      return refundWhenDue(myLedger, myDeadline, t, 'waiting for the participant to lock');
  }
}

function participantStep(v: SwapView, a: Agreed, t: Timing): Action {
  const init = v.initiatorLock;
  const mine = v.participantLock;
  const initChain = v.initiatorChain;
  const myClock = v.participantChain.now;

  if (mine.status === 'none') {
    if (init.status === 'none' || init.status === 'pending') {
      return { kind: 'wait', reason: 'initiator lock not final yet' };
    }
    if (init.status !== 'confirmed') {
      return { kind: 'abort', reason: `initiator lock is ${init.status}` };
    }
    const problem = lockProblem(init, a.initiatorAmount, a.hashlock);
    if (problem) {
      return { kind: 'abort', reason: `initiator ${problem}` };
    }
    const left = init.deadline! - latest(initChain);
    if (left > t.initiatorLock + t.claimMargin) {
      return { kind: 'abort', reason: 'initiator lock runs longer than agreed' };
    }
    if (t.initiatorLock - left > t.maxLockAge) {
      return { kind: 'abort', reason: 'initiator lock is too old' };
    }
    if (v.recipientSlotReady === false) {
      return { kind: 'abort', reason: 'the other side has no reveal slot on Nexus' };
    }
    //after my deadline I still need time to see the secret and get my claim final on their chain
    const d = participantDeadline(t, myClock, left, initChain.claimDelay ?? initChain.finalDelay);
    return d === null ? { kind: 'abort', reason: 'too little time left to lock safely' } : { kind: 'lock', deadline: d };
  }

  switch (mine.status) {
    case 'pending':
      return { kind: 'wait', reason: 'own lock not final yet' };
    case 'refunding':
      return { kind: 'wait', reason: 'refund not final yet' };
    case 'refunded':
      return init.status === 'claimed' ? { kind: 'done', result: 'swapped' } : { kind: 'done', result: 'refunded' };
    case 'claiming':
    case 'claimed':
      //the initiator took my lock: the secret is on my chain now
      return claimInitiatorLock(v, t);
    case 'confirmed':
      //the secret got out before the initiator's claim was final (seen pending, or given to us): claim right away
      if (v.secret && (init.status === 'confirmed' || init.status === 'claiming')) {
        return claimInitiatorLock(v, t);
      }
      return refundWhenDue(v.participantChain.ledgerNow ?? myClock, mine.deadline!, t, 'waiting for the initiator to claim');
    default:
      return { kind: 'wait', reason: `unexpected own lock status ${mine.status}` };
  }
}

function claimInitiatorLock(v: SwapView, t: Timing): Action {
  const init = v.initiatorLock;
  switch (init.status) {
    case 'claimed':
      return { kind: 'done', result: 'swapped' };
    case 'claiming':
      return { kind: 'wait', reason: 'own claim not final yet' };
    case 'refunding':
    case 'refunded':
      return { kind: 'done', result: 'lost', reason: 'initiator refunded before the claim' };
    default:
      break;
  }
  if (!v.secret) {
    return { kind: 'wait', reason: 'reading the secret from the claim' };
  }
  //try right up to the deadline: nothing else can save the swap now (the safety window makes this normal case early)
  if (claimOpen(v.initiatorChain, init.deadline!)) {
    return { kind: 'claim' };
  }
  return { kind: 'done', result: 'lost', reason: 'secret came too late to claim the initiator lock' };
}

//a claim may still go through: on Nexus the lock condition reads the chain's own time, which can trail the clock
//the engine uses for its other decisions; trying a claim that then fails costs nothing, giving up early could
function claimOpen(chain: SwapView['initiatorChain'], deadline: number): boolean {
  return Math.min(chain.now, chain.ledgerNow ?? chain.now) < deadline;
}

function refundWhenDue(clock: number, deadline: number, t: Timing, reason: string): Action {
  const due = deadline + t.refundDelay;
  if (clock >= due) {
    return { kind: 'refund' };
  }
  return { kind: 'wait', reason, until: due };
}
