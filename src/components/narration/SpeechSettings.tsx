import { KeyRound, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item } from "@/components/ui/item";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import type { Deck, NarrationProvider } from "../../lib/api";
import { deckProvider, useNarration } from "../../narrationStore";
import { useApp } from "../../store";
import { QUIET_LABEL } from "../styles";

/** The deck's provider, voice and language, and the service's API key. */
export function SpeechSettings({ deck }: { deck: Deck }) {
  const speech = useNarration((s) => s.speech);
  const accountVoices = useNarration((s) => s.accountVoices);
  const loadVoices = useNarration((s) => s.loadVoices);
  const provider = speech ? deckProvider(deck, speech) : undefined;
  const providerId = provider?.id;
  const hasKey = provider?.key != null;
  const id = useId();
  useEffect(() => {
    // ElevenLabs accounts have voices of their own, such as the user's cloned voice.
    if (providerId === "elevenlabs" && hasKey) void loadVoices(providerId);
  }, [providerId, hasKey, loadVoices]);
  if (!speech || !provider) return null;
  const settings = deck.narration ?? { voice: provider.voices[0]?.id ?? "", language: "en" };
  const voices = accountVoices[provider.id] ?? provider.voices;
  // A voice the deck names that is not listed (an account's own, before the list came) stays pickable.
  const listed = voices.some((v) => v.id === settings.voice);
  const choices = [...(listed ? [] : [{ id: settings.voice, name: settings.voice, description: "" }]), ...voices];
  return (
    <div className="flex flex-col gap-2 p-3 text-xs">
      <Field className="gap-1">
        <FieldLabel htmlFor={`${id}-provider`} className={QUIET_LABEL}>
          Spoken by
        </FieldLabel>
        <NativeSelect
          id={`${id}-provider`}
          size="sm"
          aria-label="Narration provider"
          value={provider.id}
          onChange={(event) => void useApp.getState().setNarrationProvider(event.target.value)}
          className="w-full"
        >
          {speech.providers.map((p) => (
            <NativeSelectOption key={p.id} value={p.id}>
              {p.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <div className="flex gap-2">
        <Field className="min-w-0 flex-[3] gap-1">
          <FieldLabel htmlFor={`${id}-voice`} className={QUIET_LABEL}>
            Voice
          </FieldLabel>
          {/* The voices have a line each on how they sound, which the list shows and the field does not. */}
          <Select
            items={choices.map((voice) => ({ value: voice.id, label: voice.name }))}
            value={settings.voice}
            onValueChange={(voice) => void useApp.getState().setNarrationVoice(voice as string)}
          >
            <SelectTrigger id={`${id}-voice`} size="sm" aria-label="Narration voice" className="w-full min-w-0 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false} align="start" className="w-auto max-w-96">
              <SelectGroup>
                {choices.map((voice) => (
                  <SelectItem key={voice.id} value={voice.id} className="text-xs">
                    {voice.name}
                    {voice.description && " "}
                    {voice.description && <span className="text-muted-foreground">— {voice.description}</span>}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field className="min-w-0 flex-[2] gap-1">
          <FieldLabel htmlFor={`${id}-language`} className={QUIET_LABEL}>
            Language
          </FieldLabel>
          <NativeSelect
            id={`${id}-language`}
            size="sm"
            aria-label="Narration language"
            value={settings.language}
            onChange={(event) => void useApp.getState().setNarrationLanguage(event.target.value)}
            className="w-full"
          >
            {speech.languages.map((language) => (
              <NativeSelectOption key={language.id} value={language.id}>
                {language.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <ApiKey provider={provider} />
    </div>
  );
}

/** The environment variable a hosted provider's key may come from. */
const KEY_ENV: Record<string, string> = { elevenlabs: "ELEVENLABS_API_KEY", openai: "OPENAI_API_KEY" };

/** A hosted provider's API key: entered once, kept in ~/.slopslides for every deck. */
function ApiKey({ provider }: { provider: NarrationProvider }) {
  const [key, setKey] = useState("");
  const id = useId();
  const save = async () => {
    if (await useNarration.getState().setKey(provider.id, key)) setKey("");
  };
  if (provider.key === "environment") {
    return (
      <p className="text-muted-foreground">
        Using {KEY_ENV[provider.id] ?? "the API key"} from your environment. Narration text is sent to {provider.name}.
      </p>
    );
  }
  if (provider.key === "saved") {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
          <KeyRound className="size-3.5 shrink-0" />
          {provider.name} API key saved
        </span>
        <Button
          variant="outline"
          size="xs"
          onClick={() => void useNarration.getState().setKey(provider.id, null)}
          tooltip={`Forget the ${provider.name} API key on this computer`}
        >
          <Trash2 data-icon="inline-start" />
          Remove
        </Button>
      </div>
    );
  }
  return (
    <Item
      variant="outline"
      size="xs"
      className="bg-card p-2"
      render={
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        />
      }
    >
      <Field className="gap-2">
        <FieldDescription id={`${id}-about`} className="text-xs">
          {provider.name} says the narration with your account. Its API key is kept on this computer for every deck,
          never in a deck. Narration text is sent to {provider.name}.
        </FieldDescription>
        <div className="flex gap-1">
          <Input
            size="sm"
            type="password"
            aria-label={`${provider.name} API key`}
            aria-describedby={`${id}-about`}
            placeholder="API key"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            className="flex-1"
          />
          <Button size="sm" type="submit" disabled={key.trim() === ""}>
            Save
          </Button>
        </div>
      </Field>
    </Item>
  );
}
