//the taker's address cannot take its refund back (as a USDT/USDC address the issuer froze): bob buys TESTT for ETH,
//alice accepts and leaves without locking, bob's address is made to refuse ETH (anvil_setCode: an EIP-7702 delegation
//to code that reverts, the address can still sign). After the deadline bob's refund fails, his swap card offers
//"Refund to another address" and the ETH goes to another address through NexusSwap refundTo. Private chain + anvil
//(local chain only), about 25 minutes (the test timing's 20 minute lock).
//  PLAYWRIGHT=$HOME/review/node_modules/playwright APP=http://127.0.0.1:5180 SHOTS=$HOME/review/dex-refundto node tools/refundto-e2e.mjs
import { mkdirSync } from 'node:fs';
import { dumpSwaps, launch, log, open, people, postOffer, savedSwaps, signIn } from './pw-helpers.mjs';

const shots = process.env.SHOTS ?? './shots';
const rpc = process.env.EVM_RPC ?? 'http://127.0.0.1:8545';
//code that refuses everything (PUSH0 PUSH0 REVERT) at an address nobody uses, and a fresh address to refund to
const refuser = '0x00000000000000000000000000000000000dEaD1';
const other = '0x00000000000000000000000000000000C0ffEE02';
mkdirSync(shots, { recursive: true });
let n = 0;
const shot = (page, name) => page.screenshot({ path: `${shots}/${String(++n).padStart(2, '0')}-${name}.png`, fullPage: true });
let failed = 0;
const check = (label, ok, detail = '') => {
  log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' - ' + detail : ''}`);
  failed += ok ? 0 : 1;
};
const call = async (method, params) => {
  const j = await (await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (j.error) {
    throw new Error(`${method}: ${j.error.message}`);
  }
  return j.result;
};
const balance = async (a) => BigInt(await call('eth_getBalance', [a, 'latest']));
const frozen = async (on) => {
  if (on) {
    await call('anvil_setCode', [refuser, '0x5f5ffd']);
  }
  await call('anvil_setCode', [people.bob.evm, on ? `0xef0100${refuser.slice(2).toLowerCase()}` : '0x']);
};
const stateOf = async (page) => ((await page.locator('.state').first().textContent().catch(() => '')) ?? '').trim();

const before = await balance(other);
const browser = await launch();
try {
  const alice = await open(browser, 'alice', 1280, undefined, JSON.stringify({ net: 'testnet', mode: 'advanced', theme: 'light', venue: 'stable' }));
  await signIn(alice, 'alice');
  //0.02 TESTT at 0.31 ETH each = 0.0062 ETH
  await postOffer(alice, { amount: '0.02', price: '0.31', chain: 'Local chain', paidIn: 'ETH' });
  log('alice posted 0.02 TESTT for ETH');

  const bob = await open(browser, 'bob', 1280, undefined, JSON.stringify({ net: 'testnet', mode: 'simple', theme: 'light', venue: 'stable' }));
  await signIn(bob, 'bob');
  await bob.getByRole('button', { name: /^Buy / }).click();
  await bob.getByRole('combobox', { name: 'Coin and chain' }).selectOption({ label: 'ETH on Local chain' });
  await bob.locator('#pay-amount').fill('0.0062');
  await bob.waitForTimeout(1000);
  await bob.locator('.ticket .btn.big').click();
  await bob.getByRole('heading', { name: 'Your swaps' }).waitFor({ timeout: 60000 });

  //alice accepts, then leaves before she locks
  const acceptEnd = Date.now() + 3 * 60 * 1000;
  while (Date.now() < acceptEnd && (await savedSwaps(alice))[0]?.stage !== 'running') {
    await alice.waitForTimeout(500);
  }
  await alice.context().close();
  log('alice accepted and left without locking');

  //bob's lock goes in, then his address stops taking ETH
  const lockEnd = Date.now() + 5 * 60 * 1000;
  while (Date.now() < lockEnd && !(await savedSwaps(bob))[0]?.rec?.evmLock) {
    await bob.waitForTimeout(2000);
  }
  check("bob's lock is in", !!(await savedSwaps(bob))[0]?.rec?.evmLock);
  await bob.waitForTimeout(15000);
  await frozen(true);
  log("bob's address now refuses ETH");

  //after the deadline bob's own refund fails, then the card offers another address
  const box = bob.locator('details.collect-to');
  if (!(await box.waitFor({ timeout: 30 * 60 * 1000 }).then(() => true, () => false))) {
    await shot(bob, 'bob-no-option');
    await dumpSwaps(bob, 'bob');
    throw new Error('the card never offered another address for the refund');
  }
  const title = ((await box.locator('summary').textContent()) ?? '').trim();
  check('the card offers to refund to another address', /Refund to another address/.test(title), title);
  await box.locator('summary').click();
  await shot(bob, 'bob-refund-to');
  await box.getByRole('textbox').fill(people.bob.evm);
  await box.getByRole('button', { name: 'Send it there' }).click();
  await bob.waitForTimeout(1000);
  const same = (await box.locator('.problem').textContent().catch(() => '')) ?? '';
  check('the address that cannot receive is refused', /another address/.test(same), same);
  await box.getByRole('textbox').fill(other);
  await box.getByRole('button', { name: 'Send it there' }).click();
  await bob.getByText(/Refund sent to your other address/).waitFor({ timeout: 60000 });
  check('the page says the refund was sent', true);

  const end = Date.now() + 5 * 60 * 1000;
  let state = '';
  while (Date.now() < end) {
    state = await stateOf(bob);
    if (/Swapped|Refunded|Lost|Stopped/.test(state)) {
      break;
    }
    await bob.waitForTimeout(3000);
  }
  await shot(bob, 'bob-done');
  check("bob's swap ended refunded", /Refunded/.test(state), state);
  const got = (await balance(other)) - before;
  check('the other address got the 0.0062 ETH back', got === 6200000000000000n, `${got} wei`);
  if (!/Refunded/.test(state)) {
    await dumpSwaps(bob, 'bob');
  }
} finally {
  await frozen(false).catch((e) => log(`bob's code not reset: ${e.message}`));
  await browser.close();
}
log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exitCode = failed ? 1 : 0;
