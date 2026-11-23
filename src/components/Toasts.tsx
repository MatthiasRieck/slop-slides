import { useEffect, useRef } from "react";

import { Toaster, toast } from "@/components/ui/toast";
import { openLayer } from "../lib/layers";
import { useApp } from "../store";
import { MAX_TOASTS } from "../store/ui";

/** How long a toast that is no error stays, unless the pointer or the focus is on it. */
export const TOAST_MS = 6000;

/**
 * What the app has to tell the user (see `showError`, `showInfo` and `showSuccess` in ../store.ts),
 * as shadcn toasts at the bottom right of the window, over everything else. The store is what the
 * app talks to; this is the one place that hands its toasts to the toaster, and that mounts it.
 * Errors stay until dismissed; the others go away by themselves, unless the pointer or the focus
 * is on them. Escape dismisses the newest, once nothing else is open to close.
 */
export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  /** The store's toasts the toaster has been given. */
  const shown = useRef(new Set<number>());
  const any = toasts.length > 0;

  useEffect(() => {
    for (const t of toasts) {
      if (shown.current.has(t.id)) continue;
      shown.current.add(t.id);
      const { action } = t;
      toast.add({
        id: String(t.id),
        type: t.kind,
        title: t.text,
        // 0: it stays until dismissed.
        timeout: t.kind === "error" ? 0 : TOAST_MS,
        // An error is said at once; the rest wait for a pause.
        priority: t.kind === "error" ? "high" : "low",
        ...(action && {
          actionProps: {
            children: action.label,
            onClick: () => {
              action.run();
              useApp.getState().dismissToast(t.id);
            },
          },
        }),
        // Closed here (its button, its time running out, a swipe): the store follows.
        onClose: () => useApp.getState().dismissToast(t.id),
      });
    }
    // Dismissed in the store (Escape, an action, the app itself): the toaster follows.
    for (const id of shown.current) {
      if (toasts.some((t) => t.id === id)) continue;
      shown.current.delete(id);
      toast.close(String(id));
    }
  }, [toasts]);

  // Gone (a window closing, a test ending), it leaves nothing behind in the toaster, which outlives it.
  useEffect(() => {
    const given = shown.current;
    return () => {
      for (const id of given) toast.close(String(id));
      given.clear();
    };
  }, []);

  useEffect(() => {
    if (!any) return;
    const dismissNewest = () => {
      const { toasts: current, dismissToast } = useApp.getState();
      const newest = current.at(-1);
      if (newest) dismissToast(newest.id);
    };
    return openLayer(dismissNewest, { base: true });
  }, [any]);

  return <Toaster limit={MAX_TOASTS} />;
}
