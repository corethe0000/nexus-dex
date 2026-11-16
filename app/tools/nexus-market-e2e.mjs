//trading on the Nexus market from the site, Nexus profiles only (no EVM wallet in either browser). alice (advanced
//view) sells 4 TESTT at 0.5 BOBT; bob (simple view) pays 2 BOBT and gets 4 TESTT in one transaction; alice collects her
//2 BOBT with "Collect"; alice places a second order and cancels it, her TESTT comes back. Private chain.
//  PLAYWRIGHT=$HOME/review/node_modules/playwright APP=http://127.0.0.1:5180 SHOTS=$HOME/review/dex-nexus-market node tools/nexus-market-e2e.mjs
import { mkdirSync } from 'node:fs';
import { launch, log, open, people } from './pw-helpers.mjs';

const shots = process.env.SHOTS ?? './shots';
mkdirSync(shots, { recursive: true });
const nodeUrl = process.env.NEXUS_NODE ?? 'http://127.0.0.1:7080';
const prefs = (mode) => JSON.stringify({ net: 'testnet', mode, theme: 'light', venue: 'nexus' });
const acct = {
  aliceTestt: '8BoheBPAFeWSKKSzWuQLxVbVz8wbKW6ZVLmgLU2mmUA9xp5FHkb',
  aliceBobt: '8Bu1Zwsg6zQMezjh6HGyS61exL3ZResPHbxSsZuiMMKuhqoiznv',
  bobTestt: '8CekfnBTnqNDLZAcwVCQP9ge2jbxnAeh2MbVmpKtKtJVkNnahzM',
  bobBobt: '8Bzvd26nG64c9h1UZy4nYK8R97FTSaaq5tgWUWiqTSUAieLxUT8',
};
let n = 0;
const shot = (page, name) => page.screenshot({ path: `${shots}/${String(++n).padStart(2, '0')}-${name}.png`, fullPage: true });
let failed = 0;
const check = (label, ok, detail = '') => {
  log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' - ' + detail : ''}`);
  failed += ok ? 0 : 1;
};
const balance = async (address) => Number((await (await fetch(`${nodeUrl}/register/get/any`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address }) })).json()).result.balance);
const balances = async () => Object.fromEntries(await Promise.all(Object.entries(acct).map(async ([k, a]) => [k, await balance(a)])));
const close = (a, b) => Math.abs(a - b) < 1e-9;
const done = (page, text) => page.locator('p.fine', { hasText: text }).filter({ hasText: 'Done' }).waitFor({ timeout: 200000 });

//Nexus sign-in only: the wallet chip stays unconnected
async function nexusOnly(page, who) {
  const [u, p, pin] = people[who].nexus;
  await page.locator('.top').getByRole('button', { name: 'Sign in to Nexus' }).click();
  await page.getByLabel('Username').fill(u);
  await page.getByLabel('Password').fill(p);
  await page.getByLabel('PIN').fill(pin);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('dialog[open] .profile-name').waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: 'Close' }).first().click();
  log(`${who} signed in to Nexus only`);
}

const browser = await launch();
const before = await balances();
log(`before: ${JSON.stringify(before)}`);

//alice, advanced: TESTT priced in BOBT, sell 4 at 0.5
const alice = await open(browser, 'alice', 1280, 'none', prefs('advanced'));
await nexusOnly(alice, 'alice');
await alice.getByLabel('Coin', { exact: true }).selectOption({ label: 'TESTT' });
await alice.getByLabel('Priced in').selectOption({ label: 'BOBT' });
check('a coin is never offered against itself', !(await alice.getByLabel('Priced in').locator('option', { hasText: /^TESTT$/ }).count()));
await alice.getByRole('button', { name: 'Sell TESTT' }).click();
await alice.getByLabel('Amount of TESTT you give').fill('4');
await alice.getByLabel('Price in BOBT per TESTT').fill('0.5');
const place = alice.getByRole('button', { name: /^Place order/ });
check('order button says what happens', /4 TESTT for 2 BOBT/.test((await place.textContent()) ?? ''), (await place.textContent()) ?? '');
await place.click();
await done(alice, 'Your order is up');
await shot(alice, 'alice-order-placed');
check('alice gave 4 TESTT into the order', close(await balance(acct.aliceTestt), before.aliceTestt - 4));

//bob, simple: pay BOBT, get TESTT
const bob = await open(browser, 'bob', 1280, 'none', prefs('simple'));
await nexusOnly(bob, 'bob');
await bob.getByLabel('Coin you pay').selectOption({ label: 'BOBT' });
await bob.getByLabel('Coin you get').selectOption({ label: 'TESTT' });
await bob.locator('#nm-pay').fill('2');
const cta = bob.locator('.ticket .btn.big');
await cta.filter({ hasText: 'Pay 2 BOBT, get 4 TESTT' }).waitFor({ timeout: 30000 });
await shot(bob, 'bob-ticket');
await cta.click();
await done(bob, 'You paid 2 BOBT');
const after = await balances();
log(`after take: ${JSON.stringify(after)}`);
check('bob got 4 TESTT', close(after.bobTestt, before.bobTestt + 4), `${before.bobTestt} -> ${after.bobTestt}`);
check('bob paid 2 BOBT', close(after.bobBobt, before.bobBobt - 2), `${before.bobBobt} -> ${after.bobBobt}`);

//alice collects her payment
await alice.reload();
await alice.locator('.top').getByRole('button', { name: 'Sign in to Nexus' }).waitFor();
await nexusOnly(alice, 'alice');
const waiting = alice.locator('.waiting');
await waiting.waitFor({ timeout: 90000 });
//exactly this one payment (earlier runs may have left others: those are collected here as well)
const shown = (await waiting.textContent()) ?? '';
const waitingBobt = Number(/([0-9.]+) BOBT/.exec(shown)?.[1] ?? 0);
check('alice sees the payment waiting', waitingBobt >= 2, shown.slice(0, 120));
await shot(alice, 'alice-payment-waiting');
await waiting.getByRole('button', { name: 'Collect' }).click();
await done(alice, 'Collected');
check('alice got what was waiting', close(await balance(acct.aliceBobt), before.aliceBobt + waitingBobt), `${before.aliceBobt} -> ${await balance(acct.aliceBobt)}`);

//a second order, cancelled: the TESTT comes back
const mid0 = await balance(acct.aliceTestt);
await alice.getByLabel('Coin', { exact: true }).selectOption({ label: 'TESTT' });
await alice.getByLabel('Priced in').selectOption({ label: 'BOBT' });
await alice.getByLabel('Amount of TESTT you give').fill('1.5');
await alice.getByLabel('Price in BOBT per TESTT').fill('2');
await alice.getByRole('button', { name: /^Place order/ }).click();
await done(alice, 'Your order is up');
check('second order took 1.5 TESTT', close(await balance(acct.aliceTestt), mid0 - 1.5));
await alice.locator('.my-offer', { hasText: 'Give 1.5 TESTT' }).getByRole('button', { name: 'Cancel' }).click();
await done(alice, 'Order cancelled');
await shot(alice, 'alice-cancelled');
check('cancel gave the 1.5 TESTT back', close(await balance(acct.aliceTestt), mid0), `${mid0} -> ${await balance(acct.aliceTestt)}`);

await browser.close();
log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exitCode = failed ? 1 : 0;
