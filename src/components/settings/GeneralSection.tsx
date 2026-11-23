import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderSearch } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

import { api } from "../../lib/api";
import { APPEARANCES, type Appearance, type RewindSetting } from "../../lib/settings";
import { revealLabel } from "../../lib/utils";
import { showError, useApp } from "../../store";

const APPEARANCE_LABELS: Record<Appearance, string> = { system: "System", light: "Light", dark: "Dark" };

/** What undoing an agent's changes does to the chat, as the settings offer it. */
const REWIND_OPTIONS: [RewindSetting, string][] = [
  ["ask", "Ask each time"],
  ["rewind", "Also rewind the chat"],
  ["deck", "Only undo the deck changes"],
];

/**
 * The settings' General section, for every deck alike: how the app looks, how undoing an agent's
 * changes treats the chat, and where the library is. (A deck's own settings, its title, slide
 * size and style, open from the file menu.) A choice is the backend's to keep: it shows once the
 * backend has it, in every window.
 */
export function GeneralSection() {
  const appearance = useApp((s) => s.settings.appearance);
  const rewind = useApp((s) => s.settings.rewind);
  const [library, setLibrary] = useState<string | null>(null);
  const id = useId();

  useEffect(() => {
    let gone = false;
    // Without it (the browser preview), the section just leaves the path out.
    Promise.resolve()
      .then(api.libraryFolder)
      .then(
        (path) => !gone && typeof path === "string" && setLibrary(path),
        () => {},
      );
    return () => {
      gone = true;
    };
  }, []);

  const update = useApp.getState().updateSettings;

  const revealLibrary = async () => {
    try {
      await revealItemInDir(library ?? (await api.libraryFolder()));
    } catch (error) {
      showError(error);
    }
  };

  return (
    <ItemGroup className="gap-0 rounded-lg border bg-card">
      <Item>
        <ItemContent>
          <ItemTitle role="heading" aria-level={4}>
            Appearance
          </ItemTitle>
          <ItemDescription className="text-xs">System follows your computer's light or dark mode.</ItemDescription>
        </ItemContent>
        <ItemActions>
          <RadioGroup
            aria-label="Appearance"
            value={appearance}
            onValueChange={(value) => void update({ appearance: value as Appearance })}
            className="flex w-auto gap-4"
          >
            {APPEARANCES.map((value) => (
              <Field key={value} orientation="horizontal" className="w-auto gap-1.5">
                <RadioGroupItem id={`${id}-appearance-${value}`} value={value} />
                <FieldLabel htmlFor={`${id}-appearance-${value}`} className="text-xs font-normal">
                  {APPEARANCE_LABELS[value]}
                </FieldLabel>
              </Field>
            ))}
          </RadioGroup>
        </ItemActions>
      </Item>
      <ItemSeparator className="my-0" />
      <Item>
        <ItemContent>
          <ItemTitle role="heading" aria-level={4}>
            Undoing a chat message's changes
          </ItemTitle>
          <ItemDescription className="text-xs">
            What happens to the chat when you undo what the agent did.
          </ItemDescription>
        </ItemContent>
        <ItemFooter>
          <RadioGroup
            aria-label="Undoing a chat message's changes"
            value={rewind}
            onValueChange={(value) => void update({ rewind: value as RewindSetting })}
          >
            {REWIND_OPTIONS.map(([value, label]) => (
              <Field key={value} orientation="horizontal">
                <RadioGroupItem id={`${id}-rewind-${value}`} value={value} />
                <FieldLabel htmlFor={`${id}-rewind-${value}`} className="text-xs font-normal">
                  {label}
                </FieldLabel>
              </Field>
            ))}
          </RadioGroup>
        </ItemFooter>
      </Item>
      <ItemSeparator className="my-0" />
      <Item>
        <ItemContent>
          <ItemTitle role="heading" aria-level={4}>
            Library
          </ItemTitle>
          <ItemDescription className="text-xs">
            New decks from the start screen are kept in the SlopSlide library.
          </ItemDescription>
        </ItemContent>
        <ItemFooter className="justify-start">
          {library && (
            <span
              data-testid="library-path"
              title={library}
              className="selectable min-w-0 flex-1 truncate rounded-md border bg-muted px-2 py-1 font-mono text-xs"
            >
              {library}
            </span>
          )}
          <Button variant="outline" size="xs" onClick={() => void revealLibrary()}>
            <FolderSearch data-icon="inline-start" />
            {revealLabel}
          </Button>
        </ItemFooter>
      </Item>
    </ItemGroup>
  );
}
