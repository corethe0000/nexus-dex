//a whole swap from the simple ticket: alice posts an offer selling TESTT (advanced view), bob opens the simple view,
//picks "Buy", the ticket matches alice's offer and its button swaps. While the swap runs, the network switch must
//ask first (a running swap would pause) and "Stay" must keep the page.
//  PLAYWRIGHT=$HOME/review/node_modules/playwright APP=http://127.0.0.1:5180 SHOTS=$HOME/review/dex-simple node tools/simple-e2e.mjs
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
const alice = await open(browser, 'alice');
await signIn(alice, 'alice');
await postOffer(alice, { amount: '0.03', price: '617', chain: 'Local chain' });
log('alice posted 0.03 TESTT at 617');

const bob = await open(browser, 'bob', 1280, undefined, JSON.stringify({ net: 'testnet', mode: 'simple', theme: 'light' }));
const cta = bob.locator('.ticket .btn.big');
await bob.getByRole('button', { name: /^Buy / }).click();
await cta.filter({ hasText: 'Sign in to Nexus' }).waitFor({ timeout: 30000 });
await cta.click();
const dialogOpened = await bob.getByLabel('Username').isVisible();
check('signed out: the swap button opens the sign-in', dialogOpened);
await bob.keyboard.press('Escape');
await signIn(bob, 'bob');
//pick alice's offer by its size chip (the ticket may prefer a cheaper one)
const chip = bob.locator('.sizes button', { hasText: 'at 617' });
if (await chip.count()) {
  await chip.first().click();
}
await bob.locator('#pay-amount').fill('18.51');
await bob.waitForTimeout(800);
const text = (await cta.textContent()) ?? '';
check('ticket matches the offer exactly', /Swap 18\.51 USDT for 0\.03 TESTT/.test(text), text);
//the relay's test config gives TESTT a fixed reference of 620
const note = (await bob.locator('.ticket .market-note').first().textContent().catch(() => '')) ?? '';
check('the ticket shows the market price', /Market price about \$620\.00 \(fixed test price\)/.test(note), note);
await shot(bob, 'ticket-ready');
await cta.click();
await bob.getByRole('heading', { name: 'Your swaps' }).waitFor({ timeout: 60000 });
log('bob swapped from the ticket');

//network switch while a swap runs: asks first, Stay keeps the page
await bob.locator('.netswitch').getByRole('button', { name: 'Mainnet' }).click();
const ask = bob.locator('.netbar-ask');
check('switching asks while a swap runs', await ask.isVisible(), ((await ask.textContent()) ?? '').slice(0, 120));
await shot(bob, 'switch-asks');
await ask.getByRole('button', { name: 'Stay' }).click();
check('Stay keeps testnet', (await bob.locator('html').getAttribute('data-net')) === 'testnet');

const end = Date.now() + 6 * 60 * 1000;
let state = '';
let lastStatus = '';
while (Date.now() < end) {
  state = ((await bob.locator('.state').first().textContent()) ?? '').trim();
  if (/Swapped|Refunded|Lost|Stopped|Not accepted/.test(state)) {
    break;
  }
  //one picture per new status line, for review of the progress display
  const status = ((await bob.locator('.progress-status').first().textContent().catch(() => '')) ?? '').trim();
  if (status && status !== lastStatus && n < 12) {
    lastStatus = status;
    log(`status: ${status}`);
    await shot(bob, 'progress');
  }
  await bob.waitForTimeout(2000);
}
check('swap finished', /Swapped/.test(state), state);
//both locks and both collects, one row each
//a finished swap sits in a closed History row
const histRow = bob.locator('details.history-row').first();
if (await histRow.count()) {
  await histRow.locator('summary').first().click();
}
const txs = bob.locator('details.txs').first();
await txs.locator('summary').click();
const rows = await txs.locator('li').allTextContents();
check('the swap lists its transactions', rows.length >= 4 && rows.some((r) => /Your lock on/.test(r)) && rows.some((r) => /Their lock on/.test(r)), rows.join(' | '));
//history as a CSV file: header and this swap (newest first)
const [download] = await Promise.all([bob.waitForEvent('download'), bob.getByRole('button', { name: 'Download as CSV' }).click()]);
const csv = (await import('node:fs')).readFileSync(await download.path(), 'utf8').split('\r\n');
check('CSV of the history', /^time_utc,result,side,nexus_amount/.test(csv[0]) && csv.some((l) => /,swapped,bought,0\.03,TESTT,18\.51,USDT,/.test(l)), `${download.suggestedFilename()}: ${csv.slice(0, 2).join(' | ').slice(0, 300)}`);
await shot(bob, 'bob-done');
await bob.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
await shot(bob, 'bob-done-dark');
await bob.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
await bob.setViewportSize({ width: 390, height: 900 });
await shot(bob, 'bob-done-phone');
if (!/Swapped/.test(state)) {
  await dumpSwaps(bob, 'bob');
  await dumpSwaps(alice, 'alice');
}
await browser.close();
log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exitCode = failed ? 1 : 0;
