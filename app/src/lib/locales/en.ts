//English: the reference pack. Every other locales/<code>.ts has exactly these keys (the type checks it).
//The English texts live in en-parts/, one file per area of the page, merged here.
import { advanced } from './en-parts/advanced';
import { connect } from './en-parts/connect';
import { frame } from './en-parts/frame';
import { market } from './en-parts/market';
import { swaps } from './en-parts/swaps';
import { trade } from './en-parts/trade';

//a text with a count: the forms a language needs (Intl.PluralRules categories); `other` is always there
export type Plural = { one: string; other: string; zero?: string; two?: string; few?: string; many?: string };

export const en = {
  ...frame,
  ...trade,
  ...advanced,
  ...swaps,
  ...connect,
  ...market,
};

export type Texts = typeof en;
