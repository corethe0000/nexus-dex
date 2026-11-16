//one Nexus claim at a time per profile: a profile has one reveal slot, and the claim's condition reads it when the
//CREDIT goes into a block. Two swaps of one profile claiming at once would overwrite each other's secret before
//their credits (and keep writing it again until the deadlines). A swap holds the slot from its reveal until its
//credit is final; the others wait. A holder that stops asking (its runner was dropped) is let go after maxHold
export interface Hold {
  swap: string;
  at: number; //last time the holder asked (seconds)
}

//where the holds live: memory of one process by default; the page passes one in localStorage, so every tab of the
//browser sees the same holds
export interface HoldStore {
  get(genesis: string): Hold | undefined;
  set(genesis: string, h: Hold): void;
  delete(genesis: string): void;
}

export class SlotGate {
  constructor(private holds: HoldStore = new Map<string, Hold>()) {}

  //true = this swap may use the profile's slot now (and holds it from now on)
  acquire(genesis: string, swap: string, now: number, maxHold: number): boolean {
    const h = this.holds.get(genesis);
    if (!h || h.swap === swap || now - h.at > maxHold) {
      this.holds.set(genesis, { swap, at: now });
      return true;
    }
    return false;
  }

  release(genesis: string, swap: string) {
    if (this.holds.get(genesis)?.swap === swap) {
      this.holds.delete(genesis);
    }
  }

  holder(genesis: string): string | undefined {
    return this.holds.get(genesis)?.swap;
  }
}

//shared by every runner of this process (all swaps of a page tab, or of the always-on maker)
export const slotGate = new SlotGate();
