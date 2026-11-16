//a maker for trying the site by hand: alice posts an offer in a headless browser and keeps her page open, so
//someone can take it from a real browser (MetaMask). Ends when her swap is finished or after MINUTES.
//  PLAYWRIGHT=... APP=http://127.0.0.1:5180 AMOUNT=0.04 PRICE=625 MINUTES=30 node tools/maker.mjs
//BUY=1: alice posts an offer buying the coins instead (a receive-only seller, e.g. the desktop wallet module, takes it)
//public testnet: add MAKER_KEY_FILE (file with a 0x key that has gas there), MAKER_RPC and CHAIN (name in the site)
import { readFileSync } from 'node:fs';
import { dumpSwaps, launch, log, open, postOffer, savedSwaps, signIn } from './pw-helpers.mjs';

const keyFile = process.env.MAKER_KEY_FILE;
const wallet = keyFile ? { key: readFileSync(keyFile, 'utf8').trim(), rpc: process.env.MAKER_RPC } : undefined;
const browser = await launch();
const alice = await open(browser, 'alice', 1280, wallet);
await signIn(alice, 'alice');
await postOffer(alice, { amount: process.env.AMOUNT ?? '0.04', price: process.env.PRICE ?? '625', chain: process.env.CHAIN, buy: !!process.env.BUY });
log('alice posted, waiting for a taker');

const end = Date.now() + Number(process.env.MINUTES ?? 30) * 60 * 1000;
let reported = '';
while (Date.now() < end) {
  await alice.waitForTimeout(5000);
  const s = (await savedSwaps(alice))[0];
  const now = s ? `${s.stage} ${s.rec.done?.result ?? s.rec.aborted ?? s.last?.reason ?? ''}` : 'no taker yet';
  if (now !== reported) {
    log(`alice: ${now}`);
    reported = now;
  }
  if (s && (s.stage === 'finished' || s.stage === 'lapsed')) {
    break;
  }
  //LEAVE_AFTER_ACCEPT=1: the maker accepts and then closes its page without locking (refund test for the taker)
  if (s && process.env.LEAVE_AFTER_ACCEPT && s.stage === 'running') {
    log('alice closes her page after accepting');
    break;
  }
}
await dumpSwaps(alice, 'alice');
await browser.close();
