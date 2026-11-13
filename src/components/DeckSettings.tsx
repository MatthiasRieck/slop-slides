import { ArrowLeft } from "lucide-react";
import { useId, useLayoutEffect } from "react";

import { formatKeys } from "../lib/keys";
import { openLayer } from "../lib/layers";
import { useApp } from "../store";
import { Button } from "./Button";
import { SlideSizeSettings } from "./SlideSize";
import { StylePicker } from "./Templates";
import { TitleField } from "./TitleField";

const card = "flex flex-col overflow-hidden rounded-xl border bg-card text-foreground";

/** How the header names the mode Done goes back to. */
const MODE_NAMES = { view: "View", edit: "Edit", git: "Git" };

/**
 * The deck's settings, in the place of the slide: its title, the slide size and its style. No
 * mode tab is selected meanwhile; the header's Done button, and Escape, go back to the mode the
 * settings opened from. (The app's own settings are a tab of the sidebar.)
 */
export function DeckSettings() {
  const from = useApp((s) => s.settingsReturn);
  const done = () => useApp.getState().closeDeckSettings();

  // Escape leaves the settings, after whatever is open over them (a menu, a dialog): they lie
  // under all of it, and a field that has its own use for the key keeps it.
  useLayoutEffect(() => openLayer(() => useApp.getState().closeDeckSettings(), { base: true }), []);

  return (
    <section aria-label="Deck settings" className="h-full overflow-y-auto bg-canvas p-6">
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <header className="flex items-center gap-3">
          <h1 className="text-base font-semibold tracking-tight text-foreground">Deck settings</h1>
          <span className="flex-1" />
          <Button
            variant="primary"
            size="xl"
            title={`Back to ${MODE_NAMES[from]} (${formatKeys("escape")})`}
            onClick={done}
          >
            <ArrowLeft />
            Done
          </Button>
        </header>
        <div className={card}>
          <DeckTitle />
        </div>
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
        Shown in the top bar and the window, and what exports are named after. The deck's file keeps its name.
      </p>
    </div>
  );
}
