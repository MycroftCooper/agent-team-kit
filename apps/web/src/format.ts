// Locale-aware formatting helpers used by every list/table. Missing or invalid
// timestamps return `null` so the caller renders the dictionary's "none" label
// instead of `Invalid Date`.
import type { Lang } from "./i18n/core.ts";

const LOCALES: Record<Lang, string> = { en: "en-GB", "zh-CN": "zh-CN" };

export function formatDateTime(iso: string | null | undefined, lang: Lang): string | null {
  if (typeof iso !== "string" || iso.trim() === "") return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(LOCALES[lang] ?? LOCALES.en, {
      dateStyle: "short",
      timeStyle: "medium",
      timeZone: "UTC",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}
