import { X } from "lucide-react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { editedSlidesOf, useApp } from "../../store";
import { Button } from "../Button";
import { Dialog } from "../Dialog";

/**
 * Floats under the edit tools while there are edits to discard, and puts the slides back as they
 * were on entering edit mode, staying in it. When the current slide and others were edited, it asks whether to put back just this
 * slide or every slide.
 */
export function DiscardButton() {
  const selected = useApp((s) => s.selected);
  const edited = useApp(useShallow(editedSlidesOf));
  const [asking, setAsking] = useState(false);
  if (edited.length === 0) return null;
  const app = useApp.getState;
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
        onClick={() => (selected && edited.includes(selected) && others > 0 ? setAsking(true) : discardAll())}
        className="absolute top-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border bg-background px-3 py-1 text-xs font-medium text-foreground shadow-md hover:bg-accent [&_svg]:size-3.5"
      >
        <X />
        Discard changes
      </button>
      {asking && selected && (
        <Dialog
          label="Discard changes"
          takeFocus
          closeOnBackdrop
          onClose={() => setAsking(false)}
          className="flex w-96 max-w-[90vw] flex-col gap-4 rounded-xl border bg-background p-5 text-foreground shadow-2xl outline-none"
          heading={
            <>
              <h2 className="text-base font-semibold">Discard changes on other slides too?</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                You also edited {others === 1 ? "1 other slide" : `${others} other slides`} since entering edit mode.
              </p>
            </>
          }
        >
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setAsking(false);
                void app().discardSlideEdits(selected);
              }}
            >
              Only this slide
            </Button>
            <Button variant="primary" onClick={discardAll}>
              All slides
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
