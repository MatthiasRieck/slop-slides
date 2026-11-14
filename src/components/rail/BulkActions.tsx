import { Copy, Eye, EyeOff, Trash2, X } from "lucide-react";

import type { Deck } from "../../lib/api";
import { railSelection, useApp } from "../../store";
import { ToolButton } from "../Button";

/**
 * What can be done to the slides picked with ⇧/⌘-click, as a bar that takes the place of the
 * list's header while several are picked: the list under it stays where it is, so the next click
 * lands on the slide it was aimed at. Locked ones are not deleted or hidden. Moving the picked
 * slides is the menu's and the keys' (⌘↑ / ⌘↓). In a narrow list the count stands alone.
 *
 * Its parent is a container (`@container`) and renders it only while several slides are picked.
 */
export function BulkActions({ deck }: { deck: Deck }) {
  // Read for the render it causes: the bar follows the picks.
  useApp((s) => s.railSelected);
  const app = useApp.getState();
  const picked = railSelection(app);
  const free = deck.slides.filter((s) => picked.includes(s.id) && !s.locked);
  const ids = free.map((s) => s.id);
  const show = free.length > 0 && free.every((s) => s.hidden);
  const locked = picked.length - free.length;
  const skips = locked > 0 && free.length > 0 ? ` (not the ${locked} locked)` : "";
  const allLocked = free.length === 0 ? "These slides are locked" : undefined;
  return (
    <div role="toolbar" aria-label="Selected slides" className="flex min-w-0 flex-1 items-center gap-0.5">
      <span
        role="status"
        title={`${picked.length} slides selected`}
        className="min-w-0 flex-1 truncate whitespace-nowrap text-2xs font-medium text-foreground"
      >
        {picked.length}
        <span className="hidden @[11rem]:inline"> selected</span>
      </span>
      <ToolButton
        variant="panel"
        label={`${show ? "Show" : "Hide"} slides`}
        title={`${show ? "Show" : "Hide"} slides${skips}`}
        disabled={free.length === 0}
        disabledReason={allLocked}
        onClick={() => void app.setSlidesHidden(ids, !show)}
      >
        {show ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
      </ToolButton>
      <ToolButton
        variant="panel"
        label="Duplicate slides"
        shortcut="mod+d"
        onClick={() => void app.duplicateSlides(picked)}
      >
        <Copy className="size-3.5" />
      </ToolButton>
      <ToolButton
        variant="panel"
        label="Delete slides"
        title={`Delete slides${skips}`}
        shortcut="backspace"
        disabled={free.length === 0}
        disabledReason={allLocked && `${allLocked}: unlock them to delete`}
        onClick={() => void app.deleteSlides(ids)}
      >
        <Trash2 className="size-3.5" />
      </ToolButton>
      <ToolButton variant="panel" label="Clear selection" shortcut="escape" onClick={app.clearRailSelection}>
        <X className="size-3.5" />
      </ToolButton>
    </div>
  );
}
