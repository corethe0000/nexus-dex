//deploys a new NexusSwap (after a contract change) and prints its address and first block for the relay and keeper
//configs (chains.<id>.swap / fromBlock). Local chain by default; a public testnet with its RPC and a deploy key file.
//ESTIMATE=1 only prints the gas the deploy needs and what the deployer holds. GAS=<limit> sends with that limit at
//the legacy gas price, or at GAS_PRICE_GWEI (when the node's estimate refuses a deployer with little left; take the
//local chain's estimate; BSC testnet includes 0.1 gwei while eth_gasPrice says more).
//  CONTRACTS=$HOME/dex/contracts/out EVM_RPC=http://127.0.0.1:8545 npx tsx tools/redeploy-swap.ts
//  CONTRACTS=... EVM_RPC=https://ethereum-sepolia-rpc.publicnode.com CHAIN_ID=11155111 DEPLOYER_KEY_FILE=<file> npx tsx tools/redeploy-swap.ts
import { readFileSync } from 'node:fs';
import { createPublicClient, defineChain, formatEther, http, parseGwei, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { keys } from '../../core/src/testing/local';
import { deploySwap } from './deploy-lib';

const rpc = process.env.EVM_RPC ?? 'http://127.0.0.1:8545';
const chainId = Number(process.env.CHAIN_ID ?? 31337);
const deployerKey = process.env.DEPLOYER_KEY_FILE ? (readFileSync(process.env.DEPLOYER_KEY_FILE, 'utf8').trim() as Hex) : keys.deploy;

if (process.env.ESTIMATE) {
  const chain = defineChain({ id: chainId, name: `chain ${chainId}`, nativeCurrency: { name: 'gas', symbol: 'GAS', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const client = createPublicClient({ chain, transport: http(rpc) });
  const account = privateKeyToAccount(deployerKey);
  const j = JSON.parse(readFileSync(`${process.env.CONTRACTS}/NexusSwap.sol/NexusSwap.json`, 'utf8'));
  const gas = await client.estimateGas({ account, data: j.bytecode.object as Hex });
  const price = await client.getGasPrice();
  const have = await client.getBalance({ address: account.address });
  console.log(JSON.stringify({ deployer: account.address, gas: gas.toString(), gasPriceGwei: Number(price) / 1e9, costs: formatEther(gas * price), has: formatEther(have) }));
} else {
  const d = await deploySwap({ out: process.env.CONTRACTS!, rpc, chainId, deployerKey, gas: process.env.GAS ? BigInt(process.env.GAS) : undefined, gasPrice: process.env.GAS_PRICE_GWEI ? parseGwei(process.env.GAS_PRICE_GWEI) : undefined });
  console.log(JSON.stringify({ chainId, swap: d.swap.toLowerCase(), fromBlock: d.fromBlock.toString() }));
}
