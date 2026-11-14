import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import { Tooltips } from "./components/Tooltip";
import "./index.css";
import { followAppearance } from "./lib/theme";
import { initNarrationEvents } from "./narrationStore";
import { initEventBridge } from "./store";

// Light, dark, or as the system shows, as chosen in the app's settings; every window follows the
// choice. index.html has already shown the window in it, before this code loaded.
followAppearance();

if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
  const { installBrowserMock } = await import("./lib/browserMock");
  installBrowserMock();
}

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
// The presenter view window shows what the show window sends it and opens no workspace. Its code
// is loaded only there: the app's windows do not start with it. (Not awaited at the top level:
// a module that waits there keeps the build from merging the chunks the lazy parts share.)
if (new URLSearchParams(window.location.search).has("presenter")) {
  void import("./components/PresenterWindow").then(({ PresenterWindow }) =>
    root.render(
      <React.StrictMode>
        <PresenterWindow />
        <Tooltips />
      </React.StrictMode>,
    ),
  );
} else {
  void initEventBridge();
  void initNarrationEvents();
  root.render(
    <React.StrictMode>
      <App />
      <Tooltips />
    </React.StrictMode>,
  );
}
