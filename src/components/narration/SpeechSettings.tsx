import { KeyRound, Loader2, Square, Trash2, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Deck, NarrationPace, NarrationProvider } from "../../lib/api";
import { voiceSample } from "../../lib/narrationCache";
import { deckProvider, useNarration } from "../../narrationStore";
import { showError, useApp } from "../../store";
import { Button, ToolButton } from "../Button";
import { Field, inputClass, wideSelectClass } from "../Field";

/** The paces narration can be said at, as the select names them. */
const PACES: { id: NarrationPace; name: string }[] = [
  { id: "slower", name: "Slower" },
  { id: "normal", name: "Normal" },
  { id: "faster", name: "Faster" },
];

/** The longest a style note may be, as the backend takes it. */
const MAX_STYLE = 200;

/**
 * Who says the whole deck's narration and how: set once, so it shows as one line (the service,
 * the voice, the language, and a pace other than normal) with Change beside it. Opened, it has
 * the service, the voice with a button to hear it, the language, the pace, a note on the manner
 * for a service that takes one, and the service's API key. A service without a key says so in
 * the folded line too, since nothing can be generated until it has one.
 */
export function SpeechSettings({ deck }: { deck: Deck }) {
  const [open, setOpen] = useState(false);
  const speech = useNarration((s) => s.speech);
  const accountVoices = useNarration((s) => s.accountVoices);
  const loadVoices = useNarration((s) => s.loadVoices);
  const kept = useNarration((s) => (s.settingsDeck === deck.id ? s.settings : undefined));
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
  const voice = voices.find((v) => v.id === settings.voice);
  const language = speech.languages.find((l) => l.id === settings.language)?.name ?? settings.language;
  const pace = kept?.pace ?? "normal";
  const style = kept?.style ?? "";
  const summary = [
    provider.name,
    voice?.name ?? settings.voice,
    language,
    ...(pace === "normal" ? [] : [pace === "slower" ? "slower pace" : "faster pace"]),
  ].join(" · ");
  const setDelivery = (next: { pace?: NarrationPace; style?: string }) =>
    void useNarration.getState().setDelivery(deck.id, next.pace ?? pace, next.style ?? style);
  return (
    <div className="flex flex-col gap-2 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span data-testid="voice-summary" className="min-w-0 truncate" title={`The whole deck is said by ${summary}`}>
          <span className="text-muted-foreground">Voice </span>
          {summary}
        </span>
        <Button
          size="md"
          aria-expanded={open}
          title={open ? "Fold the voice settings away" : "Change who says the deck's narration, and how"}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Done" : "Change"}
        </Button>
      </div>
      {!open && provider.key === null && (
        <div className="flex items-center justify-between gap-2 rounded-md border bg-card p-2">
          <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <KeyRound className="size-3.5 shrink-0" />
            Add your {provider.name} API key to generate audio.
          </span>
          <Button size="md" className="shrink-0 whitespace-nowrap" onClick={() => setOpen(true)}>
            Add key
          </Button>
        </div>
      )}
      {open && (
        <>
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
          <div className="flex items-end gap-1">
            <Field label="Voice" className="flex min-w-0 flex-1 flex-col gap-1">
              <select
                aria-label="Narration voice"
                value={settings.voice}
                onChange={(event) => void useApp.getState().setNarrationVoice(event.target.value)}
                className={wideSelectClass}
              >
                {!voice && <option value={settings.voice}>{settings.voice}</option>}
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                    {v.description ? ` — ${v.description}` : ""}
                  </option>
                ))}
              </select>
            </Field>
            <VoicePreview provider={provider} voice={settings.voice} language={settings.language} />
          </div>
          <div className="flex gap-2">
            <Field label="Language" className="flex min-w-0 flex-1 flex-col gap-1">
              <select
                aria-label="Narration language"
                value={settings.language}
                onChange={(event) => void useApp.getState().setNarrationLanguage(event.target.value)}
                className={wideSelectClass}
              >
                {speech.languages.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Pace" className="flex min-w-0 flex-1 flex-col gap-1">
              <select
                aria-label="Speaking pace"
                value={pace}
                onChange={(event) => setDelivery({ pace: event.target.value as NarrationPace })}
                className={wideSelectClass}
              >
                {PACES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <StyleNote
            key={`${deck.id}\n${style}`}
            style={style}
            provider={provider}
            onChange={(next) => setDelivery({ style: next })}
          />
          <p className="text-muted-foreground">
            A change here puts the audio already generated out of date; recordings of your own voice stay.
          </p>
          <ApiKey provider={provider} />
        </>
      )}
    </div>
  );
}

/**
 * A note on the manner the narration is said in, saved when the field is left or Enter is
 * pressed. A service that takes none has the field off, and says so.
 */
function StyleNote(props: { style: string; provider: NarrationProvider; onChange: (style: string) => void }) {
  const [draft, setDraft] = useState(props.style);
  const taken = !!props.provider.takesStyle;
  const commit = () => {
    const next = draft.trim();
    if (next !== props.style) props.onChange(next);
  };
  return (
    <Field label="Style" className="flex min-w-0 flex-col gap-1">
      <input
        aria-label="Speaking style"
        value={taken ? draft : ""}
        disabled={!taken}
        maxLength={MAX_STYLE}
        placeholder={taken ? "Like: warm and calm, or upbeat" : `${props.provider.name} takes no style note`}
        title={
          taken
            ? "How the narration should sound, in a few words. It goes to the service with every slide."
            : `${props.provider.name} says narration in the voice's own manner; only the pace can be set.`
        }
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className={`${inputClass} text-xs disabled:opacity-60`}
      />
    </Field>
  );
}

/**
 * Hear the voice before generating with it: a short sample in the deck's language. The service
 * says it once, with the user's key; after that it is kept on this computer and plays at once.
 */
function VoicePreview(props: { provider: NarrationProvider; voice: string; language: string }) {
  const { provider, voice, language } = props;
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const sound = useRef<HTMLAudioElement | null>(null);
  // Which press the sample coming in was asked by: one overtaken by another press plays nothing.
  const asked = useRef(0);
  const stop = () => {
    asked.current += 1;
    sound.current?.pause();
    sound.current = null;
    setState("idle");
  };
  // Another voice is another sample; leaving ends what plays.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Stops for each change of what is previewed.
  useEffect(() => stop, [provider.id, voice, language]);
  const play = async () => {
    if (state !== "idle") return stop();
    asked.current += 1;
    const mine = asked.current;
    setState("loading");
    try {
      const url = await voiceSample(provider.id, voice, language);
      if (asked.current !== mine) return;
      const audio = new Audio(url);
      sound.current = audio;
      audio.addEventListener("ended", () => asked.current === mine && setState("idle"), { once: true });
      await audio.play();
      if (asked.current === mine) setState("playing");
    } catch (error) {
      if (asked.current !== mine) return;
      setState("idle");
      showError(error, "Could not play the voice: ");
    }
  };
  return (
    <ToolButton
      variant="panel"
      className="size-7 shrink-0 justify-center border"
      label={state === "idle" ? "Hear this voice" : "Stop the sample"}
      disabled={provider.key === null}
      disabledReason={`Add your ${provider.name} API key first: the sample is said with it, once`}
      onClick={() => void play()}
    >
      {state === "loading" ? <Loader2 className="animate-spin" /> : state === "playing" ? <Square /> : <Volume2 />}
    </ToolButton>
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
