//the keeper process (keeper.ts): its own config, key and port, nothing shared with the relay.
//  KEEPER_CONFIG=keeper.json npx tsx src/keeper-main.ts      (see keeper.example.json)
//  POST /claim {chainId, lockId, secret} -> {tx}      GET /info -> {chains: [ids], address, addresses: {chainId: address}}
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { EvmLeg } from '../../core/src/evm/leg';
import { clientOf, Limiter, readBody } from './api';
import { Keeper, KeeperError, type KeeperChain } from './keeper';

interface Config {
  host: string;
  port: number;
  keyFile: string; //the keeper's gas key (0x...), outside the repo
  sweepSeconds: number;
  trustProxy?: boolean | 'cloudflare'; //behind a reverse proxy / tunnel: rate limits go by the forwarded client address ("cloudflare": by CF-Connecting-IP)
  //tokens: address (0x0...0 = the coin) -> smallest amount in base units worth the gas; not set = all
  //keyFile: this chain's own gas key instead of the top one (e.g. local chain on an anvil dev key, public chains not)
  chains: Record<string, { rpc: string; swap: Address; fromBlock: string; confirmations: number; claimMargin: number; refundDelay: number; tokens?: Record<string, string>; maxGas?: number; maxPerDay?: number; maxPerAddressPerDay?: number; keyFile?: string }>;
}

const config = JSON.parse(readFileSync(process.env.KEEPER_CONFIG ?? 'keeper.json', 'utf8')) as Config;
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const now = () => Math.floor(Date.now() / 1000);
const keyAccount = (file: string) => privateKeyToAccount(readFileSync(file, 'utf8').trim() as Hex);
const account = keyAccount(config.keyFile);

const chains = new Map<string, KeeperChain>();
const addresses: Record<string, Address> = {};
for (const [id, c] of Object.entries(config.chains)) {
  if (!c.tokens) {
    console.warn(`chain ${id}: no "tokens" minimums, the keeper pays gas for swaps of any token and size`);
  }
  const chain = defineChain({ id: Number(id), name: `chain ${id}`, nativeCurrency: { name: 'gas', symbol: 'GAS', decimals: 18 }, rpcUrls: { default: { http: [c.rpc] } } });
  const client = createPublicClient({ chain, transport: http(c.rpc) }) as PublicClient;
  const gas = c.keyFile ? keyAccount(c.keyFile) : account;
  addresses[id] = gas.address;
  chains.set(id, { leg: new EvmLeg(client, c.swap, c.confirmations, BigInt(c.fromBlock)), wallet: createWalletClient({ account: gas, chain, transport: http(c.rpc) }), claimMargin: c.claimMargin, refundDelay: c.refundDelay, tokens: c.tokens ? new Map(Object.entries(c.tokens).map(([t, min]) => [t.toLowerCase(), BigInt(min)])) : undefined, maxGas: c.maxGas !== undefined ? BigInt(c.maxGas) : undefined, maxPerDay: c.maxPerDay, maxPerAddressPerDay: c.maxPerAddressPerDay });
  log(`keeper chain ${id}: swap ${c.swap}, gas from ${gas.address}`);
}
const keeper = new Keeper(chains, log);
const limiter = new Limiter();

createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST' });
    res.end();
    return;
  }
  if (!limiter.ok(clientOf(req, config.trustProxy), Date.now())) {
    send(429, { error: 'slow down' });
    return;
  }
  const path = new URL(req.url ?? '/', 'http://keeper').pathname;
  try {
    if (req.method === 'GET' && path === '/info') {
      send(200, { chains: [...chains.keys()], address: account.address, addresses });
    } else if (req.method === 'POST' && path === '/claim') {
      const b = await readBody(req);
      send(200, { tx: await keeper.claim(String(b.chainId), String(b.lockId), String(b.secret), now()) });
    } else {
      send(404, { error: 'not found' });
    }
  } catch (e) {
    const status = e instanceof KeeperError ? e.status : (e as { status?: number }).status;
    if (status) {
      send(status, { error: (e as Error).message });
    } else {
      send(500, { error: 'keeper error' });
      log(`keeper request failed: ${(e as Error).message.split('\n')[0]}`);
    }
  }
}).listen(config.port, config.host, () => log(`keeper on ${config.host}:${config.port}, gas from ${account.address}`));

let busy = false;
setInterval(async () => {
  if (busy) {
    return;
  }
  busy = true;
  try {
    await keeper.sweep(now());
  } finally {
    busy = false;
  }
}, config.sweepSeconds * 1000);
