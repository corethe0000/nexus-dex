//a swap where the taker signs its Nexus steps with the Nexus Wallet extension (nexus_swapStep): alice posts an offer
//(signs in the page), bob uses the extension in "sign in this browser" mode and approves each Nexus step in the
//wallet window with his PIN. Private chain + anvil, relay and app dev server running (as ui-e2e.mjs).
//MODE=collect (default): alice sells TESTT, bob reveals + collects through the wallet; MODE=lock: alice buys TESTT,
//bob locks through the wallet; MODE=refund: as lock, alice leaves after accepting, bob takes his lock back (~22 min)
//  PLAYWRIGHT=$HOME/review/node_modules/playwright APP=http://127.0.0.1:5180 SHOTS=$HOME/review/dex-ext EXT=$HOME/wallet/.output/chrome-mv3 node tools/ext-e2e.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, dumpSwaps, launch, log, open, openIn, people, postOffer, signIn } from './pw-helpers.mjs';

const shots = process.env.SHOTS ?? './shots';
mkdirSync(shots, { recursive: true });
const ext = resolve(process.env.EXT ?? `${process.env.HOME}/wallet/.output/chrome-mv3`);
const walletNode = process.env.WALLET_NODE ?? 'http://127.0.0.1:7080';
const [bobUser, bobPass, bobPin] = people.bob.nexus;
const mode = process.env.MODE ?? 'collect';
const buy = mode !== 'collect';
const price = buy ? '610' : '625';
let n = 0;
const shot = (page, name) => page.screenshot({ path: `${shots}/${String(++n).padStart(2, '0')}-${name}.png`, fullPage: true });

const setup = mode === 'setup';
//setup: a profile made in the wallet right now, so it has no swap register yet
const [user, pass, pinCode] = setup ? [`dx${Date.now().toString(36).slice(-6)}`, 'setuppass1', '3131'] : [bobUser, bobPass, bobPin];

const browser = await launch();
let alice = null;
if (!setup) {
  alice = await open(browser, 'alice');
  await signIn(alice, 'alice');
  await postOffer(alice, { amount: '0.04', price, chain: 'Local chain', buy });
  log('alice posted');
}

//bob (or the new profile): Chromium with the wallet, logged in "sign in this browser"
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'dexext-')), {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
const extOrigin = `chrome-extension://${sw.url().split('/')[2]}`;
const wallet = await ctx.newPage();
await wallet.setViewportSize({ width: 360, height: 640 });
await wallet.goto(`${extOrigin}/popup.html`);
await wallet.getByLabel('Core address').fill(walletNode);
await wallet.getByLabel('API user').fill('');
await wallet.getByText('Sign in this browser (no login on the node)').click();
await wallet.getByRole('button', { name: 'Connect' }).click();
if (setup) {
  const field = (label) => wallet.locator(`label:has(.field-label:text-is("${label}")) input`);
  await wallet.getByRole('button', { name: 'Create a new account' }).click();
  await wallet.getByLabel('Username').fill(user);
  await field('Password').fill(pass);
  await wallet.getByLabel('Password again').fill(pass);
  await field('PIN').fill(pinCode);
  await wallet.getByLabel('PIN again').fill(pinCode);
  await wallet.getByRole('button', { name: 'Create a new account' }).click();
  await wallet.locator('.notice.ok').waitFor({ timeout: 300000 });
  log(`profile ${user} made in the wallet`);
  //the profile's first transaction must be in a block before it can log in
  await wallet.waitForTimeout(75000);
  await wallet.getByRole('button', { name: 'Back', exact: true }).click().catch(() => {});
}
await wallet.getByLabel('Username').fill(user);
await wallet.getByLabel('Password').fill(pass);
await wallet.getByLabel('PIN').fill(pinCode);
await wallet.getByRole('button', { name: 'Log in' }).click();
await wallet.locator('.balance-card').waitFor({ timeout: 90000 });
log(`${user} logged in to the wallet`);

//every wallet window: connect, then swap steps with the PIN; what it showed is logged
const approved = [];
const hints = [];
let bob = null;
ctx.on('page', async (p) => {
  if (!p.url().startsWith(extOrigin)) {
    return;
  }
  try {
    await p.waitForLoadState();
    const connect = p.getByRole('button', { name: 'Connect', exact: true });
    const pin = p.getByLabel('Confirm with your PIN');
    const unlock = p.getByRole('button', { name: 'Unlock', exact: true });
    await connect.or(pin).or(unlock).first().waitFor({ timeout: 60000 });
    //the wallet locks itself after 15 idle minutes (a refund comes later than that): the window unlocks first
    if (await unlock.isVisible()) {
      await shot(p, 'wallet-unlock');
      approved.push('unlock');
      log('wallet window: unlock first');
      const password = p.getByLabel('Password');
      if (await password.isVisible()) {
        await password.fill(pass);
      }
      await p.getByLabel('PIN', { exact: true }).fill(pinCode);
      await unlock.click();
      await connect.or(pin).first().waitFor({ timeout: 60000 });
    }
    await shot(p, 'wallet-window');
    const text = ((await p.locator('.page').first().textContent()) ?? '').replace(/\s+/g, ' ');
    if (await connect.isVisible()) {
      approved.push('connect');
      log(`wallet window: connect`);
      await connect.click();
      return;
    }
    log(`wallet window: ${text.slice(0, 220)}`);
    approved.push(text);
    //the page must say meanwhile that it waits for the wallet (swap card, or the setup note)
    const hint = bob.locator('.wallet-wait, dialog .note', { hasText: 'Nexus Wallet window' }).first();
    const hinted = await hint.waitFor({ timeout: 10000 }).then(() => true, () => false);
    hints.push(hinted);
    log(`page while the wallet waits: ${hinted ? (await hint.textContent()) : 'NO HINT'}`);
    if (hinted) {
      await shot(bob, 'page-waits-for-wallet');
    }
    await pin.fill(pinCode);
    await p.getByRole('button', { name: 'Approve' }).click();
  } catch (e) {
    log(`wallet window failed: ${e.message}`);
  }
});

bob = await openIn(ctx, 'bob');
await bob.locator('.top').getByRole('button', { name: 'Sign in to Nexus' }).click();
await bob.getByRole('button', { name: 'Use the Nexus Wallet' }).click();
await bob.locator('dialog[open] .profile-name').waitFor({ timeout: 60000 });
await shot(bob, 'signed-in-extension');
if (setup) {
  const setUp = bob.getByRole('button', { name: 'Set up swaps' });
  await setUp.click();
  //one block; the button goes once the page sees the register (or an error shows)
  await bob.locator('dialog .problem', { hasText: /rejected|failed|wallet/i }).or(bob.getByText('Setting up swaps')).first().waitFor({ timeout: 60000 }).catch(() => {});
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await bob.waitForTimeout(3000);
    ready = !(await setUp.isVisible()) && !(await bob.getByText('Setting up swaps').isVisible());
  }
  await shot(bob, 'setup-done');
  const problem = ready ? '' : ((await bob.locator('dialog .problem').allTextContents()).join(' | '));
  const steps = approved.filter((a) => a !== 'connect' && a !== 'unlock');
  log(`result: setup ${ready ? 'done' : 'not done ' + problem}, wallet windows: connect ${approved.includes('connect')}, swap steps ${steps.length}`);
  await ctx.close();
  await browser.close();
  process.exit(ready && approved.includes('connect') && hints.every(Boolean) && steps.some((s) => /set up|swap register/i.test(s)) ? 0 : 1);
}
await bob.getByRole('button', { name: 'Close' }).first().click();
await bob.locator('.top').getByRole('button', { name: 'Connect wallet' }).click();
await bob.getByRole('button', { name: 'Test wallet (anvil)' }).click();
await bob.locator('.top').getByRole('button', { name: / on / }).waitFor({ timeout: 30000 });
log('bob signed in through the extension');

const row = bob.locator('table.book tbody tr', { hasText: price }).first();
await row.waitFor({ timeout: 30000 });
await row.click();
await bob.getByRole('button', { name: /^Swap for/ }).click();
await bob.getByRole('heading', { name: 'Your swaps' }).waitFor({ timeout: 60000 });
log('bob took the offer');

const end = Date.now() + (mode === 'refund' ? 32 : 8) * 60 * 1000;
let aliceGone = false;
let nudger = null;
let state = '';
let lastShot = 0;
while (Date.now() < end) {
  state = (await bob.locator('.state').first().textContent()) ?? '';
  if (Date.now() - lastShot > 45000) {
    await shot(bob, 'progress');
    lastShot = Date.now();
  }
  //refund: alice closes her page once bob's lock went out through the wallet, before she locks
  if (mode === 'refund' && !aliceGone && approved.some((s) => /lock a payment/.test(s))) {
    await dumpSwaps(alice, 'alice');
    await alice.context().close();
    aliceGone = true;
    log('alice closed her page');
    //the private chain makes no block by itself; the refund needs one after the deadline (alice's chain is free now)
    //tsx itself, not through npx: kill() must reach the process that holds stdout
    nudger = spawn(resolve('../node_modules/.bin/tsx'), ['core/src/testing/nudge-loop.ts'], { cwd: resolve('..'), stdio: ['ignore', 'inherit', 'inherit'] });
  }
  if (/Swapped|Refunded|Lost|Stopped|Not accepted/.test(state)) {
    break;
  }
  await bob.waitForTimeout(3000);
}
let aliceState = 'left';
if (!aliceGone) {
  await alice.getByRole('button', { name: /Your swaps/ }).click();
  //her last Nexus step may still wait for its block
  for (let i = 0; i < 40 && !/Swapped|Refunded|Lost|Stopped/.test(aliceState); i++) {
    await alice.waitForTimeout(3000);
    aliceState = (await alice.locator('.state').first().textContent()) ?? '';
  }
}
await shot(bob, 'bob-done');
await dumpSwaps(bob, 'bob');
if (!aliceGone) {
  await dumpSwaps(alice, 'alice');
}
nudger?.kill();
await ctx.close();
await browser.close();
const steps = approved.filter((a) => a !== 'connect' && a !== 'unlock').length;
log(`result: bob ${state}, alice ${aliceState}, wallet windows: connect ${approved.includes('connect')}, swap steps ${steps}`);
const asked = (re) => approved.some((s) => re.test(s));
const ok = {
  collect: /Swapped/.test(state) && /Swapped/.test(aliceState) && asked(/publish the secret/) && asked(/collect a swap payment/),
  lock: /Swapped/.test(state) && /Swapped/.test(aliceState) && asked(/lock a payment/),
  refund: /Refunded/.test(state) && asked(/lock a payment/) && asked(/take back your swap lock/),
}[mode];
process.exitCode = ok && approved.includes('connect') && hints.length > 0 && hints.every(Boolean) ? 0 : 1;
