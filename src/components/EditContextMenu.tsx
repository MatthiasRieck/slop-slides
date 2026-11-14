import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useMenuKeys } from "../hooks/useMenuKeys";
import type { EditElement, StackOrder } from "../lib/editTools";
import { formatKeys } from "../lib/keys";
import { openLayer } from "../lib/layers";

export type EditMenuAction =
  | "edit-text"
  | "cut"
  | "copy"
  | "paste"
  | "duplicate"
  | "delete"
  | "select-all"
  | "copy-style"
  | "paste-style"
  | "ask"
  | "tidy"
  | "svg"
  | "flip-x"
  | "flip-y"
  | "group"
  | "ungroup"
  | "lock"
  | "unlock"
  | "unlock-all"
  | "background"
  | StackOrder;

const WIDTH = 240;

interface Item {
  action: EditMenuAction;
  label: string;
  /** The keys that do the same, as a `formatKeys` spec. */
  keys?: string;
}

const EDIT_TEXT: Item = { action: "edit-text", label: "Edit text", keys: "enter" };
const CUT: Item = { action: "cut", label: "Cut", keys: "mod+x" };
const COPY: Item = { action: "copy", label: "Copy", keys: "mod+c" };
const PASTE: Item = { action: "paste", label: "Paste", keys: "mod+v" };
const DUPLICATE: Item = { action: "duplicate", label: "Duplicate", keys: "mod+d" };
const DELETE: Item = { action: "delete", label: "Delete", keys: "backspace" };
const SELECT_ALL: Item = { action: "select-all", label: "Select all", keys: "mod+a" };
const COPY_STYLE: Item = { action: "copy-style", label: "Copy style", keys: "mod+alt+c" };
const PASTE_STYLE: Item = { action: "paste-style", label: "Paste style", keys: "mod+alt+v" };
const ORDER_ITEMS: Item[] = [
  { action: "front", label: "Bring to front", keys: "mod+shift+]" },
  { action: "forward", label: "Bring forward", keys: "mod+]" },
  { action: "backward", label: "Send backward", keys: "mod+[" },
  { action: "back", label: "Send to back", keys: "mod+shift+[" },
];
const FLIP_ITEMS: Item[] = [
  { action: "flip-x", label: "Flip horizontally", keys: "mod+shift+h" },
  { action: "flip-y", label: "Flip vertically", keys: "mod+shift+v" },
];
const GROUP: Item = { action: "group", label: "Group", keys: "mod+g" };
const UNGROUP: Item = { action: "ungroup", label: "Ungroup", keys: "mod+shift+g" };
const LOCK: Item = { action: "lock", label: "Lock", keys: "mod+alt+l" };
const UNLOCK: Item = { action: "unlock", label: "Unlock", keys: "mod+alt+l" };
const UNLOCK_ALL: Item = { action: "unlock-all", label: "Unlock all on this slide" };
const BACKGROUND: Item = { action: "background", label: "Slide background…" };
const TIDY: Item = { action: "tidy", label: "Tidy this element" };
const SVG: Item = { action: "svg", label: "Edit in the SVG editor" };

/** Whether `element` is a drawing, which the SVG editor opens. */
const isDrawing = (element: EditElement | null) => !!element && /^<svg[\s>]/i.test(element.markup.trimStart());

/**
 * The menu for a right-click in the slide editor. It lives in the app, not in the preview, so it
 * can reach past the slide; a cover over the preview catches the click that closes it. It takes
 * the focus from the preview, so the keys come here: the arrows, Home and End go through its
 * choices and Escape closes it (see `useMenuKeys`), and it gives the focus back as it closes.
 *
 * It offers only what applies to what was clicked: on an empty spot, pasting there, selecting
 * everything, unlocking and the slide's background; on a locked element, little more than
 * unlocking it; on anything else, what can be done to the selection.
 */
export function EditContextMenu(props: {
  x: number;
  y: number;
  /** What the right-click selected; null on an empty spot. */
  element: EditElement | null;
  /** Every selected element; without it, just `element`. */
  elements?: EditElement[];
  /** The one selected element holds text that can be edited. */
  editable?: boolean;
  /** Something on the slide is locked, which an empty spot's menu can unlock. */
  unlockable?: boolean;
  /** A look was copied, to paste onto the selection. */
  canPasteStyle?: boolean;
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

  const button = ({ action, label, keys }: Item, disabledReason?: string) => (
    <button
      key={action}
      type="button"
      role="menuitem"
      title={disabledReason}
      disabled={!!disabledReason}
      onClick={() => onAction(action)}
      className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1 text-left hover:bg-accent focus:bg-accent focus:outline-none disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {label}
      {keys && <span className="text-muted-foreground">{formatKeys(keys)}</span>}
    </button>
  );
  const divider = (key: string) => <hr key={key} className="my-1 border-border" />;

  const count = props.elements?.length ?? (element ? 1 : 0);
  const several = !!props.several || count > 1;
  const ask: Item = {
    action: "ask",
    label: several && count > 1 ? `Ask the agent about these ${count} elements…` : "Ask the agent about this…",
  };
  const busy = running ? "The agent is busy" : undefined;

  /** The menu's sections, each a run of choices; empty ones are left out, with a line between the rest. */
  const sections: ReactNode[][] = !element
    ? [[button(PASTE), button(SELECT_ALL), props.unlockable && button(UNLOCK_ALL)], [button(BACKGROUND)]]
    : props.locked
      ? [[button(UNLOCK), button(COPY)], [button(ask, busy)]]
      : [
          [props.editable && !several && button(EDIT_TEXT)],
          [button(CUT), button(COPY), button(PASTE), button(DUPLICATE), button(DELETE)],
          [button(COPY_STYLE), props.canPasteStyle && button(PASTE_STYLE)],
          ORDER_ITEMS.map((item) => button(item)),
          [several && button(GROUP), props.group && button(UNGROUP), button(LOCK)],
          // Each of several elements, and of what a group holds, flips if it can.
          props.flippable || several || props.group ? FLIP_ITEMS.map((item) => button(item)) : [],
          [button(ask, busy), element.added && !several && button(TIDY, busy)],
          [isDrawing(element) && !several && button(SVG)],
        ];
  const shown = sections.map((section) => section.filter(Boolean)).filter((section) => section.length > 0);

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
        aria-label={element ? "Element" : "Slide"}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{ ...position, width: WIDTH }}
        className="fixed rounded-lg border bg-card p-1 text-xs text-foreground shadow-lg outline-none"
      >
        {shown.flatMap((section, index) => (index > 0 ? [divider(`line-${index}`), ...section] : section))}
      </div>
    </div>
  );
}
