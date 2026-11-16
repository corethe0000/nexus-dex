//one swap on a public testnet with no wallet app: alice (maker) and bob (taker) both sign with test keys in key mode.
//alice sells 0.02 TESTT for 10 USDT, bob takes it; checks both pages end Swapped, the lock went through the swap
//contract the site pins, and the USDT moved. Private Nexus chain + the public testnet.
//  PLAYWRIGHT=$HOME/review/node_modules/playwright APP=http://127.0.0.1:5180 CHAIN_ID=11155111 RPC=https://ethereum-sepolia-rpc.publicnode.com TAKER_KEY_FILE=$HOME/dex-testnet/deployer-key MAKER_KEY_FILE=$HOME/dex-testnet/maker-key SHOTS=$HOME/review/dex-testnet node tools/testnet-e2e.mjs
import { mkdirSync, readFileSync } from 'node:fs';
import { app, dumpSwaps, launch, log, open, postOffer, savedSwaps, signIn } from './pw-helpers.mjs';

const { createPublicClient, http, erc20Abi, parseAbiItem } = await import('viem');
const { privateKeyToAccount } = await import('viem/accounts');

const chainId = process.env.CHAIN_ID ?? '11155111';
const rpc = process.env.RPC;
const shots = process.env.SHOTS ?? './shots';
mkdirSync(shots, { recursive: true });
const keyOf = (f) => readFileSync(f, 'utf8').trim();
const takerKey = keyOf(process.env.TAKER_KEY_FILE);
const makerKey = keyOf(process.env.MAKER_KEY_FILE);
let failed = 0;
const check = (label, ok, detail = '') => {
  log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' - ' + detail : ''}`);
  failed += ok ? 0 : 1;
};

const site = (await (await fetch(`${app}/config.json`)).json()).networks.testnet;
const info = await (await fetch(`${app}/relay/api/info`)).json();
const chain = info.chains[chainId];
const swap = site.swapContracts[chainId];
check('the relay and the site name the same swap contract', chain?.swap?.toLowerCase() === swap?.toLowerCase(), `${chain?.name} ${swap}`);
const usdt = chain.tokens.find((t) => t.symbol === 'USDT').address;
const client = createPublicClient({ transport: http(rpc) });
const taker = privateKeyToAccount(takerKey).address;
const maker = privateKeyToAccount(makerKey).address;
const usdtOf = (a) => client.readContract({ address: usdt, abi: erc20Abi, functionName: 'balanceOf', args: [a] });
const before = { taker: await usdtOf(taker), maker: await usdtOf(maker) };
const fromBlock = await client.getBlockNumber();
log(`${chain.name}: swap ${swap}, taker ${taker} ${Number(before.taker) / 1e6} USDT, maker ${maker} ${Number(before.maker) / 1e6} USDT`);

const prefs = JSON.stringify({ net: 'testnet', mode: 'advanced', theme: 'light', venue: 'stable' });
const browser = await launch();
const alice = await open(browser, 'alice', 1280, { key: makerKey, rpc }, prefs);
await signIn(alice, 'alice');
const chainOptions = (await alice.getByRole('combobox', { name: 'Chain' }).locator('option').allTextContents()).map((o) => o.trim());
log(`offer form chains: ${chainOptions.join(' | ')}`);
//the site names chains short (app/src/ui/offers.ts chainLabels): Sepolia shows as Ethereum, BSC testnet as BSC
const short = { '97': 'BSC', '80002': 'Polygon', '11155111': 'Ethereum' }[chainId] ?? chain.name;
const chainOption = chainOptions.find((o) => o === short);
check('the offer form lists the chain', !!chainOption, short);
if (!chainOption) {
  await browser.close();
  process.exit(1);
}
await postOffer(alice, { amount: '0.02', price: '500', chain: chainOption, paidIn: 'USDT' });
log(`alice posted 0.02 TESTT for 10 USDT on ${chain.name}`);

const bob = await open(browser, 'bob', 1280, { key: takerKey, rpc }, JSON.stringify({ ...JSON.parse(prefs), mode: 'simple' }));
await signIn(bob, 'bob');
await bob.getByRole('button', { name: /^Buy / }).click();
const coins = bob.getByRole('combobox', { name: 'Coin and chain' });
const coinOptions = (await coins.locator('option').allTextContents()).map((o) => o.trim());
log(`ticket coins: ${coinOptions.join(' | ')}`);
await coins.selectOption({ label: coinOptions.find((o) => o === `USDT on ${short}`) ?? `USDT on ${short}` });
await bob.locator('#pay-amount').fill('10');
await bob.waitForTimeout(1500);
const cta = bob.locator('.ticket .btn.big');
check('the ticket offers the swap', /Swap 10 USDT for 0\.02 TESTT/.test((await cta.textContent()) ?? ''), (await cta.textContent()) ?? '');
await cta.click();
await bob.getByRole('heading', { name: 'Your swaps' }).waitFor({ timeout: 60000 });

const end = Date.now() + 25 * 60 * 1000;
let state = '';
while (Date.now() < end) {
  state = ((await bob.locator('.state').first().textContent()) ?? '').trim();
  if (/Swapped|Refunded|Lost|Stopped|Not accepted/.test(state)) {
    break;
  }
  await bob.waitForTimeout(5000);
}
await bob.screenshot({ path: `${shots}/bob-done-${chainId}.png`, fullPage: true });
check('bob: the swap went through', /Swapped/.test(state), state);

//alice's page collects the USDT itself (or the relay's watcher does it for her)
const aliceEnd = Date.now() + 10 * 60 * 1000;
let aliceStage = '';
while (Date.now() < aliceEnd) {
  const s = (await savedSwaps(alice))[0];
  aliceStage = s ? `${s.stage} ${s.rec.done?.result ?? ''}` : '';
  if (s?.rec.done) {
    break;
  }
  await alice.waitForTimeout(5000);
}
check('alice: the swap went through', /swapped/.test(aliceStage), aliceStage);
if (!/Swapped/.test(state) || !/swapped/.test(aliceStage)) {
  await dumpSwaps(bob, 'bob');
  await dumpSwaps(alice, 'alice');
}
await browser.close();

const after = { taker: await usdtOf(taker), maker: await usdtOf(maker) };
check('taker paid 10 USDT', before.taker - after.taker === 10_000000n, `${Number(after.taker) / 1e6}`);
check('maker got 10 USDT', after.maker - before.maker === 10_000000n, `${Number(after.maker) / 1e6}`);
const locked = await client.getLogs({ address: swap, event: parseAbiItem('event Locked(bytes32 indexed id, address indexed sender, address indexed recipient, address token, uint256 amount, bytes32 hashlock, uint64 deadline, bytes32 nexusRef)'), fromBlock, toBlock: 'latest' });
check('the lock went through the pinned swap contract', locked.some((l) => l.args.sender?.toLowerCase() === taker.toLowerCase()), `${locked.length} lock(s)`);
log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
