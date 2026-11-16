//one swap with the page open in two tabs of one browser, both signed in: one tab at a time moves it on, the other
//follows from storage. Passes when the swap is Swapped in both tabs and the chain holds exactly one EVM lock for it.
//  PLAYWRIGHT=$HOME/review/node_modules/playwright APP=http://127.0.0.1:5180 EVM_RPC=http://127.0.0.1:8545 node tools/tabs-e2e.mjs
import { createPublicClient, http, parseAbiItem } from 'viem';
import { app, dumpSwaps, launch, log, open, postOffer, signIn } from './pw-helpers.mjs';

let failed = 0;
const check = (label, ok, detail = '') => {
  log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' - ' + detail : ''}`);
  failed += ok ? 0 : 1;
};

const browser = await launch();
const alice = await open(browser, 'alice');
await signIn(alice, 'alice');
await postOffer(alice, { amount: '0.02', price: '612', chain: 'Local chain' });
log('alice posted 0.02 TESTT at 612');

const prefs = JSON.stringify({ net: 'testnet', mode: 'simple', theme: 'light' });
const bob1 = await open(browser, 'bob', 1280, undefined, prefs);
await signIn(bob1, 'bob');
//a second tab of the same browser (same storage, same injected wallet)
const bob2 = await bob1.context().newPage();
bob2.on('pageerror', (e) => log(`bob2 page error: ${e.message}`));
bob2.on('dialog', (d) => d.accept());
await bob2.goto(app);
await bob2.locator('.trade-head').waitFor();
await signIn(bob2, 'bob');
log('bob signed in in two tabs');

await bob1.getByRole('button', { name: /^Buy / }).click();
const chip = bob1.locator('.sizes button', { hasText: 'at 612' });
await chip.first().waitFor({ timeout: 30000 }).catch(() => {});
if (await chip.count()) {
  await chip.first().click();
}
await bob1.locator('#pay-amount').fill('12.24');
await bob1.waitForTimeout(800);
const cta = bob1.locator('.ticket .btn.big');
check('ticket on the offer', /Swap 12\.24 USDT for 0\.02 TESTT/.test((await cta.textContent()) ?? ''));
await cta.click();
await bob1.getByRole('heading', { name: 'Your swaps' }).waitFor({ timeout: 60000 });
await bob1.waitForTimeout(45000);
{
  const st = JSON.parse(await bob1.evaluate(() => localStorage.getItem('nexus-dex:v1:testnet')));
  const id = [...st.swaps].sort((a, b) => b.createdAt - a.createdAt)[0].id;
  const take = await (await fetch(`${app}/relay/api/takes/${id}`)).json().catch((e) => String(e));
  const al = JSON.parse(await alice.evaluate(() => localStorage.getItem('nexus-dex:v1:testnet')));
  log(`after 45 s: take ${id.slice(0, 10)} ${JSON.stringify(take).slice(0, 160)}; alice offers ${JSON.stringify(al.offers.map((o) => [o.id.slice(0, 10), o.takeId?.slice(0, 10), o.cancelled]))}; alice swaps ${al.swaps.length}`);
}
await bob2.getByRole('link', { name: 'Your swaps' }).or(bob2.getByRole('button', { name: /^Your swaps/ })).first().click();

const stateOf = async (p) => ((await p.locator('.state').first().textContent().catch(() => '')) ?? '').trim();
const end = Date.now() + 8 * 60 * 1000;
let s1 = '';
let s2 = '';
while (Date.now() < end) {
  s1 = await stateOf(bob1);
  s2 = await stateOf(bob2);
  if (/Swapped|Refunded|Lost|Stopped/.test(s1) && /Swapped|Refunded|Lost|Stopped/.test(s2)) {
    break;
  }
  await bob1.waitForTimeout(3000);
}
check('Swapped in the tab that took it', /Swapped/.test(s1), s1);
check('Swapped in the other tab too', /Swapped/.test(s2), s2);

//on chain: exactly one lock carries this swap's id
const stored = JSON.parse(await bob1.evaluate(() => localStorage.getItem('nexus-dex:v1:testnet')));
const swap = [...stored.swaps].sort((a, b) => b.createdAt - a.createdAt)[0];
const info = await (await fetch(`${app}/relay/api/info`)).json();
const client = createPublicClient({ transport: http(process.env.EVM_RPC ?? 'http://127.0.0.1:8545') });
const logs = await client.getLogs({
  address: info.chains['31337'].swap,
  event: parseAbiItem('event Locked(bytes32 indexed id, address indexed sender, address indexed recipient, address token, uint256 amount, bytes32 hashlock, uint64 deadline, bytes32 nexusRef)'),
  fromBlock: BigInt(info.chains['31337'].fromBlock),
});
const mine = logs.filter((l) => l.args.nexusRef.toLowerCase() === swap.id.toLowerCase());
check('one EVM lock for the swap', mine.length === 1, `${mine.length} lock(s), seq ${swap.seq}`);
if (failed) {
  await dumpSwaps(bob1, 'bob1');
}
await browser.close();
log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exitCode = failed ? 1 : 0;
