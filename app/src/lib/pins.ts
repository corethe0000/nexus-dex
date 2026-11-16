//what a site (or the always-on maker) fixes itself instead of taking it from the offer service on trust. No React
//here: the maker program (service/src/maker-bot-main.ts) uses it too; the page passes its own language's texts.
import { checkTiming, defaultTiming, testTiming } from '@nexus-dex/core/src/swap/timing';
import type { Address } from 'viem';
import type { ChainInfo, RelayInfo, SiteConfig } from './config';
import { frame } from './locales/en-parts/frame';

export interface PinTexts {
  swapMismatch: string; //{chain}
  timingBad: string;
}

const englishTexts: PinTexts = { swapMismatch: frame.cfgSwapMismatch, timingBad: frame.cfgTimingBad };

export type Pins = Pick<SiteConfig, 'swapContracts' | 'timing' | 'minConfirmations' | 'tokens'>;

//the relay's tokens of one chain against the site's list: only listed addresses, with the site's symbol, decimals
//and dollar value (a relay could otherwise show its own token as USDT, or shift the decimals)
function pinTokens(id: string, tokens: ChainInfo['tokens'], pins: Pins): ChainInfo['tokens'] {
  if (!pins.tokens) {
    return tokens;
  }
  const listed = pins.tokens[id] ?? [];
  return tokens.flatMap((t) => {
    const p = listed.find((x) => x.address.toLowerCase() === t.address.toLowerCase());
    return p ? [{ ...t, address: p.address as Address, symbol: p.symbol, decimals: p.decimals, usd: p.usd ?? t.usd }] : [];
  });
}

//the relay's info checked against what the site fixes: a different swap contract stops the page, a chain the site
//does not list is left out, tokens only as the site lists them, the timing is the site's own (else it must pass
//checkTiming), confirmations never below the site's minimum
export function pinInfo(info: RelayInfo, pins: Pins, texts: PinTexts = englishTexts): RelayInfo {
  const chains: RelayInfo['chains'] = {};
  for (const [id, c] of Object.entries(info.chains)) {
    const pinned = pins.swapContracts?.[id];
    if (pins.swapContracts && !pinned) {
      continue;
    }
    if (pinned && pinned.toLowerCase() !== c.swap.toLowerCase()) {
      throw new Error(texts.swapMismatch.replace('{chain}', c.name));
    }
    chains[id] = { ...c, tokens: pinTokens(id, c.tokens, pins), confirmations: Math.max(c.confirmations, pins.minConfirmations?.[id] ?? 0) };
  }
  let timing = info.timing;
  if (pins.timing) {
    timing = pins.timing === 'test' ? testTiming : defaultTiming;
  } else {
    try {
      checkTiming(timing);
    } catch {
      throw new Error(texts.timingBad);
    }
  }
  const nexus = { ...info.nexus, confirmations: Math.max(info.nexus.confirmations, pins.minConfirmations?.nexus ?? 0) };
  return { ...info, chains, timing, nexus };
}
