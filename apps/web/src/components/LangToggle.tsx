// The visible language switch in the top bar (user requirement).
//
// - `data-testid="lang-toggle"` is the stable hook for end-to-end checks;
// - the visible text is the *target* language name, taken from the dictionary
//   (`language.en` / `language.zhCN`) — never hardcoded in this component;
// - `aria-label`/`title` describe the action (also dictionary-driven);
// - `document.documentElement.lang` and `localStorage["atk.lang"]` are updated by
//   the provider on every switch (see src/i18n/index.tsx).
import { languageNameKey, nextLanguage } from "../i18n/core.ts";
import { useLang, useT } from "../i18n/index.tsx";

export function LangToggle() {
  const t = useT();
  const { lang, toggleLang } = useLang();
  const target = nextLanguage(lang);
  const targetName = t(languageNameKey(target));
  const label = t("topbar.languageButton", { language: targetName });

  return (
    <button
      type="button"
      className="lang-toggle"
      data-testid="lang-toggle"
      data-lang={lang}
      onClick={toggleLang}
      aria-label={label}
      title={label}
    >
      <svg className="lang-toggle__icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <path
          d="M1.75 8h12.5M8 1.75c1.8 2 2.7 4 2.7 6.25S9.8 12.25 8 14.25C6.2 12.25 5.3 10.25 5.3 8S6.2 3.75 8 1.75Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.1"
        />
      </svg>
      <span className="lang-toggle__label">{targetName}</span>
    </button>
  );
}
