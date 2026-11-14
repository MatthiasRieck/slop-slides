import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "../lib/utils";

/** How long the pointer rests on a control before its tooltip shows. */
export const TOOLTIP_DELAY_MS = 500;

/** How long after a tooltip went away the next control's shows at once: moving along a toolbar reads each. */
export const TOOLTIP_WARM_MS = 400;

/** How often a tooltip that shows checks that its control is still there. */
const STALE_CHECK_MS = 500;

/** The keys that do the same as the control, already formatted ("⌘G"), which its `title` ends with in brackets. */
export const TIP_KEYS = "data-tip-keys";

/** What a disabled control is called, when its `title` says why it is disabled instead. */
export const TIP_LABEL = "data-tip-label";

/** Where a control's `title` is kept while the pointer is on it, so the browser's own tooltip stays away. */
const HELD_TITLE = "data-tip-title";

/** The keys that move the focus: a control focused right after one of them shows its tooltip. */
const FOCUS_KEYS = new Set(["Tab", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

/** How long after such a key a focus still counts as the keyboard's. */
const FOCUS_KEY_MS = 100;

/** How long after such a key scrolling is the browser's, bringing the focused control into view. */
const FOCUS_SCROLL_MS = 300;

const GAP = 6;
const MARGIN = 4;

/** A tooltip that shows: what it says and where its control is. */
export interface Tip {
  /** The control's place in the window. */
  rect: DOMRect;
  /** What the control does; for a disabled one with a reason, what it is called. */
  text: string;
  /** The keys that do the same. */
  keys: string | null;
  /** Why the control is disabled, under its name. */
  reason: string | null;
  /** Whether it follows another tooltip, and so is just there. */
  instant: boolean;
  /** Whether the control is in a part of the app that stays dark (the presenter's tools). */
  dark: boolean;
}

/** What a control's tooltip says, from its `title` and the attributes `ToolButton` adds to it. */
export function tipText(
  title: string,
  keys: string | null,
  label: string | null,
): Pick<Tip, "text" | "keys" | "reason"> {
  if (label !== null && label !== title) return { text: label, keys: null, reason: title };
  const suffix = keys ? ` (${keys})` : "";
  return suffix && title.endsWith(suffix)
    ? { text: title.slice(0, -suffix.length), keys, reason: null }
    : { text: title, keys: null, reason: null };
}

/** The control under `target` that has a tooltip; a frame's title names it and is no tooltip. */
function tipAnchor(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest(`[title], [${HELD_TITLE}]`);
  if (!anchor || anchor instanceof HTMLIFrameElement) return null;
  return (anchor.getAttribute(HELD_TITLE) ?? anchor.getAttribute("title")) ? anchor : null;
}

/**
 * Watches the document for controls with a `title` and tells `show` which tooltip to show (null
 * for none): after the pointer rested on one for `TOOLTIP_DELAY_MS`, at once when another tooltip
 * just showed, and at once when the keyboard moves the focus to one. It goes away when the pointer
 * or the focus leaves, on a press, on any key and when something scrolls. One shows at a time.
 *
 * While the pointer is on a control its `title` is held in another attribute, which keeps the
 * browser's tooltip from showing as well; it is back as soon as the pointer leaves. A browser that
 * tells the page nothing about the pointer on a disabled control still shows that title itself.
 *
 * It costs a handful of listeners on the document, whatever the number of controls, and reads no
 * layout until a tooltip shows. Returns what stops the watching.
 */
export function watchTooltips(show: (tip: Tip | null) => void): () => void {
  let anchor: Element | null = null;
  /** Whether `anchor` got its tooltip from the keyboard's focus, not the pointer. */
  let byFocus = false;
  let shown = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let staleCheck: ReturnType<typeof setInterval> | undefined;
  /** When a tooltip the pointer left last went away. */
  let hiddenAt = Number.NEGATIVE_INFINITY;
  /** The control pressed last: its tooltip stays away until the pointer has left it. */
  let pressed: Element | null = null;
  let focusKeyAt = Number.NEGATIVE_INFINITY;

  const titleOf = (element: Element) => element.getAttribute(HELD_TITLE) ?? element.getAttribute("title") ?? "";

  /** Takes the title out of the browser's sight. */
  const hold = (element: Element) => {
    const title = element.getAttribute("title");
    if (title === null) return;
    element.setAttribute(HELD_TITLE, title);
    element.removeAttribute("title");
  };

  // The control's title changing under the pointer (a toggle's, say) changes the tooltip with it.
  const observer = new MutationObserver(() => {
    if (!anchor?.hasAttribute("title")) return;
    hold(anchor);
    if (shown) reveal(true);
  });

  const reveal = (instant: boolean) => {
    if (!anchor?.isConnected) return leave(false);
    const title = titleOf(anchor);
    if (!title) return leave(false);
    shown = true;
    staleCheck ??= setInterval(() => !anchor?.isConnected && leave(false), STALE_CHECK_MS);
    show({
      ...tipText(title, anchor.getAttribute(TIP_KEYS), anchor.getAttribute(TIP_LABEL)),
      rect: anchor.getBoundingClientRect(),
      instant,
      dark: anchor.closest(".dark") !== null,
    });
  };

  /** Drops the tooltip, shown or still waiting; `warm` when the next one may show at once. */
  const leave = (warm: boolean) => {
    if (!anchor) return;
    clearTimeout(timer);
    clearInterval(staleCheck);
    staleCheck = undefined;
    observer.disconnect();
    document.removeEventListener("scroll", onScroll, true);
    const held = anchor.getAttribute(HELD_TITLE);
    if (held !== null) {
      anchor.setAttribute("title", held);
      anchor.removeAttribute(HELD_TITLE);
    }
    if (shown) {
      hiddenAt = warm ? performance.now() : Number.NEGATIVE_INFINITY;
      show(null);
    }
    shown = false;
    anchor = null;
  };

  const enter = (next: Element, focused: boolean) => {
    leave(true);
    anchor = next;
    byFocus = focused;
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    if (focused) return reveal(false);
    hold(next);
    observer.observe(next, { attributes: true, attributeFilter: ["title"] });
    if (performance.now() - hiddenAt < TOOLTIP_WARM_MS) reveal(true);
    else timer = setTimeout(() => reveal(false), TOOLTIP_DELAY_MS);
  };

  function onScroll() {
    // Focusing a control scrolls it into view first; that scrolling is not the user's.
    if (byFocus && performance.now() - focusKeyAt < FOCUS_SCROLL_MS) return;
    leave(false);
  }
  const onPointerOver = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    const next = tipAnchor(event.target);
    if (next !== pressed) pressed = null;
    if (next === anchor && !byFocus) return;
    if (next && next !== pressed) enter(next, false);
    else leave(true);
  };
  // Out of the window, or into a slide's frame.
  const onPointerOut = (event: PointerEvent) => {
    if (event.relatedTarget === null && !byFocus) leave(true);
  };
  const onPointerDown = () => {
    pressed = anchor && !byFocus ? anchor : pressed;
    leave(false);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (FOCUS_KEYS.has(event.key)) focusKeyAt = performance.now();
    leave(false);
  };
  const onFocusIn = (event: FocusEvent) => {
    if (performance.now() - focusKeyAt > FOCUS_KEY_MS) return;
    const next = tipAnchor(event.target);
    if (next) enter(next, true);
  };
  const onFocusOut = () => {
    if (byFocus) leave(false);
  };
  const onBlur = () => leave(false);

  document.addEventListener("pointerover", onPointerOver);
  document.addEventListener("pointerout", onPointerOut);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  window.addEventListener("blur", onBlur);
  return () => {
    leave(false);
    document.removeEventListener("pointerover", onPointerOver);
    document.removeEventListener("pointerout", onPointerOut);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
    window.removeEventListener("blur", onBlur);
  };
}

/** Where a tooltip of `size` goes for a control at `rect`: centered under it, over it when there is no room, inside the window. */
export function placeTip(
  rect: Pick<DOMRect, "left" | "top" | "bottom" | "width">,
  size: { width: number; height: number },
  view: { width: number; height: number },
): { left: number; top: number } {
  const centered = rect.left + rect.width / 2 - size.width / 2;
  const left = Math.max(MARGIN, Math.min(centered, view.width - size.width - MARGIN));
  const below = rect.bottom + GAP;
  const fitsBelow = below + size.height <= view.height - MARGIN;
  const above = rect.top - GAP - size.height;
  // With room on neither side (a control as tall as the window), on the control rather than out of sight.
  const top = fitsBelow ? below : above >= MARGIN ? above : view.height - size.height - MARGIN;
  return { left: Math.round(left), top: Math.round(top) };
}

/**
 * The app's tooltips: what a control does and the keys that do the same, shown beside whatever
 * has a `title` (see `watchTooltips` for when). Mounted once per window. `ToolButton` and `Button`
 * give their tooltip as that `title`; anything else with a `title` gets the same look for free.
 *
 * The control keeps its accessible name (`aria-label`) and, at rest, its `title`; the tooltip
 * itself is for the eye only and takes no pointer. A disabled control's shows its name and, under
 * it, why it is disabled.
 */
export function Tooltips() {
  const [tip, setTip] = useState<Tip | null>(null);
  useEffect(() => watchTooltips(setTip), []);
  return tip && createPortal(<TipBox tip={tip} />, document.body);
}

function TipBox({ tip }: { tip: Tip }) {
  const box = useRef<HTMLDivElement>(null);
  // Placed before it is painted, once its size is known.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    const { left, top } = placeTip(
      tip.rect,
      { width, height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  }, [tip]);
  return (
    <div className={cn(tip.dark && "dark")}>
      <div
        ref={box}
        role="tooltip"
        data-testid="tooltip"
        className={cn(
          "pointer-events-none fixed top-0 left-0 z-tooltip w-max max-w-72 rounded-md border border-background/20 bg-foreground px-2 py-1 text-xs text-background shadow-popover",
          !tip.instant && "enter-fade",
        )}
      >
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 break-words">{tip.text}</span>
          {tip.keys && <kbd className="shrink-0 font-sans text-background/65">{tip.keys}</kbd>}
        </div>
        {tip.reason && <div className="break-words text-background/65">{tip.reason}</div>}
      </div>
    </div>
  );
}
