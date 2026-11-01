// React binding for the dictionary layer. All dictionary logic lives in
// ./core.ts so it stays testable without a DOM; this file only wires React
// context, `localStorage` persistence and `<html lang>`.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { en, type MessageKey } from "./en.ts";
import { zhCN } from "./zh-CN.ts";
import {
  applyDocumentLanguage,
  isLang,
  pickInitialLanguage,
  readStoredLanguage,
  resolveLanguage,
  translate,
  writeStoredLanguage,
  type Dict,
  type Lang,
  type LangStorage,
  type TranslateParams,
} from "./core.ts";

/** Both dictionaries, addressable by locale. */
export const DICTIONARIES: Record<Lang, Dict> = { en, "zh-CN": zhCN };

/** `t()` accepts a known key (autocompleted) or a runtime-built key. */
export type TFunction = (key: MessageKey | (string & {}), params?: TranslateParams) => string;

export type I18nContextValue = {
  lang: Lang;
  setLang: (lang: Lang) => void;
  toggleLang: () => void;
  t: TFunction;
};

const I18nContext = createContext<I18nContextValue | null>(null);

function browserStorage(): LangStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    // Some privacy modes throw on access rather than on write.
    return null;
  }
}

function browserLanguage(): string | null {
  if (typeof navigator === "undefined") return null;
  return navigator.language ?? null;
}

export type I18nProviderProps = {
  children: ReactNode;
  /** Test/embedding override; normally omitted. */
  initialLang?: Lang;
};

export function I18nProvider({ children, initialLang }: I18nProviderProps) {
  const [lang, setLangState] = useState<Lang>(() => {
    if (initialLang && isLang(initialLang)) return initialLang;
    return pickInitialLanguage(readStoredLanguage(browserStorage()), browserLanguage());
  });

  // Keep <html lang> and the persisted choice in sync with every switch.
  useEffect(() => {
    applyDocumentLanguage(typeof document === "undefined" ? null : document, lang);
    writeStoredLanguage(browserStorage(), lang);
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState((previous) => (isLang(next) ? next : resolveLanguage(next ?? previous)));
  }, []);

  const toggleLang = useCallback(() => {
    setLangState((previous) => (previous === "en" ? "zh-CN" : "en"));
  }, []);

  const t = useMemo<TFunction>(() => {
    const dict = DICTIONARIES[lang];
    return (key: MessageKey | (string & {}), params?: TranslateParams) => translate(dict, key, params);
  }, [lang]);

  const value = useMemo<I18nContextValue>(() => ({ lang, setLang, toggleLang, t }), [lang, setLang, toggleLang, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Full i18n context; throws when the provider is missing (a wiring bug). */
export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside <I18nProvider>");
  return context;
}

/** Translate function only — the common case in components. */
export function useT(): TFunction {
  return useI18n().t;
}

/** Current locale plus setters — used by the top-bar toggle and Settings. */
export function useLang(): { lang: Lang; setLang: (lang: Lang) => void; toggleLang: () => void } {
  const { lang, setLang, toggleLang } = useI18n();
  return { lang, setLang, toggleLang };
}
