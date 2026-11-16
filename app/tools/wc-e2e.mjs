//WalletConnect: bob has no wallet in the browser and connects a "phone wallet" through WalletConnect's relay (the
//real one, project id from config.json). The phone is this test process: @walletconnect/sign-client approves the
//session and signs with bob's anvil key. alice posts an offer, bob takes it and pays USDT through WalletConnect.
//Private chain + anvil, internet for the relay.
//  PLAYWRIGHT=$HOME/review/node_modules/playwright APP=http://127.0.0.1:5180 SHOTS=$HOME/review/dex-wc node tools/wc-e2e.mjs
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { app, dumpSwaps, launch, log, open, people, postOffer, signIn } from './pw-helpers.mjs';

const require = createRequire(import.meta.url);
const { SignClient } = require('@walletconnect/sign-client');
const { createWalletClient, http, defineChain } = await import('viem');
const { privateKeyToAccount } = await import('viem/accounts');

const shots = process.env.SHOTS ?? './shots';
const anvilRpc = process.env.EVM_RPC ?? 'http://127.0.0.1:8545';
//anvil dev account 1 = bob's EVM address in pw-helpers
const bobKey = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
mkdirSync(shots, { recursive: true });
let n = 0;
const shot = (page, name) => page.screenshot({ path: `${shots}/${String(++n).padStart(2, '0')}-${name}.png`, fullPage: true });
let failed = 0;
const check = (label, ok, detail = '') => {
  log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' - ' + detail : ''}`);
  failed += ok ? 0 : 1;
};

const config = await (await fetch(`${app}/config.json`)).json();
const projectId = config.networks.testnet.walletConnectProjectId;
check('the testnet config has a WalletConnect project id', !!projectId);

//--- the phone wallet ---
const account = privateKeyToAccount(bobKey);
check('the phone wallet holds bob\'s address', account.address.toLowerCase() === people.bob.evm.toLowerCase());
const anvil = defineChain({ id: 31337, name: 'anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [anvilRpc] } } });
const signer = createWalletClient({ account, chain: anvil, transport: http(anvilRpc) });
const rpc = async (method, params) => {
  const j = await (await fetch(anvilRpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (j.error) {
    throw Object.assign(new Error(j.error.message), { code: j.error.code });
  }
  return j.result;
};
const asked = [];
const phone = await SignClient.init({ projectId, metadata: { name: 'Test phone wallet', description: 'DEX test', url: 'https://example.invalid', icons: [] } });
phone.on('session_proposal', async ({ id, params }) => {
  const wanted = { ...params.optionalNamespaces?.eip155, ...params.requiredNamespaces?.eip155 };
  const chains = [...new Set([...(params.requiredNamespaces?.eip155?.chains ?? []), ...(params.optionalNamespaces?.eip155?.chains ?? [])])];
  log(`phone: proposal for ${chains.join(', ')}`);
  await phone.approve({
    id,
    namespaces: {
      eip155: {
        chains,
        accounts: chains.map((c) => `${c}:${account.address}`),
        methods: [...new Set([...(wanted.methods ?? []), 'eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4', 'wallet_switchEthereumChain'])],
        events: [...new Set([...(wanted.events ?? []), 'chainChanged', 'accountsChanged'])],
      },
    },
  });
});
phone.on('session_request', async ({ id, topic, params }) => {
  const { method, params: p } = params.request;
  asked.push(method);
  log(`phone: ${method} on ${params.chainId}`);
  let result;
  try {
    if (method === 'eth_sendTransaction') {
      const tx = p[0];
      result = await signer.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined, gas: tx.gas ? BigInt(tx.gas) : undefined });
    } else if (method === 'personal_sign') {
      result = await account.signMessage({ message: { raw: p[0] } });
    } else if (method === 'eth_signTypedData_v4') {
      const td = JSON.parse(p[1]);
      delete td.types.EIP712Domain;
      result = await account.signTypedData(td);
    } else if (method === 'wallet_switchEthereumChain') {
      result = null;
      await phone.emit({ topic, event: { name: 'chainChanged', data: parseInt(p[0].chainId, 16) }, chainId: `eip155:${parseInt(p[0].chainId, 16)}` });
    } else {
      result = await rpc(method, p ?? []);
    }
    await phone.respond({ topic, response: { id, jsonrpc: '2.0', result } });
  } catch (e) {
    log(`phone: ${method} failed: ${e.shortMessage ?? e.message}`);
    await phone.respond({ topic, response: { id, jsonrpc: '2.0', error: { code: e.code ?? 5000, message: e.shortMessage ?? e.message } } });
  }
});

//--- alice posts, bob connects through WalletConnect and takes it ---
const browser = await launch();
const alice = await open(browser, 'alice', 1280, undefined, JSON.stringify({ net: 'testnet', mode: 'advanced', theme: 'light', venue: 'stable' }));
await signIn(alice, 'alice');
await postOffer(alice, { amount: '0.02', price: '600', chain: 'Local chain', paidIn: 'USDT' });
log('alice posted 0.02 TESTT for 12 USDT');

const bob = await open(browser, 'bob', 1280, 'none', JSON.stringify({ net: 'testnet', mode: 'simple', theme: 'light', venue: 'stable' }));
const [u, pw, pin] = people.bob.nexus;
await bob.locator('.top').getByRole('button', { name: 'Sign in to Nexus' }).click();
await bob.getByLabel('Username').fill(u);
await bob.getByLabel('Password').fill(pw);
await bob.getByLabel('PIN').fill(pin);
await bob.getByRole('button', { name: 'Sign in', exact: true }).click();
await bob.locator('dialog[open] .profile-name').waitFor({ timeout: 60000 });
await bob.getByRole('button', { name: 'Close' }).first().click();
await bob.locator('.top').getByRole('button', { name: 'Connect wallet' }).click();
await bob.locator('.wc-btn').click();
const link = bob.locator('.wc a.btn[href^="wc:"]');
await link.waitFor({ timeout: 60000 });
check('the page shows a QR code for the phone', (await bob.locator('.wc img.qr').count()) === 1);
await shot(bob, 'bob-walletconnect-qr');
const uri = await link.getAttribute('href');
await phone.pair({ uri });
await bob.locator('.top').getByRole('button', { name: / on / }).waitFor({ timeout: 60000 });
const wallet = (await bob.locator('.top').getByRole('button', { name: / on / }).textContent()) ?? '';
check('bob is connected through WalletConnect', true, wallet);
await shot(bob, 'bob-connected');

await bob.getByRole('button', { name: /^Buy / }).click();
await bob.getByRole('combobox', { name: 'Coin and chain' }).selectOption({ label: 'USDT on Local chain' });
await bob.locator('#pay-amount').fill('12');
await bob.waitForTimeout(1000);
const cta = bob.locator('.ticket .btn.big');
check('the ticket offers the swap', /Swap 12 USDT for 0\.02 TESTT/.test((await cta.textContent()) ?? ''), (await cta.textContent()) ?? '');
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
await shot(bob, 'bob-done');
check('the swap went through', /Swapped/.test(state), state);
check('the phone signed the payment (approve and lock)', asked.filter((m) => m === 'eth_sendTransaction').length >= 2, asked.join(', '));
if (!/Swapped/.test(state)) {
  await dumpSwaps(bob, 'bob');
  await dumpSwaps(alice, 'alice');
}
await browser.close();
await phone.core.relayer.transportClose().catch(() => {});
log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
