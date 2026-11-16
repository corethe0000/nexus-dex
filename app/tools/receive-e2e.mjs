//selling Nexus coins with only a receiving address (no EVM wallet in that browser): the relay's watcher collects the
//USDT for the seller. Private chain + anvil, relay and app dev server running (as ui-e2e.mjs).
//case maker: alice receives only and posts an offer selling TESTT, bob (test wallet) buys it
//case taker: alice (test wallet) posts an offer buying TESTT, bob receives only and takes it
//Each receiving address is new, so its USDT balance afterwards must be exactly the price.
//BLOCK=relay (taker case): bob's page cannot reach the relay's collect; the independent keeper must collect.
//BLOCK=all (taker case): neither relay nor keeper, so nobody gets the key; bob has a wallet in the browser and uses
//"Collect it yourself". Either way the receiving address must get exactly the price, the helper wallet nothing.
//  PLAYWRIGHT=$HOME/review/node_modules/playwright APP=http://127.0.0.1:5180 SHOTS=$HOME/review/dex-receive CASES=maker,taker node tools/receive-e2e.mjs
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { app, dumpSwaps, launch, log, open, people, postOffer, signIn } from './pw-helpers.mjs';

const shots = process.env.SHOTS ?? './shots';
mkdirSync(shots, { recursive: true });
const cases = (process.env.CASES ?? 'maker,taker').split(',');
const evmRpc = process.env.EVM_RPC ?? 'http://127.0.0.1:8545';
const amount = '0.04';
let n = 0;
const shot = (page, name) => page.screenshot({ path: `${shots}/${String(++n).padStart(2, '0')}-${name}.png`, fullPage: true });

const info = await (await fetch(`${app}/relay/api/info`)).json();
const usdt = info.chains['31337'].tokens.find((t) => t.symbol === 'USDT');

async function usdtOf(address) {
  const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, '0')}`;
  const r = await (await fetch(evmRpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: usdt.address, data }, 'latest'] }) })).json();
  return BigInt(r.result);
}

async function stateOf(page) {
  return ((await page.locator('.state').first().textContent().catch(() => '')) ?? '').trim();
}

async function runCase(browser, which) {
  const receiver = `0x${randomBytes(20).toString('hex')}`;
  const price = which === 'maker' ? '625' : '610';
  const expected = BigInt(Math.round(Number(amount) * Number(price) * 10 ** usdt.decimals));
  //the side that sells TESTT has no wallet in its browser at all
  const alice = await open(browser, 'alice', 1280, which === 'maker' ? 'none' : undefined);
  await signIn(alice, 'alice', which === 'maker' ? { receive: receiver } : {});
  await postOffer(alice, { amount, price, chain: 'Local chain', buy: which === 'taker' });
  log(`${which}: alice posted at ${price}`);
  const block = which === 'taker' ? process.env.BLOCK : undefined;
  const fallback = block === 'all';
  const bob = await open(browser, 'bob', 1280, which === 'taker' && !fallback ? 'none' : undefined);
  const helperBefore = fallback ? await usdtOf(people.bob.evm) : 0n;
  let helped = false;
  if (block) {
    await bob.route('**/api/takes/*/claim', (r) => r.abort());
  }
  if (fallback) {
    await bob.route('**/keeper/claim', (r) => r.abort());
  }
  await signIn(bob, 'bob', which === 'taker' ? { receive: receiver } : {});
  const row = bob.locator('table.book tbody tr', { hasText: price }).first();
  await row.waitFor({ timeout: 30000 });
  await row.click();
  await shot(bob, `${which}-take`);
  await bob.getByRole('button', { name: /^Swap for/ }).click();
  await bob.getByRole('heading', { name: 'Your swaps' }).waitFor({ timeout: 60000 });
  log(`${which}: bob took the offer`);
  await alice.getByRole('button', { name: /Your swaps/ }).click();
  //the receive-only side is done once its USDT arrived; the other side once its page says Swapped
  const seller = which === 'maker' ? alice : bob;
  const buyer = which === 'maker' ? bob : alice;
  const end = Date.now() + 8 * 60 * 1000;
  let got = 0n;
  let sState = '';
  let bState = '';
  while (Date.now() < end) {
    if (fallback && !helped) {
      const button = bob.getByRole('button', { name: /^Collect with / }).first();
      if (await button.isVisible()) {
        await shot(bob, 'collect-yourself');
        log(`fallback: ${((await bob.locator('.collect-myself p').first().textContent()) ?? '').slice(0, 240)}`);
        await button.click();
        helped = true;
        log('fallback: bob collects with his own wallet');
      }
    }
    got = await usdtOf(receiver);
    sState = await stateOf(seller);
    bState = await stateOf(buyer);
    if (got >= expected && /Swapped/.test(sState) && /Swapped/.test(bState)) {
      break;
    }
    if (/Refunded|Lost|Stopped|Not accepted/.test(sState + bState)) {
      break;
    }
    await bob.waitForTimeout(3000);
  }
  await shot(seller, `${which}-seller-done`);
  await dumpSwaps(bob, 'bob');
  await dumpSwaps(alice, 'alice');
  const helperGot = fallback ? (await usdtOf(people.bob.evm)) - helperBefore : 0n;
  const ok = got === expected && /Swapped/.test(sState) && /Swapped/.test(bState) && (!fallback || (helped && helperGot === 0n));
  log(`result ${which}${block ? ` (blocked: ${block})` : ''}: receiver ${receiver} got ${got} (expected ${expected}), seller ${sState}, buyer ${bState}${fallback ? `, collect panel used ${helped}, helper wallet USDT change ${helperGot}` : ''}: ${ok ? 'PASSED' : 'FAILED'}`);
  await alice.context().close();
  await bob.context().close();
  return ok;
}

const browser = await launch();
let ok = true;
for (const c of cases) {
  ok = (await runCase(browser, c)) && ok;
}
await browser.close();
process.exitCode = ok ? 0 : 1;
