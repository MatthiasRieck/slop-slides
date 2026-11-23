import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ChevronsDownUp, ChevronsUpDown, Copy, FileUp, FolderSearch, SquareArrowOutUpRight } from "lucide-react";
import { useMemo } from "react";

import { DropdownMenu, DropdownMenuContent } from "@/components/ui/dropdown-menu";
import type { WorkspaceEntry } from "../lib/api";
import { isPowerPoint } from "../lib/opening";
import { revealLabel } from "../lib/utils";
import { reportingErrors, showSuccess, useApp } from "../store";
import { MenuItem } from "./DeckActions";

/**
 * The menu for a row of the file tree, at the pointer (or under the row, opened with the keys):
 * open the file (or open or close the folder), reveal it in the file manager, copy its path, and
 * for a PowerPoint file, import it as a deck. A menu with no button of its own: it opens at the
 * point it is given, stays inside the window, takes the focus (the arrows go through its
 * choices), and closes on a choice, Escape or a press outside.
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
  const anchor = useMemo(() => ({ getBoundingClientRect: () => new DOMRect(x, y, 0, 0) }), [x, y]);

  const copyPath = () =>
    void reportingErrors(async () => {
      await navigator.clipboard.writeText(absolute);
      showSuccess("Path copied.");
    }, "Could not copy the path: ");

  const folder = entry.kind === "directory";
  return (
    <DropdownMenu open onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuContent
        anchor={anchor}
        align="start"
        side="bottom"
        sideOffset={0}
        aria-label={entry.name}
        className="w-52"
      >
        <MenuItem
          icon={folder ? (props.expanded ? ChevronsDownUp : ChevronsUpDown) : SquareArrowOutUpRight}
          label={folder ? (props.expanded ? "Collapse" : "Expand") : "Open"}
          onClick={props.onOpen}
        />
        {isPowerPoint(entry.path) && (
          <MenuItem
            icon={FileUp}
            label="Import as deck"
            hint="This file stays as it is"
            onClick={() => void useApp.getState().importPptx(absolute)}
          />
        )}
        <MenuItem icon={FolderSearch} label={revealLabel} onClick={() => void revealItemInDir(absolute)} />
        <MenuItem icon={Copy} label="Copy path" onClick={copyPath} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
