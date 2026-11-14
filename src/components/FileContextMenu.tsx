import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ChevronsDownUp, ChevronsUpDown, Copy, FileUp, FolderSearch, SquareArrowOutUpRight } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useMenuKeys } from "../hooks/useMenuKeys";
import type { WorkspaceEntry } from "../lib/api";
import { isPowerPoint } from "../lib/opening";
import { revealLabel } from "../lib/utils";
import { reportingErrors, showSuccess, useApp } from "../store";
import { MenuItem } from "./DeckActions";
import { useDismiss } from "./Popover";

const WIDTH = 208;
const MARGIN = 8;

/**
 * The menu for a row of the file tree, at the pointer (or under the row, opened with the keys):
 * open the file (or open or close the folder), reveal it in the file manager, copy its path, and
 * for a PowerPoint file, import it as a deck. It renders into the body, so the sidebar does not
 * clip it; the arrows go through its choices, and Escape or a press outside closes it.
 */
export function FileContextMenu(props: {
  x: number;
  y: number;
  entry: WorkspaceEntry;
  /** The entry's absolute path. */
  absolute: string;
  /** For a folder: whether it is open in the tree. */
  expanded: boolean;
  /** Opens the file, or opens or closes the folder, as a click on the row does. */
  onOpen: () => void;
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
  return createPortal(
    <div ref={boxRef} className="fixed z-50" style={{ ...position, width: WIDTH }}>
      <div
        role="menu"
        aria-label={entry.name}
        {...menu}
        className="rounded-lg border bg-card p-1 text-foreground shadow-lg outline-none"
      >
        <MenuItem
          icon={folder ? (props.expanded ? ChevronsDownUp : ChevronsUpDown) : SquareArrowOutUpRight}
          label={folder ? (props.expanded ? "Collapse" : "Expand") : "Open"}
          onClick={choose(props.onOpen)}
        />
        {isPowerPoint(entry.path) && (
          <MenuItem
            icon={FileUp}
            label="Import as deck"
            hint="This file stays as it is"
            onClick={choose(() => void useApp.getState().importPptx(absolute))}
          />
        )}
        <MenuItem icon={FolderSearch} label={revealLabel} onClick={choose(() => void revealItemInDir(absolute))} />
        <MenuItem icon={Copy} label="Copy path" onClick={choose(copyPath)} />
      </div>
    </div>,
    document.body,
  );
}
