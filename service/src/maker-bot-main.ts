//the always-on maker as a process (maker-bot.ts). Config file path in MAKER_CONFIG, e.g.
//  {
//    "relay": "https://dex.example/relay", "nexusNode": "https://dex.example/nexus",
//    "nexus": { "username": "alice", "passwordFile": "/home/me/.dex/password", "pinFile": "/home/me/.dex/pin" },
//    "evmKeyFile": "/home/me/.dex/evm-key", "rpc": { "56": "https://bsc-rpc.publicnode.com" },
//    "stateFile": "/home/me/.dex/maker-state.json",
//    "offers": [{ "sell": true, "coin": "NXS", "amount": "100", "chain": "56", "token": "USDT", "price": "0.021", "again": true }]
//  }
//Also fix what not to take from the relay on trust: "swapContracts": { "56": "0x..." }, "timing": "default",
//"minConfirmations": { "nexus": 2, "56": 15 } (a chain not in swapContracts is left out), and
//"tokens": { "56": [{ "address": "0x55d3...", "symbol": "USDT", "decimals": 18 }] }. swapContracts and tokens are
//required for every chain the offers use.
//Keep the secret files readable by you only (chmod 600), or leave any of them out: the program then asks for it at
//start and keeps it in memory only (nothing on disk, but a restart needs you at the terminal). Stop with Ctrl+C: open offers are withdrawn first; running
//swaps carry on at the next start (the state file has them).
import { readFileSync } from 'node:fs';
import type { Hex } from 'viem';
import { NexusNode } from '../../core/src/nexus/node';
import { pinInfo, type Pins } from '../../app/src/lib/pins';
import { Relay } from '../../app/src/lib/relay';
import { MakerBot, type BotState, type Info, type WantedOffer } from './maker-bot';
import { JsonStore } from './store';

interface Config extends Pins {
  relay: string;
  nexusNode: string;
  witnessNodes?: string[]; //other Nexus nodes asked before an EVM lock answers a Nexus lock
  nexus: { username: string; passwordFile?: string; pinFile?: string };
  evmKeyFile?: string;
  rpc: Record<string, string>;
  stateFile: string;
  offers: WantedOffer[];
}

//typed at the terminal without echo, kept in memory only; keys typed ahead are kept for the next question
let typedAhead = '';
const ask = (question: string) =>
  new Promise<string>((done, fail) => {
    const input = process.stdin;
    if (!input.isTTY) {
      fail(new Error(`${question} not in a file and no terminal to ask on`));
      return;
    }
    process.stdout.write(`${question}: `);
    let typed = '';
    const take = (text: string) => {
      const chars = [...text];
      for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        if (c === '\r' || c === '\n') {
          typedAhead = chars.slice(i + 1).join('').replace(/^\n/, '');
          input.off('data', onData);
          input.setRawMode(false);
          input.pause();
          process.stdout.write('\n');
          done(typed.trim());
          return true;
        }
        if (c === '\u0003') {
          process.exit(130);
        }
        typed = c === '\u007f' || c === '\b' ? typed.slice(0, -1) : typed + c;
      }
      return false;
    };
    const onData = (d: Buffer) => void take(d.toString('utf8'));
    input.setRawMode(true);
    input.on('data', onData);
    const ahead = typedAhead;
    typedAhead = '';
    if (!take(ahead)) {
      input.resume();
    }
  });
const secret = async (file: string | undefined, question: string) => (file ? readFileSync(file, 'utf8').trim() : await ask(question));
const config = JSON.parse(readFileSync(process.env.MAKER_CONFIG ?? 'maker.json', 'utf8')) as Config;
const password = await secret(config.nexus.passwordFile, `Nexus password for ${config.nexus.username}`);
const pin = await secret(config.nexus.pinFile, 'Nexus PIN');
const evmKey = await secret(config.evmKeyFile, 'EVM private key');
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

const state: BotState = { posted: {}, swaps: {} };
const store = new JsonStore<BotState>(config.stateFile, () => state);
Object.assign(state, store.load() ?? {});

//a chain the offers use must have its swap contract and tokens fixed here: else the relay names them, and a relay
//that lies could list its own token as USDT or shift the decimals
const unpinned = [...new Set(config.offers.map((o) => o.chain))].filter((c) => !config.swapContracts?.[c] || !config.tokens?.[c]?.length);
if (unpinned.length) {
  throw new Error(`set swapContracts and tokens in the config for chain ${unpinned.join(', ')} (see the top of maker-bot-main.ts)`);
}
const relayBase = config.relay.replace(/\/$/, '');
const res = await fetch(`${relayBase}/api/info`);
if (!res.ok) {
  throw new Error(`the relay answered ${res.status}`);
}
//swap contracts, timing and confirmations checked against this config (swapContracts, timing, minConfirmations),
//as the page does: a relay that lies cannot send this maker's coins into its own contract
const info: Info = pinInfo(await res.json(), config);

const bot = new MakerBot({
  node: new NexusNode(config.nexusNode),
  witnesses: (config.witnessNodes ?? []).map((u) => new NexusNode(u)),
  relay: new Relay(relayBase),
  info,
  nexus: { username: config.nexus.username, password, pin },
  evmKey: evmKey as Hex,
  rpc: config.rpc,
  wanted: config.offers,
  state,
  save: () => store.changed(),
  log,
});
await bot.start();

const beatMs = 20000;
const tickMs = 6000;
let lastBeat = 0;
let busy = false;
const loop = async () => {
  if (busy) {
    return;
  }
  busy = true;
  //running swaps first and on their own: a relay that is down or refuses must never hold up a claim or a refund
  try {
    await bot.tickSwaps();
  } catch (e) {
    log(`maker - swaps: ${(e as Error).message.split('\n')[0]}`);
  }
  try {
    const now = Math.floor(Date.now() / 1000);
    await bot.keepOffersUp(now);
    if (Date.now() - lastBeat >= beatMs) {
      lastBeat = Date.now();
      await bot.beat();
    }
  } catch (e) {
    log(`maker - ${(e as Error).message.split('\n')[0]}`);
  } finally {
    busy = false;
  }
};
await loop();
const timer = setInterval(() => void loop(), tickMs);
log('maker running');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    clearInterval(timer);
    log('stopping: withdrawing open offers');
    void bot
      .withdrawAll()
      .catch(() => {})
      .finally(() => {
        store.flush();
        process.exit(0);
      });
  });
}
