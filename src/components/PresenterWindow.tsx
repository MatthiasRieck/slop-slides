import { emit, listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

import { isTypingTarget } from "../lib/keys";
import { hasOpenLayer } from "../lib/layers";
import { useApp } from "../store";
import { PresenterPanel, scrollNotes } from "./PresenterPanel";
import { ShowKeys } from "./presenter/ShowKeys";
import { ShowOverview } from "./presenter/ShowOverview";
import { type PresenterState, presenterRemote } from "./presenter/usePresenterFeed";
import { useShowSession } from "./presenter/useShowSession";

/**
 * The window the presenter view opens in, on the presenter's own screen (see
 * src-tauri/src/screens.rs). It holds no workspace: the show window sends it the deck, the slide
 * on screen, whether the show plays by itself, whether the audience's screen is blank and the
 * slide number being typed, and it operates the show from here: its row of controls (blanking
 * the audience's screen among them), the next slide's picture, all the slides to go to one (G,
 * or the slide's number), and the keys pressed here, which the show acts on as if pressed in it
 * (the tools' keys too, and Escape, which puts a tool away before it ends the show). Only keys
 * without ⌘, Ctrl or Alt are the show's; the others stay the system's. `?` lists the keys, G
 * shows all the slides, and [ and ] scroll the notes, here and not on the audience's screen.
 * Closing the window ends the show (the backend tells the show). The show's clocks and the
 * microphone's tools live here, with the view that displays them.
 */
export function PresenterWindow() {
  const [state, setState] = useState<PresenterState | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const session = useShowSession(state?.deck.id ?? "", state?.slide ?? null);

  useEffect(() => {
    const sub = listen<PresenterState>("presenter:state", (event) => {
      // The slides' previews read the deck's version from the store.
      useApp.setState({ deck: event.payload.deck });
      setState(event.payload);
    });
    // Asked once the listener is up, so the answer is not missed.
    void sub.then(() => emit("presenter:ready"));
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // A field, a menu or what is open over the view has the key; Tab moves through the buttons.
      if (event.key === "Tab" || isTypingTarget(event.target) || hasOpenLayer()) return;
      event.preventDefault();
      if (event.key === "?") setKeysOpen(true);
      else if (event.key === "g" || event.key === "G") setOverviewOpen(true);
      else if (event.key === "[" || event.key === "]") scrollNotes(event.key === "]" ? 1 : -1);
      else presenterRemote.key({ key: event.key, shift: event.shiftKey });
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      void sub.then((off) => off());
    };
  }, []);

  if (!state)
    return (
      <div className="dark flex h-screen items-center justify-center bg-background text-foreground/50 text-sm">
        Waiting for the show…
      </div>
    );
  return (
    <div className="h-screen">
      <PresenterPanel
        window
        deck={state.deck}
        slide={state.slide}
        session={session}
        ended={state.ended}
        onNext={() => presenterRemote.key({ key: "ArrowRight", shift: false })}
        onOverview={() => setOverviewOpen(true)}
        onShowKeys={() => setKeysOpen(true)}
        remote={{
          previous: () => presenterRemote.key({ key: "ArrowLeft", shift: false }),
          playing: state.playing,
          togglePlay: presenterRemote.play,
          blank: state.blank ?? null,
          setBlank: presenterRemote.blank,
          typed: state.typed ?? "",
          end: presenterRemote.end,
        }}
      />
      {keysOpen && <ShowKeys onClose={() => setKeysOpen(false)} />}
      {overviewOpen && (
        <ShowOverview
          deck={state.deck}
          current={state.slide}
          onPick={presenterRemote.goto}
          onClose={() => setOverviewOpen(false)}
        />
      )}
    </div>
  );
}
