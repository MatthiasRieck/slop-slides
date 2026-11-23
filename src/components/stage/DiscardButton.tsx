import { X } from "lucide-react";
import { useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { plural } from "../../lib/utils";
import { editedSlidesOf, useApp } from "../../store";

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
  const discard = useRef<HTMLButtonElement>(null);
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
      <Button
        variant="outline"
        size="xs"
        tooltip="Undo the edits made since entering edit mode"
        tooltipSide="bottom"
        onClick={() => (others > 0 ? setAsking(true) : discardAll())}
        className="absolute top-2 left-1/2 z-10 -translate-x-1/2 rounded-full bg-background px-3 shadow-md dark:bg-background"
      >
        <X data-icon="inline-start" />
        {discardLabel(edited, selected)}
      </Button>
      {asking && (
        <AlertDialog open onOpenChange={(open) => !open && setAsking(false)}>
          {/* With no changes on the slide shown there is one thing to confirm: the focus starts on it. */}
          <AlertDialogContent aria-label="Discard changes" {...(!here && { initialFocus: discard })}>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {here ? "Discard changes on other slides too?" : `Discard changes on ${plural(others, "other slide")}?`}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {here
                  ? `You also edited ${plural(others, "other slide")} since entering edit mode.`
                  : `The slide shown has no changes. ${others === 1 ? "The slide" : "The slides"} you edited since entering edit mode ${others === 1 ? "goes" : "go"} back to how ${others === 1 ? "it was" : "they were"} then.`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
              {here && selected && (
                <AlertDialogAction
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setAsking(false);
                    void app().discardSlideEdits(selected);
                  }}
                >
                  Only this slide
                </AlertDialogAction>
              )}
              <AlertDialogAction
                ref={discard}
                variant={here ? "default" : "destructive"}
                size="sm"
                onClick={discardAll}
              >
                {here ? `All ${plural(edited.length, "slide")}` : `Discard on ${plural(others, "slide")}`}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
