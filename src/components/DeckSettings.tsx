import { useId, useState } from "react";

import type { SlideSize } from "../lib/slideSize";
import { useApp } from "../store";
import { Button } from "./Button";
import { Dialog, DialogActions } from "./Dialog";
import { SlideSizeSettings } from "./SlideSize";
import { StylePicker } from "./Templates";
import { TitleField } from "./TitleField";

const card = "flex shrink-0 flex-col overflow-hidden rounded-xl border bg-background text-foreground";

/**
 * The deck's settings, a dialog over the deck, whose slide and mode stay as they are underneath:
 * its title, the slide size and its style. (The app's own settings are a dialog of their own.)
 *
 * The title and the style take effect as they are given; the slide size, which lays every slide
 * out again, waits for Apply. Closing with a size that is not applied yet asks first, so nothing
 * typed is lost without a word. The heading and the buttons stay in sight while the rest scrolls.
 */
export function DeckSettings() {
  /** A slide size typed or picked and not applied yet. */
  const [pending, setPending] = useState<SlideSize | null>(null);
  /** Closing waits for the user to say what becomes of `pending`. */
  const [asking, setAsking] = useState(false);
  const [applying, setApplying] = useState(false);
  const close = () => useApp.getState().closeDeckSettings();
  const tryClose = () => (pending ? setAsking(true) : close());

  const applyAndClose = async () => {
    if (!pending) return close();
    setApplying(true);
    const change = await useApp.getState().resizeSlides(pending);
    setApplying(false);
    if (change !== null) close();
    else setAsking(false);
  };

  return (
    <Dialog label="Deck settings" size="lg" title="Deck settings" closeButton onClose={tryClose}>
      <section aria-label="Deck settings" className="-mx-5 flex min-h-0 flex-col gap-4 overflow-y-auto px-5 pb-1">
        <div className={card}>
          <DeckTitle />
        </div>
        <div className={card}>
          <SlideSizeSettings onPending={setPending} />
        </div>
        <div className={card}>
          <StylePicker />
        </div>
      </section>
      {asking && pending ? (
        <div role="alert" className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
          <p className="font-medium text-foreground">Apply the new slide size?</p>
          <p className="text-muted-foreground">
            {pending.width} × {pending.height} {pending.unit} is typed in but not applied to the slides yet.
          </p>
          <DialogActions
            aside={
              <Button size="lg" onClick={() => setAsking(false)}>
                Keep editing
              </Button>
            }
          >
            <Button size="lg" onClick={close}>
              Discard size
            </Button>
            <Button variant="primary" size="lg" busy={applying} data-autofocus onClick={() => void applyAndClose()}>
              Apply and close
            </Button>
          </DialogActions>
        </div>
      ) : (
        <DialogActions>
          <Button variant="primary" size="lg" onClick={tryClose}>
            Close
          </Button>
        </DialogActions>
      )}
    </Dialog>
  );
}

/** The deck's title, as the top bar, the window and exports show it. */
function DeckTitle() {
  const title = useApp((s) => s.deck?.title ?? "");
  const id = useId();
  return (
    <div className="flex flex-col gap-1 p-3 text-xs">
      <label htmlFor={id} className="font-medium">
        Title
      </label>
      <TitleField
        id={id}
        title={title}
        onCommit={(next) => useApp.getState().renameDeck(next)}
        className="h-7 w-full text-sm"
      />
      <p className="text-2xs text-muted-foreground">
        Shown in the top bar and the window, and what exports are named after. The deck's folder keeps its name.
      </p>
    </div>
  );
}
