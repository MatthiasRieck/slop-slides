import { ArrowLeft } from "lucide-react";
import { useId, useLayoutEffect } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { openLayer } from "../lib/layers";
import { useApp } from "../store";
import { SlideSizeSettings } from "./SlideSize";
import { StylePicker } from "./Templates";
import { TitleField } from "./TitleField";

/** A card of the settings: what is in it brings its own padding and dividers. */
const card = "gap-0 py-0";

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
          <Button size="sm" tooltip={`Back to ${MODE_NAMES[from]}`} shortcut="escape" onClick={done}>
            <ArrowLeft data-icon="inline-start" />
            Done
          </Button>
        </header>
        <Card className={card}>
          <DeckTitle />
        </Card>
        <Card className={card}>
          <SlideSizeSettings />
        </Card>
        <Card className={card}>
          <StylePicker />
        </Card>
      </div>
    </section>
  );
}

/** The deck's title, as the top bar, the window and exports show it. */
function DeckTitle() {
  const title = useApp((s) => s.deck?.title ?? "");
  const id = useId();
  return (
    <Field className="gap-1 p-3">
      <FieldLabel htmlFor={id} className="text-xs">
        Title
      </FieldLabel>
      <TitleField
        id={id}
        title={title}
        onCommit={(next) => useApp.getState().renameDeck(next)}
        className="h-7 w-full px-2"
      />
      <FieldDescription className="text-2xs">
        Shown in the top bar and the window, and what exports are named after. The deck's file keeps its name.
      </FieldDescription>
    </Field>
  );
}
