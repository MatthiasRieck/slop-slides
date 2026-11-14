import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useMemo, useState } from "react";
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

/** Marks the part of the window the toasts sit in: the slide's area, clear of the sidebar (see ../App.tsx). */
export const TOAST_AREA = "data-toast-area";

/** How far over the bottom of their area the toasts sit, clear of the bar under the slide. */
const AREA_BOTTOM = 56;

const EVERYWHERE: CSSProperties = {};

/**
 * Where the toasts go while there are `any`: at the bottom centre of the slide's area, where no
 * control is, so that none covers the chat's composer or the sidebar's footer. Without that area
 * (the start screen), or with it covered (the maximized sidebar, a slide show), at the bottom
 * centre of the window, as the classes place them.
 */
function useToastPlace(any: boolean): CSSProperties {
  const covered = useApp((s) => s.sidebarMaximized || s.presenting);
  const [place, setPlace] = useState(EVERYWHERE);
  useLayoutEffect(() => {
    const area = any && !covered ? document.querySelector(`[${TOAST_AREA}]`) : null;
    if (!area) return setPlace(EVERYWHERE);
    const measure = () => {
      const rect = area.getBoundingClientRect();
      if (rect.width === 0) return setPlace(EVERYWHERE);
      setPlace({
        left: Math.round(rect.left + rect.width / 2),
        bottom: Math.round(window.innerHeight - rect.bottom + AREA_BOTTOM),
        maxWidth: Math.max(0, rect.width - 32),
      });
    };
    measure();
    // The area changes its size with the window and with the panels beside it.
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [any, covered]);
  return place;
}

/**
 * What the app has to tell the user (see `showError`, `showInfo` and `showSuccess` in ../store.ts),
 * stacked at the bottom centre of the slide's area over everything else, the newest last. Errors
 * stay until dismissed; the others go away by themselves. Escape dismisses the newest, once
 * nothing else is open to close. A toast rises in and sinks out; one on its way out is out of reach.
 *
 * During a slide show nothing shows over the slide but what is about the show itself: the rest
 * waits, and shows when the show ends (its time to go away starts then).
 */
export function Toasts() {
  const all = useApp((s) => s.toasts);
  const presenting = useApp((s) => s.presenting);
  const toasts = useMemo(() => (presenting ? all.filter((toast) => toast.duringShow) : all), [all, presenting]);
  const leaving = useLeavingToasts(toasts);
  const any = toasts.length > 0;
  const place = useToastPlace(any || leaving.length > 0);

  useEffect(() => {
    if (!any) return;
    const dismissNewest = () => {
      const { toasts: said, presenting: showing, dismissToast } = useApp.getState();
      const newest = said.findLast((toast) => !showing || toast.duringShow);
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
      style={place}
      className="pointer-events-none fixed bottom-4 left-1/2 z-toast flex w-96 max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col gap-2"
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
  /** Whether the whole of what went wrong shows under its gist. */
  const [detailed, setDetailed] = useState(false);
  const [copied, setCopied] = useState(false);
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
        "rounded-lg border bg-card py-2 pr-1.5 pl-3 text-sm shadow-popover [&_svg]:size-4",
        leaving ? "toast-exit" : "toast-enter pointer-events-auto",
        look.box,
      )}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">{look.icon}</span>
        <span className={cn("selectable max-h-40 min-w-0 flex-1 overflow-y-auto break-words", look.text)}>
          {toast.text}
        </span>
        {toast.details !== undefined && (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            aria-expanded={detailed}
            onClick={() => setDetailed(!detailed)}
          >
            Details
          </Button>
        )}
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
      {detailed && toast.details !== undefined && (
        <div className="mt-2 mr-1.5 flex flex-col items-end gap-1.5">
          <pre className="selectable max-h-32 w-full overflow-auto rounded-md bg-muted p-2 font-mono text-2xs whitespace-pre-wrap break-words text-muted-foreground">
            {toast.details}
          </pre>
          <Button variant="ghost" size="sm" onClick={() => void copyText(toast.details ?? "").then(setCopied)}>
            {copied ? "Copied" : "Copy details"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Puts `text` on the clipboard; false when the clipboard is not to be had. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
