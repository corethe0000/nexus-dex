//the always-on maker (service/src/maker-bot-main.ts) as alice, no browser: it posts 0.02 TESTT at 590 USDT on the
//local chain with "again"; bob buys it in the simple ticket; the swap goes through with alice's side run by the
//program alone; the program puts the offer up again; Ctrl+C withdraws it. Private chain + anvil.
//  PLAYWRIGHT=$HOME/review/node_modules/playwright APP=http://127.0.0.1:5180 SHOTS=$HOME/review/dex-bot node tools/maker-bot-e2e.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch, log, open, signIn } from './pw-helpers.mjs';

const shots = process.env.SHOTS ?? './shots';
mkdirSync(shots, { recursive: true });
let failed = 0;
const check = (label, ok, detail = '') => {
  log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' - ' + detail : ''}`);
  failed += ok ? 0 : 1;
};

//alice = anvil dev account 2 (public test key) and her Nexus test profile; secrets in a temp folder like a user's files
const dir = mkdtempSync(join(tmpdir(), 'dex-bot-'));
const file = (name, text) => {
  writeFileSync(join(dir, name), text, { mode: 0o600 });
  return join(dir, name);
};
const config = {
  relay: `${process.env.APP ?? 'http://127.0.0.1:5180'}/relay`,
  nexusNode: 'http://127.0.0.1:7080',
  nexus: { username: 'alice', passwordFile: file('password', 'alicepass1'), pinFile: file('pin', '1111') },
  evmKeyFile: file('evm-key', '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'),
  rpc: { 31337: 'http://127.0.0.1:8545' },
  stateFile: join(dir, 'state.json'),
  offers: [{ sell: true, coin: '8D7zzHoiwKGxs8Tk8ApjintGincdwjaLRzMfssgsZpAczLEAhwx', amount: '0.02', chain: '31337', token: 'USDT', price: '590', hours: 1, again: true }],
};
const configFile = file('maker.json', JSON.stringify(config, null, 2));

const lines = [];
const bot = spawn(resolve('../node_modules/.bin/tsx'), ['src/maker-bot-main.ts'], { cwd: resolve('../service'), env: { ...process.env, MAKER_CONFIG: configFile } });
const onLine = (d) => {
  for (const l of d.toString().split('\n').filter(Boolean)) {
    lines.push(l);
    log(`bot: ${l.replace(/^\S+ /, '')}`);
  }
};
bot.stdout.on('data', onLine);
bot.stderr.on('data', onLine);
const waitFor = async (re, ms, times = 1) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (lines.filter((l) => re.test(l)).length >= times) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
};

check('the maker program signs in and posts its offer', await waitFor(/offer 0 up/, 120000));

const browser = await launch();
const bob = await open(browser, 'bob', 1280, undefined, JSON.stringify({ net: 'testnet', mode: 'simple', theme: 'light', venue: 'stable' }));
await signIn(bob, 'bob');
await bob.getByRole('button', { name: /^Buy / }).click();
await bob.getByRole('combobox', { name: 'Coin and chain' }).selectOption({ label: 'USDT on Local chain' });
const chip = bob.locator('.sizes button', { hasText: 'at 590' });
if (await chip.count()) {
  await chip.first().click();
}
await bob.locator('#pay-amount').fill('11.8');
await bob.waitForTimeout(1000);
const cta = bob.locator('.ticket .btn.big');
const text = (await cta.textContent()) ?? '';
check("bob's ticket matches the program's offer", /Swap 11\.8(0)? USDT for 0\.02 TESTT/.test(text), text);
await cta.click();
check('the program accepts the take', await waitFor(/accepted, swap starts/, 90000));

const end = Date.now() + 8 * 60 * 1000;
let state = '';
while (Date.now() < end) {
  state = ((await bob.locator('.state').first().textContent()) ?? '').trim();
  if (/Swapped|Refunded|Lost|Stopped|Not accepted/.test(state)) {
    break;
  }
  await bob.waitForTimeout(3000);
}
check('the swap went through for bob', /Swapped/.test(state), state);
check("the program's side finished too", await waitFor(/: swapped/, 180000));
const upAgain = await waitFor(/offer 0 up/, 60000, 2);
check('the program put the offer up again', upAgain);
await bob.screenshot({ path: `${shots}/bob-done.png`, fullPage: true });

bot.kill('SIGINT');
await new Promise((r) => bot.on('exit', r));
check('Ctrl+C withdraws the open offer', lines.some((l) => /withdrawing open offers/.test(l)));
const open2 = await bob.evaluate(async () => (await (await fetch('/relay/api/offers')).json()).offers.filter((o) => o.offer.evmAmount === '11800000').length);
check('the offer is gone from the relay', open2 === 0, `${open2} left`);
await browser.close();
log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exitCode = failed ? 1 : 0;
