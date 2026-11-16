//deploys NexusSwap on one chain of contracts/mainnet/chains.json and records it in contracts/mainnet/deployments/<id>.json
//(address, first block, tx, deployer, code hash). Checks the code on chain equals the build before it writes anything.
//  ESTIMATE=1          only the gas and what it costs at the chain's gas price now, and what the deployer holds
//  RPC=<url>           use that RPC instead of the public one (e.g. a local anvil fork for a rehearsal)
//  DRY=1               rehearsal: writes rehearsal/<id>.json instead (use it with RPC=<anvil fork>)
//  CONTRACTS=$HOME/dex/contracts/out CHAIN=56 DEPLOYER_KEY_FILE=<file with a 0x key> npx tsx tools/deploy-mainnet.ts
//Nothing is sent without DEPLOYER_KEY_FILE; the key never leaves this process.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, formatEther, http, keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const here = dirname(fileURLToPath(import.meta.url));
const mainnet = join(here, '../../contracts/mainnet');
const cfg = JSON.parse(readFileSync(join(mainnet, 'chains.json'), 'utf8'));
const id = process.env.CHAIN ?? '';
const c = cfg.chains[id];
if (!c) {
  throw new Error(`CHAIN must be one of ${Object.keys(cfg.chains).join(', ')}`);
}
const rpc = process.env.RPC ?? c.rpc;
const chain = defineChain({ id: Number(id), name: c.name, nativeCurrency: { name: c.native.symbol, symbol: c.native.symbol, decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const client = createPublicClient({ chain, transport: http(rpc) });
const art = JSON.parse(readFileSync(`${process.env.CONTRACTS ?? join(here, '../../contracts/out')}/NexusSwap.sol/NexusSwap.json`, 'utf8'));
const bytecode = art.bytecode.object as Hex;
const runtime = art.deployedBytecode.object as Hex;

const realId = await client.getChainId();
if (realId !== Number(id)) {
  throw new Error(`the RPC answers chain ${realId}, not ${id}`);
}
const price = await client.getGasPrice();
const keyFile = process.env.DEPLOYER_KEY_FILE;
const account = keyFile ? privateKeyToAccount(readFileSync(keyFile, 'utf8').trim() as Hex) : undefined;
const gas = await client.estimateGas({ account: account?.address, data: bytecode });

if (process.env.ESTIMATE || !account) {
  const have = account ? await client.getBalance({ address: account.address }) : undefined;
  console.log(JSON.stringify({ chain: c.name, gas: gas.toString(), gasPriceGwei: Number(price) / 1e9, costs: `${formatEther(gas * price)} ${c.native.symbol}`, deployer: account?.address, has: have === undefined ? undefined : `${formatEther(have)} ${c.native.symbol}` }));
  process.exit(0);
}

const target = join(mainnet, process.env.DRY ? 'rehearsal' : 'deployments', `${id}.json`);
if (existsSync(target) && !process.env.DRY) {
  throw new Error(`${target} exists: NexusSwap is already deployed on ${c.name}`);
}
const wallet = createWalletClient({ account, chain, transport: http(rpc) });
const hash = await wallet.deployContract({ abi: art.abi, bytecode, args: [], gas: (gas * 12n) / 10n });
console.log(`sent ${hash}, waiting for the receipt`);
const r = await client.waitForTransactionReceipt({ hash });
if (r.status !== 'success' || !r.contractAddress) {
  throw new Error(`deploy failed: ${r.status}`);
}
const code = await client.getCode({ address: r.contractAddress });
//immutables would differ per deploy; NexusSwap has none, so the code on chain must equal the build byte for byte
if (!code || keccak256(code) !== keccak256(runtime)) {
  throw new Error('the code on chain differs from the build');
}
mkdirSync(dirname(target), { recursive: true });
const rec = {
  chainId: Number(id),
  chain: c.name,
  swap: r.contractAddress.toLowerCase(),
  fromBlock: Number(r.blockNumber),
  tx: hash,
  deployer: account!.address,
  codeHash: keccak256(code),
  gasUsed: Number(r.gasUsed),
  compiler: { solc: '0.8.28', optimizer: true, runs: 200 },
  explorer: `${c.explorer}/address/${r.contractAddress}`,
  at: new Date().toISOString(),
};
writeFileSync(target, JSON.stringify(rec, null, 2) + '\n');
console.log(JSON.stringify(rec));
