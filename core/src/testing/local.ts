//shared setup for end to end tests on the private Nexus chain + anvil (nexus-dev). Env: NEXUS_NODE, EVM_RPC,
//CONTRACTS (forge out dir).
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { nameContract } from '../../../../wallet/src/lib/tritium';
import { slotCreateContracts } from '../nexus/htlc';
import { NexusNode } from '../nexus/node';

export const env = { nexusUrl: process.env.NEXUS_NODE, rpc: process.env.EVM_RPC, out: process.env.CONTRACTS };
export const haveLocal = !!(env.nexusUrl && env.rpc && env.out);

//anvil's well known development keys (public, local chain only)
export const keys = {
  deploy: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex,
  taker: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex,
  maker: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hex,
  watcher: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as Hex,
};

//profiles on the private chain (test only)
export const alice = { username: 'alice', password: 'alicepass1', pin: '1111', account: '8BoheBPAFeWSKKSzWuQLxVbVz8wbKW6ZVLmgLU2mmUA9xp5FHkb' };
export const bob = { username: 'bob', password: 'bobpass12', pin: '2222', account: '8CekfnBTnqNDLZAcwVCQP9ge2jbxnAeh2MbVmpKtKtJVkNnahzM' };
export type Profile = typeof alice;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function localChains() {
  const node = new NexusNode(env.nexusUrl!);
  const client = createPublicClient({ chain: foundry, transport: http(env.rpc) }) as PublicClient;
  const wallet = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain: foundry, transport: http(env.rpc) });
  return { node, client, wallet };
}

function artifact(file: string, name: string) {
  const j = JSON.parse(readFileSync(`${env.out}/${file}/${name}.json`, 'utf8'));
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
}

//a fresh NexusSwap + test USDT, 1000 USDT minted to each address
export async function deploy(holders: Address[]): Promise<{ swap: Address; usdt: Address; fromBlock: bigint }> {
  const { client, wallet } = localChains();
  const d = wallet(keys.deploy);
  const fromBlock = await client.getBlockNumber();
  const s = artifact('NexusSwap.sol', 'NexusSwap');
  const t = artifact('TestToken.sol', 'TestToken');
  const swapTx = await d.deployContract({ abi: s.abi, bytecode: s.bytecode, args: [] });
  const tokenTx = await d.deployContract({ abi: t.abi, bytecode: t.bytecode, args: ['Test USDT', 'USDT', 6] });
  const swap = (await client.waitForTransactionReceipt({ hash: swapTx })).contractAddress!;
  const usdt = (await client.waitForTransactionReceipt({ hash: tokenTx })).contractAddress!;
  for (const who of holders) {
    const tx = await d.writeContract({ address: usdt, abi: t.abi, functionName: 'mint', args: [who, 1000_000000n] });
    await client.waitForTransactionReceipt({ hash: tx });
  }
  return { swap, usdt, fromBlock };
}

//the private chain makes a block only when a transaction comes in, and a refused refund is no transaction: without
//traffic ledger.timestamp stays before a deadline forever. On mainnet blocks come every ~50 s anyway. This sends a
//throwaway local name (free on the private chain) when the newest block is older than maxAge seconds.
let nudges = 0;
export async function nudgeNexus(node: NexusNode, who: Profile, maxAge = 30): Promise<boolean> {
  const tip = await node.tip();
  const head = await localChains().client.getBlock({ blockTag: 'latest' });
  if (Number(head.timestamp) - tip.timestamp < maxAge) {
    return false;
  }
  const genesis = (await node.accountState(who.account)).owner;
  const name = `nudge${Date.now().toString(36)}${nudges++}`;
  await node.submit(who, genesis, (ts) => [nameContract(genesis, name, new Uint8Array(32), false, ts)]);
  return true;
}

//the profile's reveal slot, created once
export async function ensureSlot(node: NexusNode, who: Profile): Promise<string> {
  const genesis = (await node.accountState(who.account)).owner;
  if (!(await node.slot(genesis))) {
    const tx = await node.submit(who, genesis, (ts) => slotCreateContracts(genesis, ts));
    await node.waitConfirmed(tx);
  }
  return genesis;
}
