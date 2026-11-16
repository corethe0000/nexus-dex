import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { NexusNode } from '@nexus-dex/core/src/nexus/node';
import { inWallet, nodeFor, walletCore } from './lib/module';
import { loadInfo, loadSite, type RelayInfo, type SiteConfig } from './lib/config';
import { Desk } from './lib/desk';
import { setWalletScope, type EvmSession } from './lib/evm';
import { network, type NexusNet, type NexusProfile } from './lib/nexus';
import { allowLeave, useAttention } from './lib/attention';
import { LangContext, langReady, loadLang, setCurrentLang, translator, type Lang } from './lib/i18n';
import { applyPrefs, loadPrefs, savePrefs, type NetId, type Prefs } from './lib/prefs';
import { withLink } from './lib/link';
import { Relay } from './lib/relay';
import { TokenNames } from './lib/tokens';
import { Connections } from './ui/Connections';
import { LangPicker, Logo, NetBar, NotLive, ThemeToggle } from './ui/Frame';
import { Trade } from './ui/Trade';

//loaded when first opened (smaller first page load)
const Swaps = lazy(() => import('./ui/Swaps').then((m) => ({ default: m.Swaps })));
const Help = lazy(() => import('./ui/Help').then((m) => ({ default: m.Help })));

export type Dialog = 'nexus' | 'evm' | 'terms' | null;

export interface AppState {
  site: SiteConfig;
  info: RelayInfo;
  relay: Relay;
  node: NexusNode;
  net: NexusNet;
  desk: Desk;
  tokens: TokenNames;
  nexus: NexusProfile | null;
  evm: EvmSession | null;
  setNexus: (p: NexusProfile | null) => void;
  setEvm: (s: EvmSession | null) => void;
  prefs: Prefs;
  setPrefs: (p: Partial<Prefs>) => void;
  dialog: Dialog;
  openDialog: (d: Dialog) => void;
}

type Page = 'trade' | 'swaps' | 'help';
type Boot = { live: true; site: SiteConfig; info: RelayInfo; net: NexusNet } | { live: false } | { error: string } | null;

export function App() {
  const [prefs, setPrefsState] = useState<Prefs>(() => {
    //a shared offer link picks the network and the simple ticket, and that stays the choice
    const stored = loadPrefs();
    const p = withLink(stored);
    if (p !== stored) {
      savePrefs(p);
    }
    return p;
  });
  const [boot, setBoot] = useState<Boot>(null);
  const [nexus, setNexusState] = useState<NexusProfile | null>(null);
  const [evm, setEvmState] = useState<EvmSession | null>(null);
  const [page, setPage] = useState<Page>('trade');
  const [dialog, setDialog] = useState<Dialog>(null);
  const nexusRef = useRef<NexusProfile | null>(null);
  const evmRef = useRef<EvmSession | null>(null);

  useEffect(() => applyPrefs(prefs), [prefs]);
  //the language for the whole page: React parts through LangContext, lib/ code through T(). A pack loads when
  //first picked: the page stays in the language it shows (English on a first visit) until the new one is there
  const [shownLang, setShownLang] = useState<Lang>(() => (langReady(prefs.lang) ? prefs.lang : 'en'));
  useEffect(() => {
    let live = true;
    void loadLang(prefs.lang).then((ok) => {
      if (live && ok) {
        setShownLang(prefs.lang);
      }
    });
    return () => {
      live = false;
    };
  }, [prefs.lang]);
  const lang = useMemo(() => {
    setCurrentLang(shownLang);
    return translator(shownLang);
  }, [shownLang]);
  const t = lang.t;

  //theme and mode change in place; a network change reloads the page (other services, other chains, other swaps)
  const setPrefs = useCallback((p: Partial<Prefs>) => {
    setPrefsState((old) => {
      const next = { ...old, ...p };
      savePrefs(next);
      if (next.net !== old.net) {
        //the ribbon already asked about running swaps: no second question from the browser
        allowLeave();
        window.setTimeout(() => window.location.reload(), 0);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    setWalletScope(prefs.net);
    //inside the desktop wallet its core decides the network: a test or private core is the testnet
    const coreNet = inWallet()
      ? network(nodeFor(walletCore)).then((n): NetId => (n.testnet || n.private ? 'testnet' : 'mainnet'))
      : Promise.resolve(prefs.net);
    coreNet
      .then((net) => {
        if (net !== prefs.net) {
          setPrefs({ net });
          return new Promise<never>(() => {}); //the page reloads on the core's network
        }
        return loadSite(prefs.net);
      })
      .then(async (site) => {
        if (!site) {
          setBoot({ live: false });
          return;
        }
        const [info, net] = await Promise.all([loadInfo(site, prefs.net), network(nodeFor(site.nexusNode))]);
        setBoot({ live: true, site, info, net });
      })
      .catch((e) => setBoot({ error: (e as Error).message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const core = useMemo(() => {
    if (!boot || !('live' in boot) || !boot.live) {
      return null;
    }
    const relay = new Relay(boot.site.relay);
    const node = nodeFor(boot.site.nexusNode);
    const desk = new Desk({ net: prefs.net, site: boot.site, info: boot.info, relay, node, nexus: () => nexusRef.current, evm: () => evmRef.current });
    return { relay, node, desk, tokens: new TokenNames(node, boot.site.nexusTokens) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot]);

  useEffect(() => {
    core?.desk.start();
    return () => core?.desk.stop();
  }, [core]);

  //the desk re-renders the page whenever a swap or offer changes
  const version = useSyncExternalStore(core?.desk.subscribe ?? (() => () => {}), () => core?.desk.version ?? 0);
  useAttention(core?.desk ?? null, prefs.net, version);

  const setNexus = useCallback(
    (p: NexusProfile | null) => {
      nexusRef.current = p;
      setNexusState(p ? { ...p } : null);
      core?.desk.sessionsChanged();
    },
    [core],
  );
  const setEvm = useCallback(
    (s: EvmSession | null) => {
      evmRef.current = s;
      setEvmState(s ? { ...s } : null);
      core?.desk.sessionsChanged();
    },
    [core],
  );

  const active = core?.desk.activeCount() ?? 0;
  const netbar = <NetBar prefs={prefs} setPrefs={setPrefs} running={active} fixed={inWallet()} />;

  if (!boot || 'error' in boot || !boot.live || !core) {
    return (
      <LangContext.Provider value={lang}>
        {netbar}
        <header className="top">
          <Logo />
          <div className="top-end">
            <LangPicker prefs={prefs} setPrefs={setPrefs} />
            <ThemeToggle prefs={prefs} setPrefs={setPrefs} />
          </div>
        </header>
        <main>
          {!boot ? (
            <p className="lede loading">{t.connecting}</p>
          ) : 'error' in boot ? (
            <div className="blank">
              <h1>{t.serviceDown}</h1>
              <p className="lede">{lang.f(t.serviceDownText, { error: boot.error })}</p>
              <button className="btn" style={{ width: 'auto' }} onClick={() => window.location.reload()}>
                {t.tryAgain}
              </button>
            </div>
          ) : (
            <NotLive net={prefs.net} onSwitch={inWallet() ? undefined : () => setPrefs({ net: prefs.net === 'mainnet' ? 'testnet' : 'mainnet' })} />
          )}
        </main>
      </LangContext.Provider>
    );
  }

  const app: AppState = { site: boot.site, info: boot.info, net: boot.net, ...core, nexus, evm, setNexus, setEvm, prefs, setPrefs, dialog, openDialog: setDialog };
  return (
    <LangContext.Provider value={lang}>
      {netbar}
      <header className="top">
        <Logo />
        <nav className="nav" aria-label={t.navPages}>
          <button aria-current={page === 'trade' ? 'page' : undefined} onClick={() => setPage('trade')}>
            {t.navSwap}
          </button>
          <button aria-current={page === 'swaps' ? 'page' : undefined} onClick={() => setPage('swaps')}>
            {t.navYourSwaps}
            {active > 0 && <span className="count">{active}</span>}
          </button>
          <button aria-current={page === 'help' ? 'page' : undefined} onClick={() => setPage('help')}>
            {t.navHowItWorks}
          </button>
        </nav>
        <div className="top-end">
          <Connections app={app} />
          <LangPicker prefs={prefs} setPrefs={setPrefs} />
          <ThemeToggle prefs={prefs} setPrefs={setPrefs} />
        </div>
      </header>
      <main>
        <Suspense fallback={<p className="lede loading">{t.loading}</p>}>{page === 'trade' ? <Trade app={app} onSwap={() => setPage('swaps')} /> : page === 'swaps' ? <Swaps app={app} /> : <Help app={app} />}</Suspense>
      </main>
    </LangContext.Provider>
  );
}
