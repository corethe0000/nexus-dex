//full swaps between the private Nexus chain and a local EVM chain (anvil), both sides driven by SwapRunner:
//NEXUS_NODE=http://127.0.0.1:7080 EVM_RPC=http://127.0.0.1:8545 CONTRACTS=$HOME/dex/contracts/out npx vitest run src/swap/swap.e2e.test.ts
import { describe, expect, it } from 'vitest';
import { haveLocal } from '../testing/local';
import { runSwap } from '../testing/swap-run';
import type { SwapRecord } from './runner';

describe.skipIf(!haveLocal)('swap end to end: private Nexus chain + anvil', () => {
  it('taker pays USDT on the EVM chain for TESTT on Nexus', async () => {
    const { m } = await runSwap({ initiatorChain: 'evm' });
    //the maker's list shows the taker's claim of its Nexus lock
    expect(m.rec.txs?.filter((x) => x.chain === 'nexus' && x.kind === 'claim' && x.by === 'them').length).toBe(1);
  }, 30 * 60 * 1000);

  it('taker pays TESTT on Nexus for USDT on the EVM chain', async () => {
    await runSwap({ initiatorChain: 'nexus' });
  }, 30 * 60 * 1000);

  //both swaps' claims go to the taker's one reveal slot: the second waits until the first credit is final. The claim
  //follows its reveal before the reveal is in a block (the node applies it at once), so both share a block
  it('two swaps of one taker profile at once: both claim on Nexus, one after the other', async () => {
    const { pairs } = await runSwap({ initiatorChain: 'evm', swaps: 2 });
    expect(pairs.some((p) => p.t.rec.log.some((l) => l.includes('to finish its claim (one reveal slot)')))).toBe(true);
    for (const p of pairs) {
      expect(p.t.rec.txs?.filter((x) => x.kind === 'reveal').length).toBe(1);
      //the claim follows the reveal at once (whether the reveal is in a block by then depends on the chain)
      const at = (text: string) => Date.parse(p.t.rec.log.find((l) => l.includes(text))!.slice(0, 24));
      expect(at('claim on Nexus sent') - at('secret written to the slot')).toBeLessThan(30000);
    }
  }, 30 * 60 * 1000);

  //refunds take the full lock times (testTiming: ~20 min each)
  it('maker never locks: the taker gets its Nexus lock back after the deadline', async () => {
    await runSwap({ initiatorChain: 'nexus', offline: { who: 'maker', when: () => true, back: false }, expectResult: 'refunded' });
  }, 32 * 60 * 1000);

  it('taker vanishes after both locked: maker refunds on Nexus, taker refunds on EVM when back', async () => {
    //the moment the maker has sent its lock, before the taker can see it final and claim
    const makerLocked = (_t: SwapRecord, m: SwapRecord) => m.pending?.kind === 'lock';
    await runSwap({ initiatorChain: 'evm', offline: { who: 'taker', when: makerLocked, back: true }, expectResult: 'refunded' });
  }, 32 * 60 * 1000);
});
