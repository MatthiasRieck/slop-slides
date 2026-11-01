import { SlideSizeSettings } from "./SlideSize";
import { StylePicker } from "./Templates";

const card = "flex flex-col overflow-hidden rounded-xl border bg-card text-foreground";

/** Settings mode, in the place of the slide: the slide size and the deck's style. */
export function DeckSettings() {
  return (
    <section aria-label="Slide settings" className="h-full overflow-y-auto bg-canvas p-6">
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <div className={card}>
          <SlideSizeSettings />
        </div>
        <div className={card}>
          <StylePicker />
        </div>
      </div>
    </section>
  );
}
