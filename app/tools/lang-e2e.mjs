//every language: the page switches to it (html lang, navigation not English any more), no text shows an unfilled
//{placeholder}, and no page scrolls sideways on a phone (long words); screenshots of the longest-word languages.
//Not signed in: the pages as a visitor sees them.
//  PLAYWRIGHT=$HOME/review/node_modules/playwright APP=http://127.0.0.1:5180 SHOTS=$HOME/review/dex-lang node tools/lang-e2e.mjs
import { mkdirSync } from 'node:fs';
import { launch, log, open } from './pw-helpers.mjs';

const shots = process.env.SHOTS ?? './shots';
mkdirSync(shots, { recursive: true });
let failed = 0;
const check = (label, ok, detail = '') => {
  if (!ok || process.env.VERBOSE) {
    log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' - ' + detail : ''}`);
  }
  failed += ok ? 0 : 1;
};

const langs = ['en', 'de', 'es', 'fil', 'fr', 'hr', 'id', 'it', 'nl', 'pl', 'pt', 'tr'];
const pictures = ['de', 'hr'];
const browser = await launch();
let checks = 0;
for (const lang of langs) {
  for (const width of [390, 1280]) {
    const page = await open(browser, 'alice', width, undefined, JSON.stringify({ net: 'testnet', mode: 'simple', theme: 'light', venue: 'stable', lang }));
    await page.waitForFunction((l) => document.documentElement.lang === l, lang);
    const nav = page.locator('nav.nav button');
    //the pack loads after the first paint: wait until the navigation shows it
    if (lang !== 'en') {
      await page.waitForFunction(() => document.querySelectorAll('nav.nav button')[2]?.textContent?.trim() !== 'How it works', null, { timeout: 15000 }).catch(() => {});
    }
    const third = ((await nav.nth(2).textContent()) ?? '').trim();
    check(`${lang}: navigation in the language`, lang === 'en' ? third === 'How it works' : third !== 'How it works', third);
    checks++;
    const views = [
      ['swap', async () => nav.nth(0).click()],
      ['advanced', async () => page.locator('.seg.mode button').nth(1).click()],
      ['nexus', async () => page.locator('.venue button').nth(1).click()],
      ['swaps', async () => nav.nth(1).click()],
      ['help', async () => nav.nth(2).click()],
    ];
    for (const [name, go] of views) {
      await go();
      await page.waitForTimeout(700);
      const body = await page.evaluate(() => document.body.innerText);
      const left = body.match(/\{[a-zA-Z]\w*\}/g);
      check(`${lang} ${width} ${name}: no unfilled placeholder`, !left, left?.join(' '));
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`${lang} ${width} ${name}: no sideways scroll`, sideways <= 0, `${sideways}px`);
      checks += 2;
      if (pictures.includes(lang) && (width === 390 || name === 'swap')) {
        await page.screenshot({ path: `${shots}/${lang}-${width}-${name}.png`, fullPage: true });
      }
    }
    await page.context().close();
  }
}
await browser.close();
log(failed ? `${failed} of ${checks} FAILED` : `ALL PASSED (${checks} checks)`);
process.exitCode = failed ? 1 : 0;
