// Settings: language selection (a second, explicit switch in addition to the
// top-bar toggle) and read-only client information. The rest is a placeholder.
import { API_BASE, EVENT_STREAM_PATH } from "../api/client.ts";
import { SectionHeader } from "../components/StateViews.tsx";
import { LANGS, languageNameKey } from "../i18n/core.ts";
import { useLang, useT } from "../i18n/index.tsx";

export function SettingsPage() {
  const t = useT();
  const { lang, setLang } = useLang();

  return (
    <section className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">{t("settings.title")}</h1>
        </div>
      </header>

      <section className="card">
        <SectionHeader title={t("settings.languageTitle")} />
        <fieldset className="language-choices">
          <legend className="sr-only">{t("settings.languageTitle")}</legend>
          {LANGS.map((option) => (
            <label key={option} className={option === lang ? "language-choice is-active" : "language-choice"}>
              <input type="radio" name="language" value={option} checked={option === lang} onChange={() => setLang(option)} />
              <span className="language-choice__name">{t(languageNameKey(option))}</span>
              <span className="language-choice__code mono">{option}</span>
            </label>
          ))}
        </fieldset>
        <p className="muted">{t("settings.languageHint")}</p>
      </section>

      <section className="card">
        <SectionHeader title={t("settings.clientsTitle")} />
        <dl className="kv">
          <div className="kv__row">
            <dt>{t("settings.apiBase")}</dt>
            <dd className="mono">{API_BASE}</dd>
          </div>
          <div className="kv__row">
            <dt>{t("settings.streamEndpoint")}</dt>
            <dd className="mono">{`${API_BASE}${EVENT_STREAM_PATH}`}</dd>
          </div>
        </dl>
      </section>

      <section className="card">
        <SectionHeader title={t("settings.placeholderTitle")} />
        <p className="muted">{t("settings.placeholderHint")}</p>
      </section>
    </section>
  );
}
