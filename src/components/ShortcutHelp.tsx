import { X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";

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

/** The edit mode's keys, on `?`, unless the user is typing (the editor keeps those keys to itself). */
export function ShortcutHelp() {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

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

  // Takes focus from the preview, so Escape closes this rather than reaching the editor.
  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    returnFocus.current?.focus();
  };

  if (!open) return null;

  const onKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape" || event.key === "?") {
      event.preventDefault();
      close();
    }
  };

  return (
    <div
      data-testid="shortcut-help-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: a dialog that takes focus handles its own keys. */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="w-[34rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-4 text-xs text-foreground shadow-lg outline-none"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium">Keyboard shortcuts</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
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
      </div>
    </div>
  );
}
