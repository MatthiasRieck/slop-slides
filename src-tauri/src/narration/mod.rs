//! Spoken narration: each slide's `<aside class="narration">` read out by a hosted
//! text-to-speech service, OpenAI or ElevenLabs (see [`cloud`]), with the user's API key.
//!
//! The deck names its provider, voice and language in `<meta>` tags (see
//! [`crate::html::narration_provider`]). Each slide's audio is a WAV file next to the deck,
//! `narration/<slide id>.wav`, and `narration/manifest.json` keeps the fingerprint of the
//! script, provider, voice and language it was made from, so a changed slide is said again and
//! an unchanged one never is.
//!
//! A slide's audio can also be the presenter's own voice, recorded in the presenter view (see
//! [`crate::voice::Voice::record_narration`]) and marked so in the manifest. It is the slide's
//! audio whatever its script says, and is never said again; deleting it brings the service's
//! audio back. Audio made elsewhere (see [`import_audio`]) is kept the same way.

pub mod audio;
pub mod beats;
pub mod cloud;
pub mod timeline;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Notify;

use crate::deck::{self, Deck};
use crate::error::{Error, Result};
use crate::voice;
pub use cloud::{Provider, DEFAULT_PROVIDER};

/// A language narration can be said in.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Language {
    /// The ISO 639-1 code the deck names it by.
    pub id: &'static str,
    /// Its English name, which the services are told.
    pub name: &'static str,
}

/// The languages narration can be said in, the default first.
pub const LANGUAGES: &[Language] = &[
    Language {
        id: "en",
        name: "English",
    },
    Language {
        id: "de",
        name: "German",
    },
    Language {
        id: "fr",
        name: "French",
    },
    Language {
        id: "es",
        name: "Spanish",
    },
    Language {
        id: "it",
        name: "Italian",
    },
    Language {
        id: "pt",
        name: "Portuguese",
    },
    Language {
        id: "ru",
        name: "Russian",
    },
    Language {
        id: "zh",
        name: "Chinese",
    },
    Language {
        id: "ja",
        name: "Japanese",
    },
    Language {
        id: "ko",
        name: "Korean",
    },
];

pub const DEFAULT_LANGUAGE: &str = "en";

pub fn language(id: &str) -> Option<&'static Language> {
    LANGUAGES.iter().find(|l| l.id == id)
}

/// Emitted as a deck's narration is said: `{ deck, slide, done, total }`.
pub const RENDER_EVENT: &str = "narration-render";
/// The error a render the user cancelled ends with.
pub const CANCELLED: &str = "the narration was cancelled";

/// What narration can do on this machine right now.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechStatus {
    /// The deck whose narration is being said, if any.
    pub rendering: Option<String>,
    /// Who can say narration, the default first.
    pub providers: Vec<ProviderStatus>,
    pub languages: &'static [Language],
}

/// A provider of narration, as the Narration panel shows it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: &'static str,
    pub name: &'static str,
    /// Where its key comes from; None while it has none.
    pub key: Option<cloud::KeySource>,
    /// Its voices, the default first.
    pub voices: Vec<cloud::VoiceOption>,
}

impl ProviderStatus {
    fn of(home: &Path, provider: Provider) -> Self {
        ProviderStatus {
            id: provider.id(),
            name: provider.name(),
            key: cloud::key(home, provider).map(|(_, source)| source),
            voices: provider.voices().iter().map(Into::into).collect(),
        }
    }
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

/// Narration state, managed by Tauri: the render running.
#[derive(Default)]
pub struct Narration {
    /// Held while a deck's narration is said: one at a time.
    render: tokio::sync::Mutex<()>,
    /// The deck being said, and how to stop it.
    running: Mutex<Option<(String, Arc<Notify>)>>,
}

impl Narration {
    pub fn status(&self, home: &Path) -> SpeechStatus {
        SpeechStatus {
            rendering: self
                .running
                .lock()
                .unwrap()
                .as_ref()
                .map(|(d, _)| d.clone()),
            providers: cloud::PROVIDERS
                .into_iter()
                .map(|p| ProviderStatus::of(home, p))
                .collect(),
            languages: LANGUAGES,
        }
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
        let provider = todo[0].provider;
        let Some((key, _)) = cloud::key(home, provider) else {
            return Err(Error::msg(format!(
                "Add your {} API key in the Narration tab first.",
                provider.name()
            )));
        };
        let stop = Arc::new(Notify::new());
        *self.running.lock().unwrap() = Some((deck.id.clone(), stop.clone()));
        // Cleared however this ends, also when the caller drops it (a cancelled video export).
        let _clear = Clear(&self.running);
        tokio::select! {
            said = say_all(&key, file, &deck.id, &todo, &progress) => said?,
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

/// Says each job with the hosted service `key` is for; dropping the future (on cancel) drops
/// the request.
async fn say_all(
    key: &str,
    file: &Path,
    deck: &str,
    todo: &[Job],
    progress: &impl Fn(RenderProgress),
) -> Result<()> {
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
        let said = cloud::say(job.provider, key, &job.text, &job.voice, job.language.name)
            .await
            .and_then(|said| {
                audio::write_wav(&part, &said.samples, audio::RATE)?;
                Ok((said.samples.len(), said.words))
            });
        let (samples, words) = match said {
            Ok(said) => said,
            Err(e) => {
                let _ = fs::remove_file(&part);
                return Err(Error::msg(format!("Slide {}: {e}", job.slide)));
            }
        };
        fs::rename(&part, &dest)?;
        Manifest::update(&dir, |manifest| {
            manifest.slides.insert(
                job.slide.clone(),
                Entry {
                    fingerprint: job.fingerprint.clone(),
                    seconds: samples as f64 / f64::from(audio::RATE),
                    recorded: false,
                    // The service said when each word is: as good as hearing it again.
                    timing: if words.is_some() { WORD_TIMING } else { 0 },
                    words,
                    imported: false,
                },
            );
        })?;
    }
    Ok(())
}

/// Who says the deck's narration, in which voice and language, as its `<meta>` tags name them
/// (defaults otherwise, also for a voice the provider does not have).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// One of [`cloud::PROVIDERS`]' ids.
    pub provider: String,
    pub voice: String,
    pub language: String,
}

impl Settings {
    pub fn of(html: &str) -> Self {
        let provider = provider_of(html);
        let voice = crate::html::narration_voice(html)
            .filter(|v| provider.accepts_voice(v))
            .unwrap_or_else(|| provider.default_voice().into());
        let language = crate::html::narration_language(html)
            .filter(|l| language(l).is_some())
            .unwrap_or_else(|| DEFAULT_LANGUAGE.into());
        Settings {
            provider: provider.id().into(),
            voice,
            language,
        }
    }
}

/// The provider the deck's `<meta>` names; [`DEFAULT_PROVIDER`] without one, or for an
/// unknown one.
pub fn provider_of(html: &str) -> Provider {
    crate::html::narration_provider(html)
        .and_then(|p| Provider::parse(&p))
        .unwrap_or(DEFAULT_PROVIDER)
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
    audio_dir(deck_file).join(format!("{}.wav", file_stem(slide)))
}

/// A name for a file kept for `slide`, safe on every platform: the id itself when it is plain
/// (letters, digits, `-`, `_`, `.`), otherwise one made from its hash.
pub fn file_stem(slide: &str) -> String {
    let safe = !slide.is_empty()
        && !slide.starts_with('.')
        && slide.len() <= 100
        && slide
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if safe {
        slide.to_string()
    } else {
        format!("slide-{}", &hex(&Sha256::digest(slide.as_bytes()))[..12])
    }
}

/// What a slide's audio is made from: its script, voice and language, and the hosted service
/// and its model saying it. Audio with another fingerprint is out of date.
pub fn fingerprint(provider: Provider, text: &str, voice: &str, language: &str) -> String {
    let mut hasher = Sha256::new();
    for part in [provider.id(), provider.model(), voice, language, text] {
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
    /// Empty for a recording, which is made from no script.
    fingerprint: String,
    seconds: f64,
    /// The presenter's own voice rather than the service's.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    recorded: bool,
    /// The audio was made elsewhere and brought in (see [`import_audio`]); kept like a
    /// recording, but a recording replaces it rather than going on from its end.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    imported: bool,
    /// Every word said in the audio and when, once it was heard again by the speech-to-text
    /// model (see [`time_words`]). Made audio is a new entry, without them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    words: Option<Vec<voice::Word>>,
    /// How `words` were timed: [`WORD_TIMING`], or older and less exact ones heard again.
    #[serde(default, skip_serializing_if = "is_zero")]
    timing: u32,
}

/// The way [`time_words`] times words now: 3 places them by dynamic time warping and gives
/// each a span (see [`voice::Voice::time_words`]); 2 left some a mere moment, and 0 (or none)
/// was Whisper's own timestamps.
const WORD_TIMING: u32 = 3;

fn is_zero(n: &u32) -> bool {
    *n == 0
}

impl Entry {
    /// When each word of the audio is said, if timed the way [`time_words`] times them now.
    fn timed_words(&self) -> Option<&Vec<voice::Word>> {
        self.words.as_ref().filter(|_| self.timing == WORD_TIMING)
    }
}

/// Held while changing a manifest: a recording and a render may finish slides at the same time.
static MANIFEST_CHANGE: Mutex<()> = Mutex::new(());

impl Manifest {
    /// The manifest in `dir`; an empty one when it is missing or unreadable.
    fn read(dir: &Path) -> Self {
        fs::read_to_string(dir.join(MANIFEST))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    /// Changes the manifest in `dir`.
    fn update(dir: &Path, change: impl FnOnce(&mut Self)) -> Result<()> {
        let _one_at_a_time = MANIFEST_CHANGE.lock().unwrap_or_else(|e| e.into_inner());
        let mut manifest = Self::read(dir);
        change(&mut manifest);
        manifest.write(dir)
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
    /// The slide has no narration and no recording.
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
    /// It is the presenter's own recording, or audio made elsewhere.
    pub recorded: bool,
    /// It is audio made elsewhere (see [`import_audio`]).
    pub imported: bool,
    /// When each word of the audio is said is known (see [`time_words`]).
    pub timed: bool,
}

/// A slide's narration to say.
#[derive(Debug, Clone)]
struct Job {
    slide: String,
    text: String,
    provider: Provider,
    voice: String,
    language: &'static Language,
    fingerprint: String,
}

/// Who says the deck `file`'s narration, in which voice and language.
fn settings(file: &Path) -> (Provider, String, &'static Language) {
    let html = deck::read_html(file).unwrap_or_default();
    let settings = Settings::of(&html);
    (
        Provider::parse(&settings.provider).expect("a known provider"),
        settings.voice,
        language(&settings.language).expect("a known language"),
    )
}

/// What is said of a narration, which is Markdown: its words, without the marks around them.
/// Plain text comes out as it went in, so its audio stays up to date.
pub fn spoken(narration: &str) -> String {
    let options =
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let mut out = String::new();
    let separate = |out: &mut String, separator: &str| {
        let end = out.trim_end().len();
        if end > 0 && out[end..].matches('\n').count() < separator.len() {
            out.truncate(end);
            out.push_str(separator);
        }
    };
    for event in Parser::new_ext(narration, options) {
        match event {
            Event::Text(text) | Event::Code(text) | Event::Html(text) | Event::InlineHtml(text) => {
                out.push_str(&text)
            }
            Event::SoftBreak | Event::HardBreak => out.push('\n'),
            Event::Start(Tag::Item)
            | Event::End(TagEnd::Item | TagEnd::TableRow | TagEnd::TableHead) => {
                separate(&mut out, "\n")
            }
            Event::End(TagEnd::TableCell) => out.push(' '),
            Event::End(
                TagEnd::Paragraph
                | TagEnd::Heading(_)
                | TagEnd::BlockQuote(_)
                | TagEnd::CodeBlock
                | TagEnd::HtmlBlock
                | TagEnd::List(_)
                | TagEnd::Table,
            ) => separate(&mut out, "\n\n"),
            _ => {}
        }
    }
    out.trim_end().to_string()
}

/// The slides whose narration has no up-to-date audio.
fn jobs(file: &Path, deck: &Deck) -> Vec<Job> {
    let (provider, voice, language) = settings(file);
    let audio = statuses(file, deck);
    deck.slides
        .iter()
        .zip(audio)
        .filter(|(_, a)| matches!(a.state, AudioState::Missing | AudioState::Stale))
        .map(|(slide, _)| Job {
            slide: slide.id.clone(),
            text: spoken(&slide.narration),
            provider,
            voice: voice.clone(),
            language,
            fingerprint: fingerprint(provider, &spoken(&slide.narration), &voice, language.id),
        })
        .collect()
}

/// Every slide's audio, in slide order.
pub fn statuses(file: &Path, deck: &Deck) -> Vec<SlideAudio> {
    let (provider, voice, language) = settings(file);
    let manifest = Manifest::read(&audio_dir(file));
    deck.slides
        .iter()
        .map(|slide| {
            let path = audio_file(file, &slide.id);
            let entry = manifest.slides.get(&slide.id).filter(|_| path.is_file());
            let seconds = entry.map(|e| e.seconds);
            let text = spoken(&slide.narration);
            let recorded = entry.is_some_and(|e| e.recorded);
            let imported = entry.is_some_and(|e| e.imported);
            let timed = entry.is_some_and(|e| e.timed_words().is_some());
            let state = match entry {
                _ if recorded => AudioState::Ready,
                _ if text.is_empty() => AudioState::None,
                None => AudioState::Missing,
                Some(e) if e.fingerprint == fingerprint(provider, &text, &voice, language.id) => {
                    AudioState::Ready
                }
                Some(_) => AudioState::Stale,
            };
            SlideAudio {
                slide: slide.id.clone(),
                state,
                seconds,
                recorded,
                imported,
                timed,
            }
        })
        .collect()
}

/// Adds `samples` (mono, at `rate`) to the end of the slide's recording. Audio a service made
/// is replaced: the two voices don't go together.
pub fn append_recording(file: &Path, slide: &str, samples: &[f32], rate: u32) -> Result<()> {
    let dir = audio_dir(file);
    fs::create_dir_all(&dir)?;
    let dest = audio_file(file, slide);
    let manifest = Manifest::read(&dir);
    // A recording goes on from the end of the last one; audio brought in it replaces.
    let recorded = manifest
        .slides
        .get(slide)
        .is_some_and(|e| e.recorded && !e.imported);
    let mut all = if recorded && dest.is_file() {
        let (kept, kept_rate) = audio::read_wav(&dest)?;
        voice::resample(&kept, kept_rate, audio::RATE)
    } else {
        Vec::new()
    };
    all.extend(voice::resample(samples, rate, audio::RATE));
    let part = dest.with_extension("wav.part");
    audio::write_wav(&part, &all, audio::RATE)?;
    fs::rename(&part, &dest)?;
    Manifest::update(&dir, |manifest| {
        manifest.slides.insert(
            slide.to_string(),
            Entry {
                fingerprint: String::new(),
                seconds: all.len() as f64 / f64::from(audio::RATE),
                recorded: true,
                words: None,
                imported: false,
                timing: 0,
            },
        );
    })
}

/// Whether the slide's audio is the presenter's own recording (not audio brought in), which
/// nothing could make again once it is replaced.
pub fn has_own_recording(file: &Path, slide: &str) -> bool {
    Manifest::read(&audio_dir(file))
        .slides
        .get(slide)
        .is_some_and(|e| e.recorded && !e.imported)
        && audio_file(file, slide).is_file()
}

/// Deletes the slide's recording, if it has one; audio a service made stays.
pub fn delete_recording(file: &Path, slide: &str) -> Result<()> {
    let dir = audio_dir(file);
    if !Manifest::read(&dir)
        .slides
        .get(slide)
        .is_some_and(|e| e.recorded)
    {
        return Ok(());
    }
    match fs::remove_file(audio_file(file, slide)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
        _ => {}
    }
    Manifest::update(&dir, |manifest| {
        manifest.slides.remove(slide);
    })
}

/// Makes the audio file `source` (any format [`audio::decode`] reads) the slide's narration in
/// place of whatever it had. Like a recording, it is the slide's audio whatever its script
/// says, until deleted; its words are not timed yet (see [`time_words`]). Returns how long it
/// plays, in seconds.
pub fn import_audio(file: &Path, slide: &str, source: &Path) -> Result<f64> {
    let (samples, rate) = audio::decode(source)?;
    let samples = voice::resample(&samples, rate, audio::RATE);
    let seconds = samples.len() as f64 / f64::from(audio::RATE);
    let dir = audio_dir(file);
    fs::create_dir_all(&dir)?;
    let dest = audio_file(file, slide);
    let part = dest.with_extension("wav.part");
    audio::write_wav(&part, &samples, audio::RATE)?;
    fs::rename(&part, &dest)?;
    Manifest::update(&dir, |manifest| {
        manifest.slides.insert(
            slide.to_string(),
            Entry {
                fingerprint: String::new(),
                seconds,
                recorded: true,
                words: None,
                imported: true,
                timing: 0,
            },
        );
    })?;
    Ok(seconds)
}

/// Payload of [`TIMING_EVENT`]: how far timing a deck's words has got.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimingProgress {
    pub deck: String,
    /// The slide being heard now; None once all are done.
    pub slide: Option<String>,
    pub done: usize,
    pub total: usize,
}

/// Emitted as [`time_words`] goes.
pub const TIMING_EVENT: &str = "narration-timing";

/// When each word of a slide's audio is said: seconds from the start of its audio, which
/// plays `data-narration-start` seconds after the slide shows.
pub fn words(file: &Path, slide: &str) -> Option<Vec<voice::Word>> {
    if !audio_file(file, slide).is_file() {
        return None;
    }
    let entry = Manifest::read(&audio_dir(file)).slides.remove(slide)?;
    entry.timed_words().cloned()
}

/// Has `voice` hear the up-to-date audio of the deck `file`'s `slides` (all for None) again,
/// unless it was, to keep when each word is said (see [`words`]): the made audio in the deck's
/// narration language, a recording in whatever language it is in. Calls `progress` as it goes
/// and returns every slide's audio.
pub async fn time_words(
    voice: &voice::Voice,
    home: &Path,
    file: &Path,
    slides: Option<&[String]>,
    progress: impl Fn(TimingProgress),
) -> Result<Vec<SlideAudio>> {
    let deck = deck::load(file)?;
    let (_, _, language) = settings(file);
    let todo: Vec<SlideAudio> = statuses(file, &deck)
        .into_iter()
        .filter(|a| a.state == AudioState::Ready && !a.timed)
        .filter(|a| slides.map_or(true, |s| s.contains(&a.slide)))
        .collect();
    let dir = audio_dir(file);
    for (done, audio) in todo.iter().enumerate() {
        progress(TimingProgress {
            deck: deck.id.clone(),
            slide: Some(audio.slide.clone()),
            done,
            total: todo.len(),
        });
        let Some(heard) = Manifest::read(&dir).slides.remove(&audio.slide) else {
            continue;
        };
        let (samples, rate) = audio::read_wav(&audio_file(file, &audio.slide))?;
        let spoken_in = (!heard.recorded).then(|| language.id.to_string());
        let words = voice
            .time_words(home, samples, rate, spoken_in)
            .await
            .map_err(|e| Error::msg(format!("Slide {}: {e}", audio.slide)))?;
        keep_words(&dir, &audio.slide, &heard, words)?;
    }
    progress(TimingProgress {
        deck: deck.id.clone(),
        slide: None,
        done: todo.len(),
        total: todo.len(),
    });
    Ok(statuses(file, &deck::load(file)?))
}

/// Keeps `words` as the slide's, unless its audio changed since `heard` was its entry.
fn keep_words(dir: &Path, slide: &str, heard: &Entry, words: Vec<voice::Word>) -> Result<()> {
    Manifest::update(dir, |manifest| {
        if let Some(entry) = manifest.slides.get_mut(slide) {
            let same = entry.fingerprint == heard.fingerprint
                && entry.seconds == heard.seconds
                && entry.recorded == heard.recorded;
            if same {
                entry.words = Some(words);
                entry.timing = WORD_TIMING;
            }
        }
    })
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
    fn languages_have_a_known_default_and_openai_says_decks_naming_nobody() {
        assert_eq!(LANGUAGES[0].id, DEFAULT_LANGUAGE);
        assert_eq!(language("de").unwrap().name, "German");
        assert!(language("German").is_none());
        assert_eq!(DEFAULT_PROVIDER, Provider::OpenAi);
        // A deck made for the removed local model goes to the default provider.
        let html = r#"<html><head><meta name="slopslide-narration-provider" content="local"></head></html>"#;
        assert_eq!(provider_of(html), Provider::OpenAi);
    }

    #[test]
    fn the_agent_is_told_every_provider_voice_and_language() {
        let prompt = include_str!("../../prompts/system.md");
        let at = prompt
            .find("slopslide-narration-provider` meta")
            .expect("the narration rules");
        let words: Vec<&str> = prompt[at..at + 900]
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .collect();
        let ids = cloud::OPENAI_VOICES
            .iter()
            .map(|v| v.id)
            .chain(cloud::PROVIDERS.iter().map(|p| p.id()))
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
                provider: "openai".into(),
                voice: "marin".into(),
                language: "en".into()
            }
        );
        let set = html(
            "<meta name=\"slopslide-narration-voice\" content=\"ash\"><meta name=\"slopslide-narration-language\" content=\"ko\">",
        );
        assert_eq!(
            Settings::of(&set),
            Settings {
                provider: "openai".into(),
                voice: "ash".into(),
                language: "ko".into()
            }
        );
        let unknown = html("<meta name=\"slopslide-narration-voice\" content=\"bob\">");
        assert_eq!(Settings::of(&unknown).voice, "marin");
        assert_eq!(Settings::of(&unknown).provider, "openai");
        let openai = html(
            "<meta name=\"slopslide-narration-provider\" content=\"openai\"><meta name=\"slopslide-narration-voice\" content=\"coral\">",
        );
        assert_eq!(
            Settings::of(&openai),
            Settings {
                provider: "openai".into(),
                voice: "coral".into(),
                language: "en".into()
            }
        );
        // A voice the provider does not have falls back to its default.
        let mixed = html(
            "<meta name=\"slopslide-narration-provider\" content=\"elevenlabs\"><meta name=\"slopslide-narration-voice\" content=\"coral\">",
        );
        assert_eq!(Settings::of(&mixed).voice, cloud::ELEVENLABS_VOICES[0].id);
        let nobody = html("<meta name=\"slopslide-narration-provider\" content=\"acme\">");
        assert_eq!(Settings::of(&nobody).provider, "openai");
    }

    #[test]
    fn only_the_words_of_markdown_are_said() {
        assert_eq!(
            spoken("Plain text.\nSame part\n\nNext < part."),
            "Plain text.\nSame part\n\nNext < part."
        );
        assert_eq!(
            spoken("# Title\n\nSay **this** and `that`, [here](https://a.b).\n\n- One\n  - Inner\n- Two\n\n> Quote"),
            "Title\n\nSay this and that, here.\n\nOne\nInner\n\nTwo\n\nQuote"
        );
        assert_eq!(spoken("| A | B |\n|---|---|\n| 1 | 2 |"), "A B\n1 2");
        assert_eq!(spoken("Say <hi> & wave"), "Say <hi> & wave");
        assert_eq!(spoken("---"), "");
    }

    #[test]
    fn formatting_narration_keeps_its_audio_and_marks_alone_are_no_narration() {
        let dir = temp_dir();
        let file = deck_with(
            &dir,
            "talk",
            "",
            r#"<section class="slide" id="a"><aside class="narration">Say **this**.</aside></section><section class="slide" id="b"><aside class="narration">---</aside></section>"#,
        );
        let settings = Settings::of(&fs::read_to_string(&file).unwrap());
        let (voice, language) = (settings.voice, settings.language);
        let audio = audio_dir(&file);
        fs::create_dir_all(&audio).unwrap();
        fs::write(audio_file(&file, "a"), "").unwrap();
        Manifest {
            slides: BTreeMap::from([(
                "a".to_string(),
                Entry {
                    fingerprint: fingerprint(Provider::OpenAi, "Say this.", &voice, &language),
                    seconds: 1.0,
                    recorded: false,
                    words: None,
                    imported: false,
                    timing: 0,
                },
            )]),
        }
        .write(&audio)
        .unwrap();
        let states: Vec<_> = statuses(&file, &deck::load(&file).unwrap())
            .into_iter()
            .map(|a| a.state)
            .collect();
        assert_eq!(states, [AudioState::Ready, AudioState::None]);
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
        let base = fingerprint(Provider::OpenAi, "Hello.", "marin", "en");
        assert_eq!(base, fingerprint(Provider::OpenAi, "Hello.", "marin", "en"));
        assert_ne!(base, fingerprint(Provider::OpenAi, "Hello!", "marin", "en"));
        assert_ne!(base, fingerprint(Provider::OpenAi, "Hello.", "coral", "en"));
        assert_ne!(base, fingerprint(Provider::OpenAi, "Hello.", "marin", "de"));
        // Parts cannot run into each other.
        assert_ne!(
            fingerprint(Provider::OpenAi, "b", "a", "en"),
            fingerprint(Provider::OpenAi, "", "ab", "en")
        );
    }

    #[test]
    fn hosted_audio_keeps_its_fingerprint_and_the_old_local_models_goes_stale() {
        // As hosted audio was fingerprinted before, so none of it goes out of date.
        let hash = |parts: &[&str]| {
            let mut hasher = Sha256::new();
            for part in parts {
                hasher.update(part.as_bytes());
                hasher.update([0]);
            }
            hex(&hasher.finalize())
        };
        let openai = fingerprint(Provider::OpenAi, "Hello.", "marin", "en");
        assert_eq!(
            openai,
            hash(&["openai", "gpt-4o-mini-tts", "marin", "en", "Hello."])
        );
        let eleven = fingerprint(Provider::ElevenLabs, "Hello.", "marin", "en");
        assert_ne!(openai, eleven);
        // What the removed local model made (its model and engine revisions) matches neither.
        let local = hash(&[
            "85e237c12c027371202489a0ec509ded67b5e4b5",
            "ef339be58a778b062e1c14382347964552eae007",
            "marin",
            "en",
            "Hello.",
        ]);
        assert_ne!(local, openai);
        assert_ne!(local, eleven);
    }

    #[test]
    fn changing_the_provider_makes_the_audio_stale() {
        let dir = temp_dir();
        let file = deck_with(
            &dir,
            "deck.html",
            "",
            r#"<section class="slide" id="a"><aside class="narration">Say A.</aside></section>"#,
        );
        fs::create_dir_all(audio_dir(&file)).unwrap();
        fs::write(audio_file(&file, "a"), "").unwrap();
        Manifest {
            slides: BTreeMap::from([(
                "a".to_string(),
                Entry {
                    fingerprint: fingerprint(Provider::OpenAi, "Say A.", "marin", "en"),
                    seconds: 1.0,
                    recorded: false,
                    words: None,
                    imported: false,
                    timing: 0,
                },
            )]),
        }
        .write(&audio_dir(&file))
        .unwrap();
        let state = |file: &Path| statuses(file, &deck::load(file).unwrap())[0].state;
        assert_eq!(state(&file), AudioState::Ready);
        let html = fs::read_to_string(&file).unwrap();
        let html = crate::html::set_narration_voice(&html, "coral");
        fs::write(
            &file,
            crate::html::set_narration_provider(&html, Some("elevenlabs")),
        )
        .unwrap();
        assert_eq!(state(&file), AudioState::Stale);
        let jobs = jobs(&file, &deck::load(&file).unwrap());
        assert_eq!(jobs[0].provider, Provider::ElevenLabs);
        // OpenAI's voice is none of ElevenLabs': its default says it.
        let george = cloud::ELEVENLABS_VOICES[0].id;
        assert_eq!(jobs[0].voice, george);
        assert_eq!(
            jobs[0].fingerprint,
            fingerprint(Provider::ElevenLabs, "Say A.", george, "en")
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_hosted_provider_needs_its_key_before_saying_anything() {
        let dir = temp_dir();
        let file = deck_with(
            &dir,
            "deck.html",
            r#"<meta name="slopslide-narration-provider" content="elevenlabs">"#,
            r#"<section class="slide" id="a"><aside class="narration">Hi.</aside></section>"#,
        );
        let narration = Narration::default();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        // The app home has no key saved; only an environment key could get past this.
        if std::env::var("ELEVENLABS_API_KEY").is_err() {
            let err = rt
                .block_on(narration.render(&dir, &file, None, |_| {}))
                .unwrap_err();
            assert!(err.to_string().contains("ElevenLabs API key"), "{err}");
        }
        let status = narration.status(&dir);
        let ids: Vec<&str> = status.providers.iter().map(|p| p.id).collect();
        assert_eq!(ids, ["openai", "elevenlabs"]);
        assert_eq!(status.providers[0].voices[0].id, "marin");
        assert_eq!(
            status.providers[1].voices[0].id,
            cloud::ELEVENLABS_VOICES[0].id
        );
        cloud::set_key(&dir, Provider::OpenAi, Some("sk-x")).unwrap();
        let status = narration.status(&dir);
        assert_eq!(status.providers[0].key, Some(cloud::KeySource::Saved));
        fs::remove_dir_all(dir).unwrap();
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
                fingerprint: fingerprint(Provider::OpenAi, "Say A.", "marin", "en"),
                seconds: 0.5,
                recorded: false,
                words: None,
                imported: false,
                timing: 0,
            },
        );
        manifest.slides.insert(
            "b".into(),
            Entry {
                fingerprint: fingerprint(Provider::OpenAi, "Old B.", "marin", "en"),
                seconds: 1.0,
                recorded: false,
                words: None,
                imported: false,
                timing: 0,
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
                todo[0].voice.as_str(),
                todo[0].language.name
            ),
            ("b", "Say B.", "marin", "English")
        );
        assert_eq!(ready_audio(&file, &deck).keys().collect::<Vec<_>>(), ["a"]);

        // Another voice makes all of it out of date.
        let file = deck_with(
            &dir,
            "deck.html",
            "<meta name=\"slopslide-narration-voice\" content=\"coral\">",
            slides,
        );
        let deck = deck::load(&file).unwrap();
        assert_eq!(
            states(&deck),
            [AudioState::Stale, AudioState::Stale, AudioState::None]
        );
        assert_eq!(jobs(&file, &deck)[0].voice, "coral");

        // A missing audio file is missing, whatever the manifest says.
        fs::remove_file(audio.join("a.wav")).unwrap();
        assert_eq!(states(&deck)[0], AudioState::Missing);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn recordings_grow_replace_the_models_audio_and_stay_up_to_date() {
        let dir = temp_dir();
        let slides = r#"<section class="slide" id="a"><aside class="narration">Say A.</aside></section><section class="slide" id="b"></section>"#;
        let file = deck_with(&dir, "deck.html", "", slides);
        let deck = deck::load(&file).unwrap();
        let audio = audio_dir(&file);
        fs::create_dir_all(&audio).unwrap();
        // What the service said of a's script is replaced by the first take.
        audio::write_wav(&audio_file(&file, "a"), &[0.1; 48_000], audio::RATE).unwrap();
        Manifest::update(&audio, |m| {
            m.slides.insert(
                "a".into(),
                Entry {
                    fingerprint: fingerprint(Provider::OpenAi, "Say A.", "marin", "en"),
                    seconds: 2.0,
                    recorded: false,
                    words: None,
                    imported: false,
                    timing: 0,
                },
            );
        })
        .unwrap();
        delete_recording(&file, "a").unwrap();
        assert!(audio_file(&file, "a").is_file(), "not a recording");

        append_recording(&file, "a", &[0.5; 48_000], 48_000).unwrap();
        let found = statuses(&file, &deck);
        assert_eq!(found[0].state, AudioState::Ready);
        assert!(found[0].recorded);
        assert_eq!(found[0].seconds, Some(1.0));

        // The next takes are added, at whatever rate the microphone has.
        append_recording(&file, "a", &[0.5; 12_000], audio::RATE).unwrap();
        let (samples, rate) = audio::read_wav(&audio_file(&file, "a")).unwrap();
        assert_eq!((samples.len(), rate), (36_000, audio::RATE));
        assert_eq!(statuses(&file, &deck)[0].seconds, Some(1.5));

        // Whatever happens to the script, it is the slide's audio, and is not said again.
        let edited = deck_with(
            &dir,
            "deck.html",
            "<meta name=\"slopslide-narration-voice\" content=\"coral\">",
            &slides.replace("Say A.", "Say something else."),
        );
        let deck = deck::load(&edited).unwrap();
        assert_eq!(statuses(&edited, &deck)[0].state, AudioState::Ready);
        assert!(jobs(&edited, &deck).is_empty());

        // A slide with a recording and no script has audio all the same.
        append_recording(&edited, "b", &[0.5; 24_000], audio::RATE).unwrap();
        let found = statuses(&edited, &deck);
        assert_eq!(
            (found[1].state, found[1].recorded),
            (AudioState::Ready, true)
        );
        assert_eq!(ready_audio(&edited, &deck).len(), 2);

        // Deleted, the service takes over again.
        delete_recording(&edited, "a").unwrap();
        delete_recording(&edited, "b").unwrap();
        delete_recording(&edited, "b").unwrap();
        assert!(!audio_file(&edited, "a").exists());
        let found = statuses(&edited, &deck);
        assert_eq!(found[0].state, AudioState::Missing);
        assert_eq!(found[1].state, AudioState::None);
        assert!(!found[0].recorded);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn heard_audio_keeps_its_words_until_the_audio_changes() {
        let dir = temp_dir();
        let slides = r#"<section class="slide" id="a"><aside class="narration">Say A.</aside></section><section class="slide" id="b"><aside class="narration">Say B.</aside></section><section class="slide" id="c"></section>"#;
        let file = deck_with(&dir, "deck.html", "", slides);
        let deck = deck::load(&file).unwrap();
        let audio = audio_dir(&file);
        fs::create_dir_all(&audio).unwrap();
        // a has up-to-date audio, b out-of-date audio, c none.
        audio::write_wav(&audio_file(&file, "a"), &[0.0; 24_000], audio::RATE).unwrap();
        audio::write_wav(&audio_file(&file, "b"), &[0.0; 24_000], audio::RATE).unwrap();
        let entry = |text: &str| Entry {
            fingerprint: fingerprint(Provider::OpenAi, text, "marin", "en"),
            seconds: 1.0,
            recorded: false,
            words: None,
            imported: false,
            timing: 0,
        };
        Manifest::update(&audio, |m| {
            m.slides.insert("a".into(), entry("Say A."));
            m.slides.insert("b".into(), entry("Old B."));
        })
        .unwrap();
        assert!(statuses(&file, &deck).iter().all(|a| !a.timed));
        assert_eq!(words(&file, "a"), None);

        // Silence is heard as no words, without the speech model; only a is heard at all.
        let voice = voice::Voice::default();
        let seen = Mutex::new(Vec::new());
        let found = tauri::async_runtime::block_on(time_words(
            &voice,
            Path::new("/nonexistent"),
            &file,
            None,
            |p| seen.lock().unwrap().push((p.slide, p.done, p.total)),
        ))
        .unwrap();
        assert_eq!(
            found.iter().map(|a| a.timed).collect::<Vec<_>>(),
            [true, false, false]
        );
        assert_eq!(words(&file, "a"), Some(vec![]));
        assert_eq!(words(&file, "c"), None);
        assert_eq!(
            seen.into_inner().unwrap(),
            [(Some("a".to_string()), 0, 1), (None, 1, 1)]
        );

        // Heard audio is not heard again.
        let found = tauri::async_runtime::block_on(time_words(
            &voice,
            Path::new("/nonexistent"),
            &file,
            Some(&["a".to_string()]),
            |p| assert_eq!(p.total, 0),
        ))
        .unwrap();
        assert!(found[0].timed);

        // Words of audio that changed while it was heard are not kept.
        let heard = Manifest::read(&audio).slides.remove("a").unwrap();
        let said = vec![voice::Word {
            text: "Say".into(),
            start: 0.1,
            end: 0.4,
        }];
        keep_words(&audio, "a", &heard, said.clone()).unwrap();
        assert_eq!(words(&file, "a"), Some(said.clone()));
        append_recording(&file, "a", &[0.1; 24_000], audio::RATE).unwrap();
        assert!(!statuses(&file, &deck)[0].timed, "a recording is new audio");
        keep_words(&audio, "a", &heard, said.clone()).unwrap();
        assert_eq!(words(&file, "a"), None);

        // Words are kept in the manifest only once there are some, and go with the audio file.
        let heard = Manifest::read(&audio).slides.remove("a").unwrap();
        keep_words(&audio, "a", &heard, said.clone()).unwrap();
        let json = fs::read_to_string(audio.join(MANIFEST)).unwrap();
        assert_eq!(json.matches("\"words\"").count(), 1);
        fs::remove_file(audio_file(&file, "a")).unwrap();
        assert_eq!(words(&file, "a"), None);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn audio_made_elsewhere_becomes_the_slides_narration() {
        let dir = temp_dir();
        let slides = r#"<section class="slide" id="a"><aside class="narration">Say A.</aside></section><section class="slide" id="b"></section>"#;
        let file = deck_with(&dir, "deck.html", "", slides);
        let deck = deck::load(&file).unwrap();
        // Made audio of a, timed, is replaced by the imported audio.
        let audio = audio_dir(&file);
        fs::create_dir_all(&audio).unwrap();
        audio::write_wav(&audio_file(&file, "a"), &[0.0; 24_000], audio::RATE).unwrap();
        Manifest::update(&audio, |m| {
            m.slides.insert(
                "a".into(),
                Entry {
                    fingerprint: fingerprint(Provider::OpenAi, "Say A.", "marin", "en"),
                    seconds: 1.0,
                    recorded: false,
                    imported: false,
                    words: Some(vec![]),
                    timing: WORD_TIMING,
                },
            );
        })
        .unwrap();
        let source = dir.join("take.wav");
        audio::write_wav(&source, &[0.25; 8_000], 16_000).unwrap();
        assert_eq!(import_audio(&file, "a", &source).unwrap(), 0.5);
        // b has no script, yet its imported audio is ready too.
        assert_eq!(import_audio(&file, "b", &source).unwrap(), 0.5);
        let found = statuses(&file, &deck);
        for slide in &found {
            assert_eq!(slide.state, AudioState::Ready, "{}", slide.slide);
            assert_eq!(slide.seconds, Some(0.5));
            assert!(slide.recorded && slide.imported && !slide.timed);
        }
        // Recording the slide replaces the imported audio rather than going on from its end.
        append_recording(&file, "b", &[0.1; 24_000], audio::RATE).unwrap();
        let b = &statuses(&file, &deck)[1];
        assert_eq!(b.seconds, Some(1.0));
        assert!(b.recorded && !b.imported);
        append_recording(&file, "b", &[0.1; 24_000], audio::RATE).unwrap();
        assert_eq!(
            statuses(&file, &deck)[1].seconds,
            Some(2.0),
            "a recording goes on"
        );
        let (samples, rate) = audio::read_wav(&audio_file(&file, "a")).unwrap();
        assert_eq!((samples.len(), rate), (12_000, audio::RATE));
        assert!(source.is_file(), "the source stays where it was");
        // A file that is no audio changes nothing.
        fs::write(dir.join("notes.txt"), "hello").unwrap();
        assert!(import_audio(&file, "a", &dir.join("notes.txt")).is_err());
        assert_eq!(statuses(&file, &deck)[0].seconds, Some(0.5));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn words_timed_the_old_way_are_timed_again() {
        let dir = temp_dir();
        let slides = r#"<section class="slide" id="a"></section>"#;
        let file = deck_with(&dir, "deck.html", "", slides);
        let audio = audio_dir(&file);
        fs::create_dir_all(&audio).unwrap();
        audio::write_wav(&audio_file(&file, "a"), &[0.0; 24_000], audio::RATE).unwrap();
        fs::write(
            audio.join(MANIFEST),
            r#"{"slides":{"a":{"fingerprint":"","seconds":1.0,"recorded":true,"words":[{"text":"Hi","start":0.1,"end":0.3}]}}}"#,
        )
        .unwrap();
        let deck = deck::load(&file).unwrap();
        assert!(!statuses(&file, &deck)[0].timed);
        assert_eq!(words(&file, "a"), None);
        let found = tauri::async_runtime::block_on(time_words(
            &voice::Voice::default(),
            Path::new("/nonexistent"),
            &file,
            None,
            |_| {},
        ))
        .unwrap();
        assert!(found[0].timed);
        assert_eq!(words(&file, "a"), Some(vec![]));
        let json = fs::read_to_string(audio.join(MANIFEST)).unwrap();
        assert!(
            json.contains(&format!("\"timing\": {WORD_TIMING}")),
            "{json}"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn manifests_from_before_recordings_still_read() {
        let dir = temp_dir();
        fs::write(
            dir.join(MANIFEST),
            r#"{"slides":{"a":{"fingerprint":"f","seconds":1.5}}}"#,
        )
        .unwrap();
        assert!(!Manifest::read(&dir).slides["a"].recorded);
        // And a manifest without recordings stays as it was.
        Manifest::update(&dir, |_| {}).unwrap();
        let json = fs::read_to_string(dir.join(MANIFEST)).unwrap();
        assert!(!json.contains("recorded"), "{json}");
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
    fn rendering_nothing_needs_no_key() {
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
        // With narration but no key for the default provider, it says what to do.
        if std::env::var("OPENAI_API_KEY").is_err() {
            let file = deck_with(
                &dir,
                "deck.html",
                "",
                r#"<section class="slide" id="a"><aside class="narration">Hi.</aside></section>"#,
            );
            let err = rt
                .block_on(narration.render(&dir, &file, None, |_| {}))
                .unwrap_err();
            assert!(err.to_string().contains("OpenAI API key"), "{err}");
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
