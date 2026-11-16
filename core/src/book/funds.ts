//maker, before accepting a take: the taker must hold what it locks first. A take from a fresh key with nothing behind
//it would only keep the offer filled until the swap gives up (the maker's own lock comes after the taker's, so no
//funds are at risk, only the offer's time)
import type { PublicClient } from 'viem';
import { erc20Abi, isNative } from '../evm/leg';
import type { NexusNode } from '../nexus/node';
import type { Offer, Take } from './offer';

//null = fine; a read that fails counts as a problem (the take comes again with the next alive beat)
export async function takerFundsProblem(offer: Offer, take: Take, evm: PublicClient, nexus: NexusNode): Promise<string | null> {
  try {
    if (offer.makerGivesNexus) {
      const balance = isNative(offer.evmToken)
        ? await evm.getBalance({ address: take.taker })
        : await evm.readContract({ address: offer.evmToken, abi: erc20Abi, functionName: 'balanceOf', args: [take.taker] });
      return balance >= offer.evmAmount ? null : 'the taker does not hold the amount it has to lock';
    }
    const a = await nexus.accountState(take.nexusAccount);
    if (a.token !== offer.nexusToken || a.owner.toLowerCase() !== take.nexusGenesis.toLowerCase()) {
      return "the taker's Nexus account is not its own or holds another token";
    }
    return a.balance >= offer.nexusAmount ? null : 'the taker does not hold the amount it has to lock';
  } catch (e) {
    return `taker balance not readable now: ${(e as Error).message.split('\n')[0]}`;
  }
}
