//simulated swaps: two chains with inclusion and finality delays and clock skew, both sides driven by decide(), with
//offline periods and misbehaving counterparties. Invariant: a side that runs the engine as specified never loses.
import { describe, expect, it } from 'vitest';
import { decide, type Agreed } from './engine';
import { checkTiming, defaultTiming, participantDeadline, testTiming, type Timing } from './timing';
import type { Action, LockStatus, LockView, Result, Role, SwapView } from './types';

interface ChainSim {
  skew: number; //chain clock minus real time
  inclusion: number; //seconds until a sent tx is in a block (its conditions are checked then)
  finality: number; //seconds from inclusion until final
}

interface Lock {
  amount: string;
  hashlock: string;
  deadline: number;
  status: 'open' | 'claimed' | 'refunded';
  sentAt: number; //real time the lock tx was sent
  finalAt?: number;
  claimFinalAt?: number;
  refundFinalAt?: number;
}

interface Pending {
  kind: 'lock' | 'claim' | 'refund';
  leg: 'init' | 'part';
  by: Role;
  includeAt: number;
  deadline?: number;
}

interface Behaviour {
  offline?: Array<[number, number]>; //real time ranges the side does nothing
  stopAfter?: number; //never acts again after this time
  lockAmount?: string; //lock a different amount (cheat)
  lockHash?: string; //lock with another hash (cheat)
  neverLock?: boolean;
  neverClaim?: boolean;
}

interface Scenario {
  name: string;
  timing: Timing;
  init: ChainSim;
  part: ChainSim;
  initiator: Behaviour;
  participant: Behaviour;
  maxTime?: number;
}

const agreed: Agreed = { initiatorAmount: '100', participantAmount: '200', hashlock: 'h' };
const secret = 's';

function run(sc: Scenario) {
  const t = sc.timing;
  checkTiming(t);
  let now = 0;
  const locks: Record<'init' | 'part', Lock | undefined> = { init: undefined, part: undefined };
  const pending: Pending[] = [];
  let secretSeenAt: number | undefined; //real time the secret is readable on the participant chain (initiator's claim included)
  const results: Partial<Record<Role, Action>> = {};
  const log: string[] = [];
  const chainOf = (leg: 'init' | 'part') => (leg === 'init' ? sc.init : sc.part);
  const chainTime = (leg: 'init' | 'part') => ({ now: now + chainOf(leg).skew, finalDelay: chainOf(leg).inclusion + chainOf(leg).finality + 5 });

  const viewOf = (leg: 'init' | 'part', by: Role): LockView => {
    const l = locks[leg];
    const mineLeg = by === 'initiator' ? 'init' : 'part';
    const p = pending.find((x) => x.leg === leg && x.by === by);
    if (!l) {
      return { status: p?.kind === 'lock' && leg === mineLeg ? 'pending' : 'none' };
    }
    let status: LockStatus;
    if (l.finalAt === undefined || now < l.finalAt) {
      status = 'pending';
    } else if (l.claimFinalAt !== undefined && now >= l.claimFinalAt) {
      status = 'claimed';
    } else if (l.refundFinalAt !== undefined && now >= l.refundFinalAt) {
      status = 'refunded';
    } else if (l.status === 'claimed') {
      status = 'claiming';
    } else if (l.status === 'refunded') {
      status = 'refunding';
    } else if (p?.kind === 'claim') {
      status = 'claiming';
    } else if (p?.kind === 'refund') {
      status = 'refunding';
    } else {
      status = 'confirmed';
    }
    return { status, amount: l.amount, hashlock: l.hashlock, deadline: l.deadline, recipientOk: true, slotReady: true };
  };

  const act = (by: Role, b: Behaviour) => {
    if (results[by]?.kind === 'done' || results[by]?.kind === 'abort') {
      return;
    }
    if (b.stopAfter !== undefined && now > b.stopAfter) {
      return;
    }
    if (b.offline?.some(([s, e]) => now >= s && now < e)) {
      return;
    }
    const v: SwapView = {
      initiatorLock: viewOf('init', by),
      participantLock: viewOf('part', by),
      initiatorChain: chainTime('init'),
      participantChain: chainTime('part'),
      recipientSlotReady: true,
      secret: by === 'initiator' || (secretSeenAt !== undefined && now >= secretSeenAt) ? secret : undefined,
    };
    const a = decide(by, v, agreed, t);
    if (a.kind === 'done' || a.kind === 'abort') {
      results[by] = a;
      log.push(`${now} ${by} ${a.kind} ${'result' in a ? a.result : ''} ${a.reason ?? ''}`);
      return;
    }
    if (a.kind === 'wait') {
      return;
    }
    const leg: 'init' | 'part' = a.kind === 'lock' ? (by === 'initiator' ? 'init' : 'part') : a.kind === 'refund' ? (by === 'initiator' ? 'init' : 'part') : by === 'initiator' ? 'part' : 'init';
    if (pending.some((p) => p.leg === leg && p.by === by && p.kind === a.kind)) {
      return;
    }
    if (a.kind === 'lock' && b.neverLock) {
      return;
    }
    if (a.kind === 'claim' && b.neverClaim) {
      return;
    }
    pending.push({ kind: a.kind, leg, by, includeAt: now + chainOf(leg).inclusion, deadline: a.kind === 'lock' ? a.deadline : undefined });
    if (a.kind === 'claim' && by === 'initiator' && secretSeenAt === undefined) {
      //a sent claim is public at once (mempool, EVM calldata even if it reverts): the secret is out from now on
      secretSeenAt = now;
    }
    log.push(`${now} ${by} sends ${a.kind} on ${leg}`);
  };

  //the chains: include pending txs, checking conditions against the chain clock at inclusion
  const include = () => {
    for (const p of [...pending]) {
      if (now < p.includeAt) {
        continue;
      }
      pending.splice(pending.indexOf(p), 1);
      const c = chainOf(p.leg);
      const chainTime = now + c.skew;
      const b = p.by === 'initiator' ? sc.initiator : sc.participant;
      if (p.kind === 'lock') {
        locks[p.leg] = {
          amount: (p.leg === 'init' ? b.lockAmount : b.lockAmount) ?? (p.leg === 'init' ? agreed.initiatorAmount : agreed.participantAmount),
          hashlock: b.lockHash ?? agreed.hashlock,
          deadline: p.deadline!,
          status: 'open',
          sentAt: now,
          finalAt: now + c.finality,
        };
        continue;
      }
      const l = locks[p.leg]!;
      if (l.status !== 'open') {
        log.push(`${now} ${p.kind} on ${p.leg} rejected: lock ${l.status}`);
        continue;
      }
      if (p.kind === 'claim') {
        //the lock condition uses the block time: claim only before the deadline
        if (chainTime >= l.deadline) {
          log.push(`${now} claim on ${p.leg} rejected: after deadline`);
          continue;
        }
        l.status = 'claimed';
        l.claimFinalAt = now + c.finality;
      } else {
        if (chainTime < l.deadline) {
          log.push(`${now} refund on ${p.leg} rejected: before deadline`);
          continue;
        }
        l.status = 'refunded';
        l.refundFinalAt = now + c.finality;
      }
    }
  };

  const end = sc.maxTime ?? 3 * t.initiatorLock;
  const step = Math.max(1, Math.floor(t.claimMargin / 10));
  for (now = 0; now <= end; now += step) {
    include();
    act('initiator', sc.initiator);
    act('participant', sc.participant);
  }

  //who got what: the initiator gets the participant lock if it claimed it, etc.
  const outcome = (by: Role): Result | 'nothing' => {
    const mine = locks[by === 'initiator' ? 'init' : 'part'];
    const theirs = locks[by === 'initiator' ? 'part' : 'init'];
    if (!mine) {
      return 'nothing';
    }
    const gave = mine.status === 'claimed';
    const got = theirs?.status === 'claimed';
    if (gave && got) {
      return 'swapped';
    }
    if (gave && !got) {
      return 'lost';
    }
    if (mine.status === 'refunded') {
      return 'refunded';
    }
    return got ? 'swapped' : 'refunded';
  };
  return { results, locks, log, outcome };
}

const fast: ChainSim = { skew: 0, inclusion: 3, finality: 10 };
const nexus: ChainSim = { skew: 0, inclusion: 50, finality: 150 };

function expectSafe(r: ReturnType<typeof run>, honest: Role[]) {
  for (const role of honest) {
    const o = r.outcome(role);
    if (o === 'lost') {
      console.log(r.log.join('\n'));
    }
    expect(o, `${role} must not lose`).not.toBe('lost');
    const res = r.results[role];
    if (res?.kind === 'done') {
      expect(res.result, `${role} engine result`).not.toBe('lost');
    }
  }
}

describe('swap engine timing', () => {
  it('default and test timings are consistent', () => {
    checkTiming(defaultTiming);
    checkTiming(testTiming);
    expect(participantDeadline(testTiming, 1000, testTiming.initiatorLock, 0)).toBe(1000 + testTiming.participantLock);
    expect(participantDeadline(testTiming, 1000, testTiming.safety + testTiming.minParticipantWindow - 1, 0)).toBeNull();
  });

  const chainPairs: Array<[string, ChainSim, ChainSim]> = [
    ['evm first, nexus second', fast, nexus],
    ['nexus first, evm second', nexus, fast],
    ['skewed clocks', { ...nexus, skew: 40 }, { ...fast, skew: -40 }],
  ];

  for (const [label, init, part] of chainPairs) {
    describe(label, () => {
      it('both online: swapped', () => {
        const r = run({ name: 'happy', timing: testTiming, init, part, initiator: {}, participant: {} });
        expect(r.outcome('initiator')).toBe('swapped');
        expect(r.outcome('participant')).toBe('swapped');
        expect(r.results.initiator).toMatchObject({ kind: 'done', result: 'swapped' });
        expect(r.results.participant).toMatchObject({ kind: 'done', result: 'swapped' });
      });

      it('participant never locks: initiator refunds', () => {
        const r = run({ name: 'nolock', timing: testTiming, init, part, initiator: {}, participant: { neverLock: true } });
        expect(r.outcome('initiator')).toBe('refunded');
      });

      it('initiator never claims: both refund', () => {
        const r = run({ name: 'noclaim', timing: testTiming, init, part, initiator: { neverClaim: true }, participant: {} });
        expect(r.outcome('initiator')).toBe('refunded');
        expect(r.outcome('participant')).toBe('refunded');
      });

      it('initiator goes offline after locking, back late: participant refunds, initiator refunds', () => {
        const r = run({ name: 'initoffline', timing: testTiming, init, part, initiator: { offline: [[60, testTiming.initiatorLock]] }, participant: {} });
        expectSafe(r, ['initiator', 'participant']);
      });

      it('participant offline from just after locking until after its deadline: initiator still safe', () => {
        const r = run({ name: 'partoffline', timing: testTiming, init, part, initiator: {}, participant: { offline: [[400, testTiming.initiatorLock * 2]] } });
        //the participant was not running the engine for most of the swap, only the initiator is held to the invariant
        expectSafe(r, ['initiator']);
      });

      it('initiator stops right after revealing: participant still claims', () => {
        const happy = run({ name: 'happy', timing: testTiming, init, part, initiator: {}, participant: {} });
        const claimAt = Number(happy.log.find((l) => l.includes('initiator sends claim'))!.split(' ')[0]);
        const r = run({ name: 'initgone', timing: testTiming, init, part, initiator: { stopAfter: claimAt }, participant: {} });
        expect(r.results.initiator).toBeUndefined();
        expect(r.outcome('participant')).toBe('swapped');
        expect(r.outcome('initiator')).toBe('swapped');
      });

      it('participant locks the wrong amount: initiator does not reveal and refunds', () => {
        const r = run({ name: 'wrongamount', timing: testTiming, init, part, initiator: {}, participant: { lockAmount: '1' } });
        expect(r.outcome('initiator')).toBe('refunded');
        expect(r.locks.part?.status).not.toBe('claimed');
      });

      it('participant locks with another hash: initiator does not reveal', () => {
        const r = run({ name: 'wronghash', timing: testTiming, init, part, initiator: {}, participant: { lockHash: 'x' } });
        expect(r.outcome('initiator')).toBe('refunded');
      });

      it('initiator locks the wrong amount: participant never locks', () => {
        const r = run({ name: 'initwrong', timing: testTiming, init, part, initiator: { lockAmount: '1' }, participant: {} });
        expect(r.locks.part).toBeUndefined();
        expect(r.results.participant?.kind).toBe('abort');
      });

      it('participant comes online only after the initiator lock is old: does not lock', () => {
        const r = run({ name: 'latejoin', timing: testTiming, init, part, initiator: {}, participant: { offline: [[0, testTiming.maxLockAge + 200]] } });
        expect(r.locks.part).toBeUndefined();
        expect(r.outcome('initiator')).toBe('refunded');
      });

      it('initiator offline through the claim window, back before its own deadline: no loss', () => {
        for (let start = 100; start < testTiming.initiatorLock; start += 97) {
          const r = run({ name: 'window', timing: testTiming, init, part, initiator: { offline: [[start, start + testTiming.participantLock]] }, participant: {} });
          expectSafe(r, ['participant']);
          //the initiator was offline for part of its run; it must still never be 'lost' by its own engine's choice
          const o = r.outcome('initiator');
          if (o === 'lost') {
            console.log(r.log.join('\n'));
          }
          expect(o).not.toBe('lost');
        }
      });

      it('initiator wakes up at any time after locking (late claims near the participant deadline): nobody loses', () => {
        for (let end = 100; end < testTiming.initiatorLock + 200; end += 7) {
          const r = run({ name: 'wake', timing: testTiming, init, part, initiator: { offline: [[60, end]] }, participant: {} });
          expectSafe(r, ['initiator', 'participant']);
        }
      });

      it('participant offline windows anywhere after it saw the secret, back before the initiator deadline: swapped', () => {
        for (let start = 200; start < testTiming.participantLock; start += 53) {
          const r = run({ name: 'pwindow', timing: testTiming, init, part, initiator: {}, participant: { offline: [[start, start + testTiming.safety - 2 * testTiming.claimMargin]] } });
          expectSafe(r, ['initiator', 'participant']);
        }
      });
    });
  }
});

//Nexus lock conditions read ledger.timestamp = time of the newest block, which lags the real time until the next
//block: a refund sent before a block past the deadline exists is refused (seen on the private chain 2026-11-12)
describe('refund waits for the ledger clock', () => {
  const t = testTiming;
  const lock = (deadline: number): LockView => ({ status: 'confirmed', amount: '100', hashlock: 'h', deadline, recipientOk: true });
  const view = (ledgerNow: number, now: number): SwapView => ({
    initiatorLock: lock(1000),
    participantLock: { status: 'none' },
    initiatorChain: { now, finalDelay: 120, ledgerNow },
    participantChain: { now, finalDelay: 10 },
  });
  it('initiator: not while the newest block is before the deadline, even if the time is past it', () => {
    expect(decide('initiator', view(990, 2000), agreed, t).kind).toBe('wait');
    expect(decide('initiator', view(1000 + t.refundDelay, 2000), agreed, t).kind).toBe('refund');
  });
  it('participant: same on its own chain', () => {
    const v: SwapView = { initiatorLock: lock(5000), participantLock: lock(1000), initiatorChain: { now: 2000, finalDelay: 10 }, participantChain: { now: 2000, finalDelay: 120, ledgerNow: 990 } };
    expect(decide('participant', v, agreed, t).kind).toBe('wait');
    expect(decide('participant', { ...v, participantChain: { ...v.participantChain, ledgerNow: 1000 + t.refundDelay } }, agreed, t).kind).toBe('refund');
  });
});

//security review 2026-11-13: a Nexus claim is two transactions (reveal, then credit); after the reveal the old
//"is there time to claim safely" check must not turn into "wait and refund" while the participant has the secret
describe('after the secret is out the initiator only claims', () => {
  const t = testTiming;
  const lock = (deadline: number, amount: string): LockView => ({ status: 'confirmed', amount, hashlock: 'h', deadline, recipientOk: true });
  const view = (now: number, disclosed: boolean): SwapView => ({
    initiatorLock: lock(5000, agreed.initiatorAmount),
    participantLock: lock(1000, agreed.participantAmount),
    initiatorChain: { now, finalDelay: 10 },
    participantChain: { now, finalDelay: 120, claimDelay: 250 },
    disclosed,
  });
  it('close to the participant deadline: no reveal before, but a claim once disclosed', () => {
    //1000 - 250 - 90 = 660: from here on a first reveal is too late
    expect(decide('initiator', view(700, false), agreed, t).kind).toBe('wait');
    expect(decide('initiator', view(700, true), agreed, t).kind).toBe('claim');
  });
  it('the claim time of the chain counts, not one transaction', () => {
    //with one finalDelay (120) a reveal at 700 would look safe: 700 + 120 + 90 < 1000
    expect(decide('initiator', { ...view(700, false), participantChain: { now: 700, finalDelay: 120 } }, agreed, t).kind).toBe('claim');
    expect(decide('initiator', view(700, false), agreed, t).kind).toBe('wait');
  });
  it('a chain whose newest block is old: the floor (local clock) decides that a first reveal is too late', () => {
    //the chain says 500 (safe: 500 + 250 + 90 < 1000), the floor says 700 (not safe)
    const stale = { ...view(500, false), participantChain: { now: 500, finalDelay: 120, claimDelay: 250, floor: 700 } };
    expect(decide('initiator', stale, agreed, t).kind).toBe('wait');
    expect(decide('initiator', { ...stale, participantChain: { ...stale.participantChain, floor: 400 } }, agreed, t).kind).toBe('claim');
  });
  it('past the participant deadline even a disclosed initiator stops claiming and refunds when due', () => {
    expect(decide('initiator', view(1000, true), agreed, t).kind).toBe('wait');
    expect(decide('initiator', { ...view(6000, true), initiatorChain: { now: 6000, finalDelay: 10, ledgerNow: 6000 } }, agreed, t).kind).toBe('refund');
  });
  it('a disclosed initiator keeps claiming a Nexus lock while the Nexus tip is before its deadline', () => {
    //the EVM clock (1010) is past the deadline, the newest Nexus block (990) is not: the chain still takes the claim
    const v = { ...view(1010, true), participantChain: { now: 1010, finalDelay: 120, claimDelay: 250, ledgerNow: 990 } };
    expect(decide('initiator', v, agreed, t).kind).toBe('claim');
    expect(decide('initiator', { ...v, participantChain: { ...v.participantChain, ledgerNow: 1000 } }, agreed, t).kind).toBe('wait');
  });
});

//security review 2026-11-16: a participant lock that stays pending (dropped, or replaced on its own chain) must not
//keep the initiator's own lock away past its deadline
describe('a participant lock that never gets final', () => {
  const t = testTiming;
  const view = (now: number): SwapView => ({
    initiatorLock: { status: 'confirmed', amount: agreed.initiatorAmount, hashlock: 'h', deadline: 5000, recipientOk: true },
    participantLock: { status: 'pending' },
    initiatorChain: { now, finalDelay: 10, ledgerNow: now },
    participantChain: { now, finalDelay: 120 },
  });
  it('waits before the deadline, refunds after it', () => {
    expect(decide('initiator', view(3000), agreed, t).kind).toBe('wait');
    expect(decide('initiator', view(5000 + t.refundDelay), agreed, t).kind).toBe('refund');
  });
});
