import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect } from "react";

import { useChanges } from "../changesStore";
import { commandContext, type MenuState, menuState, runCommand } from "../commands";
import { usePresent } from "../components/presenter/present";
import { useEditorState } from "../components/stage/editorState";
import { api } from "../lib/api";
import { commandSpec, menuChoice, noteKey } from "../lib/commands";
import { isMod, isTextField } from "../lib/keys";
import { useApp } from "../store";
import { useExports } from "../store/exports";

/** The event the menu bar sends this window a command in (see src-tauri/src/menu.rs). */
export const MENU_EVENT = "menu-command";

/** How long the state has to rest before the menu bar is told: a drag reports every frame. */
export const MENU_STATE_MS = 120;

/** The commands that undo and redo: typing in a text field, while one has the focus. */
const TEXT_HISTORY: Record<string, "undo" | "redo"> = { "edit.undo": "undo", "edit.redo": "redo" };

const typing = () => isTextField(document.activeElement);

/**
 * Does what the menu bar asks for. The page owns the keys: a menu choice that is the echo of a
 * key the page just acted on is not run again (see `menuChoice`), nor one the page left alone,
 * unless that is Undo or Redo pressed in a text field, which undo the typing there, as they do
 * when chosen with the pointer while a field has the focus. Everything else runs as from the
 * palette.
 */
export function runMenuCommand(id: string): void {
  const choice = menuChoice(commandSpec(id).keys);
  if (choice === "taken") return;
  const textStep = TEXT_HISTORY[id];
  if (textStep && typing()) {
    document.execCommand(textStep);
    return;
  }
  if (choice === "click") runCommand(id);
}

/** The menu bar's state for this window: Undo and Redo stay on in a text field, for its own typing. */
export function windowMenuState(): MenuState {
  const state = menuState(commandContext());
  if (!typing()) return state;
  return { ...state, disabled: state.disabled.filter((id) => !(id in TEXT_HISTORY)) };
}

const isFrame = (source: MessageEventSource | null) =>
  Array.from(document.querySelectorAll("iframe")).some((frame) => frame.contentWindow === source);

/**
 * Connects the window to the menu bar: runs the commands chosen there, notes the keys pressed
 * (so their echo from the menu bar is not run twice), and tells the menu bar which commands can
 * run and which are on, once what it shows settles and only while this window has the focus,
 * which is whose state the menu bar shows.
 */
export function useCommandMenu() {
  useEffect(() => {
    // Each key, before anything acts on it; whether something did is known once it has gone round.
    const onKey = (event: KeyboardEvent) =>
      noteKey(
        { key: event.key, code: event.code, mod: isMod(event), shift: event.shiftKey, alt: event.altKey },
        () => event.defaultPrevented,
      );
    // A key a slide preview forwards is acted on here, whatever the preview did with it.
    const onMessage = (event: MessageEvent) => {
      const { type, key, mod, shift, alt } = event.data ?? {};
      if (type !== "slop:key" || typeof key !== "string" || !isFrame(event.source)) return;
      noteKey({ key, mod: Boolean(mod), shift: Boolean(shift), alt: Boolean(alt) }, () => true);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("message", onMessage);

    let stopped = false;
    let unlisten: (() => void) | null = null;
    try {
      void getCurrentWebviewWindow()
        .listen<string>(MENU_EVENT, ({ payload }) => runMenuCommand(payload))
        .then((off) => {
          if (stopped) off();
          else unlisten = off;
        })
        .catch(() => {});
    } catch {
      // No window to listen to (a test): there is no menu bar either.
    }

    // Outside the app's window (tests, a plain browser without the preview's stand-in) there is no menu bar to tell.
    const hasMenuBar = "__TAURI_INTERNALS__" in window;
    let sent = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = () => {
      timer = undefined;
      if (!hasMenuBar || !document.hasFocus()) return;
      const state = windowMenuState();
      const text = JSON.stringify(state);
      if (text === sent) return;
      sent = text;
      api.setMenuState(state).catch(() => {
        // Told again with the next change.
        sent = "";
      });
    };
    const soon = () => {
      timer ??= setTimeout(send, MENU_STATE_MS);
    };
    // Focused again, the window's state is the menu bar's once more, whatever another window sent.
    const onFocus = () => {
      sent = "";
      soon();
    };
    const stores = [
      useApp.subscribe(soon),
      useEditorState.subscribe(soon),
      useChanges.subscribe(soon),
      useExports.subscribe(soon),
      usePresent.subscribe(soon),
    ];
    window.addEventListener("focus", onFocus);
    document.addEventListener("focusin", soon);
    document.addEventListener("focusout", soon);
    soon();
    return () => {
      stopped = true;
      unlisten?.();
      clearTimeout(timer);
      for (const off of stores) off();
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("focusin", soon);
      document.removeEventListener("focusout", soon);
    };
  }, []);
}
