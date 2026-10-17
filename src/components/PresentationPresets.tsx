import { useApp } from "../store";
import { useNarration } from "../narrationStore";
import { useSpeech } from "../speechStore";
import { editedManifest, type NarrationLanguage } from "../lib/narration";

const field = "mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground disabled:opacity-40";

/** Defaults inherited by slides without an explicit override. */
export function PresentationPresets() {
  const deck = useApp((s) => s.deck);
  const narration = useNarration();
  const speech = useSpeech();
  if (!deck) return null;
  const manifest = narration.deckId === deck.id && narration.document
    ? editedManifest(narration.document.manifest, narration.edits, narration.languageEdit, narration.settingsEdits)
    : null;
  const providers = speech.status?.providers ?? [];
  const providerId = manifest?.speechProviderId ?? "qwen-local";
  const provider = providers.find((p) => p.id === providerId);
  const presenter = provider?.voices.find((voice) => voice.id === manifest?.presenterId);
  const locked = !manifest || !!narration.error || !!narration.conflict || !!speech.job;
  return <div className="h-full overflow-y-auto p-3 text-xs">
    <h2 className="text-sm font-medium">Presentation presets</h2>
    <p className="mt-1 text-muted-foreground">Slides use these settings unless you choose different ones for a slide.</p>
    {narration.error && <p role="alert" className="mt-3 text-amber-600">{narration.error} Resolve this in Narration before changing presets.</p>}
    <div className="mt-4 space-y-4">
      <label className="block text-muted-foreground">Speech provider
        <select aria-label="Presentation speech provider" className={field} value={providerId} disabled={locked || providers.length < 2} onChange={(e) => narration.setProvider(e.target.value)}>
          {!provider && <option value={providerId}>{providerId} · unavailable</option>}
          {providers.map((p) => <option key={p.id} value={p.id}>{p.label} · {p.processing === "local" ? "On device" : p.processing === "cloud" ? "Cloud" : "Test"}</option>)}
        </select>
      </label>
      {providers.length === 1 && <p className="text-muted-foreground">Only {providers[0]!.label} is connected. Other providers will appear here when available.</p>}
      {provider && !provider.available && <p role="alert" className="text-amber-600">{provider.unavailableReason ?? "This provider is unavailable."} Saved recordings remain available.</p>}
      <label className="block text-muted-foreground">Default presenter
        <select aria-label="Default narration presenter" className={field} value={manifest?.presenterId ?? ""} disabled={locked || !provider?.available} onChange={(e) => { const voice = provider?.voices.find((v) => v.id === e.target.value); if (voice) narration.setPresenter(voice.id, voice.name); }}>
          {!presenter && manifest && <option value={manifest.presenterId}>{manifest.presenterNameSnapshot} · unavailable</option>}
          {provider?.voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
        </select>
      </label>
      {provider && !presenter && <p className="text-amber-600">Choose a presenter supported by this provider before generating audio.</p>}
      <label className="block text-muted-foreground">Default language
        <select aria-label="Deck narration language" className={field} value={manifest?.defaultLanguage ?? "en"} disabled={locked} onChange={(e) => narration.setLanguage(e.target.value as NarrationLanguage)}>
          <option value="en">English</option><option value="de">German</option>
        </select>
      </label>
      {provider && manifest && !provider.languages.includes(manifest.defaultLanguage) && <p className="text-amber-600">This provider does not support the selected language.</p>}
      <label className="block text-muted-foreground">Default pace
        <select aria-label="Default narration pace" className={field} value={manifest?.pace ?? 1.1} disabled={locked || !provider} onChange={(e) => narration.setPace(Number(e.target.value))}>
          {provider && !provider.pace.choices.includes(manifest?.pace ?? 1.1) && <option value={manifest?.pace ?? 1.1}>{manifest?.pace ?? 1.1}× · unsupported</option>}
          {provider?.pace.choices.map((pace) => <option key={pace} value={pace}>{pace.toFixed(1)}×</option>)}
        </select>
      </label>
      <p className="border-t border-border pt-3 text-muted-foreground">Changing a preset may require new audio for slides that use it. Slides with their own settings and earlier recordings stay intact.</p>
    </div>
  </div>;
}
