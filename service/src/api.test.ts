import type { IncomingMessage } from 'node:http';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clientOf, Limiter, limitKey } from './api';
import { JsonStore } from './store';

const req = (remote: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress: remote }, headers }) as unknown as IncomingMessage;

describe('relay limits', () => {
  it('a flood of new addresses does not reset an address being slowed down', () => {
    const l = new Limiter(1, 2, 100);
    expect(l.ok('slow', 0)).toBe(true);
    expect(l.ok('slow', 0)).toBe(true);
    expect(l.ok('slow', 0)).toBe(false);
    for (let i = 0; i < 500; i++) {
      l.ok(`new${i}`, 10);
    }
    expect(l.ok('slow', 10)).toBe(false);
  });

  it('behind a proxy the client is the address the proxy added', () => {
    expect(clientOf(req('10.0.0.1', { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }))).toBe('10.0.0.1');
    expect(clientOf(req('10.0.0.1', { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }), true)).toBe('2.2.2.2');
    expect(clientOf(req('10.0.0.1', { 'cf-connecting-ip': '3.3.3.3', 'x-forwarded-for': '9.9.9.9' }), 'cloudflare')).toBe('3.3.3.3');
    //any other proxy passes the header on as the client sent it
    expect(clientOf(req('10.0.0.1', { 'cf-connecting-ip': '3.3.3.3', 'x-forwarded-for': '9.9.9.9' }), true)).toBe('9.9.9.9');
    expect(clientOf(req('10.0.0.1'), true)).toBe('10.0.0.1');
  });

  it('an IPv6 /64 counts as one address', () => {
    expect(limitKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(limitKey('2001:db8:1:2:bbbb:cccc:dddd:eeee')).toBe('2001:db8:1:2::/64');
    expect(limitKey('2001:db8::5')).toBe('2001:db8:0:0::/64');
    expect(limitKey('::ffff:10.1.2.3')).toBe('10.1.2.3');
    expect(limitKey('::1')).toBe('0:0:0:0::/64');
    expect(limitKey('10.1.2.3')).toBe('10.1.2.3');
  });
});

describe('state file', () => {
  it('a file that does not parse is set aside and the one before it is read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dex-store-'));
    const path = join(dir, 'book.json');
    let value = { n: 1 };
    const s = new JsonStore(path, () => value);
    s.flush();
    value = { n: 2 };
    s.flush();
    writeFileSync(path, '{"n": 3');
    const quiet = () => {};
    expect(new JsonStore(path, () => value).load(quiet)).toEqual({ n: 1 });
    expect(readdirSync(dir).some((f) => f.startsWith('book.json.corrupt-'))).toBe(true);
  });
});
