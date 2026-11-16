//a whole swap through the website, two browsers: alice posts an offer, bob takes it, both pages run the swap.
//Needs the relay (tools/dev-up.ts config) and the app dev server running.
//  PLAYWRIGHT=$HOME/review/node_modules/playwright APP=http://127.0.0.1:5180 SHOTS=$HOME/review/dex-ui node tools/ui-e2e.mjs
import { mkdirSync } from 'node:fs';
import { dumpSwaps, launch, log, open, postOffer, signIn } from './pw-helpers.mjs';

const shots = process.env.SHOTS ?? './shots';
mkdirSync(shots, { recursive: true });

//KEY_MODE=1: alice's wallet signs with her anvil key in this process (the path used on public testnets)
const aliceKey = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'; //anvil dev account 2 (public)
const browser = await launch();
const alice = await open(browser, 'alice', 1280, process.env.KEY_MODE ? { key: aliceKey, rpc: process.env.EVM_RPC ?? 'http://127.0.0.1:8545' } : undefined);
await alice.screenshot({ path: `${shots}/01-market-empty.png`, fullPage: true });
await signIn(alice, 'alice');
await postOffer(alice, { amount: '0.04', price: '625', chain: 'Local chain', shot: `${shots}/02-make-offer.png` });
log('alice posted');

const bob = await open(browser, 'bob');
await signIn(bob, 'bob');
await bob.locator('table.book tbody tr').first().waitFor({ timeout: 30000 });
await bob.screenshot({ path: `${shots}/03-market-offer.png`, fullPage: true });
await bob.locator('table.book tbody tr').first().click();
await bob.screenshot({ path: `${shots}/04-take.png`, fullPage: true });
await bob.getByRole('button', { name: /^Swap for/ }).click();
await bob.getByRole('heading', { name: 'Your swaps' }).waitFor({ timeout: 60000 });
log('bob took the offer');

const end = Date.now() + 6 * 60 * 1000;
let n = 5;
let lastShot = 0;
let lastState = '';
while (Date.now() < end) {
  const state = (await bob.locator('.state').first().textContent()) ?? '';
  lastState = state;
  if (Date.now() - lastShot > 30000) {
    await bob.screenshot({ path: `${shots}/${String(n++).padStart(2, '0')}-swap-progress.png`, fullPage: true });
    lastShot = Date.now();
  }
  if (/Swapped|Refunded|Lost|Stopped|Not accepted/.test(state)) {
    log(`bob: ${state}`);
    break;
  }
  await bob.waitForTimeout(3000);
}
await alice.getByRole('button', { name: /Your swaps/ }).click();
await alice.waitForTimeout(15000);
const aliceState = (await alice.locator('.state').first().textContent()) ?? '';
log(`alice: ${aliceState}`);
await bob.screenshot({ path: `${shots}/${String(n++).padStart(2, '0')}-bob-done.png`, fullPage: true });
await alice.screenshot({ path: `${shots}/${String(n++).padStart(2, '0')}-alice-done.png`, fullPage: true });
await dumpSwaps(bob, 'bob');
await dumpSwaps(alice, 'alice');

//phone width
const phone = await open(browser, 'bob', 390);
await phone.screenshot({ path: `${shots}/${String(n++).padStart(2, '0')}-phone-market.png`, fullPage: true });
await browser.close();
log(`result: bob ${lastState}, alice ${aliceState}`);
process.exitCode = /Swapped/.test(lastState) && /Swapped/.test(aliceState) ? 0 : 1;
