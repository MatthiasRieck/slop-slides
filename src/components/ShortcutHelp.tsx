import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { helpRows } from "../lib/commands";
import { formatKeys, isMod, isTypingTarget } from "../lib/keys";
import { cn } from "../lib/utils";
import { deckMode, useApp } from "../store";
import { Dialog } from "./Dialog";
import { inputClass } from "./Field";

/**
 * A row of the help: the keys, and what they do. In the keys, `{mod+z}` is a shortcut, written as
 * the platform writes it (see `formatKeys`); the rest is said as it is: `{mod+c} / {mod+v}`,
 * `{shift} moving`, `Double-click a group`.
 */
export type ShortcutRow = [keys: string, what: string];

export interface ShortcutSection {
  title: string;
  /** The mode its shortcuts are for, when they are for one: in that mode the section comes first. */
  mode?: "view" | "edit" | "git";
  rows: ShortcutRow[];
}

/** The keys of a row as shown: each `{spec}` in `template` as the platform writes that shortcut. */
export function keysLabel(template: string): string {
  return template.replace(/\{([^}]+)\}/g, (_, spec: string) => formatKeys(spec));
}

/**
 * The edit tools' keys: Select, and the tools that add something (the Insert menu's commands).
 * Exported for the test that keeps them in step with `EDIT_TOOL_KEYS`.
 */
export const TOOL_ROWS: ShortcutRow[] = [["{v}", "Select"], ...helpRows("Tools")];

/**
 * Every keyboard shortcut of the app, by where it works. The keys of the app's commands come from
 * their registry (src/lib/commands.json, each command's `help` naming its section); the rest are
 * written here: a shortcut that is not a command gets a row in the section it belongs to,
 * `["{mod+k}", "What it does"]`.
 */
export const SECTIONS: ShortcutSection[] = [
  {
    title: "General",
    rows: [
      ...helpRows("General"),
      ["{?}", "Show these shortcuts (not while typing)"],
      ["{escape}", "Close what is open: a menu, a popover, a dialog, a message"],
      ["{up} {down} in a menu", "Go through its choices"],
      ["{left} {right} on a tab", "Go to the tab beside it"],
      ["{up} {down} in the file list", "Go through the files; {right} / {left} open and close a folder"],
      ["{f2} in the file list", "Rename the file or folder"],
    ],
  },
  {
    title: "Slides",
    rows: [
      ["{right} {down} / {pagedown}", "Next slide"],
      ["{left} {up} / {pageup}", "Previous slide"],
      ["{home} / {end}", "First / last slide"],
      ["{mod+c}", "Copy the picked slides (in View, or with the slide list pressed last)"],
      ["{mod+v}", "Paste slides after this one"],
      ...helpRows("Slides"),
      ["{mod}-click / {shift}-click in the list", "Pick several slides / a range"],
      ["{shift+up} / {shift+down} in the list", "Pick the slides on the way ({shift+home} / {shift+end}: to the ends)"],
      ["{up} {down} in the grid", "A row up / down; {enter} opens the slide, {escape} goes back"],
      ["{mod+a} in the list", "Pick every slide"],
      ["{mod+x} / {mod+d} in the list", "Cut / duplicate the picked slides"],
      ["{backspace} in the list", "Delete the picked slides"],
      ["{space} on a slide in the list", "Pick it up; {arrows} move it, {space} puts it down, {escape} leaves it"],
      ["Right-click in the list", "Everything that can be done to the slide or the section"],
      ["{escape}", "Pick no slides"],
    ],
  },
  {
    title: "View",
    mode: "view",
    rows: [
      ...helpRows("View"),
      ["{0}", "Fit: back to the whole slide"],
      ["{shift+0}", "Real size (100%)"],
      ["Scroll", "Scroll the zoomed-in slide ({shift}: sideways)"],
      ["{space} and drag", "Pan"],
      ["Pinch / {mod}-scroll", "Zoom"],
      ["Middle button and drag", "Pan"],
      ["{enter} / {shift+enter} in the search", "Next / previous match"],
      ["{enter} / {mod+enter} in Replace with", "Replace this match / every match (in Edit)"],
      ["{escape} in the search", "End it"],
      ["{space} with the timeline open", "Play / pause (not in a field, on a button or in the slide)"],
      ["{left} {right} in the timeline", "Step a tenth of a second ({shift}: a second)"],
      ["{home} / {end} in the timeline", "To the start / the end"],
      ["{j} / {k} / {l} in the timeline", "Back a second / pause / play, faster with each press"],
      ["{mod}-scroll / pinch on the timeline", "Zoom the timeline around the pointer"],
      ["{alt} while dragging on the timeline", "Do not snap"],
      ["{escape}", "Put the pen or comment tool away"],
    ],
  },
  {
    title: "Edit",
    mode: "edit",
    rows: [
      ...TOOL_ROWS,
      ...helpRows("Edit"),
      ["{mod+a}", "Select all"],
      ["{tab} / {shift+tab}", "Next / previous element"],
      ["{arrows}", "Nudge 1px"],
      ["{shift+arrows}", "Nudge 10px"],
      ["{mod+c} / {mod+x} / {mod+v}", "Copy / cut / paste"],
      ["Right-click", "The menu for the element, or for the slide on an empty spot"],
      ["Double-click a group", "Select what it holds"],
      ["Double-click an image", "Replace it with another image"],
      ["{shift+2}", "Zoom to the selection"],
      ["{mod}-click", "Select what lies under the selection"],
      ["{shift}-click", "Add to or take out of the selection"],
      ["Drag on an empty spot", "Select what the box touches ({alt}: only what is fully inside)"],
      ["{shift+enter}", "Select the parent"],
      ["{shift} moving", "Straight across or up and down"],
      ["{alt} moving", "Drag a copy (press or let go any time)"],
      ["{shift} resizing", "Keep the aspect ratio (free it, when locked)"],
      ["{alt} resizing", "From the center"],
      ["{shift} rotating or tilting", "Steps of 15°"],
      ["{shift} adding a shape", "As wide as tall"],
      ["{alt} adding a shape", "From the center"],
      ["{mod} while dragging", "No snapping (or, with Snap to guides off, snapping)"],
      ["Snapping", "Moves, resizes and line points; not {shift} resizes or turned boxes"],
      ["Nudging", "Never snaps; {shift} takes 10px steps"],
      ["{escape} while dragging", "Cancel the move, resize or turn"],
      ["{escape} with a tool", "Back to Select"],
      ["{escape} with a selection", "Select nothing (in a group: the group)"],
    ],
  },
  {
    title: "Text",
    mode: "edit",
    rows: [
      ...helpRows("Text"),
      ["{enter}", "Edit the selected element's text"],
      ["Typing", "Edit the selected text, adding what is typed at its end"],
      ["{mod+z} / {mod+shift+z} while typing", "Undo / redo the typing and its formatting, step by step"],
      ["{up} {down} in a number field", "One up or down ({shift}: ten), applied at once"],
      ["{enter} while typing", "Line break, or a new list item"],
      ["{shift+enter} while typing", "Line break, also in a list"],
      ["{tab} / {shift+tab} in a list", "Indent / outdent the item"],
      ["{backspace} at the start of a list item", "Take the item out of its list"],
      ["{mod+enter} / {escape}", "Finish the text"],
      ["{mod+shift+v}", "Paste as plain text (on the slide: as a new text box)"],
    ],
  },
  {
    title: "Lines",
    mode: "edit",
    rows: [
      ["{shift} a line or its point", "Steps of 45°"],
      ["{mod} a line's end", "Sticks to nothing"],
    ],
  },
  {
    title: "Chat",
    rows: [
      ["{enter}", "Send the message, or queue it while the agent works"],
      ["{shift+enter}", "New line"],
      ["{mod+enter}", "Steer: send into the agent's turn now"],
      ...helpRows("Chat"),
      ["{up} in the empty message box", "Bring back the last message sent"],
      ["{escape} in the empty message box", "Stop the agent's turn"],
    ],
  },
  {
    title: "Presenting",
    rows: [
      ...helpRows("Presenting"),
      ["{right} {down} / {space} / {pagedown} / {enter}", "Next slide"],
      ["{left} {up} / {pageup} / {backspace} / {shift+space}", "Previous slide"],
      ["{home} / {end}", "First / last slide"],
      ["A number, then {enter}", "Go to the slide with that number in the slide list"],
      ["{g}", "All slides, to go to one"],
      ["{b} or {.} / {w}", "Blank the screen to black / white; again, or a slide key, brings the slide back"],
      ["{l} / {p} / {h} / {e}", "Laser / pen / highlighter / eraser (again to put it away)"],
      ["{c}", "Clear the ink on the slide"],
      ["{mod+z} / {mod+shift+z}", "Undo / redo a change to the slide's ink"],
      ["{0}", "Back to the whole slide"],
      ["{k}", "Play by itself, or pause"],
      ["{n}", "Show or hide the presenter view"],
      ["{[} / {]}", "Scroll the notes in the presenter view up / down"],
      ["{?}", "Show these keys"],
      ["{escape}", "Put the tool away, fit the slide, bring the slide back, then end the show"],
    ],
  },
  {
    title: "Code and drawing editors",
    rows: [
      ["{mod+s}", "Save the code / apply the drawing to the slide"],
      ["{mod+f} in the code", "Search"],
      ["{mod+z} / {mod+shift+z}", "Undo / redo in the editor"],
      ["{mod+d} in the drawing", "Duplicate the selected element"],
      ["{backspace} in the drawing", "Delete the selected element"],
      ["{arrows} / {shift+arrows} in the drawing", "Nudge 1 / 10"],
      ["{escape} in the drawing", "Select the parent"],
      ["{mod+plus} / {mod+-} / {mod+0} in the drawing", "Zoom in / out / fit the drawing"],
      ["{shift} / {alt} dragging a handle in the drawing", "Resize keeping the proportions / from the middle"],
    ],
  },
  {
    title: "Changes",
    mode: "git",
    rows: [
      ["{arrows} / {pageup} {pagedown}", "Go through the changed slides"],
      ["{space} (hold)", "See the other version of the slide"],
      ["{mod+enter} in the message", "Save a version"],
    ],
  },
];

/** The keys that close the help: Escape, and `?` again (outside its search field). */
const CLOSE_KEYS = ["Escape", "?"];

/**
 * `sections` with those of the mode the deck is in first, the rest in their order: the help
 * opens on what the user is doing.
 */
export function orderSections(sections: readonly ShortcutSection[], mode: string | null): ShortcutSection[] {
  const first = sections.filter((section) => mode !== null && section.mode === mode);
  return [...first, ...sections.filter((section) => !first.includes(section))];
}

/** Other words for the keys, so that "cmd z", "ctrl+z" and "option" all find their rows. */
const KEY_WORDS: Record<string, string> = {
  mod: "cmd command ctrl control",
  alt: "alt option opt",
  shift: "shift",
  ctrl: "ctrl control",
  enter: "enter return",
  backspace: "backspace delete",
  escape: "esc escape",
  up: "up arrow",
  down: "down arrow",
  left: "left arrow",
  right: "right arrow",
  arrows: "arrow arrows",
  plus: "plus +",
};

/** Everything a row can be found by, in lower case: its keys as shown, as spelled, and what they do. */
function searchText([keys, what]: ShortcutRow, title: string): string {
  const spelled = [...`${keys} ${what}`.matchAll(/\{([^}]+)\}/g)]
    .flatMap((match) => match[1]!.split("+"))
    .map((part) => KEY_WORDS[part] ?? part);
  return [keysLabel(keys), keysLabel(what), title, ...spelled].join(" ").toLowerCase();
}

/**
 * The rows of `sections` that `query` finds: each of its words is in the row's keys, in what
 * they do or in its section's name, whatever the case. Sections left with no row are dropped.
 * An empty query finds everything.
 */
export function filterSections(sections: readonly ShortcutSection[], query: string): ShortcutSection[] {
  const words = query
    .toLowerCase()
    .split(/[\s+]+/)
    .filter(Boolean);
  if (words.length === 0) return [...sections];
  return sections
    .map((section) => ({
      ...section,
      rows: section.rows.filter((row) => {
        const text = searchText(row, section.title);
        return words.every((word) => text.includes(word));
      }),
    }))
    .filter((section) => section.rows.length > 0);
}

/** Whether the keys ask for the help: `?` outside of typing, or ⌘/ anywhere nothing else took it. */
function asksForHelp(event: KeyboardEvent): boolean {
  if (event.altKey) return false;
  if (event.key === "/") return isMod(event) && !event.defaultPrevented;
  return event.key === "?" && !event.metaKey && !event.ctrlKey && !isTypingTarget(event.target);
}

/**
 * The app's keyboard shortcuts, in a dialog. It is mounted once, for the whole workbench, and
 * opens on `?` (unless the user is typing), on ⌘/, on either pressed in a slide preview, which
 * forwards its keys, and from `openShortcutHelp` in ../store.ts (a button, say). Not during a
 * show, whose keys are the show's.
 */
export function ShortcutHelp() {
  const open = useApp((s) => s.shortcutHelpOpen);

  useEffect(() => {
    const show = () => {
      const app = useApp.getState();
      if (!app.presenting) app.setShortcutHelpOpen(true);
    };
    const onKey = (event: KeyboardEvent) => {
      if (!asksForHelp(event)) return;
      event.preventDefault();
      show();
    };
    const onMessage = (event: MessageEvent) => {
      const { type, key, mod } = event.data ?? {};
      if (type !== "slop:key" || !(key === "?" ? !mod : key === "/" && mod)) return;
      if (Array.from(document.querySelectorAll("iframe")).some((f) => f.contentWindow === event.source)) show();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
      // Gone with the workbench, it is not left open for the next one.
      useApp.getState().setShortcutHelpOpen(false);
    };
  }, []);

  return open ? <ShortcutSheet /> : null;
}

/**
 * The open help: a search field, which has the focus and narrows the list as the user types,
 * over the shortcuts by where they work, those of the mode the deck is in first. The list
 * scrolls under the field, with a scrollbar that shows there is more.
 */
function ShortcutSheet() {
  const mode = useApp((s) => (s.deck ? deckMode(s) : null));
  const [query, setQuery] = useState("");
  const sections = useMemo(() => filterSections(orderSections(SECTIONS, mode), query), [mode, query]);
  const close = () => useApp.getState().setShortcutHelpOpen(false);
  return (
    <Dialog
      label="Keyboard shortcuts"
      onClose={close}
      size="lg"
      className="w-[60rem] gap-0 text-xs"
      title="Keyboard shortcuts"
      closeKeys={CLOSE_KEYS}
      closeOnBackdrop
      closeButton
      backdropTestId="shortcut-help-backdrop"
    >
      <label className="relative mb-3 flex shrink-0 items-center">
        <Search aria-hidden className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" />
        <input
          type="search"
          data-autofocus
          aria-label="Search the shortcuts"
          placeholder="Search by key or by what it does"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className={cn(inputClass, "h-8 pl-7")}
        />
      </label>
      {/* It scrolls here, with the scrollbar always drawn; the columns inside are as tall as they need. */}
      <div
        data-testid="shortcut-list"
        className="-mr-2 min-h-0 flex-1 overflow-y-scroll pr-2 [scrollbar-color:color-mix(in_oklab,currentColor_35%,transparent)_transparent] [scrollbar-width:thin]"
      >
        {sections.length === 0 ? (
          <p role="status" className="py-8 text-center text-muted-foreground">
            No shortcut matches “{query.trim()}”.
          </p>
        ) : (
          <div className="columns-1 gap-x-6 sm:columns-2 lg:columns-3">
            {sections.map((section) => (
              <section key={section.title} className="mb-4 break-inside-avoid">
                <h3 className="mb-1 font-medium text-muted-foreground">{section.title}</h3>
                <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
                  {section.rows.map(([keys, what]) => (
                    <div key={keys} className="contents">
                      <dt className="max-w-44 tabular-nums">{keysLabel(keys)}</dt>
                      <dd className="text-muted-foreground">{keysLabel(what)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
