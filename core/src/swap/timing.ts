//deadlines and safety margins of a swap. All times in seconds.
//
//initiator lock:    |------------------------------------------ Di
//participant lock:        |------------------------- Dp
//                                                    <-- safety --> the participant claims with the secret in here
//The initiator claims only until Dp - claimMargin, so its claim (which reveals the secret) is final before Dp; a
//reveal that lands after Dp would let the participant refund AND claim. Each deadline is measured on the clock of
//its own chain; the two chain clocks can differ a little, which the margins cover.

export interface Timing {
  initiatorLock: number; //how long the initiator's lock runs
  participantLock: number; //wanted length of the participant's lock
  safety: number; //at least this between Dp and Di, for the participant to claim with the secret
  minParticipantWindow: number; //the participant does not lock if its lock would be shorter than this
  claimMargin: number; //act this long before a deadline at the latest (confirmation time + clock drift)
  refundDelay: number; //refund this long after the deadline (chain clocks are not exact)
  maxLockAge: number; //the participant ignores an initiator lock made more than this ago
}

export const defaultTiming: Timing = {
  initiatorLock: 24 * 3600,
  participantLock: 12 * 3600,
  safety: 6 * 3600,
  minParticipantWindow: 2 * 3600,
  claimMargin: 30 * 60,
  refundDelay: 5 * 60,
  maxLockAge: 2 * 3600,
};

//short timings for tests on the private chains, same proportions
export const testTiming: Timing = {
  initiatorLock: 1200,
  participantLock: 600,
  safety: 300,
  minParticipantWindow: 240,
  claimMargin: 90,
  refundDelay: 15,
  maxLockAge: 300,
};

export function checkTiming(t: Timing): void {
  if (t.participantLock + t.safety > t.initiatorLock) {
    throw new Error('participant lock + safety must fit in the initiator lock');
  }
  if (t.minParticipantWindow <= t.claimMargin) {
    throw new Error('the participant window must be longer than the claim margin');
  }
  if (t.safety <= 2 * t.claimMargin) {
    throw new Error('safety must leave room for the participant to claim');
  }
}

//the participant's deadline on its own chain: its wanted length, but ending at least `safety` before the initiator's
//deadline (from the time left on that lock), and long enough after mine for my claim there to become final; null = too
//little time to lock safely
export function participantDeadline(t: Timing, participantClock: number, initiatorTimeLeft: number, initiatorFinalDelay: number): number | null {
  const reserve = Math.max(t.safety, initiatorFinalDelay + 2 * t.claimMargin);
  const length = Math.min(t.participantLock, initiatorTimeLeft - reserve);
  return length >= t.minParticipantWindow ? participantClock + length : null;
}
