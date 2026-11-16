//keeps the private Nexus chain moving for page tests: it only makes a block when a transaction waits, and a refund
//needs a block dated after the deadline. Every 20 s, when the newest block is over a minute old, alice writes a
//throwaway name (no fee on a private chain). Only while alice's own page is not signing (her sigchain).
//  NEXUS_NODE=http://127.0.0.1:7080 npx tsx core/src/testing/nudge-loop.ts
import { nameContract } from '../../../../wallet/src/lib/tritium';
import { NexusNode } from '../nexus/node';
import { alice } from './local';

const node = new NexusNode(process.env.NEXUS_NODE ?? 'http://127.0.0.1:7080');
const maxIdle = 60;
const everyMs = 20000;
const genesis = (await node.accountState(alice.account)).owner;
let n = 0;
for (;;) {
  try {
    const tip = await node.tip();
    if (Math.floor(Date.now() / 1000) - tip.timestamp > maxIdle) {
      const name = `nudge${Date.now().toString(36)}${n++}`;
      await node.submit(alice, genesis, (ts) => [nameContract(genesis, name, new Uint8Array(32), false, ts)]);
      console.log(`${new Date().toISOString()} nudge: block was ${Math.floor(Date.now() / 1000) - tip.timestamp} s old`);
    }
  } catch (e) {
    console.log(`${new Date().toISOString()} nudge failed: ${(e as Error).message}`);
  }
  await new Promise((r) => setTimeout(r, everyMs));
}
