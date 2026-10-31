import { emit, listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

import { useApp } from "../store";
import type { PresenterState } from "./Presenter";
import { PresenterPanel } from "./PresenterPanel";

/**
 * The window the presenter view opens in, on the presenter's own screen (see
 * src-tauri/src/screens.rs). It holds no workspace: the show window sends it the deck and the
 * slide on screen, and it sends back the keys pressed here, so the show can be driven from it.
 * Escape ends the show.
 */
export function PresenterWindow() {
  const [state, setState] = useState<PresenterState | null>(null);
  const [startedAt, setStartedAt] = useState(() => Date.now());

  useEffect(() => {
    const sub = listen<PresenterState>("presenter:state", (event) => {
      // The slides' previews read the deck's version from the store.
      useApp.setState({ deck: event.payload.deck });
      setState(event.payload);
    });
    // Asked once the listener is up, so the answer is not missed.
    void sub.then(() => emit("presenter:ready"));
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === "Escape") void emit("presenter:exit");
      else void emit("presenter:key", event.key);
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      void sub.then((off) => off());
    };
  }, []);

  if (!state)
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-950 text-white/50 text-sm">
        Waiting for the show…
      </div>
    );
  return (
    <div className="h-screen">
      <PresenterPanel
        window
        deck={state.deck}
        slide={state.slide}
        startedAt={startedAt}
        onRestart={() => setStartedAt(Date.now())}
      />
    </div>
  );
}
