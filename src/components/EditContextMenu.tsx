import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useMenuKeys } from "../hooks/useMenuKeys";
import type { EditElement, StackOrder } from "../lib/editTools";
import { formatKeys } from "../lib/keys";
import { openLayer } from "../lib/layers";

export type EditMenuAction =
  | "cut"
  | "copy"
  | "paste"
  | "duplicate"
  | "delete"
  | "ask"
  | "tidy"
  | "svg"
  | "flip-x"
  | "flip-y"
  | "group"
  | "ungroup"
  | "lock"
  | "unlock"
  | StackOrder;

const WIDTH = 224;

interface Item {
  action: EditMenuAction;
  label: string;
  /** The keys that do the same, as a `formatKeys` spec. */
  keys?: string;
}

const EDIT_ITEMS: Item[] = [
  { action: "cut", label: "Cut", keys: "mod+x" },
  { action: "copy", label: "Copy", keys: "mod+c" },
  { action: "paste", label: "Paste", keys: "mod+v" },
  { action: "duplicate", label: "Duplicate", keys: "mod+d" },
  { action: "delete", label: "Delete", keys: "backspace" },
];
const ORDER_ITEMS: Item[] = [
  { action: "front", label: "Bring to front" },
  { action: "forward", label: "Bring forward" },
  { action: "backward", label: "Send backward" },
  { action: "back", label: "Send to back" },
];
const FLIP_ITEMS: Item[] = [
  { action: "flip-x", label: "Flip horizontally" },
  { action: "flip-y", label: "Flip vertically" },
];
const GROUP: Item = { action: "group", label: "Group", keys: "mod+g" };
const UNGROUP: Item = { action: "ungroup", label: "Ungroup", keys: "mod+shift+g" };
const LOCK: Item = { action: "lock", label: "Lock" };
const UNLOCK: Item = { action: "unlock", label: "Unlock" };
const ASK: Item = { action: "ask", label: "Ask the agent about this…" };
const TIDY: Item = { action: "tidy", label: "Tidy this element" };
const SVG: Item = { action: "svg", label: "Edit in the SVG editor" };

/** Whether `element` is a drawing, which the SVG editor opens. */
const isDrawing = (element: EditElement | null) => !!element && /^<svg[\s>]/i.test(element.markup.trimStart());

/**
 * The menu for a right-click in the slide editor. It lives in the app, not in the preview, so it
 * can reach past the slide; a cover over the preview catches the click that closes it. It takes
 * the focus from the preview, so the keys come here: the arrows go through its choices and Escape
 * closes it (see `useMenuKeys`), and it gives the focus back as it closes.
 */
export function EditContextMenu(props: {
  x: number;
  y: number;
  /** What the right-click selected; null on an empty spot, where only pasting applies. */
  element: EditElement | null;
  /** The agent is busy, so it cannot take on more. */
  running: boolean;
  /** Whether the selection can be flipped (see `flippable` in EditSelection); flips show only then. */
  flippable?: boolean;
  /** Several elements are selected, which can be grouped. */
  several?: boolean;
  /** The selection is a group, which can be taken apart. */
  group?: boolean;
  /** The selection is locked. */
  locked?: boolean;
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

  const menu = useMenuKeys();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Escape closes the menu, and nothing under it sees the key.
  useEffect(() => openLayer(() => closeRef.current()), []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    menu.onKeyDown(event);
    // Nothing reaches the stage's shortcuts while the menu is open; Escape goes on, to close it.
    if (event.key !== "Escape") event.stopPropagation();
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
      {keys && <span className="text-muted-foreground">{formatKeys(keys)}</span>}
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
        ref={(element) => {
          menuRef.current = element;
          return menu.ref(element);
        }}
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
        {button(GROUP, !element || !props.several)}
        {button(UNGROUP, !element || !props.group)}
        {button(props.locked ? UNLOCK : LOCK, !element)}
        {divider}
        {element && props.flippable && (
          <>
            {FLIP_ITEMS.map((item) => button(item, false))}
            {divider}
          </>
        )}
        {button(ASK, !element || running)}
        {button(
          TIDY,
          !element?.added || running,
          element?.added ? undefined : "Only for elements you added or dropped on the slide",
        )}
        {isDrawing(element) && (
          <>
            {divider}
            {button(SVG, false)}
          </>
        )}
      </div>
    </div>
  );
}
