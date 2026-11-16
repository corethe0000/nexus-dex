//turns mainnet/chains.json and the deployments (mainnet/deployments/<id>.json from service/tools/deploy-mainnet.ts)
//into the settings the three parts need, written to mainnet/config-out/:
//  site-mainnet.json   the "mainnet" profile parts of app/public/config.json (and module/build.mjs)
//  relay-chains.json   "chains" of the relay config (watcherKeyFile still to fill in)
//  keeper-chains.json  "chains" of the keeper config (keyFile still to fill in)
//Only deployed chains are taken. --rehearsal reads mainnet/rehearsal/ instead (a sample of the output).
//  cd contracts && node tools/configs.mjs [--rehearsal]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const rehearsal = process.argv.includes('--rehearsal');
const cfg = JSON.parse(readFileSync('mainnet/chains.json', 'utf8'));
const dir = rehearsal ? 'mainnet/rehearsal' : 'mainnet/deployments';
const native = '0x0000000000000000000000000000000000000000';
const site = { evmRpc: {}, explorers: {}, swapContracts: {}, minConfirmations: { nexus: 2 }, tokens: {} };
const relay = {};
const keeper = {};
for (const [id, c] of Object.entries(cfg.chains)) {
  const file = `${dir}/${id}.json`;
  if (!existsSync(file)) {
    continue;
  }
  const d = JSON.parse(readFileSync(file, 'utf8'));
  const tokens = [...c.tokens.map((t) => ({ address: t.address, symbol: t.symbol, decimals: t.decimals, usd: 1 })), { address: native, symbol: c.native.symbol, decimals: 18, usd: c.native.usd }];
  site.evmRpc[id] = c.rpc;
  site.explorers[id] = c.explorer;
  site.swapContracts[id] = d.swap;
  site.minConfirmations[id] = c.minConfirmations;
  site.tokens[id] = tokens;
  relay[id] = { name: c.name, rpc: c.rpc, swap: d.swap, fromBlock: String(d.fromBlock), confirmations: c.minConfirmations, finalDelay: c.finalDelay, tokens, watcherKeyFile: '<file with the watcher key for this chain>' };
  keeper[id] = { rpc: c.rpc, swap: d.swap, fromBlock: String(d.fromBlock), confirmations: c.minConfirmations, claimMargin: 600, refundDelay: 1800, keyFile: '<file with the keeper key for this chain>' };
}
const out = rehearsal ? 'mainnet/config-sample' : 'mainnet/config-out';
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/site-mainnet.json`, JSON.stringify(site, null, 2) + '\n');
writeFileSync(`${out}/relay-chains.json`, JSON.stringify(relay, null, 2) + '\n');
writeFileSync(`${out}/keeper-chains.json`, JSON.stringify(keeper, null, 2) + '\n');
console.log(`${Object.keys(relay).length} chains written to ${out}`);
