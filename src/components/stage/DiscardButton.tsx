import { X } from "lucide-react";
import { useState } from "react";

import { plural } from "../../lib/utils";
import { editedSlidesOf, useApp } from "../../store";
import { Button } from "../Button";
import { Dialog, DialogActions } from "../Dialog";

/** What the button says it discards: the slide shown, or how many slides. */
export function discardLabel(edited: string[], selected: string | null): string {
  if (edited.length === 1 && edited[0] === selected) return "Discard changes";
  if (selected && edited.includes(selected)) return `Discard changes on ${plural(edited.length, "slide")}`;
  return `Discard changes on ${plural(edited.length, "other slide")}`;
}

/**
 * Floats at the top left of the stage, beside Find (see `StageOverlay` in ../Stage.tsx), while there are edits to discard, and puts the slides back as they
 * were on entering edit mode, staying in it. It says how far it reaches: the slide shown, or how
 * many slides. Only the slide shown goes back at once; whenever another slide would change too,
 * it asks first, and when the slide shown is among them, whether to put back just that one.
 */
export function DiscardButton() {
  const selected = useApp((s) => s.selected);
  const edited = useApp(editedSlidesOf);
  const [asking, setAsking] = useState(false);
  if (edited.length === 0) return null;
  const app = useApp.getState;
  const here = !!selected && edited.includes(selected);
  const others = edited.filter((slide) => slide !== selected).length;
  const discardAll = () => {
    setAsking(false);
    void app().discardSlideEdits();
  };
  return (
    <>
      <button
        type="button"
        title="Undo the edits made since entering edit mode"
        onClick={() => (others > 0 ? setAsking(true) : discardAll())}
        className="pointer-events-auto flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border bg-background px-3 text-xs font-medium text-foreground shadow-md hover:bg-accent [&_svg]:size-3.5"
      >
        <X />
        {discardLabel(edited, selected)}
      </button>
      {asking && (
        <Dialog
          label="Discard changes"
          closeOnBackdrop
          onClose={() => setAsking(false)}
          size="sm"
          title={here ? "Discard changes on other slides too?" : `Discard changes on ${plural(others, "other slide")}?`}
          description={
            here
              ? `You also edited ${plural(others, "other slide")} since entering edit mode.`
              : `The slide shown has no changes. ${others === 1 ? "The slide" : "The slides"} you edited since entering edit mode ${others === 1 ? "goes" : "go"} back to how ${others === 1 ? "it was" : "they were"} then.`
          }
        >
          <DialogActions>
            <Button size="lg" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            {here && selected && (
              <Button
                size="lg"
                onClick={() => {
                  setAsking(false);
                  void app().discardSlideEdits(selected);
                }}
              >
                Only this slide
              </Button>
            )}
            <Button
              variant={here ? "primary" : "destructive"}
              size="lg"
              data-autofocus={here ? undefined : ""}
              onClick={discardAll}
            >
              {here ? `All ${plural(edited.length, "slide")}` : `Discard on ${plural(others, "slide")}`}
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </>
  );
}
