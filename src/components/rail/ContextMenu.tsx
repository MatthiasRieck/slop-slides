import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useMenuKeys } from "../../hooks/useMenuKeys";
import { formatKeys } from "../../lib/keys";
import { openLayer } from "../../lib/layers";
import { cn } from "../../lib/utils";

/** One choice of a context menu, or the line between two groups of them. */
export type MenuEntry =
  | "divider"
  | {
      label: string;
      /** The keys that do the same, as a `formatKeys` spec. */
      keys?: string;
      /** Why it cannot be picked just now; it shows, off, with this as its tooltip. */
      disabledReason?: string;
      /** It deletes or discards. */
      destructive?: boolean;
      run: () => void;
    };

const WIDTH = 232;
const MARGIN = 8;

/**
 * The menu of a right-click, at the pointer and kept on screen. A cover over the window catches
 * the press that closes it; the arrows go through its choices and Escape closes it (see
 * `useMenuKeys` and ../../lib/layers.ts), and no key reaches the shortcuts under it meanwhile.
 * Picking a choice closes the menu first, so the focus is back where it was when the choice runs.
 */
export function ContextMenu(props: { label: string; x: number; y: number; entries: MenuEntry[]; onClose: () => void }) {
  const { x, y, entries, onClose } = props;
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const height = menuRef.current?.offsetHeight ?? 0;
    setPosition({
      left: Math.max(MARGIN, Math.min(x, window.innerWidth - WIDTH - MARGIN)),
      top: Math.max(MARGIN, Math.min(y, window.innerHeight - height - MARGIN)),
    });
  }, [x, y]);

  const menu = useMenuKeys();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => openLayer(() => closeRef.current()), []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    menu.onKeyDown(event);
    // Escape goes on, to close the menu; nothing else reaches the shortcuts under it.
    if (event.key !== "Escape") event.stopPropagation();
  };

  return createPortal(
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the cover only catches a press outside the menu.
    // biome-ignore lint/a11y/noStaticElementInteractions: the cover only catches a press outside the menu.
    <div
      data-testid="context-menu-cover"
      className="fixed inset-0 z-50"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={(element) => {
          menuRef.current = element;
          return menu.ref(element);
        }}
        role="menu"
        aria-label={props.label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{ ...position, width: WIDTH }}
        className="fixed rounded-lg border bg-card p-1 text-xs text-foreground shadow-lg outline-none"
      >
        {entries.map((entry, i) =>
          entry === "divider" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: the entries of one menu never move
            <div key={i} className="my-1 h-px bg-border" />
          ) : (
            <button
              key={entry.label}
              type="button"
              role="menuitem"
              aria-disabled={entry.disabledReason !== undefined || undefined}
              title={entry.disabledReason}
              onClick={() => {
                if (entry.disabledReason !== undefined) return;
                onClose();
                entry.run();
              }}
              className={cn(
                "flex w-full items-center justify-between gap-3 rounded-md px-2 py-1 text-left focus:outline-none",
                entry.disabledReason !== undefined ? "cursor-default opacity-40" : "hover:bg-accent focus:bg-accent",
                entry.destructive &&
                  entry.disabledReason === undefined &&
                  "hover:text-destructive focus:text-destructive",
              )}
            >
              {entry.label}
              {entry.keys && <span className="text-muted-foreground">{formatKeys(entry.keys)}</span>}
            </button>
          ),
        )}
      </div>
    </div>,
    document.body,
  );
}
