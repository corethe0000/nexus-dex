import { describe, expect, it } from 'vitest';
import { PriceFeed } from './price';

describe('PriceFeed', () => {
  it('maps feed ids and fixed prices to tokens, calls the feed once per refresh', async () => {
    const urls: string[] = [];
    const f = new PriceFeed({ '0': 'nexus', T: 2.5 }, async (u) => (urls.push(u), { nexus: { usd: 0.12 } }), 300, 3600, () => {});
    expect((await f.prices(1000)).prices).toEqual({ '0': { usd: 0.12, at: 1000, source: 'CoinGecko' }, T: { usd: 2.5, at: 1000, source: 'fixed test price' } });
    await f.prices(1100);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('ids=nexus&vs_currencies=usd');
  });

  it('keeps the last price while the feed fails, drops it once too old', async () => {
    let fail = false;
    const f = new PriceFeed({ '0': 'nexus' }, async () => {
      if (fail) {
        throw new Error('down');
      }
      return { nexus: { usd: 0.1 } };
    }, 300, 3600, () => {});
    await f.prices(0);
    fail = true;
    expect((await f.prices(400)).prices['0']?.usd).toBe(0.1);
    expect((await f.prices(4000)).prices['0']).toBeUndefined();
  });

  it('keeps samples for the price line, with the feed 24 h figures', async () => {
    let usd = 0.1;
    const f = new PriceFeed({ '0': 'nexus', T: 5 }, async () => ({ nexus: { usd, usd_24h_change: -2.5, usd_24h_vol: 12345 } }), 300, 3600, () => {});
    await f.prices(0);
    usd = 0.12;
    expect(await f.history('0', 300)).toEqual({ prices: [[0, 0.1], [300, 0.12]], change24: -2.5, volume24: 12345, source: 'CoinGecko' });
    expect(await f.history('T', 300)).toBeNull();
    expect((await f.history('0', 7 * 24 * 3600 + 400))?.prices).toEqual([[7 * 24 * 3600 + 400, 0.12]]);
  });

  it('ignores junk from the feed', async () => {
    const f = new PriceFeed({ '0': 'nexus' }, async () => ({ nexus: { usd: 'x' } }), 300, 3600, () => {});
    expect((await f.prices(0)).prices).toEqual({});
  });
});
