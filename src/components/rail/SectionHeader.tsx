import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronRight, Pencil, X } from "lucide-react";
import { memo } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import type { Section } from "../../lib/api";
import { cn, plural } from "../../lib/utils";
import { showInfo, useApp } from "../../store";
import { REMOVE_SECTION } from "./menus";
import { noLayoutAnimation } from "./Thumbnail";

/**
 * Divider row that names a section. Only the editor shows it; the player never does. Memoized,
 * with the same functions for every header, so it renders when its section changes.
 */
export const SectionHeader = memo(function SectionHeader(props: {
  itemKey: string;
  section: Section;
  filteredOut: boolean;
  /** How many slides are folded under the row while sections are being moved. */
  slides?: number;
  /** Keeps dnd-kit from sliding the row anywhere while the slides fold and open. */
  still: boolean;
  /** The section's first slide, which names its fold; none when the section has no slides. */
  first?: string;
  /** Whether the user folded the section's slides away under it. */
  collapsed: boolean;
  /** How many slides the section holds. */
  count: number;
  editing: boolean;
  /** The section whose title is being typed, by its index; null when that ends. */
  onEditing: (section: number | null) => void;
  /** A right-click on the row `key`. */
  onMenu: (event: React.MouseEvent, key: string) => void;
}) {
  const { section, editing, onEditing, onMenu, itemKey } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.itemKey,
    animateLayoutChanges: props.still ? noLayoutAnimation : undefined,
  });

  const commit = async (title: string) => {
    onEditing(null);
    const next = title.trim();
    if (!next) {
      // A section without a name would be a line nobody can tell from another.
      showInfo(`A section needs a name: it is still “${section.title || "Untitled section"}”.`);
      return;
    }
    if (next !== section.title) await useApp.getState().renameSection(section.index, next);
  };

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: dnd-kit makes the row a focusable button, which the menu key works on too.
    <li
      ref={setNodeRef}
      data-testid="section-header"
      data-section-key={props.itemKey}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(props.filteredOut ? "hidden" : "group flex items-center gap-2 pt-1", isDragging && "opacity-0")}
      onContextMenu={editing ? undefined : (event) => onMenu(event, itemKey)}
      {...attributes}
      {...listeners}
    >
      {props.first === undefined || props.slides !== undefined ? (
        <span className="w-4 shrink-0" />
      ) : (
        <Button
          variant="tool"
          size="icon-2xs"
          tooltip={props.collapsed ? "Expand section" : "Collapse section"}
          aria-expanded={!props.collapsed}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            useApp.getState().toggleSection(props.first!);
          }}
          className="-mr-1 w-4 justify-end aria-expanded:bg-transparent aria-expanded:text-muted-foreground aria-expanded:hover:bg-muted aria-expanded:hover:text-foreground"
        >
          <ChevronRight className={cn("size-3 transition-transform duration-200", !props.collapsed && "rotate-90")} />
        </Button>
      )}
      {editing ? (
        <Input
          size="sm"
          autoFocus
          aria-label="Section title"
          defaultValue={section.title}
          onFocus={(e) => e.currentTarget.select()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") {
              e.currentTarget.value = section.title;
              e.currentTarget.blur();
            }
          }}
          onBlur={(e) => void commit(e.currentTarget.value)}
          className="h-6 flex-1 bg-background text-2xs font-medium uppercase tracking-wide text-foreground data-[size=sm]:text-2xs"
        />
      ) : (
        <>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: double-click is a shortcut for the adjacent keyboard-accessible Rename section button */}
          {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: the same shortcut */}
          <span
            title="Double-click to rename"
            onDoubleClick={() => onEditing(section.index)}
            className={cn(
              "min-w-0 truncate text-2xs font-medium uppercase tracking-wide text-muted-foreground",
              !section.title && "italic",
            )}
          >
            {section.title || "Untitled section"}
          </span>
          <Separator className="flex-1 data-horizontal:w-auto" />
          {props.slides !== undefined ? (
            <span data-fold-label className="shrink-0 pr-1 text-2xs text-muted-foreground">
              {plural(props.slides, "slide")}
            </span>
          ) : (
            <>
              {props.collapsed && (
                <Badge data-testid="folded-count" variant="secondary" className="h-4 px-1.5 text-2xs font-normal">
                  {plural(props.count, "slide")}
                </Badge>
              )}
              <div className="invisible flex shrink-0 gap-0.5 group-hover:visible group-focus-within:visible">
                <SectionAction title="Rename section" onClick={() => onEditing(section.index)}>
                  <Pencil />
                </SectionAction>
                <SectionAction
                  title={REMOVE_SECTION}
                  onClick={() => void useApp.getState().removeSection(section.index)}
                >
                  <X />
                </SectionAction>
              </div>
            </>
          )}
        </>
      )}
    </li>
  );
});

function SectionAction(props: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button
      variant="tool"
      size="icon-2xs"
      tooltip={props.title}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
    >
      {props.children}
    </Button>
  );
}
