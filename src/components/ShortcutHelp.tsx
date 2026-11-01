import { useEffect, useState } from "react";

import { Dialog } from "./Dialog";

/** Exported for the test that keeps them in step with the tools' keys. */
export const SECTIONS: { title: string; keys: [string, string][] }[] = [
  {
    title: "Tools",
    keys: [
      ["V", "Select"],
      ["T", "Text box"],
      ["R", "Rectangle"],
      ["O", "Ellipse"],
      ["D", "Draw"],
      ["L", "Line"],
      ["A", "Arrow"],
    ],
  },
  {
    title: "Selection",
    keys: [
      ["⌘A", "Select all"],
      ["Tab / ⇧Tab", "Next / previous element"],
      ["Arrows", "Nudge 1px"],
      ["⇧ Arrows", "Nudge 10px"],
      ["⌘C / ⌘X / ⌘V", "Copy / cut / paste"],
      ["⌘D", "Duplicate"],
      ["⌫", "Delete"],
      ["⌘Z / ⇧⌘Z", "Undo / redo"],
    ],
  },
  {
    title: "Text",
    keys: [
      ["Enter", "Edit the selected element's text"],
      ["⌘B / ⌘I / ⌘U", "Bold / italic / underline"],
      ["Enter while typing", "Line break, or a new list item"],
      ["⇧Enter while typing", "Line break, also in a list"],
      ["⌘Enter", "Finish the text"],
      ["⌘⇧V", "Paste as plain text"],
    ],
  },
  {
    title: "Escape",
    keys: [
      ["While typing", "Finish the text"],
      ["With a tool", "Back to Select"],
      ["With a selection", "Select the parent, then nothing"],
      ["Otherwise", "Leave edit mode"],
    ],
  },
];

/** The keys that close the help: Escape, and `?` again. */
const CLOSE_KEYS = ["Escape", "?"];

/** The edit mode's keys, on `?`, unless the user is typing (the editor keeps those keys to itself). */
export function ShortcutHelp() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "?" || event.metaKey || event.ctrlKey) return;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      setOpen(true);
    };
    const onMessage = (event: MessageEvent) => {
      const { type, key, mod } = event.data ?? {};
      if (type !== "slop:key" || key !== "?" || mod) return;
      if (Array.from(document.querySelectorAll("iframe")).some((f) => f.contentWindow === event.source)) setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
    };
  }, []);

  if (!open) return null;

  return (
    <Dialog
      label="Keyboard shortcuts"
      onClose={() => setOpen(false)}
      className="w-[34rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-4 text-xs text-foreground shadow-lg outline-none"
      heading={<h2 className="text-sm font-medium">Keyboard shortcuts</h2>}
      takeFocus
      closeKeys={CLOSE_KEYS}
      closeOnBackdrop
      closeButton
      backdropTestId="shortcut-help-backdrop"
    >
      <div className="grid grid-cols-2 gap-x-6 gap-y-4">
        {SECTIONS.map((section) => (
          <section key={section.title}>
            <h3 className="mb-1 font-medium text-muted-foreground">{section.title}</h3>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
              {section.keys.map(([keys, what]) => (
                <div key={keys} className="contents">
                  <dt className="tabular-nums">{keys}</dt>
                  <dd className="text-muted-foreground">{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
