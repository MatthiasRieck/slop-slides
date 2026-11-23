import { ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut } from "@/components/ui/context-menu";
import { formatKeys } from "../../lib/keys";
import type { MenuEntry } from "./menus";

/**
 * The choices of a right-click in the rail (see ./menus.ts), as the items of its context menu. A
 * choice that cannot be picked just now shows, off, and says why under the pointer.
 */
export function RailMenuItems({ entries }: { entries: MenuEntry[] }) {
  return entries.map((entry, i) =>
    entry === "divider" ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the entries of one menu never move
      <ContextMenuSeparator key={i} />
    ) : (
      <ContextMenuItem
        key={entry.label}
        variant={entry.destructive ? "destructive" : "default"}
        disabled={entry.disabledReason !== undefined}
        title={entry.disabledReason}
        onClick={entry.run}
        className="data-disabled:pointer-events-auto"
      >
        {entry.label}
        {entry.keys && <ContextMenuShortcut>{formatKeys(entry.keys)}</ContextMenuShortcut>}
      </ContextMenuItem>
    ),
  );
}
