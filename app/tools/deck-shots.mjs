//screenshots for the presentation PDFs (1280x800 frames): simple and advanced in light and dark, how it works, phone,
//and one real swap (bob buys TESTT for USDT from alice on the local chain) shot every few seconds until it is done.
//Private chain + anvil + relay + app dev server running (as ui-e2e.mjs).
//  PLAYWRIGHT=$HOME/review/node_modules/playwright APP=http://127.0.0.1:5180 SHOTS=$HOME/review/dex-deck node tools/deck-shots.mjs
import { mkdirSync } from 'node:fs';
import { launch, log, open, postOffer, signIn } from './pw-helpers.mjs';

const shots = process.env.SHOTS ?? './deck';
mkdirSync(shots, { recursive: true });
const frame = (page, name) => page.screenshot({ path: `${shots}/${name}.png` });
const full = (page, name) => page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
const prefs = (p) => JSON.stringify({ net: 'testnet', mode: 'simple', theme: 'light', venue: 'stable', ...p });
const sized = async (browser, who, width, height, p) => {
  const page = await open(browser, who, width, undefined, prefs(p));
  await page.setViewportSize({ width, height });
  return page;
};

const browser = await launch();
//a book to look at: alice sells and buys TESTT around its test price ($620)
const alice = await open(browser, 'alice', 1280, undefined, prefs({ mode: 'advanced' }));
await signIn(alice, 'alice');
for (const o of [
  { amount: '0.04', price: '625' },
  { amount: '0.06', price: '632' },
  { amount: '0.1', price: '640' },
  { amount: '0.05', price: '612', buy: true },
  { amount: '0.08', price: '605', buy: true },
]) {
  await postOffer(alice, { ...o, chain: 'Local chain' });
}
log('alice posted five offers');

for (const theme of ['light', 'dark']) {
  const p = await sized(browser, 'bob', 1280, 800, { theme });
  await p.waitForTimeout(2500);
  await p.getByRole('button', { name: /^Buy / }).click();
  await p.waitForTimeout(1000);
  await frame(p, `d01-simple-${theme}`);
  await p.getByRole('button', { name: 'Advanced', exact: true }).click();
  await p.waitForTimeout(3000);
  await frame(p, `d02-advanced-${theme}`);
  //the order book and the take / make panel below the chart
  await p.locator('table.book').first().scrollIntoViewIfNeeded();
  await p.evaluate(() => window.scrollBy(0, -90));
  await p.locator('table.book tbody tr').first().click();
  await p.waitForTimeout(800);
  await frame(p, `d02b-book-${theme}`);
  await p.context().close();
}

const help = await sized(browser, 'bob', 1280, 800, {});
await help.getByRole('button', { name: 'How it works' }).click();
await help.waitForTimeout(1500);
await full(help, 'd03-how-it-works');
await help.context().close();

const phone = await sized(browser, 'bob', 390, 844, {});
await phone.waitForTimeout(2500);
await frame(phone, 'd04-phone');
await phone.context().close();

//one real swap, from bob's side
const bob = await sized(browser, 'bob', 1280, 800, {});
await signIn(bob, 'bob');
await bob.getByRole('button', { name: /^Buy / }).click();
await bob.getByRole('combobox', { name: 'Coin and chain' }).selectOption({ label: 'USDT on Local chain' });
await bob.locator('#pay-amount').fill('25');
await bob.waitForTimeout(1500);
await frame(bob, 'd05-ready-to-swap');
await bob.locator('.ticket .btn.big').click();
await bob.getByRole('heading', { name: 'Your swaps' }).waitFor({ timeout: 60000 });
const end = Date.now() + 15 * 60 * 1000;
let i = 0;
let last = '';
while (Date.now() < end) {
  const state = ((await bob.locator('.state').first().textContent().catch(() => '')) ?? '').trim();
  const note = ((await bob.locator('main').innerText().catch(() => '')) ?? '').slice(0, 600);
  if (note !== last) {
    last = note;
    await frame(bob, `d06-swap-${String(++i).padStart(2, '0')}`);
    log(`swap shot ${i}: ${state}`);
  }
  if (/Swapped|Refunded|Lost|Stopped/.test(state)) {
    break;
  }
  await bob.waitForTimeout(4000);
}
const row = bob.locator('details.history-row').first();
if (await row.count()) {
  await row.locator('summary').first().click();
  await bob.waitForTimeout(800);
}
await frame(bob, 'd07-swapped');
await bob.context().close();

//take the rest of alice's offers down again
for (let k = 0; k < 6; k++) {
  await alice.getByRole('button', { name: 'Withdraw' }).first().click({ timeout: 3000 }).catch(() => {});
  await alice.waitForTimeout(600);
}
await browser.close();
log('deck shots done');
