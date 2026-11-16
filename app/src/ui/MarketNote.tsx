import { useT } from '../lib/i18n';
import { marketNote, shownPrice, type NetworkFee } from './offers';

//a fee this big a part of the EVM side is worth a warning (small swaps on Ethereum)
const feeWarnShare = 0.05;

//about what the user's own EVM step costs in network fees; a warning when that is a big part of the swap.
//swapUsd = dollars of the EVM side (null when unknown)
export function FeeNote({ fee, chain, swapUsd }: { fee: NetworkFee | null; chain: string; swapUsd: number | null }) {
  const { t, f } = useT();
  if (!fee) {
    return null;
  }
  const coin = `${fee.amount.toLocaleString('en-US', { maximumSignificantDigits: 2 })} ${fee.coin}`;
  const usd = fee.usd === null ? null : fee.usd < 0.01 ? '< $0.01' : `$${fee.usd.toFixed(2)}`;
  const share = fee.usd !== null && swapUsd ? fee.usd / swapUsd : 0;
  return (
    <p className={`market-note fee-note${share >= feeWarnShare ? ' warn' : ''}`}>
      {f(t.trNetworkFee, { chain, fee: usd ? `${coin} (${usd})` : coin })}
      {share >= feeWarnShare && ` ${f(t.trNetworkFeeShare, { pct: Math.round(share * 100) })}`}
    </p>
  );
}

//one line under a price (in dollars): how far it is from the market, a warning when it is bad for the person acting.
//onUse = a link that puts the market price into the price field (the caller converts dollars to its token)
export function MarketNote({ priceNum, market, iBuy, onUse }: { priceNum: number; market: { usd: number; source: string } | null; iBuy: boolean; onUse?: (usd: number) => void }) {
  const { t, f } = useT();
  if (!market) {
    return null;
  }
  const n = marketNote(priceNum, market, iBuy);
  return (
    <p className={`market-note${n?.warn ? ' warn' : ''}`}>
      {n ? n.text : f(t.trMarketAbout, { price: shownPrice(market.usd), source: market.source || t.trReference })}{' '}
      {onUse && (!n || n.text.includes('%')) && (
        <button type="button" className="link" onClick={() => onUse(market.usd)}>
          {t.trUseIt}
        </button>
      )}
    </p>
  );
}
