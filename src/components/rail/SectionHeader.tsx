import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronRight, Pencil, Ungroup } from "lucide-react";
import { memo } from "react";

import type { Section } from "../../lib/api";
import { cn, plural } from "../../lib/utils";
import { showInfo, useApp } from "../../store";
import { SectionLabel } from "../SectionLabel";
import { REMOVE_SECTION } from "./menus";
import { noLayoutAnimation } from "./Thumbnail";

/**
 * Divider row that names a section. Only the editor shows it; the player never does. Memoized,
 * with the same functions for every header, so it renders when its section changes.
 */
export const SectionHeader = memo(function SectionHeader(props: {
  itemKey: string;
  section: Section;
  /** Edit mode: the section can be renamed, removed and moved. */
  editable: boolean;
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
        <button
          type="button"
          aria-label={props.collapsed ? "Expand section" : "Collapse section"}
          title={props.collapsed ? "Expand section" : "Collapse section"}
          aria-expanded={!props.collapsed}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            useApp.getState().toggleSection(props.first!);
          }}
          className="flex w-4 shrink-0 justify-end rounded text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className={cn("size-3 transition-transform duration-200", !props.collapsed && "rotate-90")} />
        </button>
      )}
      {editing ? (
        <input
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
          className="min-w-0 flex-1 rounded border border-input bg-background px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide text-foreground outline-none focus:ring-1 focus:ring-primary"
        />
      ) : (
        <>
          {/* Double-click is a shortcut for the adjacent keyboard-accessible Rename section button. */}
          <SectionLabel
            title={props.editable ? "Double-click to rename" : undefined}
            onDoubleClick={() => props.editable && onEditing(section.index)}
            className={cn("min-w-0 truncate", !section.title && "italic")}
          >
            {section.title || "Untitled section"}
          </SectionLabel>
          <span className="h-px flex-1 bg-border" />
          {props.slides !== undefined ? (
            <span data-fold-label className="shrink-0 pr-1 text-2xs text-muted-foreground">
              {plural(props.slides, "slide")}
            </span>
          ) : (
            <>
              {props.collapsed && (
                <span data-testid="folded-count" className="shrink-0 text-2xs text-muted-foreground">
                  {plural(props.count, "slide")}
                </span>
              )}
              {props.editable && (
                <div className="invisible flex shrink-0 gap-0.5 group-hover:visible group-focus-within:visible">
                  <SectionAction title="Rename section" onClick={() => onEditing(section.index)}>
                    <Pencil className="size-3" />
                  </SectionAction>
                  <SectionAction
                    title={REMOVE_SECTION}
                    onClick={() => void useApp.getState().removeSection(section.index)}
                  >
                    <Ungroup className="size-3" />
                  </SectionAction>
                </div>
              )}
            </>
          )}
        </>
      )}
    </li>
  );
});

function SectionAction(props: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={props.title}
      title={props.title}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
      className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {props.children}
    </button>
  );
}
