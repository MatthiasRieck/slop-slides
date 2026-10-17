import { useEffect, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useNarration } from "../narrationStore";
import { runProfileJob, useSpeech } from "../speechStore";
import { emptyScript, slideSpeechSettings, type SlideNarration, type NarrationManifest } from "../lib/narration";
import { narrationMarkers } from "../lib/narrationMarkers";
import { currentTake, matchesTake } from "../lib/speech";
import { VoiceSetup } from "./VoiceSetup";
import { PresenterLibrary } from "./PresenterLibrary";
import type { SavedPresenter } from "../lib/speech";
import { RecordingHistory } from "./RecordingHistory";
import { api, type Deck } from "../lib/api";
const field = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs disabled:opacity-40";
export function SpeechControls({ deck, selected, manifest, editable, scriptEditor, children }: { deck: Deck; selected: string | null; manifest: NarrationManifest | null; editable: boolean; scriptEditor?: ReactNode; children?: ReactNode }) {
  const speech = useSpeech(); const narration = useNarration();
  const [voiceSetup, setVoiceSetup] = useState<{ replace?: SavedPresenter; slide: string | null } | null>(null);
  useEffect(() => { setVoiceSetup(null); }, [deck.id]);
  useEffect(() => { void useSpeech.getState().initialize(); }, []);
  useEffect(() => { void useSpeech.getState().loadTakes(deck.id); }, [deck.id, narration.document?.version]);
  const providers = speech.status?.providers ?? [];
  const take = selected && speech.deckId === deck.id ? speech.takes[selected] : undefined;
  const script = selected && manifest ? manifest.slides[selected] ?? emptyScript() : emptyScript();
  const resolved = manifest ? slideSpeechSettings(manifest, script) : { speechProviderId: "qwen-local", presenterId: "preset:ryan", presenterNameSnapshot: "Ryan", pace: 1.1 };
  const slideProvider = providers.find((p) => p.id === resolved.speechProviderId);
  const slideVoice = slideProvider?.voices.find((v) => v.id === resolved.presenterId);
  const voiceReady = !!slideVoice && (slideVoice.ready ?? slideProvider?.ready);
  const personalVoice = resolved.presenterId.startsWith("profile:");
  const setup = personalVoice ? !slideProvider?.cloneReady ? slideProvider?.cloneSetup : undefined : slideProvider?.setup;
  const install = async (source?: string) => {
    if (!slideProvider) return;
    if (!personalVoice) return speech.install(slideProvider.id, source);
    try { await runProfileJob("setup", (job) => api.installCloningPack(job, source ?? null, slideProvider.id)); }
    catch (e) { useSpeech.setState({ error: String(e) }); }
  };
  const editSpeech = (patch: Partial<SlideNarration>) => {
    if (!selected || !editable) return;
    narration.edit(selected, { speechProviderIdOverride: resolved.speechProviderId, presenterIdOverride: resolved.presenterId, presenterNameSnapshotOverride: resolved.presenterNameSnapshot, paceOverride: resolved.pace, ...patch });
  };
  const overridden = script.speechProviderIdOverride != null || script.presenterIdOverride != null || script.paceOverride != null;
  const current = take && manifest && currentTake(take, script, manifest, providers);
  const busy = !!speech.job;
  const canGenerate = !narrationMarkers(script.text, slideProvider?.narrationControls).error && !!manifest && !narration.error && slideProvider?.available && (slideProvider.voices.find((v) => v.id === resolved.presenterId)?.ready ?? slideProvider.ready) && slideProvider.voices.some((v) => v.id === resolved.presenterId) && slideProvider.languages.includes(script.languageOverride ?? manifest.defaultLanguage) && resolved.pace >= slideProvider.pace.min && resolved.pace <= slideProvider.pace.max;
  const presenter = () => {
    return <label className="block text-muted-foreground">Presenter
      <select aria-label="Narration presenter" className={`${field} mt-1 text-foreground`} value={resolved.presenterId} disabled={!manifest || busy || !slideProvider?.available || !editable} onChange={(e) => { const voice = slideProvider?.voices.find((v) => v.id === e.target.value); if (voice) editSpeech({ presenterIdOverride: voice.id, presenterNameSnapshotOverride: voice.name }); }}>
        {!slideProvider?.voices.some((v) => v.id === resolved.presenterId) && <option value={resolved.presenterId}>{resolved.presenterNameSnapshot} · unavailable</option>}
        {slideProvider?.voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
      </select>
    </label>;
  };
  return <div>
    {scriptEditor}
    <div className="sticky top-0 z-10 mt-3 border-b border-border bg-background pb-3">
    {presenter()}
    {slideProvider?.available && slideProvider.supportsCloning && <div className="mt-2"><button className="w-full rounded-md border border-primary/40 bg-primary/10 px-3 py-2 font-medium text-primary disabled:opacity-40" disabled={busy} onClick={() => setVoiceSetup({ slide: selected })}>Create voice from recording…</button></div>}


    <p className="mt-1 text-[11px] text-muted-foreground">{script.languageOverride === "de" || (!script.languageOverride && manifest?.defaultLanguage === "de") ? "German" : "English"} · {resolved.pace}× · {slideProvider?.label ?? resolved.speechProviderId}</p>
    {slideProvider?.supportsCloning && <PresenterLibrary providerId={slideProvider.id} onReplace={(replace) => setVoiceSetup({ replace, slide: selected })} />}
    </div>
    {voiceSetup && slideProvider && <VoiceSetup provider={slideProvider} initialLanguage={script.languageOverride ?? manifest?.defaultLanguage ?? "en"} replace={voiceSetup.replace} onClose={() => setVoiceSetup(null)} onSaved={(profile) => { if (selected === voiceSetup.slide) editSpeech({ presenterIdOverride: profile.id, presenterNameSnapshotOverride: profile.name }); setVoiceSetup(null); }} />}
    {script.text.trim() && <button className="mt-3 w-full rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground disabled:opacity-40" title={take ? "Creates a fresh recording. With unchanged text, the local engine may sound identical." : undefined} disabled={busy || !canGenerate || !editable} onClick={() => void speech.generate(deck.id, selected, !!take)}>{take ? "Generate another take" : "Generate audio"}</button>}
    {take && <p className="mt-2 text-muted-foreground">{current ? "Recording ready" : "Script or voice changed · generate or choose a recording"} · {(take.samples / take.sampleRate).toFixed(1)}s. Play below the slide.</p>}
    {take && manifest && !matchesTake(take, script, manifest) && take.source.text === script.text.trim().replace(/\r\n/g, "\n") && <button disabled={!editable || busy} className="mt-2 underline disabled:opacity-40" onClick={() => {
      const voice = providers.find((p) => p.id === (take.source.providerId ?? "qwen-local"))?.voices.find((v) => v.id === take.source.presenterId);
      editSpeech({ speechProviderIdOverride: take.source.providerId ?? "qwen-local", presenterIdOverride: take.source.presenterId, presenterNameSnapshotOverride: voice?.name ?? take.source.presenterId, paceOverride: take.source.pace, languageOverride: take.source.language });
    }}>Restore recording settings</button>}
    {selected && manifest && editable && <RecordingHistory key={`${deck.id}:${selected}`} deckId={deck.id} slide={selected} script={script} manifest={manifest} accepted={take} editable={editable && !narration.error} version={narration.document?.version} />}
    {!speech.status ? <p className="mt-3 text-muted-foreground">Checking speech providers…</p> : !slideProvider?.available ? <p className="mt-3 text-muted-foreground">{slideProvider?.unavailableReason ?? "Speech provider unavailable. Choose a provider in Presentation presets. Saved recordings remain playable."}</p> : !voiceReady && setup ? <div className="mt-3 rounded-md border border-border p-3">
      <p className="font-medium">Set up {slideProvider.label}</p>
      <p className="mt-1 text-muted-foreground">Voice pack: {(setup.totalBytes / 1e9).toFixed(2)} GB. {setup.detail}</p>
      <button className={`${field} mt-3`} disabled={busy} onClick={() => void install()}>Download voice pack</button>
      {setup.importTitle && <button className="mt-2 underline disabled:opacity-40" disabled={busy} onClick={() => void open({ directory: true, multiple: false, title: setup.importTitle! }).then((path) => { if (typeof path === "string") void install(path); }).catch((e: unknown) => useSpeech.setState({ error: String(e) }))}>Import existing voice pack…</button>}
    </div> : null}
    {slideProvider?.available && !narrationMarkers(script.text, slideProvider.narrationControls).error && !canGenerate && manifest && script.text.trim() && !setup && <p className="mt-2 text-amber-600">{personalVoice && !voiceReady ? "This saved presenter is unavailable. Choose another presenter or replace its recording in Manage presenters." : "Choose a supported presenter, language and pace in Voice & timing."}</p>}
    <details className="mt-3 text-muted-foreground">
      <summary className="cursor-pointer">Voice & timing</summary>
      <div className="mt-3 space-y-3">
        <p className="text-[11px]">Changes here apply only to this slide.</p>
        {overridden && <button disabled={!editable || busy} className="underline disabled:opacity-40" onClick={() => narration.edit(selected!, { speechProviderIdOverride: null, presenterIdOverride: null, presenterNameSnapshotOverride: null, paceOverride: null })}>Use presentation presets</button>}
        {providers.length > 1 ? <label className="block">Speech provider<select aria-label="Speech provider" className={`${field} mt-1 text-foreground`} value={resolved.speechProviderId} disabled={!manifest || busy || !editable} onChange={(e) => editSpeech({ speechProviderIdOverride: e.target.value })}>
          {!slideProvider && <option value={resolved.speechProviderId}>{resolved.speechProviderId} · unavailable</option>}
          {providers.map((p) => <option key={p.id} value={p.id}>{p.label} · {p.processing === "local" ? "On device" : p.processing === "cloud" ? "Cloud" : "Test"}</option>)}
        </select></label> : <p>Speech provider: {slideProvider?.label ?? resolved.speechProviderId} · presentation preset</p>}
        {slideProvider && <label className="block">Speaking pace<select aria-label="Narration pace" className={`${field} mt-1 text-foreground`} value={resolved.pace} disabled={!manifest || busy || !editable} onChange={(e) => editSpeech({ paceOverride: Number(e.target.value) })}>
          {!slideProvider.pace.choices.includes(resolved.pace) && <option value={resolved.pace}>{resolved.pace}×</option>}
          {slideProvider.pace.choices.map((pace) => <option key={pace} value={pace}>{pace.toFixed(1)}×</option>)}
        </select></label>}
        {slideProvider?.voiceHint && <p className="text-[11px]">{slideProvider.voiceHint}</p>}
        {children}
        {slideProvider?.setup && slideProvider.ready && <details><summary className="cursor-pointer">Manage voice pack</summary><p className="mt-2">Removing the pack frees {(slideProvider.setup.totalBytes / 1e9).toFixed(2)} GB. Saved recordings remain playable.</p><button className="mt-2 underline disabled:opacity-40" disabled={busy} onClick={() => void speech.remove(slideProvider.id)}>Remove voice pack</button></details>}
      </div>
    </details>
    {speech.job && <div className="mt-3 rounded-md bg-accent p-2" role="status"><p>{speech.job.detail}</p>{speech.job.deckId && speech.job.deckId !== deck.id && <p className="mt-1">Generating for another open deck.</p>}{speech.job.total > 0 && <progress aria-label="Speech progress" className="mt-2 w-full" max={speech.job.total} value={speech.job.completed} />}{speech.job.kind !== "selection" && <button className="mt-2 underline disabled:opacity-40" disabled={speech.cancelling} onClick={() => void speech.cancel()}>{speech.cancelling ? "Cancelling…" : "Cancel"}</button>}</div>}
    {speech.error && <div role="alert" className="mt-3 rounded-md bg-amber-500/10 p-2 leading-relaxed">{speech.error}</div>}
    {speech.message && !speech.job && <p role="status" className="mt-2 text-muted-foreground">{speech.message}</p>}
  </div>;
}
