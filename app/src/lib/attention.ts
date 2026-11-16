//a swap runs in this page and sometimes needs the user (a wallet window to approve, a collect to send): make sure they
//notice even in another tab. The tab title says "Action needed"; when the tab is hidden a desktop notification says
//what happened (only if the user allowed notifications, asked when they start a swap or post an offer); closing the
//page while a swap runs or an offer is up asks first.
import { useEffect, useRef } from 'react';
import type { Desk, StoredSwap } from './desk';
import { T } from './i18n';
import type { NetId } from './prefs';

let leaving = false;

//a planned reload (network switch) the user already confirmed
export function allowLeave() {
  leaving = true;
}

//asked from a click (browsers only show the prompt then); a "no" is kept by the browser and never asked again
export function askToNotify() {
  try {
    if ('Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  } catch {
    //no notifications in this browser
  }
}

function notify(title: string, body: string) {
  try {
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(title, { body, tag: 'nexus-dex' });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    }
  } catch {
    //some browsers only notify from a service worker: the tab title still says it
  }
}

//what a swap's state means for the user, for comparing between renders
function phase(s: StoredSwap): string {
  if (s.rec.done) {
    return `done:${s.rec.done.result}`;
  }
  if (s.rec.aborted) {
    return 'stopped';
  }
  return s.stage;
}

export function useAttention(desk: Desk | null, net: NetId, version: number) {
  const seen = useRef(new Map<string, string>());
  const waiting = useRef(new Set<string>());
  //App sets the language before it calls this hook, so a language change re-titles the tab right away
  const lang = T().lang;

  useEffect(() => {
    const { t, f } = T();
    const base = net === 'testnet' ? f(t.swTabTestnet, { title: 'Nexus DEX' }) : 'Nexus DEX';
    if (!desk) {
      document.title = base;
      return;
    }
    const swaps = desk.swaps();
    const need = swaps.filter((s) => desk.waitingFor(s.id) || desk.collectHelp(s));
    document.title = need.length ? f(t.swTabAction, { title: base }) : base;
    for (const s of swaps) {
      const now = phase(s);
      const before = seen.current.get(s.id);
      seen.current.set(s.id, now);
      if (before !== undefined && before !== now) {
        if (now === 'done:swapped') {
          notify(t.swNoteSwapped, t.swNoteSwappedText);
        } else if (now === 'done:refunded') {
          notify(t.swNoteRefunded, t.swNoteRefundedText);
        } else if (now === 'running' && before === 'asking') {
          notify(t.swNoteAccepted, t.swNoteAcceptedText);
        }
      }
      const w = desk.waitingFor(s.id);
      if (w && !waiting.current.has(s.id)) {
        notify(t.swNoteWallet, w.wallet === 'nexus' ? t.swNoteWalletNexus : t.swNoteWalletOther);
      }
      if (w) {
        waiting.current.add(s.id);
      } else {
        waiting.current.delete(s.id);
      }
    }
  }, [desk, net, version, lang]);

  //leaving while a swap runs or an offer is up: the browser asks first
  useEffect(() => {
    if (!desk) {
      return;
    }
    const guard = (e: BeforeUnloadEvent) => {
      const now = Math.floor(Date.now() / 1000);
      if (!leaving && (desk.activeCount() > 0 || desk.myOffers().some((o) => Number(o.offer.expires) > now))) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [desk]);
}
