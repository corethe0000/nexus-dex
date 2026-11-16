//maker conveniences: alice posts 0.06 TESTT as a ladder of 3 offers (600, 606, 612 USDT, 1% apart) with "post it
//again after each swap"; bob buys the cheapest one in the simple ticket; after the swap alice's page puts the same offer
//up again by itself, so she has 3 open offers again. Private chain + anvil.
//  PLAYWRIGHT=$HOME/review/node_modules/playwright APP=http://127.0.0.1:5180 SHOTS=$HOME/review/dex-maker node tools/maker-e2e.mjs
import { mkdirSync } from 'node:fs';
import { dumpSwaps, launch, log, open, postOffer, signIn } from './pw-helpers.mjs';

const shots = process.env.SHOTS ?? './shots';
mkdirSync(shots, { recursive: true });
let n = 0;
const shot = (page, name) => page.screenshot({ path: `${shots}/${String(++n).padStart(2, '0')}-${name}.png`, fullPage: true });
let failed = 0;
const check = (label, ok, detail = '') => {
  log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' - ' + detail : ''}`);
  failed += ok ? 0 : 1;
};

const browser = await launch();
const alice = await open(browser, 'alice', 1280, undefined, JSON.stringify({ net: 'testnet', mode: 'advanced', theme: 'light', venue: 'stable' }));
await signIn(alice, 'alice');
//clear what earlier runs left in the list
for (const b of await alice.getByRole('button', { name: 'Withdraw' }).all()) {
  await b.click().catch(() => {});
}
for (const b of await alice.getByRole('button', { name: 'Remove from the list' }).all()) {
  await b.click().catch(() => {});
}
await postOffer(alice, { amount: '0.06', price: '600', chain: 'Local chain', paidIn: 'USDT', split: 3, step: 1, again: true });
const mine = alice.locator('.my-offer');
const texts = await mine.allTextContents();
check('three offers posted as a ladder', texts.length === 3 && /for 12(\.00)? USDT/.test(texts.join('|')) && /for 12\.12 USDT/.test(texts.join('|')) && /for 12\.24 USDT/.test(texts.join('|')), texts.join(' | '));
check('each is marked to be posted again', texts.every((t) => /posted again after each swap/.test(t)));
await shot(alice, 'alice-ladder');

const bob = await open(browser, 'bob', 1280, undefined, JSON.stringify({ net: 'testnet', mode: 'simple', theme: 'light', venue: 'stable' }));
await signIn(bob, 'bob');
await bob.getByRole('button', { name: /^Buy / }).click();
await bob.getByRole('combobox', { name: 'Coin and chain' }).selectOption({ label: 'USDT on Local chain' });
const chip = bob.locator('.sizes button', { hasText: 'at 600' });
if (await chip.count()) {
  await chip.first().click();
}
await bob.locator('#pay-amount').fill('12');
await bob.waitForTimeout(1000);
const cta = bob.locator('.ticket .btn.big');
const text = (await cta.textContent()) ?? '';
check('bob takes the cheapest step', /Swap 12(\.00)? USDT for 0\.02 TESTT/.test(text), text);
await cta.click();
await bob.getByRole('heading', { name: 'Your swaps' }).waitFor({ timeout: 60000 });

//alice: the taken offer shows as taken while the swap runs (her page asks for takers every 20 s)
let during = [];
const seenBy = Date.now() + 45000;
while (Date.now() < seenBy) {
  during = await mine.allTextContents();
  if (during.some((t) => /Taken, swap running/.test(t))) {
    break;
  }
  await alice.waitForTimeout(2000);
}
await shot(alice, 'alice-taken');
check('the taken offer shows its swap', during.some((t) => /Taken, swap running/.test(t)), during.join(' | '));

const end = Date.now() + 8 * 60 * 1000;
let state = '';
while (Date.now() < end) {
  state = ((await bob.locator('.state').first().textContent()) ?? '').trim();
  if (/Swapped|Refunded|Lost|Stopped|Not accepted/.test(state)) {
    break;
  }
  await bob.waitForTimeout(3000);
}
check('the swap went through', /Swapped/.test(state), state);

//alice's side finishes a little after bob's; then the offer goes up again by itself
let after = [];
const until = Date.now() + 3 * 60 * 1000;
while (Date.now() < until) {
  after = await mine.allTextContents();
  if (after.length === 3 && after.every((t) => /Open/.test(t))) {
    break;
  }
  await alice.waitForTimeout(3000);
}
check('the offer was posted again: three open offers', after.length === 3 && after.every((t) => /Open/.test(t)) && after.some((t) => /for 12(\.00)? USDT/.test(t)), after.join(' | '));
await shot(alice, 'alice-reposted');
const book = await bob.evaluate(async () => (await (await fetch('/relay/api/offers')).json()).offers.length);
log(`offers on the relay now: ${book}`);

if (!/Swapped/.test(state)) {
  await dumpSwaps(bob, 'bob');
  await dumpSwaps(alice, 'alice');
}
//clean up: one at a time, the list redraws after each (a leftover offer would stay up for the next run)
for (let i = 0; i < 10 && (await alice.getByRole('button', { name: 'Withdraw' }).count()) > 0; i++) {
  await alice.getByRole('button', { name: 'Withdraw' }).first().click().catch(() => {});
  await alice.waitForTimeout(700);
}
await browser.close();
log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exitCode = failed ? 1 : 0;
