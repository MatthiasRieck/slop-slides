import { Check, CircleAlert, Loader2, PencilLine } from "lucide-react";
import { useEffect, useState } from "react";

import { formatKeys } from "../lib/keys";
import { useSaves } from "../lib/saves";
import { SHELL_SHORTCUTS } from "../lib/shellKeys";
import { cn } from "../lib/utils";
import { useApp } from "../store";
import { NOT_SAVED } from "../store/workspace";
import { Button } from "./Button";

/** How long a write runs before the bar says "Saving…": most are over sooner, and the word would only flicker. */
export const SAVING_AFTER_MS = 400;

/** What the bar says about the deck's file. */
export type SaveState = "saved" | "saving" | "failed" | "unsaved";

/**
 * How saving the open deck stands: its HTML tab holds edits that are not in the file (`unsaved`),
 * the last write failed, a write has been running for a moment (`saving`), or everything is in
 * the file (`saved`).
 */
export function useSaveState(): SaveState {
  const codeDirty = useApp((s) => s.codeDirty);
  const pending = useSaves((s) => s.pending > 0);
  const failed = useSaves((s) => s.failed);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!pending) return setSlow(false);
    const timer = setTimeout(() => setSlow(true), SAVING_AFTER_MS);
    return () => clearTimeout(timer);
  }, [pending]);
  if (codeDirty) return "unsaved";
  if (pending && slow) return "saving";
  if (failed && !pending) return "failed";
  return "saved";
}

/**
 * The quiet word in the top bar that the deck is saved: the app saves every change as it is made,
 * and says "Saving…" while a write takes its time. Only what needs the user stands out: edits in
 * the HTML tab that are not saved yet (pressing it saves them), and a change that did not reach
 * the file. `compact` leaves the word out while all is well, and shows only what stands out.
 */
export function SaveStatus({ compact = false }: { compact?: boolean }) {
  const state = useSaveState();
  if (state === "unsaved") {
    return (
      <Button
        variant="ghost"
        size="md"
        title={`The HTML tab has edits that are not saved yet. Save them (${formatKeys(SHELL_SHORTCUTS.save)})`}
        onClick={() => void useApp.getState().confirmSaved()}
        className="shrink-0 text-warning"
      >
        <PencilLine />
        Unsaved edits
      </Button>
    );
  }
  if (compact && state !== "failed") return null;
  const failed = state === "failed";
  const Icon = failed ? CircleAlert : state === "saving" ? Loader2 : Check;
  return (
    <span
      role="status"
      title={failed ? NOT_SAVED : "Every change to the deck is saved as you make it"}
      className={cn(
        "flex shrink-0 items-center gap-1 px-1.5 text-xs",
        failed ? "font-medium text-destructive" : "text-muted-foreground",
      )}
    >
      <Icon className={cn("size-3.5", state === "saving" && "animate-spin")} />
      {failed ? "Not saved" : state === "saving" ? "Saving…" : "Saved"}
    </span>
  );
}
