import { useState } from 'react';
import type { AppState } from '../App';
import { useT } from '../lib/i18n';
import { offerLink } from '../lib/link';

//"Copy link" for one of my offers. Without a clipboard (plain http on a LAN address) the link shows selected, to copy
//by hand
export function ShareLink({ app, id }: { app: AppState; id: string }) {
  const { t } = useT();
  const [state, setState] = useState<'idle' | 'copied' | 'show'>('idle');
  const link = offerLink(app.prefs.net, id);
  function copy() {
    if (!navigator.clipboard) {
      setState('show');
      return;
    }
    navigator.clipboard.writeText(link).then(
      () => {
        setState('copied');
        window.setTimeout(() => setState('idle'), 2000);
      },
      () => setState('show'),
    );
  }
  if (state === 'show') {
    return <input className="share-link" readOnly value={link} aria-label={t.trOfferLink} onFocus={(e) => e.currentTarget.select()} autoFocus />;
  }
  return (
    <button type="button" className="btn quiet small" onClick={copy} aria-live="polite">
      {state === 'copied' ? t.trLinkCopied : t.trCopyLink}
    </button>
  );
}
