//screenshots of the trading page in its main states, for design review: mainnet not live, testnet simple and advanced,
//light and dark, phone width, a ticket with a matching offer and one where nothing fits. alice posts an offer first.
//  PLAYWRIGHT=$HOME/review/node_modules/playwright APP=http://127.0.0.1:5180 SHOTS=$HOME/review/dex-shots node tools/ui-shots.mjs
import { mkdirSync } from 'node:fs';
import { launch, log, open, postOffer, signIn } from './pw-helpers.mjs';

const shots = process.env.SHOTS ?? './shots';
mkdirSync(shots, { recursive: true });
const prefs = (o) => JSON.stringify({ theme: 'light', mode: 'simple', net: 'testnet', ...o });
const shot = (page, name) => page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });

const browser = await launch();

//first visit: nothing chosen yet, so the defaults (light, simple, mainnet)
const fresh = await open(browser, 'bob', 1280, 'none', '{}');
await shot(fresh, '01-first-visit-mainnet');
await fresh.context().close();
const freshDark = await open(browser, 'bob', 1280, 'none', JSON.stringify({ theme: 'dark' }));
await shot(freshDark, '02-mainnet-dark');
await freshDark.context().close();

//an offer to look at: alice sells TESTT
const alice = await open(browser, 'alice', 1280, undefined, prefs({ mode: 'advanced' }));
await signIn(alice, 'alice');
await postOffer(alice, { amount: '0.04', price: '625', chain: 'Local chain' });
await postOffer(alice, { amount: '0.1', price: '640', chain: 'Local chain' });
await postOffer(alice, { amount: '0.05', price: '590', chain: 'Local chain', buy: true });
log('alice posted three offers');

for (const theme of ['light', 'dark']) {
  const p = await open(browser, 'bob', 1280, undefined, prefs({ theme }));
  await p.waitForTimeout(2500);
  await shot(p, `03-simple-${theme}-signed-out`);
  await p.getByRole('button', { name: /^Buy / }).click();
  await p.waitForTimeout(800);
  await shot(p, `04-simple-${theme}-buy-best-offer`);
  await p.locator('#pay-amount').fill('10');
  await p.waitForTimeout(500);
  await shot(p, `05-simple-${theme}-buy-10-nothing-fits`);
  await p.locator('#pay-amount').fill('40');
  await p.waitForTimeout(500);
  await shot(p, `06-simple-${theme}-buy-40-bigger-than-offer`);
  await p.getByRole('button', { name: /Or offer your own price/ }).click();
  await shot(p, `07-simple-${theme}-own-offer`);
  await p.getByRole('button', { name: 'Advanced', exact: true }).click();
  await p.waitForTimeout(2500);
  await shot(p, `08-advanced-${theme}`);
  await p.locator('table.book tbody tr').first().click();
  await p.waitForTimeout(500);
  await shot(p, `08b-advanced-${theme}-take-tab`);
  await p.context().close();
}

//signed in, ready to swap
const bob = await open(browser, 'bob', 1280, undefined, prefs({}));
await signIn(bob, 'bob');
await bob.getByRole('button', { name: /^Buy / }).click();
await bob.waitForTimeout(1500);
await shot(bob, '09-simple-signed-in-ready');
await bob.locator('.top').getByRole('button', { name: /^Nexus: / }).click();
await bob.locator('dialog[open] .profile-name').waitFor();
await bob.screenshot({ path: `${shots}/12-nexus-profile.png` });
await bob.keyboard.press('Escape');
await bob.locator('.top').getByRole('button', { name: / on / }).click();
await bob.waitForTimeout(2500);
await bob.screenshot({ path: `${shots}/13-wallet-profile.png` });
await bob.keyboard.press('Escape');
await bob.context().close();

const phone = await open(browser, 'bob', 390, undefined, prefs({}));
await phone.waitForTimeout(2500);
await shot(phone, '10-phone-simple');
await phone.getByRole('button', { name: 'Advanced', exact: true }).click();
await phone.waitForTimeout(2000);
await shot(phone, '11-phone-advanced');
await phone.context().close();

//clean up alice's offers
await alice.getByRole('button', { name: 'Withdraw' }).first().waitFor({ timeout: 10000 }).catch(() => {});
for (let i = 0; i < 3; i++) {
  await alice.getByRole('button', { name: 'Withdraw' }).first().click().catch(() => {});
  await alice.waitForTimeout(500);
}
await browser.close();
log('shots done');
