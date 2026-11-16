//browser helpers for the DEX page tests (Playwright from PLAYWRIGHT): open the page with a stand-in EVM wallet,
//sign in, post an offer, read a page's saved swaps. The stand-in wallet hands every call to anvil through the
//page's /evm proxy; anvil signs for its own dev accounts.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const { chromium } = require(process.env.PLAYWRIGHT);
export const app = process.env.APP ?? 'http://127.0.0.1:5180';

//test profiles on the private chain + anvil dev accounts 1 (bob) and 2 (alice)
export const people = {
  alice: { nexus: ['alice', 'alicepass1', '1111'], evm: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' },
  bob: { nexus: ['bob', 'bobpass12', '2222'], evm: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' },
};

export const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

function walletScript(address) {
  return `(() => {
    const rpc = location.origin + '/evm';
    let id = 1;
    const provider = {
      async request({ method, params }) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['${address}'];
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
        const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params: params ?? [] }) });
        const j = await r.json();
        if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; throw e; }
        return j.result;
      },
      on() {}, removeListener() {},
    };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'test-wallet', name: 'Test wallet (anvil)', icon: '', rdns: 'test.anvil' }, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  })();`;
}

//key mode, for public testnets: the page's wallet hands every call to the test process, which signs with a private
//key (viem) and talks to the chain's RPC; the key never enters the page
function keyWalletScript(address) {
  return `(() => {
    const provider = {
      async request({ method, params }) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['${address}'];
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain' || method === 'wallet_requestPermissions') return null;
        const r = await window.__dexWallet(method, params ?? []);
        if (r.error) { const e = new Error(r.error); e.code = r.code; throw e; }
        return r.result;
      },
      on() {}, removeListener() {},
    };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'test-wallet', name: 'Test wallet (anvil)', icon: '', rdns: 'test.anvil' }, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  })();`;
}

async function keyWallet(key, rpc) {
  const { createWalletClient, http } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, transport: http(rpc) });
  let id = 1;
  const handle = async (method, params) => {
    try {
      if (method === 'eth_signTypedData_v4') {
        const td = JSON.parse(params[1]);
        delete td.types.EIP712Domain;
        return { result: await account.signTypedData(td) };
      }
      if (method === 'eth_sendTransaction') {
        const tx = params[0];
        const chainId = Number(await (await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'eth_chainId', params: [] }) })).json().then((j) => j.result));
        const hash = await wallet.sendTransaction({ chain: { id: chainId, name: 'chain', nativeCurrency: { name: 'gas', symbol: 'GAS', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } }, to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined, gas: tx.gas ? BigInt(tx.gas) : undefined });
        return { result: hash };
      }
      const j = await (await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }) })).json();
      return j.error ? { error: j.error.message, code: j.error.code } : { result: j.result };
    } catch (e) {
      return { error: e.shortMessage ?? e.message, code: e.code };
    }
  };
  return { address: account.address, handle };
}

export async function launch() {
  return chromium.launch();
}

//wallet: undefined = stand-in that forwards to anvil (people[who].evm); { key, rpc } = signs with that key on that RPC
export async function open(browser, who, width = 1280, wallet, prefs) {
  return openIn(await browser.newContext({ viewport: { width, height: 900 } }), who, wallet, prefs);
}

//the page in a given context (a persistent one with the Nexus Wallet extension, ext-e2e.mjs)
//page tests run on the testnet; most of them drive the advanced view (env PREFS = JSON to start with other choices)
const startPrefs = process.env.PREFS ?? JSON.stringify({ net: 'testnet', mode: 'advanced', theme: 'light' });

//wallet 'none': no EVM wallet in this browser at all (receive-only tests)
export async function openIn(ctx, who, wallet, prefs = startPrefs) {
  await ctx.addInitScript((p) => {
    if (!localStorage.getItem('nexus-dex:prefs')) {
      localStorage.setItem('nexus-dex:prefs', p);
    }
  }, prefs);
  if (wallet === 'none') {
    //nothing injected
  } else if (wallet) {
    const w = await keyWallet(wallet.key, wallet.rpc);
    await ctx.exposeFunction('__dexWallet', w.handle);
    await ctx.addInitScript(keyWalletScript(w.address));
  } else {
    await ctx.addInitScript(walletScript(people[who].evm));
  }
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log(`${who} page error: ${e.message}`));
  page.on('console', (m) => (m.type() === 'warning' || m.type() === 'error') && !/status of 400/.test(m.text()) && log(`${who} console ${m.type()}: ${m.text()}`));
  page.on('dialog', (d) => d.accept());
  await page.goto(app);
  //the trading page (live network) or the not-live screen
  await page.locator('.trade-head, .blank').first().waitFor();
  return page;
}

//receive: an address typed in instead of a wallet ("receive only", for selling Nexus coins)
export async function signIn(page, who, { receive } = {}) {
  const [u, p, pin] = people[who].nexus;
  await page.locator('.top').getByRole('button', { name: 'Sign in to Nexus' }).click();
  await page.getByLabel('Username').fill(u);
  await page.getByLabel('Password').fill(p);
  await page.getByLabel('PIN').fill(pin);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('dialog[open] .profile-name').waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: 'Close' }).first().click();
  //a second tab of the browser: the remembered wallet comes back by itself
  const connected = page.locator('.top').getByRole('button', { name: / on / });
  if (!receive && (await connected.waitFor({ timeout: 3000 }).then(() => true, () => false))) {
    log(`${who} signed in, wallet already connected`);
    return;
  }
  await page.locator('.top').getByRole('button', { name: 'Connect wallet' }).click();
  if (receive) {
    await page.getByLabel('Your receiving address').fill(receive);
    await page.getByRole('button', { name: 'Receive to this address' }).click();
    await page.getByRole('button', { name: /^Receive to 0x/ }).waitFor({ timeout: 30000 });
    log(`${who} signed in, receives to ${receive}`);
    return;
  }
  await page.getByRole('button', { name: 'Test wallet (anvil)' }).click();
  //the connect dialog is modal (the page behind it is inert) until the wallet answered; on a public RPC that takes a moment
  await page.locator('.top').getByRole('button', { name: / on / }).waitFor({ timeout: 30000 });
  log(`${who} signed in`);
}

//sells `amount` of the account whose option text matches `account` (else the first) at `price` per coin
//buy: the offer buys the account's token (the taker then locks on Nexus)
//split: post that many offers as a ladder (step: percent per offer); again: post it again after each swap
export async function postOffer(page, { account = /TESTT/, amount, price, chain, paidIn, shot, buy = false, split, step, again }) {
  if (chain) {
    await page.getByRole('combobox', { name: 'Chain' }).selectOption({ label: chain });
  }
  if (paidIn) {
    await page.getByRole('combobox', { name: 'Paid in' }).selectOption({ label: paidIn });
  }
  const select = page.getByLabel('Nexus account');
  const options = await select.locator('option').allTextContents();
  await select.selectOption({ index: Math.max(0, options.findIndex((o) => account.test(o))) });
  await page.getByRole('group', { name: 'Direction' }).getByRole('button', { name: buy ? /^I buy/ : /^I sell/ }).click();
  const amountBox = page.getByRole('textbox', { name: 'Amount' });
  const priceBox = page.getByRole('textbox', { name: 'Price per coin' });
  await amountBox.fill(amount);
  await priceBox.fill(price);
  if (split) {
    await page.getByRole('combobox', { name: 'Split into' }).selectOption(String(split));
    if (step) {
      await page.getByRole('combobox', { name: 'Price step' }).selectOption(String(step));
    }
  }
  if (again) {
    await page.getByRole('checkbox', { name: /Post it again/ }).check();
  }
  log(`offer form: amount ${await amountBox.inputValue()}, price ${await priceBox.inputValue()}`);
  if (shot) {
    await page.screenshot({ path: shot, fullPage: true });
  }
  await page.getByRole('button', { name: 'Post offer' }).click();
  //either the success note or the page's error shows
  const ok = page.getByText(/Offer posted|offers posted\./);
  const bad = page.locator('aside .problem');
  await ok.or(bad).first().waitFor({ timeout: 60000 });
  if (!(await ok.isVisible())) {
    await page.screenshot({ path: `${process.env.SHOTS ?? '.'}/post-offer-failed.png`, fullPage: true });
    throw new Error(`posting the offer failed: ${await bad.first().textContent()}`);
  }
}

//the swaps a page keeps (stored per network, app/src/lib/desk.ts storeKey)
export async function savedSwaps(page, net = 'testnet') {
  return JSON.parse((await page.evaluate((k) => localStorage.getItem(k), `nexus-dex:v1:${net}`)) ?? '{}').swaps ?? [];
}

//prints the swaps a page keeps, with their decision history and chain log
export async function dumpSwaps(page, who) {
  const saved = { swaps: await savedSwaps(page) };
  for (const s of saved.swaps ?? []) {
    log(`${who} swap ${s.id.slice(0, 10)} ${s.stage}`);
    for (const h of s.history ?? []) log(`  ${new Date(h.at).toISOString()} ${h.action} ${h.reason ?? ''}`);
    for (const l of s.rec.log ?? []) log(`  ${l}`);
  }
  return saved.swaps ?? [];
}
