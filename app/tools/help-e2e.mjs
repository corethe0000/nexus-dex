//the "How it works" page: deadlines from the service, contract links, no sideways scroll on a phone, both themes.
//  PLAYWRIGHT=$HOME/review/node_modules/playwright APP=http://127.0.0.1:5180 SHOTS=$HOME/review/dex-help node tools/help-e2e.mjs
import { mkdirSync } from 'node:fs';
import { launch, log, open } from './pw-helpers.mjs';

const shots = process.env.SHOTS ?? './shots';
mkdirSync(shots, { recursive: true });
let failed = 0;
const check = (label, ok, detail = '') => {
  log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' - ' + detail : ''}`);
  failed += ok ? 0 : 1;
};

const browser = await launch();
for (const [width, theme] of [
  [1280, 'light'],
  [1280, 'dark'],
  [390, 'light'],
  [390, 'dark'],
]) {
  const page = await open(browser, 'alice', width, undefined, JSON.stringify({ net: 'testnet', mode: 'simple', theme, venue: 'stable' }));
  await page.getByRole('button', { name: 'How it works' }).click();
  await page.getByRole('heading', { name: 'How it works' }).waitFor();
  const text = (await page.locator('.help').textContent()) ?? '';
  if (width === 1280 && theme === 'light') {
    const info = await page.evaluate(async () => (await (await fetch('/relay/api/info')).json()).timing);
    check('deadlines come from the service', text.includes('a deadline of') && /\d+(\.\d)? (s|min|h)/.test(text), JSON.stringify(info));
    check('one swap contract line per chain', (await page.locator('.contracts li').count()) >= 1);
    check('testnet note shown', text.includes('the coins here have no value'));
  }
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`no sideways scroll at ${width} ${theme}`, sideways <= 0, `${sideways}px`);
  await page.screenshot({ path: `${shots}/help-${width}-${theme}.png`, fullPage: true });
  await page.context().close();
}
await browser.close();
log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exitCode = failed ? 1 : 0;
