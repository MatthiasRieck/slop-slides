import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { openLayer } from "../lib/layers";
import { prefersReducedMotion } from "../lib/motion";
import { cn } from "../lib/utils";
import { type Toast, type ToastKind, useApp } from "../store";
import { Button, ToolButton } from "./Button";

/** How long a toast that is no error stays, unless the pointer or the focus is on it. */
export const TOAST_MS = 6000;

/** How long a dismissed toast takes to leave (`toast-exit` in src/index.css). */
export const TOAST_EXIT_MS = 140;

/**
 * The toasts just dismissed, kept for as long as they take to leave; none for those who asked
 * for less motion, whose toasts are gone at once.
 */
function useLeavingToasts(toasts: Toast[]): Toast[] {
  const [shown, setShown] = useState(toasts);
  const [leaving, setLeaving] = useState<Toast[]>([]);
  // Adjusted while rendering, so a dismissed toast never drops out for a frame before it leaves.
  if (shown !== toasts) {
    setShown(toasts);
    const gone = shown.filter((toast) => !toasts.some((t) => t.id === toast.id));
    if (gone.length > 0 && !prefersReducedMotion()) setLeaving([...leaving, ...gone]);
  }
  useEffect(() => {
    if (leaving.length === 0) return;
    const timer = setTimeout(() => setLeaving([]), TOAST_EXIT_MS);
    return () => clearTimeout(timer);
  }, [leaving]);
  return leaving;
}

const LOOKS: Record<ToastKind, { box: string; text: string; icon: ReactNode }> = {
  error: {
    box: "border-destructive/30",
    text: "text-destructive",
    icon: <CircleAlert className="text-destructive" />,
  },
  info: { box: "", text: "text-foreground", icon: <Info className="text-primary" /> },
  success: { box: "", text: "text-foreground", icon: <CheckCircle2 className="text-success" /> },
};

/**
 * What the app has to tell the user (see `showError`, `showInfo` and `showSuccess` in ../store.ts),
 * stacked at the bottom right of the window over everything else, the newest last. Errors stay
 * until dismissed; the others go away by themselves. Escape dismisses the newest, once nothing
 * else is open to close. A toast rises in and sinks out; one on its way out is out of reach.
 */
export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const leaving = useLeavingToasts(toasts);
  const any = toasts.length > 0;

  useEffect(() => {
    if (!any) return;
    const dismissNewest = () => {
      const { toasts: shown, dismissToast } = useApp.getState();
      const newest = shown.at(-1);
      if (newest) dismissToast(newest.id);
    };
    return openLayer(dismissNewest, { base: true });
  }, [any]);

  if (!any && leaving.length === 0) return null;
  // In the order they were said, those leaving in their places.
  const cards = [...toasts, ...leaving].sort((a, b) => a.id - b.id);
  // In the body, so that a dialog, which takes the rest of the app out of reach, leaves them in it.
  return createPortal(
    <div
      data-testid="toasts"
      className="pointer-events-none fixed right-4 bottom-4 z-[70] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {cards.map((toast) => (
        <ToastCard key={toast.id} toast={toast} leaving={leaving.includes(toast)} />
      ))}
    </div>,
    document.body,
  );
}

function ToastCard({ toast, leaving }: { toast: Toast; leaving: boolean }) {
  const look = LOOKS[toast.kind];
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const stays = toast.kind === "error" || hovered || focused || leaving;
  const dismiss = () => useApp.getState().dismissToast(toast.id);

  useEffect(() => {
    if (stays) return;
    const timer = setTimeout(() => useApp.getState().dismissToast(toast.id), TOAST_MS);
    return () => clearTimeout(timer);
  }, [stays, toast.id]);

  return (
    // The pointer and the focus on it only keep it from going away.
    <div
      role={leaving ? undefined : toast.kind === "error" ? "alert" : "status"}
      aria-hidden={leaving || undefined}
      inert={leaving}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      className={cn(
        "flex items-start gap-2 rounded-lg border bg-card py-2 pr-1.5 pl-3 text-sm shadow-lg [&_svg]:size-4",
        leaving ? "toast-exit" : "toast-enter pointer-events-auto",
        look.box,
      )}
    >
      <span className="mt-0.5 shrink-0">{look.icon}</span>
      <span className={cn("selectable max-h-40 min-w-0 flex-1 overflow-y-auto break-words", look.text)}>
        {toast.text}
      </span>
      {toast.action && (
        <Button
          size="sm"
          className="shrink-0"
          onClick={() => {
            toast.action?.run();
            dismiss();
          }}
        >
          {toast.action.label}
        </Button>
      )}
      <ToolButton variant="panel" label="Dismiss" className="shrink-0" onClick={dismiss}>
        <X />
      </ToolButton>
    </div>
  );
}
