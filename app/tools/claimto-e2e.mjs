//the maker's address cannot take the payment (as a USDT/USDC address the issuer froze): alice sells TESTT for ETH,
//her address refuses ETH (anvil_setCode: an EIP-7702 delegation to code that reverts, the address can still sign),
//so her collect fails; her swap card then offers "Receive at another address" and the ETH goes to another address
//through NexusSwap claimTo. Private chain + anvil (local chain only).
//  PLAYWRIGHT=$HOME/review/node_modules/playwright APP=http://127.0.0.1:5180 SHOTS=$HOME/review/dex-claimto node tools/claimto-e2e.mjs
import { mkdirSync } from 'node:fs';
import { dumpSwaps, launch, log, open, people, postOffer, signIn } from './pw-helpers.mjs';

const shots = process.env.SHOTS ?? './shots';
const rpc = process.env.EVM_RPC ?? 'http://127.0.0.1:8545';
//code that refuses everything (PUSH0 PUSH0 REVERT) at an address nobody uses, and a fresh address to collect to
const refuser = '0x00000000000000000000000000000000000dEaD1';
const other = '0x00000000000000000000000000000000C0ffEE01';
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
  await call('anvil_setCode', [people.alice.evm, on ? `0xef0100${refuser.slice(2).toLowerCase()}` : '0x']);
};

const before = await balance(other);
const browser = await launch();
try {
  const alice = await open(browser, 'alice', 1280, undefined, JSON.stringify({ net: 'testnet', mode: 'advanced', theme: 'light', venue: 'stable' }));
  await signIn(alice, 'alice');
  //0.02 TESTT at 0.31 ETH each = 0.0062 ETH
  await postOffer(alice, { amount: '0.02', price: '0.31', chain: 'Local chain', paidIn: 'ETH' });
  log('alice posted 0.02 TESTT for ETH');
  await frozen(true);
  log("alice's address now refuses ETH");

  const bob = await open(browser, 'bob', 1280, undefined, JSON.stringify({ net: 'testnet', mode: 'simple', theme: 'light', venue: 'stable' }));
  await signIn(bob, 'bob');
  await bob.getByRole('button', { name: /^Buy / }).click();
  await bob.getByRole('combobox', { name: 'Coin and chain' }).selectOption({ label: 'ETH on Local chain' });
  await bob.locator('#pay-amount').fill('0.0062');
  await bob.waitForTimeout(1000);
  await bob.locator('.ticket .btn.big').click();
  await bob.getByRole('heading', { name: 'Your swaps' }).waitFor({ timeout: 60000 });
  await alice.getByRole('button', { name: /Your swaps/ }).click();

  //alice's collect fails, then the card offers another address
  const box = alice.locator('details.collect-to');
  if (!(await box.waitFor({ timeout: 8 * 60 * 1000 }).then(() => true, () => false))) {
    await shot(alice, 'alice-no-option');
    await dumpSwaps(alice, 'alice');
    await dumpSwaps(bob, 'bob');
    throw new Error('the card never offered another address');
  }
  check('the card offers another address after the collect failed', true);
  await box.locator('summary').click();
  await shot(alice, 'alice-collect-to');
  await box.getByRole('textbox').fill('0x1234');
  await box.getByRole('button', { name: 'Send it there' }).click();
  const bad = (await box.locator('.problem').textContent({ timeout: 10000 }).catch(() => '')) ?? '';
  check('a wrong address is refused before anything is sent', /not an address/.test(bad), bad);
  await box.getByRole('textbox').fill(people.alice.evm);
  await box.getByRole('button', { name: 'Send it there' }).click();
  await alice.waitForTimeout(1000);
  const same = (await box.locator('.problem').textContent().catch(() => '')) ?? '';
  check('the address that cannot receive is refused', /another address/.test(same), same);
  await box.getByRole('textbox').fill(other);
  await box.getByRole('button', { name: 'Send it there' }).click();
  await alice.getByText(/Sent to your other address/).waitFor({ timeout: 60000 });
  check('the page says it was sent', true);

  const end = Date.now() + 10 * 60 * 1000;
  let state = '';
  while (Date.now() < end) {
    state = ((await alice.locator('.state').first().textContent()) ?? '').trim();
    if (/Swapped|Refunded|Lost|Stopped/.test(state)) {
      break;
    }
    await alice.waitForTimeout(3000);
  }
  const row = alice.locator('details.history-row').first();
  if (await row.count()) {
    await row.locator('summary').first().click();
  }
  await shot(alice, 'alice-done');
  check("alice's swap finished", /Swapped/.test(state), state);
  const got = (await balance(other)) - before;
  check('the other address got the 0.0062 ETH', got === 6200000000000000n, `${got} wei`);
  //bob credits on Nexus after alice's claim can already be in, give him a bit
  const bobEnd = Date.now() + 3 * 60 * 1000;
  let bobState = '';
  while (Date.now() < bobEnd) {
    bobState = ((await bob.locator('.state').first().textContent()) ?? '').trim();
    if (/Swapped|Refunded|Lost|Stopped/.test(bobState)) {
      break;
    }
    await bob.waitForTimeout(3000);
  }
  check("bob's swap finished too", /Swapped/.test(bobState), bobState);
  if (!/Swapped/.test(state) || !/Swapped/.test(bobState)) {
    await dumpSwaps(alice, 'alice');
    await dumpSwaps(bob, 'bob');
  }
} finally {
  await frozen(false).catch((e) => log(`alice's code not reset: ${e.message}`));
  await browser.close();
}
log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exitCode = failed ? 1 : 0;
