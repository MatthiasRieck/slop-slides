import { useEffect } from "react";

import { formatKeys, isMod, isTypingTarget } from "../lib/keys";
import { useApp } from "../store";
import { Dialog } from "./Dialog";

/**
 * A row of the help: the keys, and what they do. In the keys, `{mod+z}` is a shortcut, written as
 * the platform writes it (see `formatKeys`); the rest is said as it is: `{mod+c} / {mod+v}`,
 * `{shift} moving`, `Double-click a group`.
 */
export type ShortcutRow = [keys: string, what: string];

export interface ShortcutSection {
  title: string;
  rows: ShortcutRow[];
}

/** The keys of a row as shown: each `{spec}` in `template` as the platform writes that shortcut. */
export function keysLabel(template: string): string {
  return template.replace(/\{([^}]+)\}/g, (_, spec: string) => formatKeys(spec));
}

/** The edit tools' keys. Exported for the test that keeps them in step with `EDIT_TOOL_KEYS`. */
export const TOOL_ROWS: ShortcutRow[] = [
  ["{v}", "Select"],
  ["{t}", "Text box"],
  ["{r}", "Rectangle"],
  ["{o}", "Ellipse"],
  ["{d}", "Draw"],
  ["{l}", "Line"],
  ["{a}", "Arrow"],
];

/**
 * Every keyboard shortcut of the app, by where it works. A shortcut added to the app gets a row
 * here, in the section it belongs to: `["{mod+k}", "What it does"]`.
 */
export const SECTIONS: ShortcutSection[] = [
  {
    title: "General",
    rows: [
      ["{?} / {mod+/}", "Show these shortcuts"],
      ["{mod+z} / {mod+shift+z}", "Undo / redo a change to the deck"],
      ["{mod+n}", "New window"],
      ["{mod+o}", "Open a folder"],
      ["{mod+1} / {mod+2} / {mod+3}", "View / Edit / Git (in a repository)"],
      ["{mod+\\}", "Show or hide the sidebar"],
      ["{mod+shift+\\}", "Show or hide the slide list"],
      ["{mod+,}", "App settings"],
      ["{escape}", "Close what is open: a menu, a popover, a dialog, a message"],
      ["{up} {down} in a menu", "Go through its choices"],
      ["{left} {right} on a tab", "Go to the tab beside it"],
      ["{up} {down} in the file list", "Go through the files; {right} / {left} open and close a folder"],
    ],
  },
  {
    title: "Slides",
    rows: [
      ["{right} {down} / {pagedown}", "Next slide"],
      ["{left} {up} / {pageup}", "Previous slide"],
      ["{home} / {end}", "First / last slide"],
      ["{mod+c}", "Copy the picked slides (in View, or with the slide list pressed last)"],
      ["{mod+v}", "Paste slides after this one (in Edit)"],
      ["{mod+shift+n}", "New blank slide after this one (in Edit)"],
      ["{mod}-click / {shift}-click in the list", "Pick several slides / a range"],
      ["{mod+a} in the list", "Pick every slide"],
      ["{mod+x} / {mod+d} in the list", "Cut / duplicate the picked slides (in Edit)"],
      ["{mod+up} / {mod+down}", "Move the picked slides up / down (in Edit)"],
      ["{backspace} in the list", "Delete the picked slides (in Edit)"],
      ["{space} on a slide in the list", "Pick it up; {arrows} move it, {space} puts it down, {escape} leaves it"],
      ["Right-click in the list", "Everything that can be done to the slide or the section"],
      ["{escape}", "Pick no slides"],
    ],
  },
  {
    title: "View",
    rows: [
      ["{mod+plus} / {mod+-}", "Zoom in / out"],
      ["{0} / {mod+0}", "Fit: back to the whole slide"],
      ["{space} and drag", "Pan"],
      ["Pinch / {mod}-scroll", "Zoom"],
      ["Middle button and drag", "Pan"],
      ["{mod+f}", "Search the slides (in View and in Edit)"],
      ["{enter} / {shift+enter} in the search", "Next / previous match"],
      ["{enter} / {mod+enter} in Replace with", "Replace this match / every match (in Edit)"],
      ["{escape} in the search", "End it"],
      ["{space} in the timeline", "Play / pause"],
      ["{left} {right} in the timeline", "Step a tenth of a second ({shift}: a second)"],
      ["{home} / {end} in the timeline", "To the start / the end"],
      ["{escape}", "Put the pen or comment tool away"],
    ],
  },
  {
    title: "Edit",
    rows: [
      ...TOOL_ROWS,
      ["{mod+a}", "Select all"],
      ["{tab} / {shift+tab}", "Next / previous element"],
      ["{arrows}", "Nudge 1px"],
      ["{shift+arrows}", "Nudge 10px"],
      ["{mod+c} / {mod+x} / {mod+v}", "Copy / cut / paste"],
      ["{mod+d}", "Duplicate"],
      ["{mod+g} / {mod+shift+g}", "Group / ungroup"],
      ["{mod+]} / {mod+[}", "Bring forward / send backward"],
      ["{mod+shift+]} / {mod+shift+[}", "Bring to front / send to back"],
      ["{mod+alt+l}", "Lock / unlock the selection"],
      ["{mod+shift+h} / {mod+shift+v}", "Flip horizontally / vertically"],
      ["{mod+alt+c} / {mod+alt+v}", "Copy / paste the style"],
      ["Right-click", "The menu for the element, or for the slide on an empty spot"],
      ["Double-click a group", "Select what it holds"],
      ["{backspace}", "Delete (not what is locked)"],
      ["{shift} moving", "Straight across or up and down"],
      ["{alt} moving", "Drag a copy"],
      ["{shift} resizing", "Keep the aspect ratio (free it, when locked)"],
      ["{alt} resizing", "From the center"],
      ["{shift} rotating or tilting", "Steps of 15°"],
      ["{shift} adding a shape", "As wide as tall"],
      ["{mod} while dragging", "No snapping (or, with Snap to guides off, snapping)"],
      ["Snapping", "Moves, resizes and line points; not {shift} resizes or turned boxes"],
      ["Nudging", "Never snaps; {shift} takes 10px steps"],
      ["{escape} with a tool", "Back to Select"],
      ["{escape} with a selection", "Select the parent, then nothing"],
      ["{escape} otherwise", "Leave edit mode"],
    ],
  },
  {
    title: "Text",
    rows: [
      ["{enter}", "Edit the selected element's text"],
      ["{mod+b} / {mod+i} / {mod+u}", "Bold / italic / underline"],
      ["{mod+shift+l} / {mod+shift+e} / {mod+shift+r} / {mod+shift+j}", "Align left / center / right / justify"],
      ["{mod+shift+.} / {mod+shift+,}", "Larger / smaller text"],
      ["{mod+k}", "Add or change the link"],
      ["{up} {down} in a number field", "One up or down ({shift}: ten), applied at once"],
      ["{enter} while typing", "Line break, or a new list item"],
      ["{shift+enter} while typing", "Line break, also in a list"],
      ["{tab} / {shift+tab} in a list", "Indent / outdent the item"],
      ["{backspace} at the start of a list item", "Take the item out of its list"],
      ["{mod+enter} / {escape}", "Finish the text"],
      ["{mod+shift+v}", "Paste as plain text"],
    ],
  },
  {
    title: "Lines",
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
      ["{mod+l}", "Go to the chat and its message box"],
      ["{up} in the empty message box", "Bring back the last message sent"],
      ["{escape} in the empty message box", "Stop the agent's turn"],
      ["{mod+1} … {mod+9} in the model menu", "Pick that model"],
    ],
  },
  {
    title: "Presenting",
    rows: [
      ["{mod+enter} / {mod+shift+enter}", "Present from the current slide / from the beginning"],
      ["{right} {down} / {space} / {pagedown} / {enter}", "Next slide"],
      ["{left} {up} / {pageup} / {backspace} / {shift+space}", "Previous slide"],
      ["{home} / {end}", "First / last slide"],
      ["A number, then {enter}", "Go to that slide"],
      ["{b} or {.} / {w}", "Blank the screen to black / white; again, or a slide key, brings the slide back"],
      ["{l} / {p} / {h} / {e}", "Laser / pen / highlighter / eraser (again to put it away)"],
      ["{c}", "Clear the ink on the slide"],
      ["{mod+z} / {mod+shift+z}", "Undo / redo a change to the slide's ink"],
      ["{0}", "Back to the whole slide"],
      ["{n}", "Show or hide the notes panel"],
      ["{?}", "Show these keys"],
      ["{escape}", "Put the tool away, then end the show"],
    ],
  },
  {
    title: "HTML and SVG editors",
    rows: [
      ["{mod+s}", "Save the HTML / apply the drawing to the slide"],
      ["{mod+f} in the HTML", "Search"],
      ["{mod+z} / {mod+shift+z}", "Undo / redo in the editor"],
      ["{mod+d} in the drawing", "Duplicate the selected element"],
      ["{backspace} in the drawing", "Delete the selected element"],
      ["{arrows} / {shift+arrows} in the drawing", "Nudge 1 / 10"],
      ["{escape} in the drawing", "Select the parent"],
    ],
  },
  {
    title: "Changes (Git)",
    rows: [
      ["{arrows} / {pageup} {pagedown}", "Go through the changed slides"],
      ["{mod+enter} in the message", "Commit what is staged"],
    ],
  },
];

/** The keys that close the help: Escape, and `?` again. */
const CLOSE_KEYS = ["Escape", "?"];

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

  if (!open) return null;

  return (
    <Dialog
      label="Keyboard shortcuts"
      onClose={() => useApp.getState().setShortcutHelpOpen(false)}
      className="flex max-h-[calc(100vh-4rem)] w-[60rem] max-w-[calc(100vw-2rem)] flex-col rounded-xl border bg-card p-4 text-xs text-foreground shadow-lg outline-none"
      heading={<h2 className="text-sm font-medium">Keyboard shortcuts</h2>}
      closeKeys={CLOSE_KEYS}
      closeOnBackdrop
      closeButton
      backdropTestId="shortcut-help-backdrop"
    >
      <div className="min-h-0 columns-1 gap-x-6 overflow-y-auto sm:columns-2 lg:columns-3">
        {SECTIONS.map((section) => (
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
    </Dialog>
  );
}
