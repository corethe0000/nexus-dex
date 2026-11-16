//takes back a test profile's swap locks that are past their deadline and still open (left by aborted page tests,
//whose page record is gone). Lists the profile's own chain, so it finds every lock it ever made.
//  NEXUS_NODE=http://127.0.0.1:7080 npx tsx core/src/testing/refund-stranded.ts [bob|alice] [--dry]
import { localSigner } from '../nexus/signer';
import { NexusNode } from '../nexus/node';
import { alice, bob } from './local';

const node = new NexusNode(process.env.NEXUS_NODE ?? 'http://127.0.0.1:7080');
const who = process.argv[2] === 'alice' ? alice : bob;
const dry = process.argv.includes('--dry');
const genesis = (await node.accountState(who.account)).owner;
const signer = localSigner(node, who, genesis);

const txs: any[] = await node.call('ledger/list/transactions', { genesis, limit: 200, order: 'desc', verbose: 'summary' });
let n = 0;
for (const s of txs) {
  const tx = await node.transaction(s.txid);
  for (const c of tx?.contracts ?? []) {
    if (c.OP !== 'DEBIT' || !c.conditions) {
      continue;
    }
    const open = Number(c.amount ?? 0) - Number(c.claimed ?? 0);
    if (open <= 0) {
      continue;
    }
    const from = typeof c.from === 'object' ? c.from.address : c.from;
    const state = await node.accountState(from);
    const amount = BigInt(Math.round(open * 10 ** state.decimals));
    console.log(`open lock ${s.txid.slice(0, 16)} contract ${c.id}: ${open} from ${from}`);
    if (dry) {
      continue;
    }
    try {
      const txid = await signer.refund({ lockTxid: s.txid, contract: c.id, from, amount });
      await node.waitConfirmed(txid, 1, 180000);
      console.log(`  refunded ${txid.slice(0, 16)}`);
      n++;
    } catch (e) {
      //not past its deadline yet (the tip's time counts), or a lock of the other side's swap path
      console.log(`  not refunded: ${(e as Error).message}`);
    }
  }
}
console.log(`done, ${n} refunded`);
