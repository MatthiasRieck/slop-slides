import { X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";

/**
 * A modal dialog over the whole window: a scrim with a box in the middle, its heading on top.
 *
 * It comes in two kinds:
 * - by default, a native `<dialog open>` that closes on Escape pressed anywhere in the window;
 * - with `takeFocus`, a focusable `role="dialog"` that takes the focus when it opens (from a slide
 *   preview, say), keeps the keys pressed in it from the rest of the page, closes on any of
 *   `closeKeys` and gives the focus back when it closes.
 */
export function Dialog(props: {
  /** The dialog's accessible name. */
  label: string;
  onClose: () => void;
  /** The box's classes. */
  className: string;
  /** What goes at the top of the box: the heading, and anything said under it. */
  heading: ReactNode;
  takeFocus?: boolean;
  /** With `takeFocus`, the keys that close the dialog. */
  closeKeys?: string[];
  /** Whether pressing the scrim around the box closes the dialog. */
  closeOnBackdrop?: boolean;
  /** Whether a Close button goes beside the heading. */
  closeButton?: boolean;
  backdropTestId?: string;
  children: ReactNode;
}) {
  const { onClose, takeFocus = false, closeKeys = ["Escape"] } = props;
  const boxRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (takeFocus) return;
    const onKey = (event: globalThis.KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [takeFocus, onClose]);

  // Takes focus from wherever it was (a slide preview), so Escape closes this rather than reaching it.
  useEffect(() => {
    if (!takeFocus) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    boxRef.current?.focus();
  }, [takeFocus]);

  const close = () => {
    onClose();
    if (takeFocus) returnFocus.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (closeKeys.includes(event.key)) {
      event.preventDefault();
      close();
    }
  };

  const heading = props.closeButton ? (
    <div className="mb-3 flex items-center justify-between">
      {props.heading}
      <button
        type="button"
        aria-label="Close"
        onClick={close}
        className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="size-4" />
      </button>
    </div>
  ) : (
    <div>{props.heading}</div>
  );

  return (
    <div
      data-testid={props.backdropTestId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      onPointerDown={
        props.closeOnBackdrop
          ? (event) => {
              if (event.target === event.currentTarget) close();
            }
          : undefined
      }
    >
      {takeFocus ? (
        // biome-ignore lint/a11y/noNoninteractiveElementInteractions: a dialog that takes focus handles its own keys.
        <div
          ref={boxRef}
          role="dialog"
          aria-label={props.label}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className={props.className}
        >
          {heading}
          {props.children}
        </div>
      ) : (
        <dialog open aria-label={props.label} className={props.className}>
          {heading}
          {props.children}
        </dialog>
      )}
    </div>
  );
}
