import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { DarkScope } from "@/lib/darkScope";
import { formatKeys } from "@/lib/keys";
import { keysLabel, SECTIONS } from "../settings/shortcuts";

/** The keys of a show, as the settings list them under Presenting. */
export const showKeyRows = () => SECTIONS.find((section) => section.title === "Presenting")?.rows ?? [];

/**
 * A row's keys (see `ShortcutRow`): each `{spec}` a key cap, written as the platform writes it
 * (see `formatKeys`); the words between them as they are.
 */
function Keys({ template }: { template: string }) {
  let at = 0;
  return template
    .split(/(\{[^}]+\})/)
    .filter((part) => part.trim() !== "")
    .map((part) => {
      const key = `${at}:${part}`;
      at += part.length;
      return part.startsWith("{") ? (
        <Kbd key={key}>{formatKeys(part.slice(1, -1))}</Kbd>
      ) : (
        <span key={key}>{part.trim()}</span>
      );
    });
}

/**
 * The show's keys, in a small dialog over the show: `?` opens it there, where the app's whole
 * list of shortcuts would bury them under the editor's. Escape closes it, and so do `?` again,
 * its Close button and a press beside it. The show is dark in either theme, and so is this,
 * which opens outside it (a `DarkScope` of its own, as the presenter window shows it too).
 */
export function ShowKeys({ onClose }: { onClose: () => void }) {
  return (
    <DarkScope>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent
          className="flex max-h-[calc(100vh-4rem)] flex-col text-xs sm:max-w-md"
          onKeyDown={(event) => {
            if (event.key === "?") onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-sm">Keys while presenting</DialogTitle>
          </DialogHeader>
          <dl className="grid min-h-0 grid-cols-[max-content_1fr] items-center gap-x-3 gap-y-1.5 overflow-y-auto">
            {showKeyRows().map(([keys, what]) => (
              <div key={keys} className="contents">
                <dt className="flex flex-wrap items-center gap-1">
                  <Keys template={keys} />
                </dt>
                <dd className="text-muted-foreground">{keysLabel(what)}</dd>
              </div>
            ))}
          </dl>
        </DialogContent>
      </Dialog>
    </DarkScope>
  );
}
