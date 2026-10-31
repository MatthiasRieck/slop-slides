import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { EditElement, StackOrder } from "../lib/editTools";

export type EditMenuAction = "cut" | "copy" | "paste" | "duplicate" | "delete" | "ask" | "tidy" | StackOrder;

const WIDTH = 224;

interface Item {
  action: EditMenuAction;
  label: string;
  keys?: string;
}

const EDIT_ITEMS: Item[] = [
  { action: "cut", label: "Cut", keys: "⌘X" },
  { action: "copy", label: "Copy", keys: "⌘C" },
  { action: "paste", label: "Paste", keys: "⌘V" },
  { action: "duplicate", label: "Duplicate", keys: "⌘D" },
  { action: "delete", label: "Delete", keys: "⌫" },
];
const ORDER_ITEMS: Item[] = [
  { action: "front", label: "Bring to front" },
  { action: "forward", label: "Bring forward" },
  { action: "backward", label: "Send backward" },
  { action: "back", label: "Send to back" },
];
const ASK: Item = { action: "ask", label: "Ask the agent about this…" };
const TIDY: Item = { action: "tidy", label: "Tidy this element" };

/**
 * The menu for a right-click in the slide editor. It lives in the app, not in the preview, so it
 * can reach past the slide; a cover over the preview catches the click that closes it.
 */
export function EditContextMenu(props: {
  x: number;
  y: number;
  /** What the right-click selected; null on an empty spot, where only pasting applies. */
  element: EditElement | null;
  /** The agent is busy, so it cannot take on more. */
  running: boolean;
  onAction: (action: EditMenuAction) => void;
  onClose: () => void;
}) {
  const { x, y, element, running, onAction, onClose } = props;
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const height = menuRef.current?.offsetHeight ?? 0;
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - WIDTH - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
    });
  }, [x, y]);

  // Takes focus from the preview, so the keys come here.
  useEffect(() => menuRef.current?.focus(), []);

  const onKeyDown = (event: KeyboardEvent) => {
    // Nothing reaches the stage's shortcuts while the menu is open.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? []);
      const at = items.indexOf(document.activeElement as HTMLElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[at < 0 && step < 0 ? items.length - 1 : (at + step + items.length) % items.length]?.focus();
    }
  };

  const button = ({ action, label, keys }: Item, disabled: boolean, title?: string) => (
    <button
      key={action}
      type="button"
      role="menuitem"
      title={title}
      disabled={disabled}
      onClick={() => onAction(action)}
      className="flex w-full items-center justify-between rounded-md px-2 py-1 text-left hover:bg-accent focus:bg-accent focus:outline-none disabled:pointer-events-none disabled:opacity-40"
    >
      {label}
      {keys && <span className="text-muted-foreground">{keys}</span>}
    </button>
  );
  const divider = <div className="my-1 h-px bg-border" />;

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the cover only catches a press outside the menu.
    // biome-ignore lint/a11y/noStaticElementInteractions: the cover only catches a press outside the menu.
    <div
      data-testid="edit-menu-cover"
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
        ref={menuRef}
        role="menu"
        aria-label="Element"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{ ...position, width: WIDTH }}
        className="fixed rounded-lg border bg-card p-1 text-xs text-foreground shadow-lg outline-none"
      >
        {EDIT_ITEMS.map((item) => button(item, item.action !== "paste" && !element))}
        {divider}
        {ORDER_ITEMS.map((item) => button(item, !element))}
        {divider}
        {button(ASK, !element || running)}
        {button(
          TIDY,
          !element?.added || running,
          element?.added ? undefined : "Only for elements you added or dropped on the slide",
        )}
      </div>
    </div>
  );
}
