//deploys the DEX contracts on one EVM chain: NexusSwap + mintable test USDT and USDC (testnets and local chains
//only; on a mainnet the real stablecoins are used and only NexusSwap is deployed)
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export interface Deployed {
  swap: Address;
  fromBlock: bigint;
  tokens: { address: Address; symbol: string; decimals: number }[];
}

function artifact(out: string, file: string, name: string) {
  const j = JSON.parse(readFileSync(`${out}/${file}/${name}.json`, 'utf8'));
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
}

export async function deployDex(o: { out: string; rpc: string; chainId: number; deployerKey: Hex; testTokens: boolean; holders: Address[]; mintEach: bigint; symbols?: string[] }): Promise<Deployed> {
  const chain = defineChain({ id: o.chainId, name: `chain ${o.chainId}`, nativeCurrency: { name: 'gas', symbol: 'GAS', decimals: 18 }, rpcUrls: { default: { http: [o.rpc] } } });
  const client = createPublicClient({ chain, transport: http(o.rpc) }) as PublicClient;
  const deployer = createWalletClient({ account: privateKeyToAccount(o.deployerKey), chain, transport: http(o.rpc) });
  const fromBlock = await client.getBlockNumber();
  const s = artifact(o.out, 'NexusSwap.sol', 'NexusSwap');
  const swap = (await client.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi: s.abi, bytecode: s.bytecode, args: [] }) })).contractAddress!;
  const tokens: Deployed['tokens'] = [];
  if (o.testTokens) {
    const t = artifact(o.out, 'TestToken.sol', 'TestToken');
    for (const [name, symbol] of [
      ['Test USDT', 'USDT'],
      ['Test USDC', 'USDC'],
    ] as const) {
      if (o.symbols && !o.symbols.includes(symbol)) {
        continue;
      }
      const address = (await client.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi: t.abi, bytecode: t.bytecode, args: [name, symbol, 6] }) })).contractAddress!;
      for (const to of o.holders) {
        await client.waitForTransactionReceipt({ hash: await deployer.writeContract({ address, abi: t.abi, functionName: 'mint', args: [to, o.mintEach] }) });
      }
      tokens.push({ address, symbol, decimals: 6 });
    }
  }
  return { swap, fromBlock, tokens };
}

//one more mintable test token (e.g. a stand-in for WETH with 18 decimals), minted to the holders
export async function deployTestToken(o: { out: string; rpc: string; chainId: number; deployerKey: Hex; name: string; symbol: string; decimals: number; holders: Address[]; mintEach: bigint }): Promise<Address> {
  const chain = defineChain({ id: o.chainId, name: `chain ${o.chainId}`, nativeCurrency: { name: 'gas', symbol: 'GAS', decimals: 18 }, rpcUrls: { default: { http: [o.rpc] } } });
  const client = createPublicClient({ chain, transport: http(o.rpc) }) as PublicClient;
  const deployer = createWalletClient({ account: privateKeyToAccount(o.deployerKey), chain, transport: http(o.rpc) });
  const t = artifact(o.out, 'TestToken.sol', 'TestToken');
  const address = (await client.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi: t.abi, bytecode: t.bytecode, args: [o.name, o.symbol, o.decimals] }) })).contractAddress!;
  for (const to of o.holders) {
    await client.waitForTransactionReceipt({ hash: await deployer.writeContract({ address, abi: t.abi, functionName: 'mint', args: [to, o.mintEach] }) });
  }
  return address;
}

//only the NexusSwap contract (a new version on a chain that already has its tokens)
//gas: a fixed gas limit at the chain's legacy gas price (a deployer with little left: the node's own estimate
//assumes a higher fee cap and refuses)
export async function deploySwap(o: { out: string; rpc: string; chainId: number; deployerKey: Hex; gas?: bigint; gasPrice?: bigint }): Promise<{ swap: Address; fromBlock: bigint }> {
  const chain = defineChain({ id: o.chainId, name: `chain ${o.chainId}`, nativeCurrency: { name: 'gas', symbol: 'GAS', decimals: 18 }, rpcUrls: { default: { http: [o.rpc] } } });
  const client = createPublicClient({ chain, transport: http(o.rpc) }) as PublicClient;
  const deployer = createWalletClient({ account: privateKeyToAccount(o.deployerKey), chain, transport: http(o.rpc) });
  const fromBlock = await client.getBlockNumber();
  const s = artifact(o.out, 'NexusSwap.sol', 'NexusSwap');
  const fees = o.gas !== undefined ? { gas: o.gas, gasPrice: o.gasPrice ?? (await client.getGasPrice()) } : {};
  const receipt = await client.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi: s.abi, bytecode: s.bytecode, args: [], ...fees }) });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`deploy failed in ${receipt.transactionHash}`);
  }
  return { swap: receipt.contractAddress, fromBlock };
}
