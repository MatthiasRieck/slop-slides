import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import "./index.css";
import { isRemote, lockPageZoom } from "./lib/platform";
import { initEventBridge } from "./store";

// Follow the OS appearance.
const dark = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", dark.matches);
applyTheme();
dark.addEventListener("change", applyTheme);

// A device served by the desktop app (src/lib/platform.ts) talks to the real backend.
if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window) && !isRemote) {
  const { installBrowserMock } = await import("./lib/browserMock");
  installBrowserMock();
}
if (isRemote) lockPageZoom();
void initEventBridge();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
