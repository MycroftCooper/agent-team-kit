// Guard rails for the user-facing requirement "the UI is bilingual and the
// switch is a visible top-bar button":
//
//  * no CJK copy outside src/i18n/** (components must go through the dictionary);
//  * every literal `t("key")` in the source exists in BOTH dictionaries;
//  * the language toggle is a real <button data-testid="lang-toggle"> in the
//    top bar;
//  * the provider persists the choice and syncs <html lang>.
//
// Static checks are intentional here: no DOM testing library is allowed.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { en } from "../src/i18n/en.ts";
import { zhCN } from "../src/i18n/zh-CN.ts";
import { hasKey } from "../src/i18n/core.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const sourceFiles = walk(SRC).sort();
const relative = (file) => path.relative(SRC, file).split(path.sep).join("/");

test("source tree is discovered", () => {
  assert.ok(sourceFiles.length >= 20, `expected to scan the SPA sources, found ${sourceFiles.length}`);
});

test("no hardcoded CJK copy outside the dictionaries", () => {
  const offenders = [];
  for (const file of sourceFiles) {
    const name = relative(file);
    if (name.startsWith("i18n/")) continue; // dictionaries are where copy belongs
    const text = readFileSync(file, "utf8");
    const matches = text.match(/[\u4e00-\u9fff]/g);
    if (matches) offenders.push(`${name} (${matches.length} CJK chars)`);
  }
  assert.deepEqual(offenders, [], "components/pages must use t(...) instead of hardcoded Chinese");
});

test("every literal t(\"key\") exists in both dictionaries", () => {
  const keys = new Set();
  const pattern = /\bt\(\s*"([A-Za-z0-9_.-]+)"/g;
  for (const file of sourceFiles) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) keys.add(match[1]);
  }
  assert.ok(keys.size >= 60, `expected many literal keys, found ${keys.size}`);
  const missing = [...keys].filter((key) => !hasKey(en, key) || !hasKey(zhCN, key)).sort();
  assert.deepEqual(missing, [], "literal keys used in source but missing from a dictionary");
});

test("the language toggle is a visible top-bar button with data-testid=lang-toggle", () => {
  const toggle = readFileSync(path.join(SRC, "components", "LangToggle.tsx"), "utf8");
  assert.match(toggle, /data-testid="lang-toggle"/);
  assert.match(toggle, /<button/);
  assert.match(toggle, /onClick=\{toggleLang\}/);
  assert.doesNotMatch(toggle, /[\u4e00-\u9fff]/);

  const topbar = readFileSync(path.join(SRC, "components", "TopBar.tsx"), "utf8");
  assert.match(topbar, /<LangToggle \/>/, "the toggle must be rendered in the top bar");
});

test("the i18n provider persists the choice and syncs <html lang>", () => {
  const provider = readFileSync(path.join(SRC, "i18n", "index.tsx"), "utf8");
  assert.match(provider, /writeStoredLanguage\(/, "the choice must be persisted to localStorage atk.lang");
  assert.match(provider, /readStoredLanguage\(/, "the stored choice must be read on start");
  assert.match(provider, /applyDocumentLanguage\(/, "document.documentElement.lang must follow the switch");
  assert.match(provider, /navigator\.language/, "the default language comes from the browser");
});

test("the settings page offers a second explicit language switch", () => {
  const settings = readFileSync(path.join(SRC, "pages", "SettingsPage.tsx"), "utf8");
  assert.match(settings, /LANGS\.map/);
  assert.match(settings, /setLang/);
  assert.match(settings, /languageNameKey/);
});
