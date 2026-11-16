//the trading page: what to trade (stablecoins on other chains, or Nexus coins on the Nexus market), and for
//stablecoins simple (one swap ticket, the default) or advanced (book, depth, own prices); the choices are kept
import { lazy, Suspense } from 'react';
import type { AppState } from '../App';
import { useT } from '../lib/i18n';
import { Simple } from './Simple';

//the views besides simple mode load when first opened (smaller first page load)
const Advanced = lazy(() => import('./Advanced').then((m) => ({ default: m.Advanced })));
const NexusMarket = lazy(() => import('./NexusMarket').then((m) => ({ default: m.NexusMarket })));

export function Trade({ app, onSwap }: { app: AppState; onSwap: () => void }) {
  const { t, f } = useT();
  const nexus = app.prefs.venue === 'nexus';
  const simple = app.prefs.mode === 'simple';
  return (
    <>
      <div className="venue" role="group" aria-label={t.trWhatToTrade}>
        <button aria-pressed={!nexus} onClick={() => app.setPrefs({ venue: 'stable' })}>
          {t.trVenueStable}
          <small>
            {f(t.trVenueStableSub, {
              coins: [...new Set(Object.values(app.info.chains).flatMap((c) => c.tokens.map((tk) => tk.symbol)))].join(', '),
              chains: Object.values(app.info.chains)
                .map((c) => c.name)
                .join(', '),
            })}
          </small>
        </button>
        <button aria-pressed={nexus} onClick={() => app.setPrefs({ venue: 'nexus' })}>
          {t.trVenueNexus}
          <small>{t.trVenueNexusSub}</small>
        </button>
      </div>
      <div className={`trade-head${simple || nexus ? ' simple-head' : ''}`}>
        <div>
          <h1>{nexus ? (simple ? t.trHeadNexusSimple : t.trHeadNexusAdvanced) : simple ? t.trHeadSimple : t.trHeadAdvanced}</h1>
          <p className="lede">{nexus ? t.trLedeNexus : simple ? t.trLedeSimple : t.trLedeAdvanced}</p>
        </div>
        <div className="seg mode" role="group" aria-label={t.trTradingView}>
          <button aria-pressed={simple} onClick={() => app.setPrefs({ mode: 'simple' })}>
            {t.trSimple}
          </button>
          <button aria-pressed={!simple} onClick={() => app.setPrefs({ mode: 'advanced' })}>
            {t.trAdvanced}
          </button>
        </div>
      </div>
      <Suspense fallback={<p className="lede loading">{t.loading}</p>}>{nexus ? <NexusMarket app={app} /> : simple ? <Simple app={app} onSwap={onSwap} /> : <Advanced app={app} onSwap={onSwap} />}</Suspense>
    </>
  );
}
