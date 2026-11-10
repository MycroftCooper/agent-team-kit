import { useEffect, useState, type ReactNode } from "react";
import type { Lang } from "./i18n";

type WindowState = { maximized: boolean; minimized: boolean };
declare global {
  interface Window {
    atkDesktop?: {
      getWindowState: () => Promise<WindowState>;
      chooseProjectFolder: (currentPath: string) => Promise<string | null>;
      minimize: () => Promise<void>;
      toggleMaximize: () => Promise<void>;
      close: () => Promise<void>;
      onWindowState: (callback: (state: WindowState) => void) => () => void;
    };
  }
}
export const desktopWindow = window.atkDesktop;

export function DesktopTitleBar({ lang, workspace }: { lang: Lang; workspace?: ReactNode }) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!desktopWindow) return;
    let mounted = true;
    function update(state: WindowState) { if (mounted) setMaximized(state.maximized); }
    const unsubscribe = desktopWindow.onWindowState(update);
    void desktopWindow.getWindowState().then(update).catch(console.error);
    return () => { mounted = false; unsubscribe(); };
  }, []);
  if (!desktopWindow) return null;
  const zh = lang === "zh";
  const buttons = [
    { key: "minimize", label: zh ? "最小化窗口" : "Minimize window", action: desktopWindow.minimize, path: "M3 8h10" },
    { key: "maximize", label: maximized ? (zh ? "还原窗口" : "Restore window") : (zh ? "最大化窗口" : "Maximize window"), action: desktopWindow.toggleMaximize, path: maximized ? "M5 5V3h8v8h-2M3 5h8v8H3z" : "M3 3h10v10H3z" },
    { key: "close", label: zh ? "关闭窗口" : "Close window", action: desktopWindow.close, path: "m3.5 3.5 9 9m0-9-9 9" },
  ];
  return <header className="desktop-titlebar">
    <div className="desktop-title-brand">
      <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
      <span>Agent Team Kit</span><span className="desktop-title-badge">DEV</span>
    </div>
    {workspace}
    <div className="desktop-title-actions">
      {buttons.map(({ key, label, action, path }) => <button type="button" key={key}
        className={`desktop-window-button desktop-window-${key}`} aria-label={label} title={label}
        onClick={() => { void action().catch(console.error); }}>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1"><path d={path} /></svg>
      </button>)}
    </div>
  </header>;
}
