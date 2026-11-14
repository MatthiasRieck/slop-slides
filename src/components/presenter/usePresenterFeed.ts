import { emit } from "@tauri-apps/api/event";
import { useEffect } from "react";

import { useTauriEvent } from "../../hooks/useTauriEvent";
import type { Deck } from "../../lib/api";
import { useApp } from "../../store";

/** What blanks the audience's screen: black, white, or nothing (the slide shows). */
export type Blank = "black" | "white" | null;

/**
 * What the show tells the presenter view's window: the deck, the slide on screen, whether it
 * plays by itself, whether the audience's screen is blank, the slide number being typed, and
 * whether the show is past its last slide.
 */
export interface PresenterState {
  deck: Deck;
  slide: string | null;
  playing: boolean;
  blank: Blank;
  typed: string;
  ended: boolean;
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
  /** Go to the slide picked from all of them. */
  goto: (slide: string) => void emit("presenter:goto", slide),
  /** Blank the audience's screen, or show the slide again. */
  blank: (color: Blank) => void emit("presenter:blank", color),
  end: () => void emit("presenter:exit"),
};

/** What the show does for the presenter view's window. */
export interface PresenterHandlers {
  key: (key: PresenterKey) => void;
  play: () => void;
  goto: (slide: string) => void;
  blank: (color: Blank) => void;
}

/**
 * Keeps the presenter view's window up to date (it asks for the state when it opens, and gets it
 * again on every change), and takes what it sends: the keys pressed there, Play, a slide picked
 * from all of them, blanking the screen, and the end of the show. Does nothing without a deck.
 */
export function usePresenterFeed(state: Omit<PresenterState, "deck"> & { deck: Deck | null }, on: PresenterHandlers) {
  const { deck, slide, playing, blank, typed, ended } = state;
  const active = deck !== null;
  useEffect(() => {
    if (deck) void emit("presenter:state", { deck, slide, playing, blank, typed, ended });
  }, [deck, slide, playing, blank, typed, ended]);
  useTauriEvent(
    "presenter:ready",
    () => deck && void emit("presenter:state", { deck, slide, playing, blank, typed, ended }),
    active,
  );
  useTauriEvent<PresenterKey>("presenter:key", on.key, active);
  useTauriEvent("presenter:play", on.play, active);
  useTauriEvent<string>("presenter:goto", (slide) => on.goto(String(slide)), active);
  useTauriEvent<Blank>(
    "presenter:blank",
    (color) => on.blank(color === "black" || color === "white" ? color : null),
    active,
  );
  useTauriEvent("presenter:exit", () => useApp.getState().setPresenting(false), active);
}
