//what the user picked for this browser: theme, simple or advanced trading, mainnet or testnet, language. Defaults:
//light, simple, mainnet, the browser's language. Storage can be blocked (private windows): then the defaults hold and nothing breaks.
import { defaultLang, isLang, type Lang } from './i18n';
import { inWallet } from './module';

export type Theme = 'light' | 'dark';
export type Mode = 'simple' | 'advanced';
export type NetId = 'mainnet' | 'testnet';
//stable = NXS against USDT / USDC on other chains (atomic swaps); nexus = Nexus coins on the Nexus market
export type Venue = 'stable' | 'nexus';

export interface Prefs {
  theme: Theme;
  mode: Mode;
  net: NetId;
  venue: Venue;
  lang: Lang;
}

const key = 'nexus-dex:prefs';
export const defaultPrefs = (): Prefs => ({ theme: 'light', mode: 'simple', net: 'mainnet', venue: 'stable', lang: defaultLang() });

export function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(key) ?? '{}') as Partial<Prefs>;
    return {
      //inside the Nexus desktop wallet the page starts dark, like the wallet around it
      theme: p.theme === 'dark' || p.theme === 'light' ? p.theme : inWallet() ? 'dark' : 'light',
      mode: p.mode === 'advanced' ? 'advanced' : 'simple',
      net: p.net === 'testnet' ? 'testnet' : 'mainnet',
      venue: p.venue === 'nexus' ? 'nexus' : 'stable',
      lang: isLang(p.lang) ? p.lang : defaultLang(),
    };
  } catch {
    return defaultPrefs();
  }
}

export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(key, JSON.stringify(p));
  } catch {
    //storage blocked: the choice lasts until the page reloads
  }
}

//theme and network show on the root element, so the whole page (and its frame) follows them; the tab title is set
//by lib/attention.ts (network and "Action needed")
export function applyPrefs(p: Prefs) {
  const root = document.documentElement;
  root.dataset.theme = p.theme;
  root.dataset.net = p.net;
  root.lang = p.lang;
}
