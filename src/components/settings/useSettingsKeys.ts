import { useEffect } from "react";

import { isMod, isTypingTarget } from "../../lib/keys";
import { useApp } from "../../store";

/** Whether the keys ask for the shortcuts: `?` outside of typing, or ⌘/ anywhere nothing else took it. */
function asksForShortcuts(event: KeyboardEvent): boolean {
  if (event.altKey) return false;
  if (event.key === "/") return isMod(event) && !event.defaultPrevented;
  return event.key === "?" && !event.metaKey && !event.ctrlKey && !isTypingTarget(event.target);
}

/**
 * The keys that open the app's settings on its keyboard shortcuts: `?` (unless the user is
 * typing), ⌘/, and either pressed in a slide preview, which forwards its keys. Not during a show,
 * whose keys are the show's. (⌘, opens the settings on General: a shell shortcut, see
 * ../../hooks/useShellKeys.ts.) Used once, by the window.
 */
export function useSettingsKeys() {
  useEffect(() => {
    const show = () => {
      const app = useApp.getState();
      if (!app.presenting) app.openSettings("keyboard");
    };
    const onKey = (event: KeyboardEvent) => {
      if (!asksForShortcuts(event)) return;
      event.preventDefault();
      show();
    };
    const onMessage = (event: MessageEvent) => {
      const { type, key, mod } = event.data ?? {};
      if (type !== "slop:key" || !(key === "?" ? !mod : key === "/" && mod)) return;
      if (Array.from(document.querySelectorAll("iframe")).some((f) => f.contentWindow === event.source)) show();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
    };
  }, []);
}
