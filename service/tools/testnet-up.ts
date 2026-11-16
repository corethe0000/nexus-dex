//public testnet setup: deploys NexusSwap + test USDT/USDC on BSC testnet (97) and Polygon Amoy (80002) and writes a
//relay config for both. The deployer pays the gas in test BNB / test POL (from a faucet); test coins go to HOLDERS.
//  CONTRACTS=$HOME/dex/contracts/out DEPLOYER_KEY_FILE=<file with 0x key> [WATCHER_KEY_FILE=..] [MERGE_INTO=<relay config>] [TOKENS=USDT,USDC] HOLDERS=0x..,0x.. npx tsx tools/testnet-up.ts $HOME/dex-testnet [97,80002]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Address, Hex } from 'viem';
import { deployDex } from './deploy-lib';

//public RPCs (https, so wallets accept them) and block times; finalDelay = inclusion + confirmations with headroom
export const testnets: Record<string, { name: string; rpc: string; confirmations: number; finalDelay: number }> = {
  '97': { name: 'BSC testnet', rpc: 'https://bsc-testnet-rpc.publicnode.com', confirmations: 3, finalDelay: 30 },
  //rpc-amoy.polygon.technology was retired in July 2026
  '80002': { name: 'Polygon Amoy', rpc: 'https://polygon-amoy-bor-rpc.publicnode.com', confirmations: 5, finalDelay: 40 },
  //Ethereum Sepolia: 12 s blocks; gas from a proof-of-work faucet (sepolia-faucet.pk910.de), no login or balance
  '11155111': { name: 'Sepolia', rpc: 'https://ethereum-sepolia-rpc.publicnode.com', confirmations: 3, finalDelay: 60 },
};

const dataDir = process.argv[2] ?? join(process.env.HOME ?? '.', 'dex-testnet');
const which = (process.argv[3] ?? '97,80002').split(',');
const deployerKey = readFileSync(process.env.DEPLOYER_KEY_FILE!, 'utf8').trim() as Hex;
const holders = (process.env.HOLDERS ?? '').split(',').filter(Boolean) as Address[];

const chains: Record<string, unknown> = {};
for (const id of which) {
  const t = testnets[id];
  if (!t) {
    throw new Error(`unknown testnet ${id}`);
  }
  const d = await deployDex({ out: process.env.CONTRACTS!, rpc: t.rpc, chainId: Number(id), deployerKey, testTokens: true, holders, mintEach: 10_000_000000n, symbols: process.env.TOKENS?.split(',') });
  chains[id] = { name: t.name, rpc: t.rpc, swap: d.swap, fromBlock: d.fromBlock.toString(), confirmations: t.confirmations, finalDelay: t.finalDelay, tokens: d.tokens, watcherKeyFile: process.env.WATCHER_KEY_FILE ?? process.env.DEPLOYER_KEY_FILE };
  console.log(`${t.name}: swap ${d.swap}, ${d.tokens.map((x) => `${x.symbol} ${x.address}`).join(', ')}`);
}

//MERGE_INTO=<relay config>: add these chains to a running relay's config (restart the relay after), else a new config
const mergeInto = process.env.MERGE_INTO;
if (mergeInto) {
  const config = JSON.parse(readFileSync(mergeInto, 'utf8'));
  config.chains = { ...config.chains, ...chains };
  writeFileSync(mergeInto, JSON.stringify(config, null, 2));
  console.log(`chains added to ${mergeInto}`);
} else {
  mkdirSync(dataDir, { recursive: true });
  const config = { host: '127.0.0.1', port: 3201, dataDir, nexusNode: 'http://127.0.0.1:7080', nexusFinalDelay: 120, nexusConfirmations: 1, timing: 'test', chains };
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify(config, null, 2));
  console.log(`config ${join(dataDir, 'config.json')}`);
}
