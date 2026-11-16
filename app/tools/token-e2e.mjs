//a swap against a coin that is not a stablecoin: alice sells TESTT for COIN in the advanced view; the book shows it
//under its own price group, prices in COIN with enough decimals. bob picks "COIN on Local chain" in the simple ticket,
//takes it and the swap goes through. Private chain + anvil.
//COIN=TETH (default): an ERC-20 stand-in for WETH, 18 decimals. COIN=ETH: the chain's own coin (no approve, the coin
//goes along with the lock call).
//On a public testnet: CHAIN=Ethereum RPC_URL=<https rpc> ALICE_KEY_FILE=<maker key> BOB_KEY_FILE=<taker key> (real test
//coins; the keys sign in the test process).
//  PLAYWRIGHT=$HOME/review/node_modules/playwright APP=http://127.0.0.1:5180 SHOTS=$HOME/review/dex-token [COIN=ETH] node tools/token-e2e.mjs
import { mkdirSync, readFileSync } from 'node:fs';
import { dumpSwaps, launch, log, open, postOffer, signIn } from './pw-helpers.mjs';

const shots = process.env.SHOTS ?? './shots';
const coin = process.env.COIN ?? 'TETH';
const chainName = process.env.CHAIN ?? 'Local chain';
const keyOf = (file) => (file ? { key: readFileSync(file, 'utf8').trim(), rpc: process.env.RPC_URL } : undefined);
mkdirSync(shots, { recursive: true });
let n = 0;
const shot = (page, name) => page.screenshot({ path: `${shots}/${String(++n).padStart(2, '0')}-${name}.png`, fullPage: true });
let failed = 0;
const check = (label, ok, detail = '') => {
  log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' - ' + detail : ''}`);
  failed += ok ? 0 : 1;
};

const browser = await launch();
const alice = await open(browser, 'alice', 1280, keyOf(process.env.ALICE_KEY_FILE), JSON.stringify({ net: 'testnet', mode: 'advanced', theme: 'light', venue: 'stable' }));
await signIn(alice, 'alice');
//0.02 TESTT at 0.31 COIN each = 0.0062 COIN
await postOffer(alice, { amount: '0.02', price: '0.31', chain: chainName, paidIn: coin });
log(`alice posted 0.02 TESTT for ${coin}`);

const groups = alice.getByRole('group', { name: 'Priced in' });
const groupNames = await groups.getByRole('button').allTextContents();
check('the book has a price group per kind of coin', groupNames[0] === 'Stablecoins' && groupNames.includes(coin), groupNames.join(','));
await groups.getByRole('button', { name: coin, exact: true }).click();
await alice.waitForTimeout(1500);
const row = (await alice.locator('table.book tbody tr').first().textContent()) ?? '';
check(`the ${coin} book shows the price and total in ${coin}`, (row.includes(`0.31 ${coin}`) || row.includes(`0.3100 ${coin}`)) && row.includes(`0.0062 ${coin}`), row);
await shot(alice, `alice-${coin}-book`);

const bob = await open(browser, 'bob', 1280, keyOf(process.env.BOB_KEY_FILE), JSON.stringify({ net: 'testnet', mode: 'simple', theme: 'light', venue: 'stable' }));
await signIn(bob, 'bob');
await bob.getByRole('button', { name: /^Buy / }).click();
await bob.getByRole('combobox', { name: 'Coin and chain' }).selectOption({ label: `${coin} on ${chainName}` });
await bob.locator('#pay-amount').fill('0.0062');
await bob.waitForTimeout(1000);
const cta = bob.locator('.ticket .btn.big');
const text = (await cta.textContent()) ?? '';
check(`the ticket pays in ${coin} with its decimals`, text.includes(`Swap 0.0062 ${coin} for 0.02 TESTT`), text);
const note = (await bob.locator('.ticket .market-note').first().textContent().catch(() => '')) ?? '';
check(`the market note works through the ${coin} dollar price`, /Market price about \$620\.00/.test(note), note);
await shot(bob, `bob-${coin}-ticket`);
await cta.click();
await bob.getByRole('heading', { name: 'Your swaps' }).waitFor({ timeout: 60000 });

const end = Date.now() + 15 * 60 * 1000;
let state = '';
while (Date.now() < end) {
  state = ((await bob.locator('.state').first().textContent()) ?? '').trim();
  if (/Swapped|Refunded|Lost|Stopped|Not accepted/.test(state)) {
    break;
  }
  await bob.waitForTimeout(3000);
}
const histRow = bob.locator('details.history-row').first();
if (await histRow.count()) {
  await histRow.locator('summary').first().click();
}
await shot(bob, 'bob-done');
check(`the ${coin} swap finished`, /Swapped/.test(state), state);
const status = (await bob.locator('.progress-status').first().textContent()) ?? '';
check('the result names the coin received', /You received 0\.02 TESTT/.test(status), status);
if (!/Swapped/.test(state)) {
  await dumpSwaps(bob, 'bob');
  await dumpSwaps(alice, 'alice');
}
await browser.close();
log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exitCode = failed ? 1 : 0;
