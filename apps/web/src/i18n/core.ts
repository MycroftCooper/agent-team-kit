// Pure i18n core: no React, no DOM globals. Everything in this module is
// importable from `node:test` (the SPA's tests run without a DOM).
//
// Two rules the rest of the app relies on:
//  * a missing dictionary key returns the key itself, never `undefined` and
//    never an exception, so a half-translated build degrades into readable
//    identifiers instead of blank labels;
//  * every stored/observed language tag is normalised to one of the two locales
//    this build ships (`en`, `zh-CN`).

export type Lang = "en" | "zh-CN";

export const LANGS: readonly Lang[] = ["en", "zh-CN"];
export const DEFAULT_LANG: Lang = "en";
export const LANG_STORAGE_KEY = "atk.lang";

export type TranslateParams = Record<string, string | number>;
export type Dict = Record<string, string>;

/** Narrowing guard used by storage and UI input. */
export function isLang(value: unknown): value is Lang {
  return value === "en" || value === "zh-CN";
}

/**
 * Default language from a BCP-47 tag: anything starting with `zh` maps to
 * `zh-CN` (we ship simplified Chinese only), everything else to `en`.
 * `undefined`/`null`/`""` fall back to English.
 */
export function resolveLanguage(preferredTag: string | null | undefined): Lang {
  const tag = String(preferredTag ?? "")
    .trim()
    .toLowerCase();
  return tag.startsWith("zh") ? "zh-CN" : DEFAULT_LANG;
}

/** Minimal `localStorage` surface so tests can inject a fake. */
export type LangStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/** Read the persisted choice; unreadable/blocked storage is not an error. */
export function readStoredLanguage(storage: LangStorage | null | undefined): Lang | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(LANG_STORAGE_KEY);
    return isLang(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Persist the choice; returns false when storage is unavailable (private mode). */
export function writeStoredLanguage(storage: LangStorage | null | undefined, lang: Lang): boolean {
  if (!storage || !isLang(lang)) return false;
  try {
    storage.setItem(LANG_STORAGE_KEY, lang);
    return true;
  } catch {
    return false;
  }
}

/** Persisted choice wins; otherwise follow the browser; otherwise English. */
export function pickInitialLanguage(stored: string | null | undefined, preferredTag: string | null | undefined): Lang {
  if (isLang(stored)) return stored;
  return resolveLanguage(preferredTag);
}

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/**
 * `"{{n}} tasks"` + `{n: 3}` -> `"3 tasks"`. Unknown placeholders are left
 * verbatim so a typo is visible instead of silently blank.
 */
export function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replace(PLACEHOLDER_RE, (match: string, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return match;
    const value = params[name];
    return value === undefined || value === null ? match : String(value);
  });
}

/** Own-property check: `key in dict` would also accept `toString`. */
export function hasKey(dict: Dict, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(dict, key);
}

/** Dictionary lookup + interpolation with the documented missing-key fallback. */
export function translate(dict: Dict, key: string, params?: TranslateParams): string {
  const template = hasKey(dict, key) ? dict[key] : undefined;
  if (template === undefined) return key;
  return interpolate(template, params);
}

/** Sync `<html lang>` so screen readers and CSS `:lang()` see the switch. */
export function applyDocumentLanguage(
  doc: { documentElement: { lang: string } } | null | undefined,
  lang: Lang,
): void {
  if (!doc || !isLang(lang)) return;
  doc.documentElement.lang = lang;
}

/** The other locale — used by the top-bar toggle button. */
export function nextLanguage(current: Lang): Lang {
  return current === "en" ? "zh-CN" : "en";
}

/** Dictionary key holding the *name of a language* (shown on the toggle). */
export function languageNameKey(lang: Lang): "language.en" | "language.zhCN" {
  return lang === "zh-CN" ? "language.zhCN" : "language.en";
}
