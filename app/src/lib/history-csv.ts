//finished swaps as a CSV file, for the user's own records (taxes, bookkeeping). Machine-readable on purpose: English
//column names, ISO times in UTC, plain decimal amounts without thousands separators, whatever the page language.
import { offerFromJson } from '@nexus-dex/core/src/book/offer';
import type { AppState } from '../App';
import { tokenOf } from './config';
import type { StoredSwap } from './desk';
import { fromUnits, price } from './format';

const columns = ['time_utc', 'result', 'side', 'nexus_amount', 'nexus_coin', 'other_amount', 'other_coin', 'other_chain', 'price_per_coin', 'role', 'swap_id', 'transactions'];

const plain = (s: string) => s.replace(/,/g, '');
//a text starting with = + - @ runs as a formula in a spreadsheet (tickers and names come from others): kept as text,
//negative numbers stay numbers
const cell = (s: string) => {
  const v = /^[=+\-@\t\r]/.test(s) && !/^-\d/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

function resultOf(s: StoredSwap): string {
  if (s.stage === 'lapsed') {
    return 'not accepted';
  }
  if (s.rec.done) {
    return s.rec.done.result;
  }
  return s.rec.aborted ? 'stopped' : s.stage;
}

export function swapsCsv(app: AppState, swaps: StoredSwap[]): string {
  const rows = swaps.map((s) => {
    const o = offerFromJson(s.offer.offer);
    const nt = app.tokens.get(o.nexusToken);
    const et = tokenOf(app.info, s.offer.offer.evmChainId, o.evmToken);
    const nd = nt?.decimals ?? 0;
    const ed = et?.decimals ?? 0;
    //the taker is the initiator: it gives Nexus coins when the swap starts on Nexus
    const takerGivesNexus = s.rec.initiatorChain === 'nexus';
    const iGiveNexus = s.role === 'initiator' ? takerGivesNexus : !takerGivesNexus;
    return [
      new Date(s.createdAt * 1000).toISOString(),
      resultOf(s),
      iGiveNexus ? 'sold' : 'bought',
      plain(fromUnits(o.nexusAmount, nd)),
      nt?.ticker ?? `token ${o.nexusToken}`,
      plain(fromUnits(o.evmAmount, ed)),
      et?.symbol ?? o.evmToken,
      app.info.chains[s.offer.offer.evmChainId]?.name ?? s.offer.offer.evmChainId,
      plain(price(o.nexusAmount, nd, o.evmAmount, ed, 8)),
      s.role === 'initiator' ? 'took an offer' : 'own offer',
      s.id,
      (s.rec.txs ?? []).map((x) => `${x.chain} ${x.kind} by ${x.by} ${x.hash}`).join('; '),
    ]
      .map(cell)
      .join(',');
  });
  return [columns.join(','), ...rows].join('\r\n') + '\r\n';
}

export function downloadCsv(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
