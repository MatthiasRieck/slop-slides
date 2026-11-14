import { Dialog } from "../Dialog";
import { keysLabel, SECTIONS } from "../ShortcutHelp";

/** The keys that close the list: Escape, and `?` again. */
const CLOSE_KEYS = ["Escape", "?"];

/** The keys of a show, as the shortcut help lists them under Presenting. */
export const showKeyRows = () => SECTIONS.find((section) => section.title === "Presenting")?.rows ?? [];

/**
 * The show's keys, in a small dialog over the show: `?` opens it there, where the app's whole
 * shortcut help would bury them under the editor's.
 */
export function ShowKeys({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      label="Keys while presenting"
      onClose={onClose}
      className="dark flex max-h-[calc(100vh-4rem)] w-[28rem] max-w-[calc(100vw-2rem)] flex-col rounded-xl border border-foreground/10 bg-background p-4 text-xs text-foreground shadow-lg outline-none"
      heading={<h2 className="text-sm font-medium">Keys while presenting</h2>}
      closeKeys={CLOSE_KEYS}
      closeOnBackdrop
      closeButton
    >
      <dl className="grid min-h-0 grid-cols-[max-content_1fr] gap-x-3 gap-y-1 overflow-y-auto">
        {showKeyRows().map(([keys, what]) => (
          <div key={keys} className="contents">
            <dt className="tabular-nums">{keysLabel(keys)}</dt>
            <dd className="text-foreground/60">{keysLabel(what)}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
