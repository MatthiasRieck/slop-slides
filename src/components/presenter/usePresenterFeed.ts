import { emit } from "@tauri-apps/api/event";
import { useEffect } from "react";

import { useTauriEvent } from "../../hooks/useTauriEvent";
import type { Deck } from "../../lib/api";
import { useApp } from "../../store";

/** What the show tells the presenter view's window: the deck, the slide on screen, and whether it plays by itself. */
export interface PresenterState {
  deck: Deck;
  slide: string | null;
  playing: boolean;
}

/** A key pressed in the presenter view's window, for the show to act on as if pressed in it. */
export interface PresenterKey {
  key: string;
  shift: boolean;
}

/** What the presenter view's window sends the show. */
export const presenterRemote = {
  /** A key pressed there, without ⌘, Ctrl or Alt. */
  key: (key: PresenterKey) => void emit("presenter:key", key),
  /** Play or pause the show running by itself. */
  play: () => void emit("presenter:play"),
  end: () => void emit("presenter:exit"),
};

/**
 * Keeps the presenter view's window up to date (it asks for the state when it opens, and gets it
 * again on every change), and takes what it sends: the keys pressed there (`onKey`), Play
 * (`onPlay`) and the end of the show. Does nothing without a deck.
 */
export function usePresenterFeed(
  state: { deck: Deck | null; slide: string | null; playing: boolean },
  on: { key: (key: PresenterKey) => void; play: () => void },
) {
  const { deck, slide, playing } = state;
  const active = deck !== null;
  useEffect(() => {
    if (deck) void emit("presenter:state", { deck, slide, playing });
  }, [deck, slide, playing]);
  useTauriEvent("presenter:ready", () => deck && void emit("presenter:state", { deck, slide, playing }), active);
  useTauriEvent<PresenterKey>("presenter:key", on.key, active);
  useTauriEvent("presenter:play", on.play, active);
  useTauriEvent("presenter:exit", () => useApp.getState().setPresenting(false), active);
}
