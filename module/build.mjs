//builds the Nexus DEX desktop wallet module into module/dist: the app in vite mode "module", config.js, the icon and
//nxs_package.json listing every file (the wallet refuses files a module does not list).
//  node module/build.mjs --config app/public/config.json [--base http://host:port] [--net testnet]
//--base turns the config's relative service paths (/relay, /evm, /keeper) into absolute ones, since the module page
//has no server of its own; nexusNode becomes "wallet" (the wallet's own core). WalletConnect stays off unless
//WC_PROJECT_ID is set.
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = resolve(here, 'dist');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const configPath = resolve(root, arg('config', 'app/public/config.json'));
const base = arg('base', '');
const onlyNet = arg('net', '');

//config: one profile per network, services made absolute, Nexus through the wallet
const file = JSON.parse(readFileSync(configPath, 'utf8'));
const nets = file.networks ?? { testnet: file };
const abs = (u) => (typeof u === 'string' && u.startsWith('/') ? `${base.replace(/\/$/, '')}${u}` : u);
const networks = {};
for (const [net, p] of Object.entries(nets)) {
  if (onlyNet && net !== onlyNet) {
    continue;
  }
  const q = { ...p };
  if (q.relay) {
    if (q.relay.startsWith('/') && !base) {
      throw new Error(`${net}: relay ${q.relay} is relative, give --base`);
    }
    q.relay = abs(q.relay);
    q.nexusNode = 'wallet';
  }
  q.evmRpc = Object.fromEntries(Object.entries(q.evmRpc ?? {}).map(([k, v]) => [k, abs(v)]));
  q.keepers = (q.keepers ?? []).map(abs);
  q.witnessNodes = (q.witnessNodes ?? []).map(abs);
  delete q.walletRpc; //only for adding a chain to an injected wallet, there is none in the desktop wallet
  if (process.env.WC_PROJECT_ID) {
    q.walletConnectProjectId = process.env.WC_PROJECT_ID;
  } else {
    delete q.walletConnectProjectId;
  }
  networks[net] = q;
}

execSync('npx vite build --mode module', { cwd: resolve(root, 'app'), stdio: 'inherit', env: { ...process.env, DEX_MODULE_OUT: out } });

//one classic script: module scripts do not load from file://
const indexPath = join(out, 'index.html');
let html = readFileSync(indexPath, 'utf8');
html = html.replace(/<script type="module" crossorigin src=/g, '<script defer src=').replace(/<link rel="stylesheet" crossorigin /g, '<link rel="stylesheet" ');
html = html.replace('<script defer src=', '<script src="./config.js"></script>\n    <script defer src=');
writeFileSync(indexPath, html);
writeFileSync(join(out, 'config.js'), `window.dexConfig = ${JSON.stringify({ networks }, null, 2)};\n`);
copyFileSync(join(here, 'icon.svg'), join(out, 'icon.svg'));

const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) {
      walk(p);
    } else {
      files.push(relative(out, p).split('\\').join('/'));
    }
  }
};
walk(out);
const app = JSON.parse(readFileSync(resolve(root, 'app/package.json'), 'utf8'));
const pkg = {
  name: 'nexus-dex',
  displayName: 'Nexus DEX',
  version: app.version,
  targetWalletVersion: '3.1.5',
  description: 'Swap NXS and Nexus tokens with USDT, USDC and other coins on EVM chains, peer to peer with atomic swaps.',
  type: 'app',
  entry: 'index.html',
  icon: 'icon.svg',
  author: { name: 'Nexus', email: 'impressions@nexus.io' },
  files: files.filter((f) => f !== 'nxs_package.json' && f !== 'nxs_package.dev.json').sort(),
};
writeFileSync(join(out, 'nxs_package.json'), JSON.stringify(pkg, null, 2) + '\n');
//the wallet reads only this one for a folder added as a development module (Settings > Application, developer mode)
const dev = { name: 'nexus-dex-dev', displayName: 'Nexus DEX (dev)', description: pkg.description, type: 'app', entry: pkg.entry, icon: pkg.icon };
writeFileSync(join(out, 'nxs_package.dev.json'), JSON.stringify(dev, null, 2) + '\n');
console.log(`module built in ${out}: ${pkg.files.length} files, networks ${Object.keys(networks).join(', ')}`);
