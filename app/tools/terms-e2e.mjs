//the notice before the first swap: bob's first swap click opens it, Continue waits for the box, after agreeing the
//same click starts the swap, and the agreement is kept. alice posts with the notice agreed (pw-helpers default).
//Private chain + anvil + relay + app dev server running (as ui-e2e.mjs).
//  PLAYWRIGHT=$HOME/review/node_modules/playwright APP=http://127.0.0.1:5180 SHOTS=$HOME/review/dex-terms node tools/terms-e2e.mjs
import { mkdirSync } from 'node:fs';
import { dumpSwaps, launch, log, open, postOffer, signIn } from './pw-helpers.mjs';

const shots = process.env.SHOTS ?? './shots';
mkdirSync(shots, { recursive: true });
let failed = 0;
const check = (label, ok, detail = '') => {
  log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' - ' + detail : ''}`);
  failed += ok ? 0 : 1;
};
const prefs = (p) => JSON.stringify({ net: 'testnet', mode: 'simple', theme: 'light', venue: 'stable', ...p });

const browser = await launch();
try {
  const alice = await open(browser, 'alice', 1280, undefined, prefs({ mode: 'advanced' }));
  await signIn(alice, 'alice');
  await postOffer(alice, { amount: '0.02', price: '625', chain: 'Local chain' });
  log('alice posted 0.02 TESTT for 12.5 USDT');

  process.env.TERMS = 'show';
  const bob = await open(browser, 'bob', 1280, undefined, prefs({}));
  delete process.env.TERMS;
  await signIn(bob, 'bob');
  await bob.getByRole('button', { name: /^Buy / }).click();
  await bob.getByRole('combobox', { name: 'Coin and chain' }).selectOption({ label: 'USDT on Local chain' });
  await bob.locator('#pay-amount').fill('12.5');
  await bob.waitForTimeout(1000);
  await bob.locator('.ticket .btn.big').click();
  const dialog = bob.locator('dialog[open]');
  const title = ((await dialog.locator('h2').textContent({ timeout: 10000 }).catch(() => '')) ?? '').trim();
  check('the first swap click opens the notice', title === 'Before your first swap', title);
  await bob.screenshot({ path: `${shots}/01-notice.png` });
  const cont = dialog.getByRole('button', { name: 'Continue' });
  check('Continue waits for the box', await cont.isDisabled());
  await dialog.getByRole('checkbox').check();
  await cont.click();
  check('the notice closes after agreeing', !(await bob.locator('dialog[open]').count()));
  check('the agreement is kept', (await bob.evaluate(() => localStorage.getItem('nexus-dex:terms'))) === '1');
  await bob.locator('.ticket .btn.big').click();
  const started = await bob.getByRole('heading', { name: 'Your swaps' }).waitFor({ timeout: 60000 }).then(() => true, () => false);
  check('the same click then starts the swap', started);

  const end = Date.now() + 8 * 60 * 1000;
  let state = '';
  while (Date.now() < end) {
    state = ((await bob.locator('.state').first().textContent().catch(() => '')) ?? '').trim();
    if (/Swapped|Refunded|Lost|Stopped/.test(state)) {
      break;
    }
    await bob.waitForTimeout(3000);
  }
  check("bob's swap finished", /Swapped/.test(state), state);
  if (!/Swapped/.test(state)) {
    await dumpSwaps(bob, 'bob');
  }
} finally {
  await browser.close();
}
log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exitCode = failed ? 1 : 0;
