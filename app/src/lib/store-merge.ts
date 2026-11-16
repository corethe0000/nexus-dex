//several tabs of the page share one stored copy of the swaps and offers. Each item carries a sequence number that goes
//up whenever its content changes; merging keeps, per id, the copy with the higher number (on a tie this tab's), adds
//items another tab made, and keeps items only this tab has. Agent keys: the stored one wins (offers name it).
export interface Seq {
  id: string;
  seq?: number;
}

export interface Merged<T extends Seq> {
  items: T[];
  adopted: Set<string>; //ids whose copy now comes from the other side
}

export function mergeItems<T extends Seq>(mine: T[], theirs: T[], gone: Set<string> = new Set()): Merged<T> {
  const byId = new Map(theirs.map((t) => [t.id, t]));
  const adopted = new Set<string>();
  const items: T[] = [];
  for (const m of mine) {
    const t = byId.get(m.id);
    byId.delete(m.id);
    if (t && (t.seq ?? 0) > (m.seq ?? 0)) {
      items.push(t);
      adopted.add(m.id);
    } else {
      items.push(m);
    }
  }
  for (const t of byId.values()) {
    if (!gone.has(t.id)) {
      items.push(t);
      adopted.add(t.id);
    }
  }
  return { items, adopted };
}

export function mergeAgents<K extends string>(mine: Record<string, K>, theirs: Record<string, K>): Record<string, K> {
  return { ...mine, ...theirs };
}

//raises seq of every item whose content differs from what was last stamped (`last`: id -> content)
export function stamp<T extends Seq>(items: T[], last: Map<string, string>, json: (v: unknown) => string) {
  for (const it of items) {
    const { seq: _seq, ...rest } = it;
    const fp = json(rest);
    if (last.get(it.id) !== fp) {
      it.seq = (it.seq ?? 0) + 1;
      last.set(it.id, fp);
    }
  }
}
