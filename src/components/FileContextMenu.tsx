import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  FileUp,
  FolderPlus,
  FolderSearch,
  MessageSquarePlus,
  PencilLine,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useMenuKeys } from "../hooks/useMenuKeys";
import type { WorkspaceEntry } from "../lib/api";
import { isDeckFolder } from "../lib/fileTree";
import { isPowerPoint } from "../lib/opening";
import { revealLabel } from "../lib/utils";
import { reportingErrors, showSuccess } from "../store";
import { MenuItem } from "./DeckActions";
import { importPowerPoint } from "./export/importPowerPoint";
import { addToChat, displayName, trashName } from "./fileActions";
import { useDismiss } from "./Popover";

const WIDTH = 208;
const MARGIN = 8;

/**
 * The menu for a row of the file tree, at the pointer (or under the row, opened with the keys).
 * For a file: open it, add it to the chat, and for a PowerPoint file, import it as a deck. For a
 * folder: open or close it, and make a folder in it. For a deck's folder, which shows as the
 * deck: open the deck, and show or hide its files. Then for all: rename it, reveal it in the
 * file manager, copy its path, and move it to the trash. It renders into the body, so the
 * sidebar does not clip it; the arrows go through its choices, and Escape or a press outside
 * closes it.
 */
export function FileContextMenu(props: {
  x: number;
  y: number;
  entry: WorkspaceEntry;
  /** The entry's absolute path. */
  absolute: string;
  /** For a folder: whether it is open in the tree. */
  expanded: boolean;
  /** Opens the file or the deck, as a click on the row does. */
  onOpen: () => void;
  /** Opens or closes the folder in the tree. */
  onToggle: () => void;
  /** Starts renaming the row, in place. */
  onRename: () => void;
  /** Makes a folder in this folder, and starts naming it. */
  onNewFolder: () => void;
  /** Moves the file or folder to the trash, after asking. */
  onTrash: () => void;
  onClose: () => void;
}) {
  const { x, y, entry, absolute, onClose } = props;
  const boxRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const menu = useMenuKeys();
  useDismiss(true, boxRef, onClose);

  useLayoutEffect(() => {
    const height = boxRef.current?.offsetHeight ?? 0;
    setPosition({
      left: Math.max(MARGIN, Math.min(x, window.innerWidth - WIDTH - MARGIN)),
      top: Math.max(MARGIN, Math.min(y, window.innerHeight - height - MARGIN)),
    });
  }, [x, y]);

  const choose = (action: () => void) => () => {
    onClose();
    action();
  };

  const copyPath = () =>
    void reportingErrors(async () => {
      await navigator.clipboard.writeText(absolute);
      showSuccess("Path copied.");
    }, "Could not copy the path: ");

  const folder = entry.kind === "directory";
  const deck = isDeckFolder(entry);
  const toggleIcon = props.expanded ? ChevronsDownUp : ChevronsUpDown;
  return createPortal(
    <div ref={boxRef} className="fixed z-overlay" style={{ ...position, width: WIDTH }}>
      <div
        role="menu"
        aria-label={displayName(entry)}
        {...menu}
        className="rounded-lg border bg-card p-1 text-foreground shadow-popover outline-none"
      >
        {(!folder || deck) && (
          <MenuItem icon={SquareArrowOutUpRight} label={deck ? "Open deck" : "Open"} onClick={choose(props.onOpen)} />
        )}
        {folder && (
          <MenuItem
            icon={toggleIcon}
            label={
              deck
                ? props.expanded
                  ? "Hide the deck's files"
                  : "Show the deck's files"
                : props.expanded
                  ? "Collapse"
                  : "Expand"
            }
            onClick={choose(props.onToggle)}
          />
        )}
        <MenuItem
          icon={MessageSquarePlus}
          label="Add to chat"
          hint="Goes along with your next message"
          onClick={choose(() => addToChat(entry))}
        />
        {isPowerPoint(entry.path) && (
          <MenuItem
            icon={FileUp}
            label="Import as deck"
            hint="This file stays as it is"
            onClick={choose(() => void importPowerPoint(absolute))}
          />
        )}
        <Divider />
        <MenuItem
          icon={PencilLine}
          label={deck ? "Rename folder" : "Rename"}
          shortcut="f2"
          onClick={choose(props.onRename)}
        />
        {folder && !deck && <MenuItem icon={FolderPlus} label="New folder" onClick={choose(props.onNewFolder)} />}
        <MenuItem icon={FolderSearch} label={revealLabel} onClick={choose(() => void revealItemInDir(absolute))} />
        <MenuItem icon={Copy} label="Copy path" onClick={choose(copyPath)} />
        <Divider />
        <MenuItem icon={Trash2} label={`Move to ${trashName}…`} onClick={choose(props.onTrash)} />
      </div>
    </div>,
    document.body,
  );
}

/** A line between two groups of a menu's choices. */
function Divider() {
  return <hr className="mx-1 my-1 border-border" />;
}
