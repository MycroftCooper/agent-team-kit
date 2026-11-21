import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Lang } from "./i18n";

type Theme = "system" | "light" | "dark";
const storageKey = "atk-theme";
const systemDark = matchMedia("(prefers-color-scheme: dark)");
function preference(value: string | null): Theme {
  return value === "light" || value === "dark" ? value : "system";
}
function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}
applyTheme(preference(localStorage.getItem(storageKey)));

const ThemeContext = createContext<{
  theme: Theme;
  dark: boolean;
  setTheme: (theme: Theme) => void;
}>({ theme: "system", dark: systemDark.matches, setTheme: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setPreference] = useState(() => preference(localStorage.getItem(storageKey)));
  const [system, setSystem] = useState(() => systemDark.matches);
  useEffect(() => {
    function syncSystem() { setSystem(systemDark.matches); }
    function syncStorage(event: StorageEvent) {
      if (event.key !== storageKey && event.key !== null) return;
      const next = preference(localStorage.getItem(storageKey));
      applyTheme(next);
      setPreference(next);
    }
    systemDark.addEventListener("change", syncSystem);
    window.addEventListener("storage", syncStorage);
    syncSystem();
    return () => {
      systemDark.removeEventListener("change", syncSystem);
      window.removeEventListener("storage", syncStorage);
    };
  }, []);
  function setTheme(next: Theme) {
    applyTheme(next);
    localStorage.setItem(storageKey, next);
    setPreference(next);
  }
  return <ThemeContext.Provider value={{ theme, dark: theme === "dark" || (theme === "system" && system), setTheme }}>
    {children}
  </ThemeContext.Provider>;
}

export function ThemeToggle({ lang }: { lang: Lang }) {
  const { dark, setTheme } = useContext(ThemeContext);
  const title = dark ? (lang === "zh" ? "切换到浅色主题" : "Switch to light theme")
    : (lang === "zh" ? "切换到深色主题" : "Switch to dark theme");
  return <button type="button" className="theme-toggle quiet" title={title} aria-label={title}
    onClick={() => setTheme(dark ? "light" : "dark")}>
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {dark ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>
        : <path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z" />}
    </svg>
  </button>;
}

export function ThemeSettings({ lang }: { lang: Lang }) {
  const { theme, setTheme } = useContext(ThemeContext);
  const zh = lang === "zh";
  return <section className="panel settings-panel">
    <h3>{zh ? "外观" : "Appearance"}</h3>
    <p>{zh ? "主题偏好保存在当前应用中。" : "Theme preference is saved in this app."}</p>
    <select name="theme" aria-label={zh ? "界面主题" : "Interface theme"} value={theme}
      onChange={(event) => setTheme(preference(event.target.value))}>
      <option value="system">{zh ? "跟随系统" : "Follow system"}</option>
      <option value="light">{zh ? "浅色" : "Light"}</option>
      <option value="dark">{zh ? "深色" : "Dark"}</option>
    </select>
  </section>;
}
