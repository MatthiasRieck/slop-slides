import { X } from "lucide-react";
import { useState } from "react";

import { plural } from "../../lib/utils";
import { editedSlidesOf, useApp } from "../../store";
import { Button } from "../Button";
import { Dialog } from "../Dialog";

/** What the button says it discards: the slide shown, or how many slides. */
export function discardLabel(edited: string[], selected: string | null): string {
  if (edited.length === 1 && edited[0] === selected) return "Discard changes";
  if (selected && edited.includes(selected)) return `Discard changes on ${plural(edited.length, "slide")}`;
  return `Discard changes on ${plural(edited.length, "other slide")}`;
}

/**
 * Floats under the edit tools while there are edits to discard, and puts the slides back as they
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
        className="absolute top-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border bg-background px-3 py-1 text-xs font-medium text-foreground shadow-md hover:bg-accent [&_svg]:size-3.5"
      >
        <X />
        {discardLabel(edited, selected)}
      </button>
      {asking && (
        <Dialog
          label="Discard changes"
          closeOnBackdrop
          onClose={() => setAsking(false)}
          className="flex w-96 max-w-[90vw] flex-col gap-4 rounded-xl border bg-background p-5 text-foreground shadow-2xl outline-none"
          heading={
            <>
              <h2 className="text-base font-semibold">
                {here ? "Discard changes on other slides too?" : `Discard changes on ${plural(others, "other slide")}?`}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {here
                  ? `You also edited ${plural(others, "other slide")} since entering edit mode.`
                  : `The slide shown has no changes. ${others === 1 ? "The slide" : "The slides"} you edited since entering edit mode ${others === 1 ? "goes" : "go"} back to how ${others === 1 ? "it was" : "they were"} then.`}
              </p>
            </>
          }
        >
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            {here && selected && (
              <Button
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
              data-autofocus={here ? undefined : ""}
              onClick={discardAll}
            >
              {here ? `All ${plural(edited.length, "slide")}` : `Discard on ${plural(others, "slide")}`}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
