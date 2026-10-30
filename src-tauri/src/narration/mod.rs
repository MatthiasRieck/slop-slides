//! Spoken narration: each slide's `<aside class="narration">` read out by a local
//! text-to-speech model, Qwen3-TTS 0.6B CustomVoice, in one of its built-in voices.
//!
//! The model (about 2.5 GB) is downloaded once, on request, to
//! `~/.slopslides/models/qwen3-tts-0.6b-customvoice/` and shared by every workspace; all its
//! voices come with it. The deck names its voice and language in `<meta>` tags (see
//! [`crate::html::narration_voice`]). Each slide's audio is a WAV file next to the deck,
//! `narration/<slide id>.wav`, and `narration/manifest.json` keeps the fingerprint of the
//! script, voice and language it was made from, so a changed slide is said again and an
//! unchanged one never is.

pub mod audio;
pub mod engine;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

use crate::deck::{self, Deck};
use crate::error::{Error, Result};
use crate::voice;

/// A built-in voice of the model.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Voice {
    /// The id the deck names it by, and the engine's speaker name.
    pub id: &'static str,
    pub name: &'static str,
    /// What it sounds like.
    pub description: &'static str,
    /// The language it speaks natively (see [`LANGUAGES`]); others it speaks with an accent.
    pub native: &'static str,
}

/// The model's voices, the default first.
pub const VOICES: &[Voice] = &[
    Voice {
        id: "ryan",
        name: "Ryan",
        description: "Dynamic male voice",
        native: "en",
    },
    Voice {
        id: "aiden",
        name: "Aiden",
        description: "Sunny American male voice",
        native: "en",
    },
    Voice {
        id: "vivian",
        name: "Vivian",
        description: "Bright young female voice",
        native: "zh",
    },
    Voice {
        id: "serena",
        name: "Serena",
        description: "Warm, gentle female voice",
        native: "zh",
    },
    Voice {
        id: "uncle_fu",
        name: "Uncle Fu",
        description: "Low, mellow male voice",
        native: "zh",
    },
    Voice {
        id: "dylan",
        name: "Dylan",
        description: "Youthful Beijing male voice",
        native: "zh",
    },
    Voice {
        id: "eric",
        name: "Eric",
        description: "Lively Chengdu male voice",
        native: "zh",
    },
    Voice {
        id: "ono_anna",
        name: "Ono Anna",
        description: "Playful female voice",
        native: "ja",
    },
    Voice {
        id: "sohee",
        name: "Sohee",
        description: "Warm female voice",
        native: "ko",
    },
];

/// A language the model speaks.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Language {
    /// The ISO 639-1 code the deck names it by.
    pub id: &'static str,
    pub name: &'static str,
    /// The engine's name for it.
    #[serde(skip)]
    pub engine: &'static str,
}

/// The model's languages, the default first.
pub const LANGUAGES: &[Language] = &[
    Language {
        id: "en",
        name: "English",
        engine: "English",
    },
    Language {
        id: "de",
        name: "German",
        engine: "German",
    },
    Language {
        id: "fr",
        name: "French",
        engine: "French",
    },
    Language {
        id: "es",
        name: "Spanish",
        engine: "Spanish",
    },
    Language {
        id: "it",
        name: "Italian",
        engine: "Italian",
    },
    Language {
        id: "pt",
        name: "Portuguese",
        engine: "Portuguese",
    },
    Language {
        id: "ru",
        name: "Russian",
        engine: "Russian",
    },
    Language {
        id: "zh",
        name: "Chinese",
        engine: "Chinese",
    },
    Language {
        id: "ja",
        name: "Japanese",
        engine: "Japanese",
    },
    Language {
        id: "ko",
        name: "Korean",
        engine: "Korean",
    },
];

pub const DEFAULT_VOICE: &str = "ryan";
pub const DEFAULT_LANGUAGE: &str = "en";

pub fn voice(id: &str) -> Option<&'static Voice> {
    VOICES.iter().find(|v| v.id == id)
}

pub fn language(id: &str) -> Option<&'static Language> {
    LANGUAGES.iter().find(|l| l.id == id)
}

/// A file of the model, as the Hugging Face repository has it at [`MODEL_REVISION`].
pub struct ModelFile {
    pub path: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

const MODEL_REPO: &str = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice";
/// Pinned, so the checksums stay valid; part of every audio fingerprint.
const MODEL_REVISION: &str = "85e237c12c027371202489a0ec509ded67b5e4b5";
/// The folder under `~/.slopslides/models` the model downloads to.
const MODEL_DIR: &str = "qwen3-tts-0.6b-customvoice";
/// The engine's version (vendor/qwen3-tts/UPSTREAM.md); part of every audio fingerprint.
const ENGINE_REVISION: &str = "ef339be58a778b062e1c14382347964552eae007";

#[rustfmt::skip]
pub const MODEL_FILES: &[ModelFile] = &[
    ModelFile { path: "config.json", bytes: 4_908, sha256: "81aca2b6fac304944d8acf345272d8a9a727d5fc2e2e66b222ab4729340c7455" },
    ModelFile { path: "generation_config.json", bytes: 245, sha256: "f1b90b4513f3b34c62851049e2492d7b4c5940daf1276f89c82b8ef04127f3aa" },
    ModelFile { path: "merges.txt", bytes: 1_671_839, sha256: "599bab54075088774b1733fde865d5bd747cbcc7a547c5bc12610e874e26f5e3" },
    ModelFile { path: "preprocessor_config.json", bytes: 127, sha256: "efdde1022ea9d76928bf7a9cd53139138f5ba2e466e837f08f6105ab1af1c119" },
    ModelFile { path: "tokenizer_config.json", bytes: 7_344, sha256: "dc3c31c3bdaedd5016382bb3cbe07323026775ad51f5a4fb564505992ae4a670" },
    ModelFile { path: "vocab.json", bytes: 2_776_833, sha256: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910" },
    ModelFile { path: "speech_tokenizer/config.json", bytes: 2_336, sha256: "ee65bb901c876664ab8707c487157aa1a6ee57c65969b28fb5ec9dc211e68167" },
    ModelFile { path: "speech_tokenizer/configuration.json", bytes: 76, sha256: "6bc26d64eb5024b4d1dab5a52371958b429256d6c9d59787f1f5294a54e0cebd" },
    ModelFile { path: "speech_tokenizer/preprocessor_config.json", bytes: 234, sha256: "fcb3805e597e786d4067706e602f6688524640f8d3396790e2e09b5942fcbdfb" },
    ModelFile { path: "speech_tokenizer/model.safetensors", bytes: 682_293_092, sha256: "836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258" },
    ModelFile { path: "model.safetensors", bytes: 1_811_626_576, sha256: "bc3c7e785eb961179c25450d1acff03f839e0002f2f3a5aeb67b5735c0fa2adb" },
];

/// Emitted while the model downloads: `{ received, total }` bytes.
pub const DOWNLOAD_EVENT: &str = "speech-download";
/// Emitted as a deck's narration is said: `{ deck, slide, done, total }`.
pub const RENDER_EVENT: &str = "narration-render";
/// The error a render the user cancelled ends with.
pub const CANCELLED: &str = "the narration was cancelled";

/// `~/.slopslides/models/<MODEL_DIR>`.
pub fn model_dir(home: &Path) -> PathBuf {
    voice::models_dir(home).join(MODEL_DIR)
}

/// The model's download size.
pub fn model_bytes() -> u64 {
    MODEL_FILES.iter().map(|f| f.bytes).sum()
}

/// Whether every model file is there (each was checked against its checksum as it came in).
pub fn model_ready(home: &Path) -> bool {
    let dir = model_dir(home);
    MODEL_FILES
        .iter()
        .all(|f| fs::metadata(dir.join(f.path)).is_ok_and(|m| m.is_file() && m.len() == f.bytes))
}

fn model_url(file: &ModelFile) -> String {
    format!(
        "https://huggingface.co/{MODEL_REPO}/resolve/{MODEL_REVISION}/{}",
        file.path
    )
}

/// What narration can do on this machine right now.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechStatus {
    /// This build has the speech engine (not every platform does).
    pub available: bool,
    pub model_ready: bool,
    /// The model's download size, to tell the user before downloading it.
    pub model_bytes: u64,
    pub downloading: bool,
    /// The deck whose narration is being said, if any.
    pub rendering: Option<String>,
    pub voices: &'static [Voice],
    pub languages: &'static [Language],
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    received: u64,
    total: u64,
}

/// How far saying a deck's narration has got.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderProgress {
    pub deck: String,
    /// The slide being said now; None once all are done.
    pub slide: Option<String>,
    /// Slides said so far, and how many there are to say.
    pub done: usize,
    pub total: usize,
}

/// Narration state, managed by Tauri: whether the model downloads, and the render running.
#[derive(Default)]
pub struct Narration {
    downloading: AtomicBool,
    /// Held while a deck's narration is said: one at a time, the model is large.
    render: tokio::sync::Mutex<()>,
    /// The deck being said, and how to stop it.
    running: Mutex<Option<(String, Arc<Notify>)>>,
}

impl Narration {
    pub fn status(&self, home: &Path) -> SpeechStatus {
        SpeechStatus {
            available: engine::unavailable_reason().is_none(),
            model_ready: model_ready(home),
            model_bytes: model_bytes(),
            downloading: self.downloading.load(Ordering::SeqCst),
            rendering: self
                .running
                .lock()
                .unwrap()
                .as_ref()
                .map(|(d, _)| d.clone()),
            voices: VOICES,
            languages: LANGUAGES,
        }
    }

    /// Downloads the model unless it is there, reporting progress as [`DOWNLOAD_EVENT`].
    /// Files already downloaded are kept, so a failed download goes on where it stopped.
    pub async fn download(&self, app: &AppHandle, home: &Path) -> Result<()> {
        if model_ready(home) {
            return Ok(());
        }
        if self.downloading.swap(true, Ordering::SeqCst) {
            while self.downloading.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            return match model_ready(home) {
                true => Ok(()),
                false => Err(Error::msg("Downloading the narration voice model failed.")),
            };
        }
        let result = download_model(app, &model_dir(home)).await;
        self.downloading.store(false, Ordering::SeqCst);
        result
    }

    /// Stops saying narration, if it is; the render ends with [`CANCELLED`].
    pub fn cancel(&self) {
        if let Some((_, stop)) = self.running.lock().unwrap().as_ref() {
            stop.notify_one();
        }
    }

    /// Says the narration of the deck `file`'s `slides` (all of them for None) that has no
    /// up-to-date audio yet, calling `progress` as it goes. Returns every slide's audio.
    pub async fn render(
        &self,
        home: &Path,
        file: &Path,
        slides: Option<&[String]>,
        progress: impl Fn(RenderProgress),
    ) -> Result<Vec<SlideAudio>> {
        let _one_at_a_time = self.render.lock().await;
        let deck = deck::load(file)?;
        let todo: Vec<Job> = jobs(file, &deck)
            .into_iter()
            .filter(|j| slides.map_or(true, |s| s.contains(&j.slide)))
            .collect();
        if todo.is_empty() {
            return Ok(statuses(file, &deck));
        }
        if let Some(reason) = engine::unavailable_reason() {
            return Err(Error::msg(reason));
        }
        if !model_ready(home) {
            return Err(Error::msg(
                "Download the narration voice model first (Narration tab).",
            ));
        }
        let stop = Arc::new(Notify::new());
        *self.running.lock().unwrap() = Some((deck.id.clone(), stop.clone()));
        // Cleared however this ends, also when the caller drops it (a cancelled video export).
        let _clear = Clear(&self.running);
        tokio::select! {
            said = say_all(home, file, &deck.id, &todo, &progress) => said?,
            _ = stop.notified() => return Err(Error::msg(CANCELLED)),
        };
        progress(RenderProgress {
            deck: deck.id.clone(),
            slide: None,
            done: todo.len(),
            total: todo.len(),
        });
        Ok(statuses(file, &deck::load(file)?))
    }
}

/// Empties the running render's slot when dropped.
struct Clear<'a>(&'a Mutex<Option<(String, Arc<Notify>)>>);

impl Drop for Clear<'_> {
    fn drop(&mut self) {
        *self.0.lock().unwrap() = None;
    }
}

/// Says each job in one worker; dropping the future (on cancel) kills the worker.
async fn say_all(
    home: &Path,
    file: &Path,
    deck: &str,
    todo: &[Job],
    progress: &impl Fn(RenderProgress),
) -> Result<()> {
    let mut worker = engine::Worker::start(&model_dir(home)).await?;
    let dir = audio_dir(file);
    fs::create_dir_all(&dir)?;
    for (done, job) in todo.iter().enumerate() {
        progress(RenderProgress {
            deck: deck.to_string(),
            slide: Some(job.slide.clone()),
            done,
            total: todo.len(),
        });
        let dest = audio_file(file, &job.slide);
        let part = dest.with_extension("wav.part");
        let request = engine::Request {
            text: job.text.clone(),
            speaker: job.voice.to_string(),
            language: job.language.to_string(),
            output: part.clone(),
        };
        let samples = match worker.say(&request).await {
            Ok(samples) => samples,
            Err(e) => {
                let _ = fs::remove_file(&part);
                return Err(Error::msg(format!("Slide {}: {e}", job.slide)));
            }
        };
        fs::rename(&part, &dest)?;
        let mut manifest = Manifest::read(&dir);
        manifest.slides.insert(
            job.slide.clone(),
            Entry {
                fingerprint: job.fingerprint.clone(),
                seconds: samples as f64 / f64::from(audio::RATE),
            },
        );
        manifest.write(&dir)?;
    }
    worker.shutdown().await
}

async fn download_model(app: &AppHandle, dir: &Path) -> Result<()> {
    let total = model_bytes();
    let mut before = 0u64;
    let mut reported = 0u64;
    for file in MODEL_FILES {
        let dest = dir.join(file.path);
        if fs::metadata(&dest).is_ok_and(|m| m.len() == file.bytes) {
            before += file.bytes;
            continue;
        }
        fs::create_dir_all(dest.parent().expect("model files are in a folder"))?;
        let part = dest.with_extension("part");
        let fetched = voice::fetch_to(&model_url(file), &part, |received, _| {
            let received = before + received;
            // About every half percent, so the progress bar moves without flooding the frontend.
            if received - reported >= total / 200 || received == total {
                reported = received;
                let _ = app.emit(DOWNLOAD_EVENT, DownloadProgress { received, total });
            }
        })
        .await;
        let hash = match fetched {
            Ok(hash) => hash,
            Err(e) => {
                let _ = fs::remove_file(&part);
                return Err(e);
            }
        };
        voice::finish_download(&part, &dest, &hash, file.sha256)?;
        before += file.bytes;
    }
    Ok(())
}

/// The deck's voice and language, as its `<meta>` tags name them (defaults otherwise).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub voice: String,
    pub language: String,
}

impl Settings {
    pub fn of(html: &str) -> Self {
        let voice = crate::html::narration_voice(html)
            .filter(|v| voice(v).is_some())
            .unwrap_or_else(|| DEFAULT_VOICE.into());
        let language = crate::html::narration_language(html)
            .filter(|l| language(l).is_some())
            .unwrap_or_else(|| DEFAULT_LANGUAGE.into());
        Settings { voice, language }
    }
}

/// Where a deck's narration audio lives: `narration/` next to it, or `narration/<name>/`
/// for a deck file not named deck.html, so decks sharing a folder keep theirs apart.
pub fn audio_dir(deck_file: &Path) -> PathBuf {
    let dir = deck_file
        .parent()
        .unwrap_or(Path::new(""))
        .join("narration");
    let stem = deck_file.file_stem().unwrap_or_default().to_string_lossy();
    match deck_file.file_name().and_then(|n| n.to_str()) {
        Some(deck::DECK_FILE) => dir,
        _ => dir.join(stem.as_ref()),
    }
}

/// A slide's narration audio: `<slide id>.wav`, or a name made from the id when it is not
/// safe as a file name.
pub fn audio_file(deck_file: &Path, slide: &str) -> PathBuf {
    let safe = !slide.is_empty()
        && !slide.starts_with('.')
        && slide.len() <= 100
        && slide
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    let name = if safe {
        slide.to_string()
    } else {
        format!("slide-{}", &hex(&Sha256::digest(slide.as_bytes()))[..12])
    };
    audio_dir(deck_file).join(format!("{name}.wav"))
}

/// What a slide's audio is made from: its script, voice and language, and the model and
/// engine saying it. Audio with another fingerprint is out of date.
pub fn fingerprint(text: &str, voice: &str, language: &str) -> String {
    let mut hasher = Sha256::new();
    for part in [MODEL_REVISION, ENGINE_REVISION, voice, language, text] {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    hex(&hasher.finalize())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

const MANIFEST: &str = "manifest.json";

/// `narration/manifest.json`: what each slide's audio was made from, and how long it is.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Manifest {
    #[serde(default)]
    slides: BTreeMap<String, Entry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Entry {
    fingerprint: String,
    seconds: f64,
}

impl Manifest {
    /// The manifest in `dir`; an empty one when it is missing or unreadable.
    fn read(dir: &Path) -> Self {
        fs::read_to_string(dir.join(MANIFEST))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn write(&self, dir: &Path) -> Result<()> {
        let json = serde_json::to_string_pretty(self).map_err(|e| Error::msg(e.to_string()))?;
        let part = dir.join(format!("{MANIFEST}.part"));
        fs::write(&part, json + "\n")?;
        fs::rename(part, dir.join(MANIFEST))?;
        Ok(())
    }
}

/// Whether a slide's audio matches its narration.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioState {
    /// The slide has no narration.
    None,
    /// It has narration, but no audio yet.
    Missing,
    /// Its audio was made from another script, voice or language.
    Stale,
    Ready,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideAudio {
    pub slide: String,
    pub state: AudioState,
    /// How long the audio there is plays, in seconds (out of date audio too).
    pub seconds: Option<f64>,
}

/// A slide's narration to say.
#[derive(Debug, Clone)]
struct Job {
    slide: String,
    text: String,
    voice: &'static str,
    language: &'static str,
    fingerprint: String,
}

fn settings(file: &Path) -> (&'static Voice, &'static Language) {
    let html = deck::read_html(file).unwrap_or_default();
    let settings = Settings::of(&html);
    (
        voice(&settings.voice).expect("a known voice"),
        language(&settings.language).expect("a known language"),
    )
}

/// The slides whose narration has no up-to-date audio.
fn jobs(file: &Path, deck: &Deck) -> Vec<Job> {
    let (voice, language) = settings(file);
    let audio = statuses(file, deck);
    deck.slides
        .iter()
        .zip(audio)
        .filter(|(_, a)| matches!(a.state, AudioState::Missing | AudioState::Stale))
        .map(|(slide, _)| Job {
            slide: slide.id.clone(),
            text: slide.narration.clone(),
            voice: voice.id,
            language: language.engine,
            fingerprint: fingerprint(&slide.narration, voice.id, language.id),
        })
        .collect()
}

/// Every slide's audio, in slide order.
pub fn statuses(file: &Path, deck: &Deck) -> Vec<SlideAudio> {
    let (voice, language) = settings(file);
    let manifest = Manifest::read(&audio_dir(file));
    deck.slides
        .iter()
        .map(|slide| {
            let path = audio_file(file, &slide.id);
            let entry = manifest.slides.get(&slide.id).filter(|_| path.is_file());
            let seconds = entry.map(|e| e.seconds);
            let state = if slide.narration.trim().is_empty() {
                AudioState::None
            } else {
                match entry {
                    None => AudioState::Missing,
                    Some(e)
                        if e.fingerprint
                            == fingerprint(&slide.narration, voice.id, language.id) =>
                    {
                        AudioState::Ready
                    }
                    Some(_) => AudioState::Stale,
                }
            };
            SlideAudio {
                slide: slide.id.clone(),
                state,
                seconds,
            }
        })
        .collect()
}

/// The up-to-date audio of each slide that has it, by slide id: its samples at `rate`.
pub fn ready_audio(file: &Path, deck: &Deck) -> BTreeMap<String, (Vec<f32>, u32)> {
    statuses(file, deck)
        .into_iter()
        .filter(|a| a.state == AudioState::Ready)
        .filter_map(|a| {
            let read = audio::read_wav(&audio_file(file, &a.slide)).ok()?;
            Some((a.slide, read))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("slopslide-narration-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn deck_with(dir: &Path, name: &str, head: &str, slides: &str) -> PathBuf {
        let file = dir.join(name);
        fs::write(
            &file,
            format!("<!DOCTYPE html><html><head><title>T</title>{head}</head><body><main class=\"deck\">{slides}</main></body></html>"),
        )
        .unwrap();
        file
    }

    #[test]
    fn the_model_lives_in_the_app_home_models_folder() {
        assert_eq!(
            model_dir(Path::new("/home/me/.slopslides")),
            Path::new("/home/me/.slopslides/models/qwen3-tts-0.6b-customvoice")
        );
        assert!(model_bytes() > 2_400_000_000 && model_bytes() < 2_600_000_000);
        let url = model_url(&MODEL_FILES[0]);
        assert!(url.contains(MODEL_REVISION), "{url}");
        assert!(url.ends_with("/config.json"), "{url}");
    }

    #[test]
    fn the_model_is_ready_once_every_file_has_its_size() {
        let home = temp_dir();
        assert!(!model_ready(&home));
        let dir = model_dir(&home);
        for f in MODEL_FILES {
            let path = dir.join(f.path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::File::create(&path).unwrap().set_len(f.bytes).unwrap();
        }
        assert!(model_ready(&home));
        fs::File::create(dir.join("vocab.json"))
            .unwrap()
            .set_len(1)
            .unwrap();
        assert!(!model_ready(&home));
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn voices_and_languages_have_known_defaults() {
        assert_eq!(VOICES[0].id, DEFAULT_VOICE);
        assert_eq!(LANGUAGES[0].id, DEFAULT_LANGUAGE);
        assert!(VOICES.iter().all(|v| language(v.native).is_some()));
        assert_eq!(voice("aiden").unwrap().name, "Aiden");
        assert!(voice("Aiden").is_none());
        assert_eq!(language("de").unwrap().engine, "German");
    }

    #[test]
    fn the_agent_is_told_every_voice_and_language() {
        let prompt = include_str!("../../prompts/system.md");
        let at = prompt
            .find("slopslide-narration-voice` meta")
            .expect("the narration rules");
        let words: Vec<&str> = prompt[at..at + 600]
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .collect();
        let ids = VOICES
            .iter()
            .map(|v| v.id)
            .chain(LANGUAGES.iter().map(|l| l.id));
        for id in ids {
            assert!(words.contains(&id), "{id}");
        }
    }

    #[test]
    fn settings_come_from_the_deck_with_defaults_for_missing_or_unknown_ones() {
        let html =
            |head: &str| format!("<html><head><title>T</title>{head}</head><body></body></html>");
        assert_eq!(
            Settings::of(&html("")),
            Settings {
                voice: "ryan".into(),
                language: "en".into()
            }
        );
        let set = html(
            "<meta name=\"slopslide-narration-voice\" content=\"sohee\"><meta name=\"slopslide-narration-language\" content=\"ko\">",
        );
        assert_eq!(
            Settings::of(&set),
            Settings {
                voice: "sohee".into(),
                language: "ko".into()
            }
        );
        let unknown = html("<meta name=\"slopslide-narration-voice\" content=\"bob\">");
        assert_eq!(Settings::of(&unknown).voice, "ryan");
    }

    #[test]
    fn audio_sits_next_to_the_deck_named_by_slide() {
        let deck = Path::new("/ws/talk/deck.html");
        assert_eq!(audio_dir(deck), Path::new("/ws/talk/narration"));
        assert_eq!(
            audio_file(deck, "intro"),
            Path::new("/ws/talk/narration/intro.wav")
        );
        // Decks sharing a folder keep their audio apart.
        assert_eq!(
            audio_dir(Path::new("/ws/pitch.html")),
            Path::new("/ws/narration/pitch")
        );
        // Ids that are not safe file names get a name made from them.
        for unsafe_id in ["#3", "../x", ".hidden", "a/b", ""] {
            let name = audio_file(deck, unsafe_id);
            let name = name.file_name().unwrap().to_str().unwrap();
            assert!(
                name.starts_with("slide-") && name.ends_with(".wav"),
                "{name}"
            );
        }
        assert_ne!(audio_file(deck, "#3"), audio_file(deck, "#4"));
    }

    #[test]
    fn fingerprints_change_with_script_voice_and_language() {
        let base = fingerprint("Hello.", "ryan", "en");
        assert_eq!(base, fingerprint("Hello.", "ryan", "en"));
        assert_ne!(base, fingerprint("Hello!", "ryan", "en"));
        assert_ne!(base, fingerprint("Hello.", "aiden", "en"));
        assert_ne!(base, fingerprint("Hello.", "ryan", "de"));
        // Parts cannot run into each other.
        assert_ne!(fingerprint("b", "a", "en"), fingerprint("", "ab", "en"));
    }

    #[test]
    fn statuses_tell_missing_stale_and_ready_audio_apart() {
        let dir = temp_dir();
        let slides = r#"<section class="slide" id="a"><aside class="narration">Say A.</aside></section><section class="slide" id="b"><aside class="narration">Say B.</aside></section><section class="slide" id="c"></section>"#;
        let file = deck_with(&dir, "deck.html", "", slides);
        let deck = deck::load(&file).unwrap();
        let states = |deck: &Deck| {
            statuses(&file, deck)
                .iter()
                .map(|a| a.state)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            states(&deck),
            [AudioState::Missing, AudioState::Missing, AudioState::None]
        );
        assert_eq!(jobs(&file, &deck).len(), 2);

        // Audio for a, made from its script; audio for b, made from an older one.
        let audio = audio_dir(&file);
        fs::create_dir_all(&audio).unwrap();
        audio::write_wav(&audio.join("a.wav"), &[0.0; 12_000], audio::RATE).unwrap();
        audio::write_wav(&audio.join("b.wav"), &[0.0; 24_000], audio::RATE).unwrap();
        let mut manifest = Manifest::default();
        manifest.slides.insert(
            "a".into(),
            Entry {
                fingerprint: fingerprint("Say A.", "ryan", "en"),
                seconds: 0.5,
            },
        );
        manifest.slides.insert(
            "b".into(),
            Entry {
                fingerprint: fingerprint("Old B.", "ryan", "en"),
                seconds: 1.0,
            },
        );
        manifest.write(&audio).unwrap();
        let found = statuses(&file, &deck);
        assert_eq!(
            found.iter().map(|a| a.state).collect::<Vec<_>>(),
            [AudioState::Ready, AudioState::Stale, AudioState::None]
        );
        assert_eq!(found[0].seconds, Some(0.5));
        assert_eq!(found[1].seconds, Some(1.0));
        let todo = jobs(&file, &deck);
        assert_eq!(todo.len(), 1);
        assert_eq!(
            (
                todo[0].slide.as_str(),
                todo[0].text.as_str(),
                todo[0].voice,
                todo[0].language
            ),
            ("b", "Say B.", "ryan", "English")
        );
        assert_eq!(ready_audio(&file, &deck).keys().collect::<Vec<_>>(), ["a"]);

        // Another voice makes all of it out of date.
        let file = deck_with(
            &dir,
            "deck.html",
            "<meta name=\"slopslide-narration-voice\" content=\"aiden\">",
            slides,
        );
        let deck = deck::load(&file).unwrap();
        assert_eq!(
            states(&deck),
            [AudioState::Stale, AudioState::Stale, AudioState::None]
        );
        assert_eq!(jobs(&file, &deck)[0].voice, "aiden");

        // A missing audio file is missing, whatever the manifest says.
        fs::remove_file(audio.join("a.wav")).unwrap();
        assert_eq!(states(&deck)[0], AudioState::Missing);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_unreadable_manifest_counts_as_empty() {
        let dir = temp_dir();
        fs::write(dir.join(MANIFEST), "{ nope").unwrap();
        assert!(Manifest::read(&dir).slides.is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rendering_nothing_needs_no_model() {
        let dir = temp_dir();
        let file = deck_with(
            &dir,
            "deck.html",
            "",
            r#"<section class="slide" id="a"></section>"#,
        );
        let narration = Narration::default();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let audio = rt
            .block_on(narration.render(&dir, &file, None, |_| {}))
            .unwrap();
        assert_eq!(audio[0].state, AudioState::None);
        // With narration but no model, it says what to do.
        let file = deck_with(
            &dir,
            "deck.html",
            "",
            r#"<section class="slide" id="a"><aside class="narration">Hi.</aside></section>"#,
        );
        let err = rt
            .block_on(narration.render(&dir, &file, None, |_| {}))
            .unwrap_err();
        assert!(err.to_string().contains("narration"), "{err}");
        fs::remove_dir_all(dir).unwrap();
    }
}
