//HTTP API of the relay. Everything that changes the book is signed by the user's EVM wallet; reads are open.
//  GET  /api/info                 chains, tokens, swap contracts, timing, relay time
//  GET  /api/price                reference prices in USD per Nexus token, for hints only (price.ts)
//  GET  /api/history?token=       that reference price over the last 24 h, for a chart
//  GET  /api/trades?since=        swaps that went through here (default: last 7 days), for charts
//  GET  /api/offers               open offers of makers that are online
//  POST /api/offers               {offer, sig}                 -> {id}
//  POST /api/offers/:id/cancel    {sig}
//  POST /api/alive                {agent, at, sig}             -> {takes: waiting takes for this agent's offers}
//  POST /api/takes                {take, sig}                  -> {id, acceptBy}
//  POST /api/takes/:id/accept     {sig}
//  POST /api/takes/:id/void       {sig}                        the maker's agent: the taker never locked, open the
//                                                                  offer again
//  GET  /api/takes/:id                                          -> take with its offer and status
//  POST /api/takes/:id/claim      {secret}                     -> {tx}: the watcher collects the EVM lock for its
//                                                                  recipient now (receive-only sellers, no wallet)
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Address, Hex } from 'viem';
import { Book, BookError, type TakeOut } from './book';

//prices and finished trades, for hints and charts (price.ts, trades.ts)
export interface MarketData {
  price(now: number): Promise<unknown>;
  history(token: string, now: number): Promise<unknown>;
  trades(since: number, now: number): unknown[];
}

const maxBody = 16 * 1024;
const hex32 = /^0x[0-9a-fA-F]{64}$/;
const sigRe = /^0x[0-9a-fA-F]{130}$/;

//requests per address per second (token bucket), against floods
export class Limiter {
  private buckets = new Map<string, { n: number; at: number }>();
  constructor(
    private rate = 10,
    private burst = 40,
    private maxKeys = 10000,
  ) {}
  ok(key: string, nowMs: number): boolean {
    const b = this.buckets.get(key) ?? { n: this.burst, at: nowMs };
    b.n = Math.min(this.burst, b.n + ((nowMs - b.at) / 1000) * this.rate);
    b.at = nowMs;
    this.buckets.delete(key);
    this.buckets.set(key, b); //newest last
    if (this.buckets.size > this.maxKeys) {
      this.forget(nowMs);
    }
    if (b.n < 1) {
      return false;
    }
    b.n -= 1;
    return true;
  }
  //an address idle long enough to have a full bucket again loses nothing when forgotten; when that is not enough,
  //the longest idle that are not being slowed down go (a flood of new addresses cannot reset a slowed one), and only
  //past twice the limit any of them
  private forget(nowMs: number) {
    const full = (this.burst / this.rate) * 1000;
    for (const [k, b] of this.buckets) {
      if (nowMs - b.at >= full) {
        this.buckets.delete(k);
      }
    }
    for (const [k, b] of this.buckets) {
      if (this.buckets.size <= this.maxKeys * 0.9) {
        break;
      }
      if (b.n >= 1 || this.buckets.size > 2 * this.maxKeys) {
        this.buckets.delete(k);
      }
    }
  }
}

//the address a request comes from, as a rate limit key. Behind a reverse proxy (trustProxy) every request comes from
//the proxy: then the client is the last address the proxy added to X-Forwarded-For (earlier ones are whatever the
//client sent); CF-Connecting-IP only behind Cloudflare itself ("cloudflare"), any other proxy passes it on as the
//client sent it
export function clientOf(req: IncomingMessage, trustProxy: boolean | 'cloudflare' = false): string {
  const direct = req.socket.remoteAddress ?? '?';
  if (!trustProxy) {
    return limitKey(direct);
  }
  const cf = req.headers['cf-connecting-ip'];
  if (trustProxy === 'cloudflare' && typeof cf === 'string' && cf.trim()) {
    return limitKey(cf.trim());
  }
  const fwd = req.headers['x-forwarded-for'];
  const list = (Array.isArray(fwd) ? fwd.join(',') : (fwd ?? '')).split(',').map((s) => s.trim()).filter(Boolean);
  return limitKey(list[list.length - 1] ?? direct);
}

//one IPv6 user gets a whole /64, so it counts as one address; IPv4 (also written as ::ffff:a.b.c.d) as itself
export function limitKey(a: string): string {
  const v4 = /^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (v4) {
    return v4[1]!;
  }
  if (!a.includes(':')) {
    return a;
  }
  const [head, tail = ''] = a.toLowerCase().split('%')[0]!.split('::');
  const h = head ? head.split(':') : [];
  const t = a.includes('::') ? (tail ? tail.split(':') : []) : [];
  const groups = a.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBody) {
        reject(new BookError('request too big', 413));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => {
      try {
        resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {});
      } catch {
        reject(new BookError('bad JSON'));
      }
    });
    req.on('error', reject);
  });
}

function need(ok: boolean, what: string) {
  if (!ok) {
    throw new BookError(`bad ${what}`);
  }
}

export function apiHandler(book: Book, info: () => unknown, clock: () => number = () => Math.floor(Date.now() / 1000), claim?: (t: TakeOut, secret: Hex, now: number) => Promise<Hex>, market?: MarketData, trustProxy: boolean | 'cloudflare' = false) {
  const limiter = new Limiter();
  return async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST' });
      res.end();
      return;
    }
    if (!limiter.ok(clientOf(req, trustProxy), Date.now())) {
      send(429, { error: 'slow down' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://relay');
    const parts = url.pathname.split('/').filter(Boolean);
    const now = clock();
    try {
      if (parts[0] !== 'api') {
        throw new BookError('not found', 404);
      }
      const route = `${req.method} ${parts.slice(1).map((p, i) => (i === 1 ? ':id' : p)).join('/')}`;
      const id = parts[2] as Hex | undefined;
      if (id !== undefined) {
        need(hex32.test(id), 'id');
      }
      switch (route) {
        case 'GET info':
          send(200, { ...(info() as object), now });
          return;
        case 'GET price':
          send(200, market ? await market.price(now) : { prices: {}, source: '' });
          return;
        case 'GET history': {
          const token = url.searchParams.get('token') ?? '0';
          need(/^(0|[1-9A-HJ-NP-Za-km-z]{20,64})$/.test(token), 'token');
          send(200, { history: market ? await market.history(token, now) : null, now });
          return;
        }
        case 'GET trades': {
          const since = Number(url.searchParams.get('since') ?? now - 7 * 24 * 3600);
          need(Number.isFinite(since), 'since');
          send(200, { trades: market ? market.trades(since, now) : [], now });
          return;
        }
        case 'GET offers':
          send(200, { offers: book.list(now), now });
          return;
        case 'POST offers': {
          const b = await readBody(req);
          need(typeof b.offer === 'object' && sigRe.test(b.sig), 'offer');
          send(200, { id: await book.post(b.offer, b.sig, now) });
          return;
        }
        case 'POST offers/:id/cancel': {
          const b = await readBody(req);
          need(sigRe.test(b.sig), 'signature');
          await book.cancel(id!, b.sig);
          send(200, { ok: true });
          return;
        }
        case 'POST alive': {
          const b = await readBody(req);
          need(/^0x[0-9a-fA-F]{40}$/.test(b.agent) && Number.isInteger(b.at) && sigRe.test(b.sig), 'alive');
          send(200, { takes: await book.beat(b.agent as Address, b.at, b.sig, now), now });
          return;
        }
        case 'POST takes': {
          const b = await readBody(req);
          need(typeof b.take === 'object' && sigRe.test(b.sig), 'take');
          send(200, await book.take(b.take, b.sig, now));
          return;
        }
        case 'POST takes/:id/accept': {
          const b = await readBody(req);
          need(sigRe.test(b.sig), 'signature');
          await book.accept(id!, b.sig, now);
          send(200, { ok: true });
          return;
        }
        case 'POST takes/:id/void': {
          const b = await readBody(req);
          need(sigRe.test(b.sig), 'signature');
          await book.void(id!, b.sig, now);
          send(200, { ok: true });
          return;
        }
        case 'POST takes/:id/claim': {
          const b = await readBody(req);
          need(typeof b.secret === 'string' && hex32.test(b.secret), 'secret');
          const t = book.takeOut(id!);
          if (!t || t.status !== 'accepted') {
            throw new BookError('no accepted take with this id', 404);
          }
          if (!claim) {
            throw new BookError('this relay does not collect', 501);
          }
          send(200, { tx: await claim(t, b.secret as Hex, now) });
          return;
        }
        case 'GET takes/:id': {
          book.sweep(now);
          const t = book.takeOut(id!);
          if (!t) {
            throw new BookError('no such take', 404);
          }
          send(200, t);
          return;
        }
        default:
          throw new BookError('not found', 404);
      }
    } catch (e) {
      if (e instanceof BookError) {
        send(e.status, { error: e.message });
      } else {
        send(500, { error: 'relay error' });
        console.error(e);
      }
    }
  };
}
