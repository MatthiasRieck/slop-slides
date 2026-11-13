import { useEffect } from "react";

import { isMod } from "../../lib/keys";
import { useApp } from "../../store";

/** Whether a key press is the one that goes to the chat: the modifier with L, and nothing else held. */
const isChatKey = (key: string, mod: boolean, shift: boolean, alt: boolean) =>
  mod && !shift && !alt && key.toLowerCase() === "l";

/**
 * Goes to the chat from anywhere in the window with the modifier and L: the sidebar's chat tab
 * opens, and the keyboard focus lands in the message input. It works while typing elsewhere too,
 * and from a slide preview, which forwards its keys as `slop:key` messages, but not during a
 * slide show.
 */
export function useChatShortcut() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isChatKey(event.key, isMod(event), event.shiftKey, event.altKey)) return;
      if (useApp.getState().presenting) return;
      event.preventDefault();
      useApp.getState().focusComposer();
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type !== "slop:key" || !isChatKey(String(data.key), !!data.mod, !!data.shift, !!data.alt)) return;
      if (useApp.getState().presenting) return;
      useApp.getState().focusComposer();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
    };
  }, []);
}
