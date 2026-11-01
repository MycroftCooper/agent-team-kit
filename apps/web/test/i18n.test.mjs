// i18n: dictionary completeness, interpolation, fallback, language resolution
// and persistence. No DOM: the persistence layer takes an injected storage.
import test from "node:test";
import assert from "node:assert/strict";

import { en } from "../src/i18n/en.ts";
import { zhCN } from "../src/i18n/zh-CN.ts";
import {
  LANG_STORAGE_KEY,
  applyDocumentLanguage,
  hasKey,
  interpolate,
  isLang,
  languageNameKey,
  nextLanguage,
  pickInitialLanguage,
  readStoredLanguage,
  resolveLanguage,
  translate,
  writeStoredLanguage,
} from "../src/i18n/core.ts";

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

test("en and zh-CN expose exactly the same key set", () => {
  const enKeys = Object.keys(en).sort();
  const zhKeys = Object.keys(zhCN).sort();
  assert.deepEqual(zhKeys, enKeys);
});

test("both dictionaries are non-trivial and contain no empty values", () => {
  const keys = Object.keys(en);
  assert.ok(keys.length >= 200, `expected >= 200 keys, got ${keys.length}`);
  for (const key of keys) {
    assert.equal(typeof en[key], "string", `en[${key}] must be a string`);
    assert.ok(en[key].trim().length > 0, `en[${key}] must not be blank`);
    assert.equal(typeof zhCN[key], "string", `zh[${key}] must be a string`);
    assert.ok(zhCN[key].trim().length > 0, `zh[${key}] must not be blank`);
    assert.equal(key, key.trim());
  }
});

test("Dictionary key set is identical to the union used by the UI", () => {
  const enKeys = new Set(Object.keys(en));
  const zhKeys = new Set(Object.keys(zhCN));
  for (const key of [...enKeys, ...zhKeys]) {
    assert.ok(enKeys.has(key), `missing in en: ${key}`);
    assert.ok(zhKeys.has(key), `missing in zh-CN: ${key}`);
  }
});

test("every status label key has text in both languages", () => {
  for (const key of Object.keys(en)) {
    if (!key.startsWith("status.") && !key.startsWith("statusGroup.")) continue;
    assert.ok(zhCN[key], `zh-CN missing ${key}`);
  }
});

test("interpolate replaces known placeholders", () => {
  assert.equal(interpolate("{{n}} tasks", { n: 3 }), "3 tasks");
  assert.equal(interpolate("{{n}} 个任务", { n: 0 }), "0 个任务");
  assert.equal(interpolate("{{a}}-{{b}}", { a: "x", b: "y" }), "x-y");
  assert.equal(interpolate("{{ n }} tasks", { n: 2 }), "2 tasks");
});

test("interpolate leaves unknown placeholders visible instead of blanking them", () => {
  assert.equal(interpolate("{{n}} tasks", {}), "{{n}} tasks");
  assert.equal(interpolate("{{n}} tasks", { other: 1 }), "{{n}} tasks");
  assert.equal(interpolate("{{n}} tasks"), "{{n}} tasks");
});

test("translate falls back to the key itself when a key is missing", () => {
  assert.equal(translate({}, "missing.key"), "missing.key");
  assert.equal(translate(en, "missing.key"), "missing.key");
  assert.equal(translate(en, "app.name"), en["app.name"]);
  assert.equal(translate(en, "topbar.languageButton", { language: "中文" }), "Switch language to 中文");
  assert.equal(translate(zhCN, "topbar.languageButton", { language: "English" }), "切换界面语言为English");
});

test("hasKey only accepts own properties", () => {
  assert.equal(hasKey(en, "app.name"), true);
  assert.equal(hasKey(en, "toString"), false);
  assert.equal(hasKey(en, "missing.key"), false);
});

test("resolveLanguage normalises browser tags", () => {
  assert.equal(resolveLanguage("zh-CN"), "zh-CN");
  assert.equal(resolveLanguage("zh-TW"), "zh-CN");
  assert.equal(resolveLanguage("zh"), "zh-CN");
  assert.equal(resolveLanguage("ZH-cn"), "zh-CN");
  assert.equal(resolveLanguage("en-US"), "en");
  assert.equal(resolveLanguage("fr-FR"), "en");
  assert.equal(resolveLanguage(""), "en");
  assert.equal(resolveLanguage(null), "en");
  assert.equal(resolveLanguage(undefined), "en");
});

test("isLang narrows only the two supported locales", () => {
  assert.equal(isLang("en"), true);
  assert.equal(isLang("zh-CN"), true);
  assert.equal(isLang("zh-TW"), false);
  assert.equal(isLang(""), false);
  assert.equal(isLang(null), false);
});

test("pickInitialLanguage prefers the persisted choice over the browser", () => {
  assert.equal(pickInitialLanguage("zh-CN", "en-US"), "zh-CN");
  assert.equal(pickInitialLanguage("en", "zh-CN"), "en");
  assert.equal(pickInitialLanguage(null, "zh-TW"), "zh-CN");
  assert.equal(pickInitialLanguage("de", "zh-TW"), "zh-CN");
  assert.equal(pickInitialLanguage(undefined, undefined), "en");
});

test("language persistence round-trips through the atk.lang key", () => {
  const storage = fakeStorage();
  assert.equal(readStoredLanguage(storage), null);
  assert.equal(writeStoredLanguage(storage, "zh-CN"), true);
  assert.equal(storage.map.get(LANG_STORAGE_KEY), "zh-CN");
  assert.equal(readStoredLanguage(storage), "zh-CN");
  assert.equal(writeStoredLanguage(storage, "en"), true);
  assert.equal(readStoredLanguage(storage), "en");
});

test("storage failures are not errors", () => {
  const throwing = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
  };
  assert.equal(readStoredLanguage(throwing), null);
  assert.equal(writeStoredLanguage(throwing, "en"), false);
  assert.equal(readStoredLanguage(null), null);
  assert.equal(writeStoredLanguage(null, "en"), false);
});

test("stored garbage is ignored", () => {
  const storage = fakeStorage({ [LANG_STORAGE_KEY]: "klingon" });
  assert.equal(readStoredLanguage(storage), null);
});

test("applyDocumentLanguage syncs <html lang>", () => {
  const doc = { documentElement: { lang: "en" } };
  applyDocumentLanguage(doc, "zh-CN");
  assert.equal(doc.documentElement.lang, "zh-CN");
  applyDocumentLanguage(doc, "en");
  assert.equal(doc.documentElement.lang, "en");
  assert.doesNotThrow(() => applyDocumentLanguage(null, "en"));
});

test("nextLanguage toggles between the two locales", () => {
  assert.equal(nextLanguage("en"), "zh-CN");
  assert.equal(nextLanguage("zh-CN"), "en");
  assert.equal(languageNameKey("en"), "language.en");
  assert.equal(languageNameKey("zh-CN"), "language.zhCN");
  assert.ok(en[languageNameKey("zh-CN")].length > 0);
  assert.ok(zhCN[languageNameKey("en")].length > 0);
});
