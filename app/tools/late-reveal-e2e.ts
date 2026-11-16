//the wallet extension refuses to publish a swap secret too close to the lock's deadline: alice locks 0.01 TESTT to
//bob twice (deadline 40 s and 200 s away), bob's page asks the wallet for a reveal against each. The near one must
//be refused without any window; the far one opens the window (rejected here, nothing is published). alice takes
//both locks back at the end. Private chain + anvil, app dev server, wallet build.
//  cd ~/dex && PLAYWRIGHT=$HOME/review/node_modules/playwright APP=http://127.0.0.1:5180 NEXUS_NODE=http://127.0.0.1:7080 EVM_RPC=http://127.0.0.1:8545 CONTRACTS=$HOME/dex/contracts/out SHOTS=$HOME/review/dex-late npx tsx app/tools/late-reveal-e2e.ts
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hashOf, newSecret } from '../../core/src/nexus/htlc';
import { localSigner } from '../../core/src/nexus/signer';
import { nameContract } from '../../../wallet/src/lib/tritium';
import { alice, bob, ensureSlot, localChains } from '../../core/src/testing/local';
// @ts-expect-error plain JS helper
import { chromium, log, openIn, people } from './pw-helpers.mjs';

const shots = process.env.SHOTS ?? './shots';
mkdirSync(shots, { recursive: true });
const ext = resolve(process.env.EXT ?? `${process.env.HOME}/wallet/.output/chrome-mv3`);
const [user, pass, pin] = people.bob.nexus;
let failed = 0;
const check = (label: string, ok: boolean, detail = '') => {
  log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' - ' + detail : ''}`);
  failed += ok ? 0 : 1;
};
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const { node } = localChains();
const aliceGenesis = await ensureSlot(node, alice);
const bobGenesis = await ensureSlot(node, bob);

//bob in Chromium with the wallet, "sign in this browser"
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'dexlate-')), {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
const extOrigin = `chrome-extension://${sw.url().split('/')[2]}`;
const wallet = await ctx.newPage();
await wallet.goto(`${extOrigin}/popup.html`);
await wallet.getByLabel('Core address').fill(process.env.NEXUS_NODE ?? 'http://127.0.0.1:7080');
await wallet.getByLabel('API user').fill('');
await wallet.getByText('Sign in this browser (no login on the node)').click();
await wallet.getByRole('button', { name: 'Connect' }).click();
await wallet.getByLabel('Username').fill(user);
await wallet.getByLabel('Password').fill(pass);
await wallet.getByLabel('PIN').fill(pin);
await wallet.getByRole('button', { name: 'Log in' }).click();
await wallet.locator('.balance-card').waitFor({ timeout: 90000 });

//wallet windows: connect is approved, a swap step is looked at and rejected
const windows: string[] = [];
ctx.on('page', async (p: any) => {
  if (!p.url().startsWith(extOrigin)) {
    return;
  }
  await p.waitForLoadState();
  const connect = p.getByRole('button', { name: 'Connect', exact: true });
  const reject = p.getByRole('button', { name: 'Reject' });
  await connect.or(p.getByLabel('Confirm with your PIN')).first().waitFor({ timeout: 60000 });
  if (await connect.isVisible()) {
    windows.push('connect');
    await connect.click();
    return;
  }
  const text = ((await p.locator('.page').first().textContent()) ?? '').replace(/\s+/g, ' ');
  windows.push(text);
  log(`wallet window: ${text.slice(0, 200)}`);
  await p.screenshot({ path: `${shots}/wallet-window-far-lock.png` });
  await reject.click();
});
const page = await openIn(ctx, 'bob');
await page.locator('.top').getByRole('button', { name: 'Sign in to Nexus' }).click();
await page.getByRole('button', { name: 'Use the Nexus Wallet' }).click();
await page.locator('dialog[open] .profile-name').waitFor({ timeout: 60000 });
log('bob signed in through the wallet');

//the two locks, made only now so the near one is still open when asked
const signer = localSigner(node, alice, aliceGenesis);
const tipNow = async () => Math.max((await node.tip()).timestamp, Math.floor(Date.now() / 1000));
const locks: { secret: Uint8Array; deadline: number; txid: string }[] = [];
for (const ahead of [40, 200]) {
  const secret = newSecret();
  const deadline = (await tipNow()) + ahead;
  const txid = await signer.lock({ from: alice.account, to: bob.account, amount: 1n, terms: { recipient: bobGenesis, sender: aliceGenesis, hashlock: hashOf(secret), deadline } });
  await node.waitConfirmed(txid);
  locks.push({ secret, deadline, txid });
  log(`alice locked 0.01 TESTT to bob, deadline in ${deadline - (await tipNow())} s, ${txid.slice(0, 16)}`);
}

const ask = (l: (typeof locks)[number]) =>
  page.evaluate(
    (p: unknown) => (window as any).nexus.request({ method: 'nexus_swapStep', params: p }).then(() => 'ACCEPTED', (e: any) => `${e.code}: ${e.message}`),
    { step: 'reveal', secret: toHex(l.secret), txid: l.txid, contract: 0 },
  );

const before = windows.length;
const near = await ask(locks[0]!);
check('a reveal for the lock that runs out in under a minute is refused', /Too close to the deadline/.test(near), near);
check('no wallet window opened for it', windows.length === before);
const far = await ask(locks[1]!);
check('a reveal with time left opens the wallet window (rejected here)', windows.length === before + 1 && /publish the secret/.test(windows.at(-1) ?? ''), far);
check('nothing was published: bob\'s slot does not hold either secret', !(await node.slot(bobGenesis))!.value.every((b, i) => b === locks[1]!.secret[i]));
await ctx.close();

//alice takes both back once the far deadline is behind a block
while ((await node.tip()).timestamp < locks[1]!.deadline) {
  await new Promise((r) => setTimeout(r, 15000));
  //the private chain makes a block only for a transaction: a throwaway name
  await node.waitConfirmed(await node.submit(alice, aliceGenesis, (ts) => [nameContract(aliceGenesis, `late${Date.now().toString(36)}`, new Uint8Array(32), false, ts)])).catch(() => {});
}
for (const l of locks) {
  const txid = await signer.refund({ lockTxid: l.txid, contract: 0, from: alice.account, amount: 1n });
  await node.waitConfirmed(txid);
}
log('alice took both locks back');
log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
