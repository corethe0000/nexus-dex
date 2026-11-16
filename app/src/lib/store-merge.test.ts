import { describe, expect, it } from 'vitest';
import { mergeAgents, mergeItems, stamp } from './store-merge';

const json = (v: unknown) => JSON.stringify(v);

describe('copies of several tabs', () => {
  it('the higher seq wins per id, a tie keeps this tab, new items come in, gone ones stay gone', () => {
    const mine = [
      { id: 'a', seq: 3, v: 'mine' },
      { id: 'b', seq: 2, v: 'mine' },
      { id: 'c', seq: 1, v: 'mine' },
    ];
    const theirs = [
      { id: 'a', seq: 4, v: 'theirs' },
      { id: 'b', seq: 2, v: 'theirs' },
      { id: 'd', seq: 1, v: 'theirs' },
      { id: 'x', seq: 9, v: 'theirs' },
    ];
    const m = mergeItems(mine, theirs, new Set(['x']));
    expect(m.items.map((i) => `${i.id}:${i.v}`)).toEqual(['a:theirs', 'b:mine', 'c:mine', 'd:theirs']);
    expect([...m.adopted].sort()).toEqual(['a', 'd']);
  });

  it('seq rises only when the content changed since the last stamp', () => {
    const last = new Map<string, string>();
    const items = [{ id: 'a', seq: 5, v: 1 }];
    last.set('a', json({ id: 'a', v: 1 }));
    stamp(items, last, json);
    expect(items[0]!.seq).toBe(5);
    items[0]!.v = 2;
    stamp(items, last, json);
    expect(items[0]!.seq).toBe(6);
    stamp(items, last, json);
    expect(items[0]!.seq).toBe(6);
  });

  it('a stored agent key wins (offers already name it)', () => {
    expect(mergeAgents({ m: '0x1', n: '0x2' }, { m: '0x9' })).toEqual({ m: '0x9', n: '0x2' });
  });
});
