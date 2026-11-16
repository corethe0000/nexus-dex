//local trial setup in nexus-dev: deploys NexusSwap + test USDT and USDC on anvil, gives test coins to the anvil
//accounts, and writes the relay config. Then: DEX_CONFIG=<out> npx tsx src/main.ts, and the app's dev server.
//  CONTRACTS=$HOME/dex/contracts/out EVM_RPC=http://127.0.0.1:8545 npx tsx tools/dev-up.ts $HOME/dex-data
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mnemonicToAccount } from 'viem/accounts';
import { keys } from '../../core/src/testing/local';
import { deployDex } from './deploy-lib';

const rpc = process.env.EVM_RPC ?? 'http://127.0.0.1:8545';
const dataDir = process.argv[2] ?? join(process.env.HOME ?? '.', 'dex-data');

//anvil's default accounts (public test mnemonic): 0-9 get test coins, so any of them imported into a wallet can trade
const anvilMnemonic = 'test test test test test test test test test test test junk';
const holders = Array.from({ length: 10 }, (_, i) => mnemonicToAccount(anvilMnemonic, { addressIndex: i }).address);

const d = await deployDex({ out: process.env.CONTRACTS!, rpc, chainId: 31337, deployerKey: keys.deploy, testTokens: true, holders, mintEach: 10_000_000000n });

mkdirSync(dataDir, { recursive: true });
const keyFile = join(dataDir, 'watcher-key');
writeFileSync(keyFile, keys.watcher, { mode: 0o600 });
const config = {
  host: '127.0.0.1',
  port: 3200,
  dataDir,
  nexusNode: 'http://127.0.0.1:7080',
  nexusFinalDelay: 120,
  nexusConfirmations: 1,
  timing: 'test',
  chains: { '31337': { name: 'Local chain', rpc, swap: d.swap, fromBlock: d.fromBlock.toString(), confirmations: 2, finalDelay: 10, tokens: d.tokens, watcherKeyFile: keyFile } },
};
writeFileSync(join(dataDir, 'config.json'), JSON.stringify(config, null, 2));
console.log(`swap ${d.swap}\n${d.tokens.map((x) => `${x.symbol} ${x.address}`).join('\n')}\nconfig ${join(dataDir, 'config.json')}`);
