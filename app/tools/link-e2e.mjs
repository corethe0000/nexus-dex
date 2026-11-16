//a shared offer link: alice posts an offer and copies its link from "Your offers"; bob opens it (stored choice:
//advanced) and lands in the simple ticket on that offer; a link to an offer that is not up says so.
//  PLAYWRIGHT=$HOME/review/node_modules/playwright APP=http://127.0.0.1:5180 node tools/link-e2e.mjs
import { app, launch, log, open, postOffer, signIn } from './pw-helpers.mjs';

const browser = await launch();
let failed = 0;
const check = (ok, what) => {
  log(`${ok ? 'ok' : 'FAILED'}: ${what}`);
  failed += ok ? 0 : 1;
};

const alice = await open(browser, 'alice');
await alice.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(app).origin });
await signIn(alice, 'alice');
await postOffer(alice, { amount: '0.03', price: '615', chain: 'Local chain' });
const mine = alice.locator('.my-offer', { hasText: '0.03 TESTT' }).first();
await mine.getByRole('button', { name: 'Copy link' }).click();
await mine.getByRole('button', { name: 'Link copied' }).waitFor();
const link = await alice.evaluate(() => navigator.clipboard.readText());
check(/[?&]net=testnet&offer=0x[0-9a-f]{64}$/.test(link), `link ${link}`);

const bob = await open(browser, 'bob');
await bob.goto(link);
await bob.locator('.ticket').waitFor();
await bob.waitForFunction(() => document.querySelector('#pay-amount')?.value === '18.45', null, { timeout: 20000 }).catch(() => {});
check((await bob.locator('#pay-amount').inputValue()) === '18.45', `bob pays ${await bob.locator('#pay-amount').inputValue()} (18.45)`);
check((await bob.locator('output.leg-amount').textContent()) === '0.03', 'bob gets 0.03');
check((await bob.getByRole('button', { name: /^Buy TESTT/ }).getAttribute('aria-pressed')) === 'true', 'ticket is on Buy');
check(!bob.url().includes('offer='), `address bar cleaned (${bob.url()})`);
const prefs = JSON.parse(await bob.evaluate(() => localStorage.getItem('nexus-dex:prefs')));
check(prefs.mode === 'simple' && prefs.net === 'testnet', `choice kept: ${prefs.mode}, ${prefs.net}`);

await bob.goto(`${app}?net=testnet&offer=0x${'0'.repeat(63)}1`);
await bob.locator('.ticket').waitFor();
await bob.getByText(/not up right now/).waitFor({ timeout: 20000 }).catch(() => {});
check(await bob.getByText(/not up right now/).isVisible(), 'a link to an offer that is not up says so');

await mine.getByRole('button', { name: 'Withdraw' }).click();
await browser.close();
log(failed ? `link-e2e: ${failed} FAILED` : 'link-e2e: ALL PASSED');
process.exit(failed ? 1 : 0);
