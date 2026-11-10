import { KeyRound, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import type { Deck, NarrationProvider } from "../../lib/api";
import { deckProvider, useNarration } from "../../narrationStore";
import { useApp } from "../../store";
import { Button } from "../Button";
import { Field, inputClass, wideSelectClass } from "../Field";

/** The deck's provider, voice and language, and the service's API key. */
export function SpeechSettings({ deck }: { deck: Deck }) {
  const speech = useNarration((s) => s.speech);
  const accountVoices = useNarration((s) => s.accountVoices);
  const loadVoices = useNarration((s) => s.loadVoices);
  const provider = speech ? deckProvider(deck, speech) : undefined;
  const providerId = provider?.id;
  const hasKey = provider?.key != null;
  useEffect(() => {
    // ElevenLabs accounts have voices of their own, such as the user's cloned voice.
    if (providerId === "elevenlabs" && hasKey) void loadVoices(providerId);
  }, [providerId, hasKey, loadVoices]);
  if (!speech || !provider) return null;
  const settings = deck.narration ?? { voice: provider.voices[0]?.id ?? "", language: "en" };
  const voices = accountVoices[provider.id] ?? provider.voices;
  // A voice the deck names that is not listed (an account's own, before the list came) stays pickable.
  const listed = voices.some((v) => v.id === settings.voice);
  return (
    <div className="flex flex-col gap-2 p-3 text-xs">
      <Field label="Spoken by" className="flex min-w-0 flex-col gap-1">
        <select
          aria-label="Narration provider"
          value={provider.id}
          onChange={(event) => void useApp.getState().setNarrationProvider(event.target.value)}
          className={wideSelectClass}
        >
          {speech.providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="flex gap-2">
        <Field label="Voice" className="flex min-w-0 flex-[3] flex-col gap-1">
          <select
            aria-label="Narration voice"
            value={settings.voice}
            onChange={(event) => void useApp.getState().setNarrationVoice(event.target.value)}
            className={wideSelectClass}
          >
            {!listed && <option value={settings.voice}>{settings.voice}</option>}
            {voices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.name}
                {voice.description ? ` — ${voice.description}` : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Language" className="flex min-w-0 flex-[2] flex-col gap-1">
          <select
            aria-label="Narration language"
            value={settings.language}
            onChange={(event) => void useApp.getState().setNarrationLanguage(event.target.value)}
            className={wideSelectClass}
          >
            {speech.languages.map((language) => (
              <option key={language.id} value={language.id}>
                {language.name}
              </option>
            ))}
          </select>
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
          size="md"
          onClick={() => void useNarration.getState().setKey(provider.id, null)}
          title={`Forget the ${provider.name} API key on this computer`}
        >
          <Trash2 />
          Remove
        </Button>
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-2 rounded-md border bg-card p-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="text-muted-foreground">
        {provider.name} says the narration with your account. Its API key is kept on this computer for every deck, never
        in a deck. Narration text is sent to {provider.name}.
      </p>
      <div className="flex gap-1">
        <input
          type="password"
          aria-label={`${provider.name} API key`}
          placeholder="API key"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          className={`${inputClass} flex-1 text-xs`}
        />
        <Button size="md" type="submit" disabled={key.trim() === ""}>
          Save
        </Button>
      </div>
    </form>
  );
}
