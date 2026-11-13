import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import { PresenterWindow } from "./components/PresenterWindow";
import "./index.css";
import { followAppearance } from "./lib/theme";
import { initNarrationEvents } from "./narrationStore";
import { initEventBridge } from "./store";

// Light, dark, or as the system shows, as chosen in the app's settings; every window follows the choice.
followAppearance();

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
