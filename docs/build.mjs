//renders docs/src/*.html to docs/pdf/*.pdf with headless Chrome (A4; the pages set their own size and margins)
//  node docs/build.mjs [name ...]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p));
if (!chrome) {
  throw new Error('no Chrome found');
}
const names = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(join(here, 'src')).filter((f) => f.endsWith('.html')).map((f) => f.replace(/\.html$/, ''));
mkdirSync(join(here, 'pdf'), { recursive: true });
for (const n of names) {
  const out = resolve(here, 'pdf', `${pdfName(n)}.pdf`);
  execFileSync(chrome, ['--headless=new', '--disable-gpu', `--user-data-dir=${join(here, '.chrome-profile', `${n}-${Date.now()}`)}`, '--no-pdf-header-footer', '--virtual-time-budget=15000', `--print-to-pdf=${out}`, pathToFileURL(join(here, 'src', `${n}.html`)).href], { stdio: 'inherit' });
  console.log(out);
}

function pdfName(n) {
  return { overview: 'Nexus-DEX-Overview', 'contract-guide': 'NexusSwap-Contract-Guide', 'mainnet-needs': 'Nexus-DEX-What-Mainnet-Needs' }[n] ?? n;
}
