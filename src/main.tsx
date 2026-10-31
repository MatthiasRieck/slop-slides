import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import { PresenterWindow } from "./components/PresenterWindow";
import "./index.css";
import { initNarrationEvents } from "./narrationStore";
import { initEventBridge } from "./store";

// Follow the OS appearance.
const dark = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", dark.matches);
applyTheme();
dark.addEventListener("change", applyTheme);

if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
  const { installBrowserMock } = await import("./lib/browserMock");
  installBrowserMock();
}
// The presenter view window shows what the show window sends it and opens no workspace.
const presenterView = new URLSearchParams(window.location.search).has("presenter");
if (!presenterView) {
  void initEventBridge();
  void initNarrationEvents();
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{presenterView ? <PresenterWindow /> : <App />}</React.StrictMode>,
);
