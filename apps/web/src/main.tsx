import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { desktopWindow } from "./desktop-window";
import { ThemeProvider } from "./theme";
import "./theme.css";
import "./style.css";

if (desktopWindow) document.documentElement.dataset.desktop = "";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider><App /></ThemeProvider>
  </React.StrictMode>,
);
