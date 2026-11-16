//the page frame: the network ribbon (always on top, so nobody mistakes testnet for real money or the other way round),
//the logo, the theme and language buttons and the screen for a network that is not live yet
import { useState } from 'react';
import { languages, useT, type Lang, type Texts } from '../lib/i18n';
import type { NetId, Prefs } from '../lib/prefs';

const netText = (t: Texts, net: NetId) => (net === 'mainnet' ? { name: t.netMainnet, text: t.netMainnetText } : { name: t.netTestnet, text: t.netTestnetText });

//two linked rings: both sides of a swap are locked together, either both finish or both come back
export function Knot({ spin = false, size = 28 }: { spin?: boolean; size?: number }) {
  return (
    <svg className={`knot${spin ? ' spin' : ''}`} viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <circle cx="12" cy="16" r="7.5" fill="none" stroke="var(--k1, currentColor)" strokeWidth="3" />
      <circle cx="20" cy="16" r="7.5" fill="none" stroke="var(--k2, var(--nexus))" strokeWidth="3" />
      {/* the first ring passes over the second once: redraw that part on top */}
      <path d="M 16.9 10.4 A 7.5 7.5 0 0 1 19.5 16" fill="none" stroke="var(--k1, currentColor)" strokeWidth="3" />
    </svg>
  );
}

export function Logo() {
  return (
    <div className="wordmark">
      <Knot />
      <span>
        Nexus <b>DEX</b>
      </span>
    </div>
  );
}

//fixed: the network is not a choice here (inside the desktop wallet its core decides)
export function NetBar({ prefs, setPrefs, running, fixed = false }: { prefs: Prefs; setPrefs: (p: Partial<Prefs>) => void; running: number; fixed?: boolean }) {
  const { t: tx, p } = useT();
  const [asking, setAsking] = useState<NetId | null>(null);
  const t = netText(tx, prefs.net);
  const go = (net: NetId) => {
    if (net === prefs.net) {
      return;
    }
    if (running > 0 && asking !== net) {
      setAsking(net);
      return;
    }
    setPrefs({ net });
  };
  return (
    <div className="netbar" data-net={prefs.net} role="region" aria-label={tx.netRegion}>
      <div className="netbar-in">
        <span className="netbar-name">{t.name}</span>
        <span className="netbar-text">{t.text}</span>
        {asking ? (
          <span className="netbar-ask" role="alert">
            {p(tx.netSwitchRunning, running, { net: t.name, other: netText(tx, asking).name })}
            <button onClick={() => setPrefs({ net: asking })}>{tx.netSwitchAnyway}</button>
            <button onClick={() => setAsking(null)}>{tx.netStay}</button>
          </span>
        ) : fixed ? null : (
          <div className="netswitch" role="group" aria-label={tx.netChoose}>
            {(['mainnet', 'testnet'] as const).map((n) => (
              <button key={n} aria-pressed={prefs.net === n} onClick={() => go(n)}>
                {netText(tx, n).name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ThemeToggle({ prefs, setPrefs }: { prefs: Prefs; setPrefs: (p: Partial<Prefs>) => void }) {
  const { t } = useT();
  const dark = prefs.theme === 'dark';
  return (
    <button className="icon-btn" onClick={() => setPrefs({ theme: dark ? 'light' : 'dark' })} aria-label={dark ? t.themeUseLight : t.themeUseDark} title={dark ? t.themeLight : t.themeDark}>
      {dark ? (
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="12" cy="12" r="4.5" fill="currentColor" />
          {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
            <line key={a} x1="12" y1="2.5" x2="12" y2="5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" transform={`rotate(${a} 12 12)`} />
          ))}
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" fill="currentColor" />
        </svg>
      )}
    </button>
  );
}

//the page language: a native list, so it works with a keyboard and on phones; the button shows the language code
export function LangPicker({ prefs, setPrefs }: { prefs: Prefs; setPrefs: (p: Partial<Prefs>) => void }) {
  const { t } = useT();
  return (
    <label className="lang-pick" title={t.language}>
      <span aria-hidden="true">{prefs.lang.toUpperCase()}</span>
      <select aria-label={t.language} value={prefs.lang} onChange={(e) => setPrefs({ lang: e.target.value as Lang })}>
        {Object.entries(languages).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
    </label>
  );
}

export function NotLive({ net, onSwitch }: { net: NetId; onSwitch?: () => void }) {
  const { t, f } = useT();
  const other = net === 'mainnet' ? 'testnet' : 'mainnet';
  return (
    <div className="blank">
      <Knot size={56} />
      <h1>{net === 'mainnet' ? t.mainnetSoon : t.testnetMissing}</h1>
      <p className="lede">{net === 'mainnet' ? t.mainnetSoonText : t.testnetMissingText}</p>
      {onSwitch && (
        <button className="btn" style={{ width: 'auto', paddingInline: 22 }} onClick={onSwitch}>
          {f(t.switchTo, { net: netText(t, other).name })}
        </button>
      )}
    </div>
  );
}
