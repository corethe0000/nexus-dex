import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AppState } from '../App';
import { connect, discoverWallets, receiveOnly, reconnect, rememberWallet, rememberedWallet, type WalletOption } from '../lib/evm';
import { createSlot, refresh, signIn, slotFeeOn } from '../lib/nexus';
import { findExtension, signInWithExtension } from '../lib/extension';
import { fromUnits, short } from '../lib/format';
import { evmFraction, isStable, useEvmBalance } from './offers';
import QRCode from 'qrcode';
import { connectWalletConnect, disconnectWalletConnect, restoreWalletConnect, walletConnectId } from '../lib/walletconnect';
import { useT } from '../lib/i18n';
import { inWallet } from '../lib/module';
import { acceptTerms } from '../lib/terms';

function useDialog(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && open && !d.open) {
      d.showModal();
    }
    if (d && !open && d.open) {
      d.close();
    }
  }, [open]);
  return ref;
}

export function Connections({ app }: { app: AppState }) {
  const { t, f } = useT();
  const which = app.dialog;
  const setWhich = app.openDialog;
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const tried = useRef(false);
  useEffect(() => discoverWallets(setWallets), []);
  //back after a reload: the wallet (or receive-only address) used last time, without a prompt. Wallets announce
  //themselves right after the page asks; a browser without any wallet still gets its receive-only address back
  const { evm, setEvm } = app;
  const firstChain = Number(Object.keys(app.info.chains)[0] ?? 0);
  useEffect(() => {
    if (tried.current || evm) {
      return;
    }
    const timer = window.setTimeout(
      () => {
        tried.current = true;
        //a phone wallet connected last time comes back from WalletConnect's own session store
        const wc = rememberedWallet() === walletConnectId ? restoreWalletConnect(app.site, app.info).catch(() => null) : Promise.resolve(null);
        void wc.then((w) => reconnect(w ? [...wallets, w] : wallets, firstChain)).then((s) => s && setEvm(s));
      },
      wallets.length ? 0 : 600,
    );
    return () => window.clearTimeout(timer);
  }, [wallets, evm, setEvm, firstChain]);
  //follow the wallet when the user (or the site) switches its chain or account
  const evmRef = useRef(evm);
  evmRef.current = evm;
  const provider = evm?.wallet?.provider;
  useEffect(() => {
    if (!provider) {
      return;
    }
    const onChain = (hex: unknown) => {
      const s = evmRef.current;
      if (s) {
        setEvm({ ...s, chainId: Number(hex) });
      }
    };
    const onAccounts = (list: unknown) => {
      const s = evmRef.current;
      const [address] = (list as string[]) ?? [];
      setEvm(s && address ? { ...s, address: address as typeof s.address } : null);
    };
    provider.on?.('chainChanged', onChain);
    provider.on?.('accountsChanged', onAccounts);
    return () => {
      provider.removeListener?.('chainChanged', onChain);
      provider.removeListener?.('accountsChanged', onAccounts);
    };
  }, [provider, setEvm]);
  const chainName = app.evm ? (app.info.chains[String(app.evm.chainId)]?.name ?? f(t.conChainId, { id: app.evm.chainId })) : '';
  return (
    <div className="connections">
      <button className={`chip chain-nexus${app.nexus ? '' : ' off'}`} onClick={() => setWhich('nexus')}>
        {app.nexus ? f(t.conChipNexus, { name: app.nexus.username }) : t.conSignInNexus}
      </button>
      <button
        className={`chip chain-${app.evm?.chainId ?? ''}${app.evm ? '' : ' off'}${!app.evm && app.prefs.venue === 'nexus' ? ' not-needed' : ''}`}
        title={!app.evm && app.prefs.venue === 'nexus' ? t.conNotNeeded : undefined}
        onClick={() => setWhich('evm')}
      >
        {app.evm ? (app.evm.wallet ? f(t.conChipWallet, { address: short(app.evm.address), chain: chainName }) : f(t.conChipReceive, { address: short(app.evm.address) })) : t.conConnectWallet}
      </button>
      <NexusDialog app={app} open={which === 'nexus'} onClose={() => setWhich(null)} />
      <WalletDialog app={app} wallets={wallets} open={which === 'evm'} onClose={() => setWhich(null)} />
      <TermsDialog open={which === 'terms'} onClose={() => setWhich(null)} />
    </div>
  );
}

function NexusDialog({ app, open, onClose }: { app: AppState; open: boolean; onClose: () => void }) {
  const { t } = useT();
  const ref = useDialog(open);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [hasExtension, setHasExtension] = useState(false);

  useEffect(() => {
    if (open) {
      findExtension().then((p) => setHasExtension(!!p));
    }
  }, [open]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError('');
    setBusy(t.conBusyChecking);
    try {
      const p = await signIn(app.node, String(f.get('username')), String(f.get('password')), String(f.get('pin')));
      app.setNexus(p);
    } catch (x) {
      setError((x as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function withExtension() {
    setError('');
    setBusy(t.conBusyWaitWallet);
    try {
      app.setNexus(await signInWithExtension(app.node, app.net, () => app.setNexus(null)));
    } catch (x) {
      setError((x as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function refreshProfile() {
    if (!app.nexus) {
      return;
    }
    setError('');
    setBusy(t.conBusyReading);
    try {
      await refresh(app.node, app.nexus);
      app.setNexus(app.nexus);
    } catch (x) {
      setError((x as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function setUp() {
    if (!app.nexus) {
      return;
    }
    setError('');
    const viaWallet = app.nexus.via === 'extension';
    setBusy(viaWallet ? t.conBusyApproveSetup : t.conBusySettingUp);
    try {
      const tx = await createSlot(app.nexus, app.net);
      if (viaWallet) {
        setBusy(t.conBusySettingUp);
      }
      await app.node.waitConfirmed(tx);
      await refresh(app.node, app.nexus);
      app.setNexus(app.nexus);
    } catch (x) {
      setError((x as Error).message);
    } finally {
      setBusy('');
    }
  }

  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="nexus-title">
      <h2 id="nexus-title">{t.conNexusTitle}</h2>
      {app.nexus ? (
        <>
          <Profile app={app} busy={!!busy} onRefresh={refreshProfile} />
          {!app.nexus.slotReady && (
            <>
              <p className="problem">{slotFeeOn(app.net) > 0n ? t.conSetupNeededFee : t.conSetupNeeded}</p>
              <button className="btn" onClick={setUp} disabled={!!busy}>
                {t.conSetUp}
              </button>
            </>
          )}
          {busy && <p className="note">{busy}</p>}
          {error && <p className="problem">{error}</p>}
          <div className="row">
            <button className="btn quiet" onClick={() => app.setNexus(null)}>
              {t.conSignOut}
            </button>
            <button className="btn quiet" onClick={onClose}>
              {t.conClose}
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={submit}>
          {hasExtension && (
            <>
              <p className="note" style={{ marginTop: 0 }}>
                {t.conExtensionFound}
              </p>
              <div className="row">
                <button type="button" className="btn" onClick={withExtension} disabled={!!busy}>
                  {t.conUseExtension}
                </button>
              </div>
              <p className="note">{t.conOrSignInHere}</p>
            </>
          )}
          <p className="note" style={hasExtension ? undefined : { marginTop: 0 }}>
            {t.conSignedHereNote}
          </p>
          <label className="field">
            <span>{t.conUsername}</span>
            <input name="username" autoComplete="username" required />
          </label>
          <label className="field">
            <span>{t.conPassword}</span>
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          <label className="field">
            <span>{t.conPin}</span>
            <input name="pin" type="password" inputMode="numeric" autoComplete="off" required />
          </label>
          {error && <p className="problem">{error}</p>}
          {busy && <p className="note">{busy}</p>}
          <div className="row">
            <button type="button" className="btn quiet" onClick={onClose}>
              {t.conCancel}
            </button>
            <button className="btn" disabled={!!busy}>
              {t.conSignIn}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

//who is signed in, what the profile holds, and whether it is ready for swaps
function Profile({ app, busy, onRefresh }: { app: AppState; busy: boolean; onRefresh: () => void }) {
  const { t, p: plural } = useT();
  const p = app.nexus!;
  const [copied, setCopied] = useState(false);
  const nxs = p.accounts.filter((a) => a.token === '0').reduce((sum, a) => sum + a.balance, 0n);
  const running = app.desk.activeCount();
  //empty accounts folded away: test and long-used profiles collect many
  const [all, setAll] = useState(false);
  const empty = p.accounts.filter((a) => a.balance === 0n).length;
  const shown = all ? p.accounts : p.accounts.filter((a) => a.balance > 0n);
  const copy = () => {
    void navigator.clipboard?.writeText(p.genesis).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="profile">
      <div className="profile-head">
        <span className="avatar" aria-hidden="true">
          {p.username.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <b className="profile-name">{p.username}</b>
          <span className="profile-via">{p.via === 'extension' ? t.conViaExtension : t.conViaPage}</span>
        </div>
        <div className="profile-total">
          <b>{fromUnits(nxs, 6, 4)}</b>
          <span>NXS</span>
        </div>
      </div>
      <dl className="profile-facts">
        <div>
          <dt>{t.conProfileId}</dt>
          <dd>
            <code title={p.genesis}>{short(p.genesis)}</code>
            <button type="button" className="link" onClick={copy}>
              {copied ? t.conCopied : t.conCopy}
            </button>
          </dd>
        </div>
        <div>
          <dt>{t.conSwaps}</dt>
          <dd className={p.slotReady ? 'ok-text' : 'alert-text'}>{p.slotReady ? (running ? plural(t.conSwapsReadyRunning, running) : t.conSwapsReady) : t.conSwapsNotSetUp}</dd>
        </div>
      </dl>
      <div className="accounts-head">
        <span>{t.conAccounts}</span>
        <button type="button" className="link" onClick={onRefresh} disabled={busy}>
          {t.conRefresh}
        </button>
      </div>
      {p.accounts.length === 0 ? (
        <p className="note" style={{ marginTop: 4 }}>
          {t.conNoAccounts}
        </p>
      ) : (
        <ul className="accounts">
          {shown.length === 0 && <li className="muted">{t.conAllEmpty}</li>}
          {shown.map((a) => (
            <li key={a.address}>
              <span>
                {a.name ?? t.conAccountUnnamed}
                <code title={a.address}>{short(a.address)}</code>
              </span>
              <b>
                {fromUnits(a.balance, a.decimals)} {a.ticker}
              </b>
            </li>
          ))}
        </ul>
      )}
      {empty > 0 && (
        <button type="button" className="link" style={{ marginTop: 6 }} onClick={() => setAll(!all)}>
          {all ? t.conHideEmpty : plural(t.conShowEmpty, empty)}
        </button>
      )}
      <p className="note">
        {p.via === 'extension'
          ? t.conNoteExtension
          : t.conNotePage}
      </p>
    </div>
  );
}

//the connected address and its tokens on every chain this site trades on
function EvmSummary({ app }: { app: AppState }) {
  const { t: tx, f } = useT();
  const e = app.evm!;
  const tokens = Object.entries(app.info.chains).flatMap(([chainId, c]) => c.tokens.map((t) => ({ chainId, chain: c.name, ...t })));
  return (
    <div className="profile">
      <div className="profile-head">
        <span className="avatar evm" aria-hidden="true">
          {e.wallet ? tx.conAvatarWallet : tx.conAvatarReceive}
        </span>
        <div>
          <b className="profile-name">
            <code title={e.address}>{short(e.address)}</code>
          </b>
          <span className="profile-via">{e.wallet ? `${e.wallet.name}` : tx.conReceiveOnly}</span>
        </div>
      </div>
      <ul className="accounts">
        {tokens.map((t) => (
          <TokenLine key={`${t.chainId}:${t.address}`} app={app} chainId={t.chainId} token={t.address} label={f(tx.conTokenOn, { symbol: t.symbol, chain: t.chain })} decimals={t.decimals} stable={isStable(t)} />
        ))}
      </ul>
    </div>
  );
}

function TokenLine({ app, chainId, token, label, decimals, stable }: { app: AppState; chainId: string; token: `0x${string}`; label: string; decimals: number; stable: boolean }) {
  const bal = useEvmBalance(app, chainId, token);
  return (
    <li className={`chain-${chainId}`}>
      <span className="tag">{label}</span>
      <b>{bal === null ? '...' : fromUnits(bal, decimals, evmFraction(stable, decimals))}</b>
    </li>
  );
}

function WalletDialog({ app, wallets, open, onClose }: { app: AppState; wallets: WalletOption[]; open: boolean; onClose: () => void }) {
  const { t: tx, f, lang } = useT();
  const ref = useDialog(open);
  const [error, setError] = useState('');
  const [address, setAddress] = useState('');
  const coins = new Intl.ListFormat(lang, { type: 'conjunction' }).format(Object.values(app.info.chains).map((c) => c.name));
  const symbols = new Intl.ListFormat(lang, { type: 'disjunction' }).format([...new Set(Object.values(app.info.chains).flatMap((c) => c.tokens.map((t) => t.symbol)))]);
  const [wcUri, setWcUri] = useState<string | null>(null);
  const [wcQr, setWcQr] = useState('');
  const [wcBusy, setWcBusy] = useState(false);

  //a phone wallet: show the pairing link as a QR code until the wallet answers
  async function withWalletConnect() {
    setError('');
    setWcBusy(true);
    try {
      const w = await connectWalletConnect(app.site, app.info, (uri) => {
        setWcUri(uri);
        void QRCode.toDataURL(uri, { margin: 1, width: 240 }).then(setWcQr);
      });
      app.setEvm(await connect(w));
      rememberWallet(w);
      onClose();
    } catch (x) {
      setError((x as Error).message || tx.conPhoneNoConnect);
    } finally {
      setWcBusy(false);
      setWcUri(null);
      setWcQr('');
    }
  }

  function useAddress(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const s = receiveOnly(address.trim(), Number(Object.keys(app.info.chains)[0] ?? 0));
      app.setEvm(s);
      rememberWallet(s);
      setAddress('');
      onClose();
    } catch (x) {
      setError((x as Error).message);
    }
  }

  async function pick(w: WalletOption) {
    setError('');
    try {
      app.setEvm(await connect(w));
      rememberWallet(w);
      onClose();
    } catch (x) {
      setError((x as Error).message);
    }
  }

  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="wallet-title">
      <h2 id="wallet-title">{app.evm ? tx.conWalletTitle : tx.conConnectTitle}</h2>
      {app.evm && <EvmSummary app={app} />}
      <p className="note" style={{ marginTop: 0 }}>
        {app.evm ? tx.conPickAnother : f(tx.conWalletFor, { symbols, chains: coins })}
      </p>
      {wallets.length === 0 ? (
        <p className="note">{inWallet() ? tx.conNoWalletIn : tx.conNoWallet}</p>
      ) : (
        <div className="wallets">
          {wallets.map((w) => (
            <button key={w.id} onClick={() => pick(w)}>
              {w.icon && <img src={w.icon} alt="" />}
              {w.name}
            </button>
          ))}
        </div>
      )}
      {app.site.walletConnectProjectId && (
        <div className="wc">
          {wcUri ? (
            <>
              <p className="note" style={{ marginTop: 0 }}>
                {tx.conScanCode}
              </p>
              {wcQr && <img className="qr" src={wcQr} alt={tx.conQrAlt} width={240} height={240} />}
              <div className="row" style={{ marginTop: 8 }}>
                <a className="btn quiet" href={wcUri}>
                  {tx.conOpenWalletApp}
                </a>
                <button className="btn quiet" type="button" onClick={() => void navigator.clipboard?.writeText(wcUri)}>
                  {tx.conCopyLink}
                </button>
              </div>
            </>
          ) : (
            <button className="wc-btn" type="button" onClick={() => void withWalletConnect()} disabled={wcBusy}>
              <span>{wcBusy ? tx.conStartingWc : tx.conPhoneWallet}</span>
              <small>{tx.conPhoneWalletHint}</small>
            </button>
          )}
        </div>
      )}
      <form className="receive-only" onSubmit={useAddress}>
        <h3>{tx.conOnlySelling}</h3>
        <p className="note">{f(tx.conReceiveText, { symbols, chains: coins })}</p>
        <label className="field">
          <span>{tx.conReceivingAddress}</span>
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x..." spellCheck={false} autoComplete="off" />
        </label>
        <button className="btn" disabled={!address.trim()}>
          {tx.conReceiveHere}
        </button>
      </form>
      {error && <p className="problem">{error}</p>}
      <div className="row">
        {app.evm && (
          <button className="btn quiet" onClick={() => (app.evm?.wallet?.id === walletConnectId && void disconnectWalletConnect(), app.setEvm(null), rememberWallet(null), onClose())}>
            {tx.conDisconnect}
          </button>
        )}
        <button className="btn quiet" onClick={onClose}>
          {tx.conClose}
        </button>
      </div>
    </dialog>
  );
}

//the notice before the first swap (lib/terms.ts): the swap buttons open it until the user agreed once
function TermsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useT();
  const ref = useDialog(open);
  const [agreed, setAgreed] = useState(false);
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="terms-title">
      <h2 id="terms-title">{t.termsTitle}</h2>
      <p>{t.termsIntro}</p>
      <ul className="terms">
        <li>{t.termsP1}</li>
        <li>{t.termsP2}</li>
        <li>{t.termsP3}</li>
        <li>{t.termsP4}</li>
      </ul>
      <label className="check">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} /> {t.termsAgree}
      </label>
      <div className="row">
        <button className="btn quiet" onClick={onClose}>
          {t.conClose}
        </button>
        <button
          className="btn"
          disabled={!agreed}
          onClick={() => {
            acceptTerms();
            onClose();
          }}
        >
          {t.termsContinue}
        </button>
      </div>
    </dialog>
  );
}
