import { X } from "lucide-react";
import {
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { focusableIn, focusTarget, restoreFocus, wrapTab } from "../lib/focus";
import { isTextField } from "../lib/keys";
import { openLayer } from "../lib/layers";
import { cn } from "../lib/utils";
import { ToolButton } from "./Button";

/** How wide a dialog's box is: `sm` for a question, `md` for a form, `lg` for what shows a lot. */
export type DialogSize = "sm" | "md" | "lg";

const WIDTHS: Record<DialogSize, string> = { sm: "w-96", md: "w-[32rem]", lg: "w-[44rem]" };

/** The box every dialog with a `size` gets: one surface, one edge, one shadow, never past the window. */
const BOX =
  "flex max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-xl border bg-card p-5 text-foreground shadow-dialog outline-none";

/** A dialog's heading: the question it asks or the name of what it shows. */
export function DialogTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 {...props} className={cn("text-sm font-semibold", className)} />;
}

/** What a dialog says under its heading. */
export function DialogText({ className, ...props }: ComponentProps<"p">) {
  return <p {...props} className={cn("selectable text-xs leading-relaxed text-muted-foreground", className)} />;
}

/**
 * The buttons at the bottom of a dialog, at its right: the one that stays first, the one that goes
 * ahead last. `aside` is a third way out that is neither (not saving, say), set apart at the left.
 */
export function DialogActions({
  aside,
  className,
  children,
}: {
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("mt-1 flex items-center justify-end gap-2", className)}>
      {aside !== undefined && <div className="mr-auto flex items-center gap-2">{aside}</div>}
      {children}
    </div>
  );
}

/** The app under a dialog: everything but what is rendered into the body beside it. */
const appRoot = () => document.getElementById("root");

/** How many dialogs are open; the app is out of reach while any is. */
let openDialogs = 0;

/** Takes the app out of reach of the pointer, the keyboard and assistive tech while a dialog is open. */
function holdApp(): () => void {
  if (openDialogs++ === 0) appRoot()?.setAttribute("inert", "");
  return () => {
    if (--openDialogs === 0) appRoot()?.removeAttribute("inert");
  };
}

/**
 * A modal dialog over the whole window: a scrim with a box in the middle, its heading on top.
 *
 * While it is open the rest of the app is out of reach (inert), and the keys are the dialog's:
 * - the focus moves in as it opens, to `initialFocus`, else to what is marked `autofocus` (or
 *   `data-autofocus`), else to its first control, else to the box; Tab stays inside;
 * - Escape closes it wherever the focus is, and nothing under it sees the key (unless
 *   `closeKeys` leaves Escape out); the other `closeKeys` close it too, unless typed in a field;
 * - closed, it gives the focus back to what had it (a slide preview, say).
 *
 * It renders into the body, so nothing it is used in clips it. The scrim fades in and the box
 * comes in with it (see `enter-fade` and `enter-pop` in src/index.css).
 *
 * Every dialog looks the same: give it a `size` and a `title` (and what it says as `description`),
 * its content, and its buttons in `DialogActions`. `className` then only adds to the box.
 */
export function Dialog(props: {
  /** The dialog's accessible name. */
  label: string;
  onClose: () => void;
  /** How wide the box is. With it, the box has the dialogs' one look; without, `className` is all of it. */
  size?: DialogSize;
  /** The box's classes: all of them without a `size`, else what is added to the standard box. */
  className?: string;
  /** The heading, in the dialogs' one style. */
  title?: ReactNode;
  /** What is said under the heading. */
  description?: ReactNode;
  /** What goes at the top of the box instead of a `title`: a heading of the caller's own. */
  heading?: ReactNode;
  /** The keys that close the dialog; Escape unless given. */
  closeKeys?: string[];
  /** Whether pressing the scrim around the box closes the dialog. */
  closeOnBackdrop?: boolean;
  /** Whether a Close button goes beside the heading. */
  closeButton?: boolean;
  /** What takes the focus as the dialog opens. */
  initialFocus?: RefObject<HTMLElement | null>;
  backdropTestId?: string;
  children: ReactNode;
}) {
  const { onClose, closeKeys = ["Escape"], initialFocus } = props;
  const boxRef = useRef<HTMLDivElement>(null);
  /** What had the focus before the dialog, read before anything in it takes the focus. */
  const [returnFocus] = useState(() => document.activeElement);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const closesOnEscape = closeKeys.includes("Escape");
  const otherKeys = useRef(closeKeys);
  otherKeys.current = closeKeys.filter((key) => key !== "Escape");

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const release = holdApp();
    // A control that focused itself as it mounted (React's `autoFocus`) keeps the focus.
    const active = document.activeElement;
    // What opened the dialog may have gone since (a menu's choice); then what has the focus now.
    const before = box.contains(active) || !active ? returnFocus : active;
    if (!box.contains(active)) (focusTarget(box, initialFocus) ?? focusableIn(box)[0] ?? box).focus();
    return () => {
      release();
      restoreFocus(box, before);
    };
  }, [initialFocus, returnFocus]);

  // On top of whatever else is open: Escape stops here, whether or not it closes the dialog. A
  // layout effect, so that it lies under what opens in the dialog as the dialog does.
  useLayoutEffect(() => openLayer(() => closesOnEscape && closeRef.current()), [closesOnEscape]);

  // A key pressed with the focus lost (what had it went away) is still the dialog's, not the app's.
  useEffect(() => {
    const onStray = (event: globalThis.KeyboardEvent) => {
      const box = boxRef.current;
      const target = event.target as Node | null;
      if (!box || event.key === "Escape" || !target || box.contains(target)) return;
      // What else is rendered into the body (a popover, the toasts) keeps its keys.
      if (target !== document.body && target !== document.documentElement && !appRoot()?.contains(target)) return;
      event.stopPropagation();
      if (otherKeys.current.includes(event.key)) {
        event.preventDefault();
        closeRef.current();
      } else if (wrapTab(box, event)) event.preventDefault();
      else box.focus();
    };
    document.addEventListener("keydown", onStray, true);
    return () => document.removeEventListener("keydown", onStray, true);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Escape goes on to close what is on top (see ../lib/layers.ts), which a field in the dialog
    // lets through here; nothing else reaches the app's shortcuts while the dialog is open.
    if (event.key === "Escape") return;
    event.stopPropagation();
    if (otherKeys.current.includes(event.key) && !isTextField(event.target)) {
      event.preventDefault();
      onClose();
    } else if (wrapTab(event.currentTarget, event)) {
      event.preventDefault();
    }
  };

  const sized = props.size !== undefined;
  const title = props.title !== undefined ? <DialogTitle>{props.title}</DialogTitle> : props.heading;
  const header = props.closeButton ? (
    <div className={cn("flex items-center justify-between", !sized && "mb-3")}>
      {title}
      <ToolButton variant="panel" label="Close" onClick={onClose}>
        <X />
      </ToolButton>
    </div>
  ) : props.title !== undefined ? (
    title
  ) : (
    title !== undefined && <div>{title}</div>
  );

  return createPortal(
    <div
      data-testid={props.backdropTestId}
      className="enter-fade fixed inset-0 z-overlay flex items-center justify-center bg-scrim"
      onPointerDown={
        props.closeOnBackdrop
          ? (event) => {
              if (event.target === event.currentTarget) onClose();
            }
          : undefined
      }
    >
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: a dialog keeps the keys pressed in it. */}
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cn("enter-pop", props.size !== undefined && [BOX, WIDTHS[props.size]], props.className)}
      >
        {header}
        {/* Close under the heading it explains. */}
        {props.description !== undefined && <DialogText className="-mt-1.5">{props.description}</DialogText>}
        {props.children}
      </div>
    </div>,
    document.body,
  );
}
