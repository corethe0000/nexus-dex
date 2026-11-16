import { useEffect, useState } from 'react';
import { offerFromJson } from '@nexus-dex/core/src/book/offer';
import type { SwapTx } from '@nexus-dex/core/src/swap/runner';
import type { AppState } from '../App';
import { tokenOf } from '../lib/config';
import type { StoredSwap, WalletWait } from '../lib/desk';
import { discoverWallets, gasCoinOf, type WalletOption } from '../lib/evm';
import { clock, fromUnits, short, span } from '../lib/format';
import { downloadCsv, swapsCsv } from '../lib/history-csv';
import { useT, type Texts, type Tr } from '../lib/i18n';
import { inWallet } from '../lib/module';
import { evmAmount } from './offers';

export function Swaps({ app }: { app: AppState }) {
  const { t } = useT();
  const swaps = app.desk.swaps();
  const [, setNow] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setNow((n) => n + 1), 5000);
    return () => window.clearInterval(t);
  }, []);
  //names and decimals of the Nexus tokens in these swaps (after a reload nothing else has read them yet)
  const tokenList = [...new Set(swaps.map((s) => s.offer.offer.nexusToken))].join(',');
  useEffect(() => {
    void Promise.all(tokenList.split(',').filter(Boolean).map((t) => app.tokens.ready(t))).then(() => setNow((n) => n + 1));
  }, [tokenList, app.tokens]);
  const running = swaps.filter((s) => s.stage === 'asking' || s.stage === 'running');
  const history = swaps.filter((s) => s.stage !== 'asking' && s.stage !== 'running');
  return (
    <>
      <h1>{t.swTitle}</h1>
      <p className="lede">{inWallet() ? t.swLedeIn : t.swLede}</p>
      {swaps.length === 0 && (
        <div className="panel empty">
          <strong>{t.swEmpty}</strong>
          {t.swEmptyText}
        </div>
      )}
      {running.length > 0 && (
        <section aria-labelledby="running-title">
          <h2 id="running-title" className="section-title">
            {t.swRunning} <span>{running.length}</span>
          </h2>
          <div className="swaps">
            {running.map((s) => (
              <SwapCard key={s.id} app={app} s={s} />
            ))}
          </div>
        </section>
      )}
      {history.length > 0 && (
        <section aria-labelledby="history-title">
          <h2 id="history-title" className="section-title">
            {t.swHistory} <span>{history.length}</span>
            <button type="button" className="btn quiet small section-act" onClick={() => downloadCsv(`nexus-dex-swaps-${app.prefs.net}-${new Date().toISOString().slice(0, 10)}.csv`, swapsCsv(app, history))}>
              {t.swDownloadCsv}
            </button>
          </h2>
          <div className="history">
            {history.map((s) => (
              <HistoryRow key={s.id} app={app} s={s} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

//a finished swap in one line; opens to the full card with its time line and steps
function HistoryRow({ app, s }: { app: AppState; s: StoredSwap }) {
  const tr = useT();
  const { t, f } = tr;
  const a = amounts(app, s, tr);
  const takerGivesNexus = s.rec.initiatorChain === 'nexus';
  const iGiveNexus = s.role === 'initiator' ? takerGivesNexus : !takerGivesNexus;
  const h = headline(s, tr);
  const when = new Date(s.createdAt * 1000);
  return (
    <details className="history-row">
      <summary>
        <time dateTime={when.toISOString()}>{when.toLocaleDateString(tr.lang, { day: 'numeric', month: 'short' })} {clock(s.createdAt)}</time>
        <span className="history-what">{f(iGiveNexus ? t.swSold : t.swBought, { nexus: a.nexusText, evm: a.evmText })}</span>
        <span className={`tag chain-${a.chainId}`}>{a.chainName}</span>
        <span className={`state ${h.cls}`}>{h.text}</span>
      </summary>
      <SwapCard app={app} s={s} />
    </details>
  );
}

interface Amounts {
  nexusText: string;
  evmText: string;
  chainName: string;
  chainId: string;
}

function amounts(app: AppState, s: StoredSwap, { t, f }: Tr): Amounts {
  const o = offerFromJson(s.offer.offer);
  const nt = app.tokens.get(o.nexusToken);
  const et = tokenOf(app.info, s.offer.offer.evmChainId, o.evmToken);
  return {
    nexusText: nt ? `${fromUnits(o.nexusAmount, nt.decimals)} ${nt.ticker}` : f(t.swUnits, { amount: String(o.nexusAmount) }),
    evmText: et ? `${evmAmount(o.evmAmount, et)} ${et.symbol}` : f(t.swUnits, { amount: String(o.evmAmount) }),
    chainName: app.info.chains[s.offer.offer.evmChainId]?.name ?? s.offer.offer.evmChainId,
    chainId: s.offer.offer.evmChainId,
  };
}

function headline(s: StoredSwap, { t, f }: Tr): { text: string; cls: string } {
  if (s.stage === 'asking') {
    return { text: t.swStateAsking, cls: '' };
  }
  if (s.stage === 'lapsed') {
    return { text: t.swStateLapsed, cls: 'lapsed' };
  }
  if (s.rec.done) {
    const r = s.rec.done.result;
    return { text: r === 'swapped' ? t.swStateSwapped : r === 'refunded' ? t.swStateRefunded : t.swStateLost, cls: r };
  }
  if (s.rec.aborted) {
    //the reason is the engine's own English text
    return { text: f(t.swStateStopped, { reason: s.rec.aborted }), cls: 'lapsed' };
  }
  if (s.paused) {
    //made in lib/desk.ts
    return { text: s.paused, cls: 'paused' };
  }
  return { text: t.swStateInProgress, cls: '' };
}

function SwapCard({ app, s }: { app: AppState; s: StoredSwap }) {
  const tr = useT();
  const { t, f } = tr;
  const a = amounts(app, s, tr);
  const takerGivesNexus = s.rec.initiatorChain === 'nexus';
  const iGiveNexus = s.role === 'initiator' ? takerGivesNexus : !takerGivesNexus;
  const h = headline(s, tr);
  return (
    <article className="panel swap" aria-label={f(t.swCardLabel, { id: s.id.slice(0, 10) })}>
      <div className="swap-head">
        <h2>{f(t.swPair, { pay: iGiveNexus ? a.nexusText : a.evmText, get: iGiveNexus ? a.evmText : a.nexusText })}</h2>
        <span className="tag">{s.role === 'initiator' ? t.swRoleTook : t.swRoleTaken}</span>
        <span className={`state ${h.cls}`}>{h.text}</span>
      </div>
      <Progress app={app} s={s} a={a} wait={app.desk.waitingFor(s.id)} />
      {s.stage === 'running' && s.last?.action === 'error' && !app.desk.collectHelp(s) && (
        <p className="problem" style={{ marginTop: 12 }}>
          {f(t.swLastFailed, { reason: noDot(s.last.reason) })}
        </p>
      )}
      <CollectMyself app={app} s={s} a={a} />
      <CollectTo app={app} s={s} a={a} />
      <Txs app={app} s={s} a={a} />
      {app.desk.canStop(s) && (
        <button className="btn quiet" style={{ width: 'auto', marginTop: 12, padding: '8px 14px' }} onClick={() => app.desk.stopSwap(s.id)}>
          {t.swStop}
        </button>
      )}
    </article>
  );
}

const txWhat = (t: Texts): Record<SwapTx['kind'], string> => ({ lock: t.swTxLock, reveal: t.swTxReveal, claim: t.swTxClaim, refund: t.swTxRefund });

//every transaction of the swap, with a link to the chain's explorer where there is one
function Txs({ app, s, a }: { app: AppState; s: StoredSwap; a: Amounts }) {
  const { t: tx, f } = useT();
  const txs = s.rec.txs ?? [];
  if (txs.length === 0) {
    return null;
  }
  const url = (t: SwapTx) => {
    if (t.chain === 'nexus') {
      return app.site.nexusExplorer ? `${app.site.nexusExplorer}/scan/${t.hash}` : null;
    }
    const base = app.site.explorers[a.chainId];
    return base ? `${base.replace(/\/$/, '')}/tx/${t.hash}` : null;
  };
  const what = txWhat(tx);
  return (
    <details className="txs">
      <summary>{f(tx.swTxs, { n: txs.length })}</summary>
      <ul>
        {txs.map((t) => {
          const href = url(t);
          const line = t.by === 'me' ? tx.swTxMine : t.by === 'them' ? tx.swTxTheirs : tx.swTxService;
          return (
            <li key={t.hash}>
              <span>{f(line, { what: what[t.kind], chain: t.chain === 'nexus' ? 'Nexus' : a.chainName })}</span>
              {href ? (
                <a href={href} target="_blank" rel="noreferrer" className="mono">
                  {short(t.hash)}
                </a>
              ) : (
                <button type="button" className="link mono" title={tx.swTxCopy} onClick={() => void navigator.clipboard?.writeText(t.hash)}>
                  {short(t.hash)}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

//error texts end in a period of their own; a sentence around them adds its own
const noDot = (t = '') => t.replace(/\.\s*$/, '');

//receive only, when the service has not collected the payment: any wallet in this browser can send the collect (it
//pays only the receiving address); the user pays that one fee
function CollectMyself({ app, s, a }: { app: AppState; s: StoredSwap; a: Amounts }) {
  const { t, f } = useT();
  const help = app.desk.collectHelp(s);
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => (help ? discoverWallets(setWallets) : undefined), [help !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!help) {
    return null;
  }
  const receiver = s.role === 'initiator' ? s.take.taker : s.offer.offer.maker;
  async function pick(w: WalletOption) {
    setBusy(true);
    setError('');
    try {
      await app.desk.collectWith(s.id, w);
    } catch (e) {
      //the wallet's or the desk's own text
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  //the reason is an error text from the engine or the chain, in English
  const text = f(help.reason ? t.swCollectTextWhy : t.swCollectText, {
    amount: a.evmText,
    reason: noDot(help.reason),
    gas: gasCoinOf(a.chainId),
    chain: a.chainName,
    address: short(receiver),
  });
  return (
    <div className="collect-myself" role="alert">
      <h3>{t.swCollectTitle}</h3>
      <p>
        {text}
        {help.deadline ? ` ${f(t.swCollectBefore, { time: clock(help.deadline) })}` : ''}
      </p>
      {wallets.length === 0 ? (
        <p className="note">{inWallet() ? t.swNoWalletIn : t.swNoWallet}</p>
      ) : (
        <div className="row">
          {wallets.map((w) => (
            <button key={w.id} className="btn" style={{ width: 'auto' }} disabled={busy} onClick={() => pick(w)}>
              {f(t.swCollectWith, { wallet: w.name })}
            </button>
          ))}
        </div>
      )}
      {error && <p className="problem">{error}</p>}
    </div>
  );
}

//the collect to my own address fails or hangs (a token that froze it refuses the payment): my wallet for that address
//can have the payment sent to another address of mine (NexusSwap claimTo)
function CollectTo({ app, s, a }: { app: AppState; s: StoredSwap; a: Amounts }) {
  const { t, f } = useT();
  const option = app.desk.collectToOption(s);
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  if (!option && !sent) {
    return null;
  }
  async function send() {
    setBusy(true);
    setError('');
    try {
      await app.desk.collectTo(s.id, to);
      setSent(true);
    } catch (e) {
      //the wallet's or the desk's own text
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (sent) {
    return <p className="note">{f(t.swToSent, { chain: a.chainName })}</p>;
  }
  return (
    <details className="collect-to">
      <summary>{t.swToTitle}</summary>
      <p>
        {f(t.swToText, { amount: a.evmText, address: short(option!.recipient) })}
        {option!.deadline ? ` ${f(t.swCollectBefore, { time: clock(option!.deadline) })}` : ''}
      </p>
      <label className="field">
        <span>{f(t.swToLabel, { chain: a.chainName })}</span>
        <input className="mono" value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x..." spellCheck={false} autoComplete="off" disabled={busy} />
      </label>
      <button type="button" className="btn" style={{ width: 'auto' }} disabled={busy || !to.trim()} onClick={() => void send()}>
        {t.swToSend}
      </button>
      {error && <p className="problem">{error}</p>}
    </details>
  );
}

//the engine's wait reasons (core/src/swap/engine.ts, runner.ts) in the user's words, each a whole sentence
const plainReasons: [RegExp, (t: Texts) => string][] = [
  [/^own lock not final yet|^own lock not on chain yet/, (t) => t.swWaitOwnLock],
  [/^own claim not final yet|^own claim not on chain yet|^own reveal not on chain yet/, (t) => t.swWaitOwnCollect],
  [/^refund not final yet|^own refund not on chain yet/, (t) => t.swWaitOwnRefund],
  [/^participant lock not final yet|^initiator lock not final yet/, (t) => t.swWaitOtherLockFinal],
  [/^waiting for the participant to lock/, (t) => t.swWaitOtherLock],
  [/^waiting for the initiator to claim/, (t) => t.swWaitOtherCollect],
  [/^reading the secret/, (t) => t.swWaitReadKey],
  [/^too late to claim/, (t) => t.swWaitTooLate],
  [/^participant lock not usable/, (t) => t.swWaitLockWrong],
];

//a reason without words of our own is shown as the engine wrote it (English), made into a sentence
function plain(reason: string, t: Texts): string {
  const known = plainReasons.find(([re]) => re.test(reason));
  return known ? known[1](t) : cap(reason) + '.';
}

//a wallet step the page waits for: the wallet's window may be behind others, and the Nexus Wallet locks itself
//after some idle minutes (always the case for a refund), so say where to look
const walletStep = (t: Texts): Record<string, string> => ({
  createSlot: t.swStepCreateSlot,
  lock: t.swStepLock,
  reveal: t.swStepReveal,
  claim: t.swStepClaim,
  claimTo: t.swStepClaim,
  refund: t.swStepRefund,
  approve: t.swStepApprove,
});

function waitText(w: WalletWait, { t, f }: Tr): string {
  const what = walletStep(t)[w.step] ?? w.step;
  return f(w.wallet === 'nexus' ? t.swApproveNexus : t.swConfirmWallet, { what });
}

interface Coin {
  text: string;
  chain: string;
  cls: string;
}

interface FlowStep {
  mine: boolean;
  kind: 'lock' | 'get' | 'back';
  coin: Coin;
  done: boolean;
}

//the swap as four steps on one line, in the order they happen: the taker locks, the maker locks, the taker receives,
//the maker receives. Above it one sentence says where the swap is; below it, while the user's own coins are locked,
//when they come back if the other side stops.
function Progress({ app, s, a, wait }: { app: AppState; s: StoredSwap; a: Amounts; wait?: WalletWait }) {
  const tr = useT();
  const { t, f } = tr;
  const seen = s.rec.seen;
  const initIsNexus = s.rec.initiatorChain === 'nexus';
  const initLock = seen ? (initIsNexus ? seen.nexus : seen.evm) : null;
  const partLock = seen ? (initIsNexus ? seen.evm : seen.nexus) : null;
  const locked = (l: typeof initLock) => !!l && l.status !== 'none' && l.status !== 'pending';
  const nexusCoin: Coin = { text: a.nexusText, chain: 'Nexus', cls: 'chain-nexus' };
  const evmCoin: Coin = { text: a.evmText, chain: a.chainName, cls: `chain-${a.chainId}` };
  const takerCoin = initIsNexus ? nexusCoin : evmCoin;
  const makerCoin = initIsNexus ? evmCoin : nexusCoin;
  const me = s.role === 'initiator';
  const myPay = me ? takerCoin : makerCoin;
  const myGet = me ? makerCoin : takerCoin;
  const myLock = me ? initLock : partLock;
  const result = s.rec.done?.result;

  let steps: FlowStep[] = [
    { mine: me, kind: 'lock', coin: takerCoin, done: locked(initLock) },
    { mine: !me, kind: 'lock', coin: makerCoin, done: locked(partLock) },
    { mine: me, kind: 'get', coin: makerCoin, done: partLock?.status === 'claimed' || (result === 'swapped' && me) },
    //once the taker has its coins the maker holds the key to its own: the swap is through for both
    { mine: !me, kind: 'get', coin: takerCoin, done: initLock?.status === 'claimed' || result === 'swapped' },
  ];
  if (result === 'refunded') {
    steps = [...steps.slice(0, 2).filter((x) => x.done || x.mine), { mine: true, kind: 'back', coin: myPay, done: true }];
  }
  const running = s.stage === 'running' && !result && !s.rec.aborted;
  const current = running ? steps.findIndex((x) => !x.done) : -1;

  //the one sentence on top
  let status: { text: string; cls: string };
  if (s.stage === 'asking') {
    status = { text: t.swStatusAsking, cls: '' };
  } else if (s.stage === 'lapsed') {
    status = { text: t.swStatusLapsed, cls: 'muted' };
  } else if (result === 'swapped') {
    status = { text: f(t.swStatusSwapped, { amount: myGet.text, chain: myGet.chain }), cls: 'ok' };
  } else if (result === 'refunded') {
    status = { text: f(t.swStatusRefunded, { amount: myPay.text }), cls: 'back' };
  } else if (result) {
    status = { text: f(t.swStatusLost, { amount: myPay.text }), cls: 'bad' };
  } else if (s.rec.aborted) {
    //the reason is the engine's own English text
    status = { text: f(t.swStatusStopped, { reason: noDot(s.rec.aborted) }), cls: 'muted' };
  } else if (s.paused) {
    //made in lib/desk.ts
    status = { text: s.paused, cls: 'bad' };
  } else if (wait) {
    status = { text: waitText(wait, tr), cls: 'act wallet-wait' };
  } else {
    const step = steps[current];
    const lockOf = (x: FlowStep) => (x.coin === takerCoin ? initLock : partLock);
    let fallback = t.swStatusWorking;
    if (step?.kind === 'lock') {
      if (!step.mine) {
        fallback = f(t.swStatusTheirLock, { amount: step.coin.text });
      } else if (lockOf(step)?.status === 'pending') {
        fallback = f(t.swStatusLockSent, { chain: step.coin.chain });
      } else {
        fallback = f(t.swStatusLocking, { amount: step.coin.text });
      }
    } else if (step?.kind === 'get') {
      fallback = f(step.mine ? t.swStatusCollecting : t.swStatusTheirCollect, { amount: step.coin.text });
    }
    status = { text: s.last?.action === 'wait' && s.last.reason ? plain(s.last.reason, t) : fallback, cls: '' };
  }

  //while my coins sit in a lock and the swap is not through: when they come back if the other side stops
  const safeBy = running && locked(myLock) && myLock?.status !== 'claimed' && myLock?.status !== 'claiming' ? myLock?.deadline : undefined;
  const nowChain = seen ? Math.max(seen.evmNow, seen.nexusNow) : Math.floor(Date.now() / 1000);

  return (
    <div className="progress">
      <p className={`progress-status ${status.cls}`} role="status">
        {status.text}
        {wait && <time> {span(Date.now() / 1000 - wait.since / 1000)}</time>}
      </p>
      {s.stage !== 'asking' && s.stage !== 'lapsed' && !s.rec.aborted && (
        <ol className={`flow steps-${steps.length}`}>
          {steps.map((x, i) => {
            const state = x.done ? 'done' : i === current ? 'now' : 'todo';
            return (
              <li key={`${x.kind}-${x.mine}`} className={`${state} ${x.kind === 'back' ? 'back' : x.coin.cls}`}>
                <span className="dot" aria-hidden>
                  {x.done ? <Check /> : x.kind === 'lock' ? <Padlock /> : i + 1}
                </span>
                <span className="flow-who">{stepVerb(x, t)}</span>
                <span className="flow-what">{x.coin.text}</span>
                <span className="flow-where">{f(t.swOnChain, { chain: x.coin.chain })}</span>
              </li>
            );
          })}
        </ol>
      )}
      {safeBy !== undefined && (
        <p className="safe">
          <Padlock />{' '}
          {safeBy > nowChain
            ? f(t.swSafeAfter, { amount: myPay.text, time: clock(safeBy), wait: span(safeBy - nowChain) })
            : f(t.swSafeNow, { amount: myPay.text })}
        </p>
      )}
    </div>
  );
}

function stepVerb(x: FlowStep, t: Texts): string {
  if (x.kind === 'back') {
    return t.swBackToYou;
  }
  if (x.kind === 'lock') {
    return x.done ? (x.mine ? t.swYouLocked : t.swTheyLocked) : x.mine ? t.swYouLock : t.swTheyLock;
  }
  return x.done ? (x.mine ? t.swYouReceived : t.swTheyReceived) : x.mine ? t.swYouReceive : t.swTheyReceive;
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

function Check() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Padlock() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden className="padlock">
      <rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor" />
      <path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}
