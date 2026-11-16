//checks the independent keeper against the local anvil chain (relay config for addresses): a lock that expires in 20 s
//must be refunded to its sender by Keeper.sweep, and a claim with a wrong secret must be refused.
//  DEX_CONFIG=~/dex-data/config.json npx tsx tools/keeper-check.ts
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { EvmLeg, erc20Abi } from '../../core/src/evm/leg';
import { toHexBytes } from '../../core/src/nexus/bytes';
import { hashOf, newSecret } from '../../core/src/nexus/htlc';
import { keys } from '../../core/src/testing/local';
import { Keeper } from '../src/keeper';

const cfg = JSON.parse(readFileSync(process.env.DEX_CONFIG ?? 'config.json', 'utf8')).chains['31337'];
const client = createPublicClient({ chain: foundry, transport: http(cfg.rpc) }) as PublicClient;
const sender = createWalletClient({ account: privateKeyToAccount(keys.taker), chain: foundry, transport: http(cfg.rpc) });
const keeperWallet = createWalletClient({ account: privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba'), chain: foundry, transport: http(cfg.rpc) }); //anvil dev account 5 (public)
const leg = new EvmLeg(client, cfg.swap, 1, BigInt(cfg.fromBlock));
const usdt = cfg.tokens.find((t: { symbol: string }) => t.symbol === 'USDT').address as Address;
const balance = () => client.readContract({ address: usdt, abi: erc20Abi, functionName: 'balanceOf', args: [sender.account.address] });

let failed = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' - ' + detail : ''}`);
  failed += ok ? 0 : 1;
};

const before = await balance();
const amount = 1_000000n;
const deadline = (await leg.clock()) + 20;
const e = { sender: sender.account.address, recipient: `0x${randomBytes(20).toString('hex')}` as Address, token: usdt, amount, hashlock: `0x${toHexBytes(hashOf(newSecret()))}` as Hex, nexusRef: `0x${randomBytes(32).toString('hex')}` as Hex };
const { id, tx } = await leg.lock(sender, e, deadline);
await client.waitForTransactionReceipt({ hash: tx });
check('lock made', (await leg.state(id)).state === 'open', id);

const keeper = new Keeper(new Map([['31337', { leg, wallet: keeperWallet, claimMargin: 5, refundDelay: 0 }]]), (m) => console.log(`  ${m}`));
const wrong = await keeper.claim('31337', id, `0x${'11'.repeat(32)}`, Math.floor(Date.now() / 1000)).then(
  () => 'claimed',
  (x) => (x as Error).message,
);
check('wrong secret refused', /not the secret/.test(wrong), wrong);

//sweep until the deadline has passed and the refund is in
let state = 'open';
for (let i = 0; i < 30 && state === 'open'; i++) {
  await keeper.sweep(Math.floor(Date.now() / 1000));
  await new Promise((r) => setTimeout(r, 3000));
  state = (await leg.state(id)).state;
}
check('expired lock refunded by the keeper', state === 'refunded', state);
check('sender has the amount back', (await balance()) === before, `${before} -> ${await balance()}`);
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
