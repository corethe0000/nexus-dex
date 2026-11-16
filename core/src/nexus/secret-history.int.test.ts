//the secret must be found after the claimer wrote its reveal slot again (security review 2026-11-13): private chain
//  NEXUS_NODE=http://127.0.0.1:7080 EVM_RPC=http://127.0.0.1:8545 CONTRACTS=$HOME/dex/contracts/out npx vitest run src/nexus/secret-history.int.test.ts
import { describe, expect, it } from 'vitest';
import { nameContract } from '../../../../wallet/src/lib/tritium';
import { alice, ensureSlot, haveLocal, localChains } from '../testing/local';
import { hashOf, newSecret } from './htlc';
import { NexusLeg } from './leg';
import { localSigner } from './signer';

describe.skipIf(!haveLocal)('secret from the reveal history', () => {
  it('a slot written again still gives up the secret it held before', async () => {
    const { node } = localChains();
    const genesis = await ensureSlot(node, alice);
    const signer = localSigner(node, alice, genesis);
    const secret = newSecret();
    const hashlock = hashOf(secret);
    await node.waitConfirmed(await signer.reveal(secret));
    //the next write, as the claimer's next swap (or an attempt to hide it) would do
    await new Promise((r) => setTimeout(r, 11000));
    await node.waitConfirmed(await signer.reveal(newSecret()));
    const leg = new NexusLeg(node, 1);
    expect(await leg.findSecret(genesis, hashlock)).toBeNull();
    const found = await leg.findSecret(genesis, hashlock, true);
    expect(found && Buffer.from(found).toString('hex')).toBe(Buffer.from(secret).toString('hex'));
    //a second search is answered from what was already read
    const again = await leg.findSecret(genesis, hashOf(newSecret()), true);
    expect(again).toBeNull();
    //what a search for another hashlock read is still checked for this one (one swap's miss is the next one's secret)
    const third = await leg.findSecret(genesis, hashlock, true);
    expect(third && Buffer.from(third).toString('hex')).toBe(Buffer.from(secret).toString('hex'));
  }, 5 * 60 * 1000);

  //the claimer reveals, sends other transactions, then "claims" and writes the slot again: walking back from the claim
  //finds the reveal however much came after it
  it('from the claim back to the reveal, past other transactions', async () => {
    const { node } = localChains();
    const genesis = await ensureSlot(node, alice);
    const signer = localSigner(node, alice, genesis);
    const secret = newSecret();
    const hashlock = hashOf(secret);
    const gap = () => new Promise((r) => setTimeout(r, 11000));
    const other = async () => {
      const tx = await node.submit(alice, genesis, (ts) => [nameContract(genesis, 'fill-' + Date.now(), new Uint8Array(32), false, ts)]);
      await node.waitConfirmed(tx);
      return tx;
    };
    await node.waitConfirmed(await signer.reveal(secret));
    await gap();
    await other();
    await gap();
    const claim = await other(); //stands in for the CREDIT
    await gap();
    await node.waitConfirmed(await signer.reveal(newSecret()));
    const leg = new NexusLeg(node, 1);
    const found = await leg.findSecret(genesis, hashlock, true, claim);
    expect(found && Buffer.from(found).toString('hex')).toBe(Buffer.from(secret).toString('hex'));
    //a claim after a later write of the slot does not reach back past that write
    const later = await other();
    expect(await new NexusLeg(node, 1)['secretBeforeClaim'](genesis, hashlock, later)).toBeNull();
  }, 5 * 60 * 1000);
});
