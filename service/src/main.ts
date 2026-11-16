//the relay process: order book API + watcher. Config file path in DEX_CONFIG (see config.example.json).
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { NexusLeg } from '../../core/src/nexus/leg';
import { NexusNode } from '../../core/src/nexus/node';
import { defaultTiming, testTiming } from '../../core/src/swap/timing';
import { apiHandler } from './api';
import { Book, defaultBookSettings, type Snapshot } from './book';
import { PriceFeed, type Samples } from './price';
import { JsonStore } from './store';
import { Trades, type Trade } from './trades';
import { evmChain, Watcher, type WatchChain, type Watched } from './watcher';

interface ChainConfig {
  name: string;
  rpc: string;
  swap: Address;
  fromBlock: string;
  confirmations: number;
  finalDelay: number;
  //maxAmount: largest offer in base units (optional); usd: its dollar value for hints and charts, a fixed number
  //(1 for USDT / USDC) or a CoinGecko id ("ethereum" for WETH)
  tokens: { address: Address; symbol: string; decimals: number; maxAmount?: string; usd?: number | string }[];
  watcherKeyFile?: string; //file with the watcher's gas key (0x...), outside the repo
}

interface Config {
  host: string;
  port: number;
  dataDir: string;
  nexusNode: string;
  nexusFinalDelay: number;
  nexusConfirmations: number;
  timing: 'test' | 'default';
  chains: Record<string, ChainConfig>;
  priceRefs?: Record<string, string | number>; //Nexus token -> CoinGecko id or fixed USD price; default NXS = "nexus"
  trustProxy?: boolean | 'cloudflare'; //behind a reverse proxy / tunnel: rate limits go by the forwarded client address ("cloudflare": by CF-Connecting-IP)
}

const config = JSON.parse(readFileSync(process.env.DEX_CONFIG ?? 'config.json', 'utf8')) as Config;
const timing = config.timing === 'test' ? testTiming : defaultTiming;
const now = () => Math.floor(Date.now() / 1000);
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

const book = new Book({ ...defaultBookSettings, chains: Object.fromEntries(Object.entries(config.chains).map(([id, c]) => [id, { tokens: c.tokens.map((t) => t.address), limits: Object.fromEntries(c.tokens.filter((t) => t.maxAmount).map((t) => [t.address.toLowerCase(), BigInt(t.maxAmount!)])) }])) }, () => bookStore.changed());
const bookStore = new JsonStore<Snapshot>(join(config.dataDir, 'book.json'), () => book.snapshot());
const saved = bookStore.load();
if (saved) {
  const dropped = book.restore(saved);
  if (dropped) {
    log(`book: ${dropped} saved entries no longer valid, dropped`);
  }
}

const watched = new Map<Hex, Watched>();
const watchStore = new JsonStore<Watched[]>(join(config.dataDir, 'watcher.json'), () => [...watched.values()]);
for (const w of watchStore.load() ?? []) {
  watched.set(w.id, w);
}

const chains = new Map<string, WatchChain>();
for (const [id, c] of Object.entries(config.chains)) {
  const chain = defineChain({ id: Number(id), name: c.name, nativeCurrency: { name: 'gas', symbol: 'GAS', decimals: 18 }, rpcUrls: { default: { http: [c.rpc] } } });
  const client = createPublicClient({ chain, transport: http(c.rpc) }) as PublicClient;
  const key = c.watcherKeyFile ? (readFileSync(c.watcherKeyFile, 'utf8').trim() as Hex) : undefined;
  const wallet = key ? createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(c.rpc) }) : undefined;
  chains.set(id, evmChain(client, c.swap, c.confirmations, BigInt(c.fromBlock), wallet, { claimMargin: timing.claimMargin, claimGrace: 3 * c.finalDelay, refundDelay: timing.refundDelay, giveUpAfter: timing.initiatorLock * 2 }));
  log(`chain ${id} ${c.name}: swap ${c.swap}, watcher ${wallet ? wallet.account.address : 'watch only'}`);
}
const trades = new Trades();
const tradeStore = new JsonStore<Trade[]>(join(config.dataDir, 'trades.json'), () => trades.list);
trades.list.push(...(tradeStore.load() ?? []));
const watcher = new Watcher(chains, new NexusLeg(new NexusNode(config.nexusNode), config.nexusConfirmations), watched, log, undefined, (t, at) => {
  trades.add(t, at);
  tradeStore.changed();
});

const info = () => ({
  nexus: { finalDelay: config.nexusFinalDelay, confirmations: config.nexusConfirmations },
  chains: Object.fromEntries(Object.entries(config.chains).map(([id, c]) => [id, { name: c.name, swap: c.swap, fromBlock: c.fromBlock, confirmations: c.confirmations, finalDelay: c.finalDelay, tokens: c.tokens }])),
  timing,
});

const claimFor = async (t: Parameters<Watcher['claimFor']>[0], secret: Hex, at: number) => {
  const tx = await watcher.claimFor(t, secret, at);
  watchStore.changed();
  return tx;
};
const samples: Samples = {};
const sampleStore = new JsonStore<Samples>(join(config.dataDir, 'prices.json'), () => samples);
Object.assign(samples, sampleStore.load() ?? {});
//Nexus tokens by token id, EVM tokens as "<chain id>:<token address>"
const refs: Record<string, string | number> = { ...(config.priceRefs ?? { '0': 'nexus' }) };
for (const [id, c] of Object.entries(config.chains)) {
  for (const t of c.tokens) {
    if (t.usd !== undefined) {
      refs[`${id}:${t.address.toLowerCase()}`] = t.usd;
    }
  }
}
const feed = new PriceFeed(refs, undefined, undefined, undefined, log, samples, () => sampleStore.changed());
createServer(apiHandler(book, info, now, claimFor, { price: (at) => feed.prices(at), history: (token, at) => feed.history(token, at), trades: (since, at) => trades.since(since, at) }, config.trustProxy)).listen(config.port, config.host, () => log(`relay on ${config.host}:${config.port}`));

let busy = false;
setInterval(async () => {
  if (busy) {
    return;
  }
  busy = true;
  try {
    book.sweep(now());
    //keeps the price samples going while nobody looks (one feed call per 5 minutes at most)
    void feed.prices(now()).catch(() => {});
    await watcher.tick(book.accepted(), now());
    watchStore.changed();
  } finally {
    busy = false;
  }
}, 10000);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    bookStore.flush();
    watchStore.flush();
    tradeStore.flush();
    sampleStore.flush();
    process.exit(0);
  });
}
