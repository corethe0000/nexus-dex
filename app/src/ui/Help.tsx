//how a swap works and what keeps the coins safe, in plain words; deadlines and contract addresses come from the
//service of the network in use, so the page always says what really applies
import type { AppState } from '../App';
import { short, span } from '../lib/format';
import { useT } from '../lib/i18n';

export function Help({ app }: { app: AppState }) {
  const { t, f } = useT();
  const tm = app.info.timing;
  const chains = Object.entries(app.info.chains);
  const mainnet = app.prefs.net === 'mainnet';
  return (
    <div className="help">
      <h1>{t.helpTitle}</h1>
      <p className="lede">{t.helpLede}</p>

      <section className="panel help-part">
        <h2>{t.helpStepsTitle}</h2>
        <ol className="help-steps">
          <li>
            <b>{t.helpStep1Title}</b> {f(t.helpStep1Text, { deadline: span(tm.initiatorLock) })}
          </li>
          <li>
            <b>{t.helpStep2Title}</b> {f(t.helpStep2Text, { most: span(tm.participantLock) })}
          </li>
          <li>
            <b>{t.helpStep3Title}</b> {t.helpStep3Text}
          </li>
          <li>
            <b>{t.helpStep4Title}</b> {f(t.helpStep4Text, { safety: span(tm.safety) })}
          </li>
        </ol>
        <p className="help-note">{t.helpRoles}</p>
      </section>

      <section className="panel help-part">
        <h2>{t.helpCasesTitle}</h2>
        <dl className="help-cases">
          <dt>{t.helpSwapped}</dt>
          <dd>{t.helpSwappedText}</dd>
          <dt>{t.helpRefunded}</dt>
          <dd>{t.helpRefundedText}</dd>
          <dt>{t.helpStopped}</dt>
          <dd>{t.helpStoppedText}</dd>
        </dl>
      </section>

      <section className="panel help-part">
        <h2>{t.helpSafeTitle}</h2>
        <ul className="help-list">
          <li>{t.helpSafe1}</li>
          <li>{t.helpSafe2}</li>
          <li>{t.helpSafe3}</li>
          <li>{f(t.helpSafe4, { chains: chains.map(([, c]) => c.name).join(', ') })}</li>
          <li>{t.helpSafe5}</li>
        </ul>
      </section>

      <section className="panel help-part">
        <h2>{t.helpYouTitle}</h2>
        <ul className="help-list">
          <li>{f(t.helpYou1, { most: span(tm.participantLock) })}</li>
          <li>{t.helpYou2}</li>
          <li>{t.helpYou3}</li>
          <li>{t.helpYou4}</li>
          {!mainnet && <li>{t.helpYouTestnet}</li>}
          <li>{t.helpYou5}</li>
        </ul>
      </section>

      <section className="panel help-part">
        <h2>{t.helpTokensTitle}</h2>
        <p className="help-note">{t.helpTokensText}</p>
      </section>

      <section className="panel help-part">
        <h2>{t.helpCheckTitle}</h2>
        <ul className="help-list contracts">
          {chains.map(([id, c]) => {
            const base = app.site.explorers[id];
            return (
              <li key={id}>
                {f(t.helpContractOn, { chain: c.name })}{' '}
                {base ? (
                  <a href={`${base.replace(/\/$/, '')}/address/${c.swap}`} target="_blank" rel="noreferrer">
                    {short(c.swap)}
                  </a>
                ) : (
                  <code>{short(c.swap)}</code>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
