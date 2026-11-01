// Browser entry point. The I18nProvider sits above the app so the very first
// render already uses the stored/browser-preferred language.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { I18nProvider } from "./i18n/index.tsx";
import "./styles/tokens.css";
import "./styles/app.css";

const container = document.getElementById("root");
if (!container) throw new Error("Agent Team Kit: #root element is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
