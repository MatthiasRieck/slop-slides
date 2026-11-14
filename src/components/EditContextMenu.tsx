import { ChevronRight } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useMenuKeys } from "../hooks/useMenuKeys";
import type { AlignTo } from "../lib/arrange";
import type { EditElement, EditLayerPick, StackOrder } from "../lib/editTools";
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
  | "comment"
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
  | "select-parent"
  | "link"
  | "replace-image"
  | "position"
  | "rotate-right"
  | "rotate-left"
  /** Lines the selection up: one element with the slide, several with each other. */
  | `align-${AlignTo}`
  | "distribute-h"
  | "distribute-v"
  /** Selects the element at this index of what lay under the pointer (see `under`). */
  | `select-under-${number}`
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
  { action: "flip-x", label: "Flip horizontally", keys: "mod+alt+shift+h" },
  { action: "flip-y", label: "Flip vertically", keys: "mod+alt+shift+v" },
];
const GROUP: Item = { action: "group", label: "Group", keys: "mod+g" };
const UNGROUP: Item = { action: "ungroup", label: "Ungroup", keys: "mod+shift+g" };
const LOCK: Item = { action: "lock", label: "Lock", keys: "mod+alt+l" };
const UNLOCK: Item = { action: "unlock", label: "Unlock", keys: "mod+alt+l" };
const UNLOCK_ALL: Item = { action: "unlock-all", label: "Unlock all on this slide" };
const BACKGROUND: Item = { action: "background", label: "Slide background…" };
const COMMENT: Item = { action: "comment", label: "Add comment…" };
const TIDY: Item = { action: "tidy", label: "Tidy this element" };
const SVG: Item = { action: "svg", label: "Edit in the SVG editor" };
const LINK: Item = { action: "link", label: "Link…", keys: "mod+k" };
const REPLACE_IMAGE: Item = { action: "replace-image", label: "Replace image…" };
const POSITION: Item = { action: "position", label: "Position and size…" };
const ROTATE_ITEMS: Item[] = [
  { action: "rotate-right", label: "Rotate right 90°", keys: "mod+alt+r" },
  { action: "rotate-left", label: "Rotate left 90°" },
];
const ALIGN_ITEMS: Item[] = [
  { action: "align-left", label: "Align left" },
  { action: "align-center", label: "Align center" },
  { action: "align-right", label: "Align right" },
  { action: "align-top", label: "Align top" },
  { action: "align-middle", label: "Align middle" },
  { action: "align-bottom", label: "Align bottom" },
];
const DISTRIBUTE_ITEMS: Item[] = [
  { action: "distribute-h", label: "Distribute horizontally" },
  { action: "distribute-v", label: "Distribute vertically" },
];
const SELECT_PARENT: Item = { action: "select-parent", label: "Select parent", keys: "shift+enter" };
// The most elements under the pointer the menu lists to select.
const MAX_PICKS = 8;

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
 * unlocking it; on anything else, what can be done to the selection. Wherever it opens, it lists
 * what else lies under the pointer (covered elements, the slide's background layer) and the
 * selection's parent, to select instead.
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
  /** The one selected element is an image, which can be replaced. */
  image?: boolean;
  /** What lies under the pointer, the top-most first, to select instead (see `select-under-…`). */
  under?: EditLayerPick[];
  /** What holds the one selected element, which "Select parent" selects. */
  parent?: EditLayerPick | null;
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
  const [aligning, setAligning] = useState(false);

  const count = props.elements?.length ?? (element ? 1 : 0);
  const several = !!props.several || count > 1;
  const ask: Item = {
    action: "ask",
    label: several && count > 1 ? `Ask the agent about these ${count} elements…` : "Ask the agent about this…",
  };
  const busy = running ? "The agent is busy" : undefined;
  // What else lies at the pointer, under a heading, and what holds the selection.
  const picks = (props.under ?? [])
    .flatMap((pick, index) => (pick.selected ? [] : [button({ action: `select-under-${index}`, label: pick.name })]))
    .slice(0, MAX_PICKS);
  const selectSection: ReactNode[] = [
    picks.length > 0 && (
      <div key="select-heading" role="presentation" className="px-2 pt-0.5 pb-0.5 text-muted-foreground">
        Select
      </div>
    ),
    ...picks,
    props.parent && button(SELECT_PARENT),
  ];

  /** The menu's sections, each a run of choices; empty ones are left out, with a line between the rest. */
  const sections: ReactNode[][] = !element
    ? [
        [button(PASTE), button(SELECT_ALL), props.unlockable && button(UNLOCK_ALL)],
        selectSection,
        [button(BACKGROUND)],
        [button(COMMENT)],
      ]
    : props.locked
      ? [[button(UNLOCK), button(COPY)], selectSection, [button(COMMENT), button(ask, busy)]]
      : [
          [props.editable && !several && button(EDIT_TEXT)],
          [button(CUT), button(COPY), button(PASTE), button(DUPLICATE), button(DELETE)],
          [
            button(COPY_STYLE),
            button(PASTE_STYLE, props.canPasteStyle ? undefined : `Copy a style first (${formatKeys("mod+alt+c")})`),
          ],
          [!several && button(LINK), props.image && !several && button(REPLACE_IMAGE)],
          [
            <AlignSubmenu
              key="align"
              open={aligning}
              onOpen={setAligning}
              items={[
                ...ALIGN_ITEMS.map((item) => button(item)),
                count >= 3 && divider("distribute"),
                ...(count >= 3 ? DISTRIBUTE_ITEMS.map((item) => button(item)) : []),
              ]}
              text={several ? "Align" : "Align with the slide"}
            />,
            button(POSITION),
          ],
          ORDER_ITEMS.map((item) => button(item)),
          selectSection,
          [several && button(GROUP), props.group && button(UNGROUP), button(LOCK)],
          [
            ...ROTATE_ITEMS.map((item) => button(item)),
            // Each of several elements, and of what a group holds, flips if it can.
            ...(props.flippable || several || props.group ? FLIP_ITEMS.map((item) => button(item)) : []),
          ],
          [button(COMMENT), button(ask, busy), element.added && !several && button(TIDY, busy)],
          [isDrawing(element) && !several && button(SVG)],
        ];
  const shown = sections.map((section) => section.filter(Boolean)).filter((section) => section.length > 0);

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the cover only catches a press outside the menu.
    // biome-ignore lint/a11y/noStaticElementInteractions: the cover only catches a press outside the menu.
    <div
      data-testid="edit-menu-cover"
      className="fixed inset-0 z-overlay"
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
        className="fixed rounded-lg border bg-card p-1 text-xs text-foreground shadow-popover outline-none"
      >
        {shown.flatMap((section, index) => (index > 0 ? [divider(`line-${index}`), ...section] : section))}
      </div>
    </div>
  );
}

/**
 * A choice of the menu that opens more choices beside it: on the pointer resting on it, a click,
 * or → (← and Escape go back). Its choices are part of the menu, so ↑ and ↓ reach them too.
 */
function AlignSubmenu(props: { text: string; open: boolean; onOpen: (open: boolean) => void; items: ReactNode[] }) {
  const row = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<"right" | "left">("right");
  useLayoutEffect(() => {
    if (!props.open) return;
    const box = row.current?.getBoundingClientRect();
    if (box) setSide(box.right + WIDTH > window.innerWidth - 8 ? "left" : "right");
  }, [props.open]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the pointer resting on the row opens its choices.
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: ← in its choices goes back to the row.
    <div
      className="relative"
      onMouseEnter={() => props.onOpen(true)}
      onMouseLeave={() => props.onOpen(false)}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || (event.key === "Escape" && props.open)) {
          event.preventDefault();
          event.stopPropagation();
          props.onOpen(false);
          row.current?.focus();
        }
      }}
    >
      <button
        ref={row}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={props.open}
        onClick={() => props.onOpen(!props.open)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowRight") return;
          event.preventDefault();
          event.stopPropagation();
          props.onOpen(true);
          requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus());
        }}
        className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1 text-left hover:bg-accent focus:bg-accent focus:outline-none"
      >
        {props.text}
        <ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
      </button>
      {props.open && (
        <div
          ref={panel}
          role="menu"
          aria-label="Align"
          className={`absolute -top-1 w-48 rounded-lg border bg-card p-1 shadow-popover ${side === "right" ? "left-full ml-1" : "right-full mr-1"}`}
        >
          {props.items}
        </div>
      )}
    </div>
  );
}
