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
//! audio back. Audio made elsewhere (see [`set_audio`]) is kept the same way.

pub mod audio;
pub mod beats;
pub mod cloud;
mod generate;
mod manifest;
mod preview;
mod recordings;
mod settings;
pub mod timeline;
mod words;

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use serde::Serialize;
use tokio::sync::Notify;

use crate::deck::{self, Deck};
use crate::error::{Error, Result};
pub use cloud::{Provider, DEFAULT_PROVIDER};
pub use generate::Outcome;
#[cfg(test)]
use manifest::fingerprint;
use manifest::fingerprint_with;
pub use manifest::{audio_dir, audio_file, file_stem};
use manifest::{Entry, Manifest};
pub use preview::preview_voice;
pub use recordings::{
    append_recording, delete_recording, refusal, replace_recording, set_audio, Refusal,
};
use settings::settings;
pub use settings::{
    deck_settings, language, provider_of, set_delivery, set_timing, DeckSettings, Delivery,
    Language, Pace, Settings, Timing, DEFAULT_LANGUAGE, LANGUAGES,
};
pub use words::{cancel_timing, time_words, words, TimingProgress, TIMING_EVENT};

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
    /// Whether it takes a note on the manner narration is said in (see [`Delivery`]).
    pub takes_style: bool,
}

impl ProviderStatus {
    fn of(home: &Path, provider: Provider) -> Self {
        ProviderStatus {
            id: provider.id(),
            name: provider.name(),
            key: cloud::key(home, provider).map(|(_, source)| source),
            voices: provider.voices().iter().map(Into::into).collect(),
            takes_style: provider.takes_style(),
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
        let said = cloud::say(
            job.provider,
            key,
            &job.text,
            &job.voice,
            job.language.name,
            &job.delivery,
        )
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
            let seconds = samples as f64 / f64::from(audio::RATE);
            let made = Entry::made(job.fingerprint.clone(), seconds, words);
            manifest.slides.insert(job.slide.clone(), made);
        })?;
    }
    Ok(())
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
    /// It is audio made elsewhere (see [`set_audio`]).
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
    delivery: Delivery,
    fingerprint: String,
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
    let delivery = deck_settings(file).delivery;
    let audio = statuses(file, deck);
    deck.slides
        .iter()
        .zip(audio)
        .filter(|(_, a)| matches!(a.state, AudioState::Missing | AudioState::Stale))
        .map(|(slide, _)| {
            let text = spoken(&slide.narration);
            Job {
                fingerprint: fingerprint_with(provider, &text, &voice, language.id, &delivery),
                slide: slide.id.clone(),
                text,
                provider,
                voice: voice.clone(),
                language,
                delivery: delivery.clone(),
            }
        })
        .collect()
}

/// Every slide's audio, in slide order.
pub fn statuses(file: &Path, deck: &Deck) -> Vec<SlideAudio> {
    // The deck names who says it: the file is not read for that again.
    let (provider, voice, language) = deck.narration.resolved();
    let manifest = Manifest::read(&audio_dir(file));
    let delivery = &manifest.settings.delivery;
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
                Some(e)
                    if e.fingerprint
                        == fingerprint_with(provider, &text, voice, language.id, delivery) =>
                {
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
mod testing {
    use std::fs;
    use std::path::{Path, PathBuf};

    pub fn temp_dir() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("slopslide-narration-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The deck file `name` in `dir`, with `head` in its head and `slides` in it.
    pub fn deck_with(dir: &Path, name: &str, head: &str, slides: &str) -> PathBuf {
        let file = dir.join(name);
        fs::write(
            &file,
            format!("<!DOCTYPE html><html><head><title>T</title>{head}</head><body><main class=\"deck\">{slides}</main></body></html>"),
        )
        .unwrap();
        file
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{deck_with, temp_dir};
    use super::*;

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
                Entry::made(
                    fingerprint(Provider::OpenAi, "Say this.", &voice, &language),
                    1.0,
                    None,
                ),
            )]),
            ..Default::default()
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
    fn another_pace_or_style_makes_the_audio_stale_and_the_plain_one_brings_it_back() {
        let dir = temp_dir();
        let file = deck_with(
            &dir,
            "deck.html",
            "",
            r#"<section class="slide" id="a"><aside class="narration">Say A.</aside></section>"#,
        );
        fs::create_dir_all(audio_dir(&file)).unwrap();
        fs::write(audio_file(&file, "a"), "").unwrap();
        // Audio made before a deck could set how it is said.
        Manifest::update(&audio_dir(&file), |m| {
            let made = fingerprint(Provider::OpenAi, "Say A.", "marin", "en");
            m.slides.insert("a".into(), Entry::made(made, 1.0, None));
        })
        .unwrap();
        let state = || statuses(&file, &deck::load(&file).unwrap())[0].state;
        assert_eq!(state(), AudioState::Ready);
        set_delivery(&file, Pace::Slower, "").unwrap();
        assert_eq!(state(), AudioState::Stale);
        let job = &jobs(&file, &deck::load(&file).unwrap())[0];
        assert_eq!(job.delivery.pace, Pace::Slower);
        assert_ne!(
            job.fingerprint,
            fingerprint(Provider::OpenAi, "Say A.", "marin", "en")
        );
        set_delivery(&file, Pace::Normal, "calm").unwrap();
        assert_eq!(state(), AudioState::Stale);
        set_delivery(&file, Pace::Normal, "").unwrap();
        assert_eq!(state(), AudioState::Ready);
        // The times the deck plays with say nothing about its audio.
        let timing = Timing {
            seconds_per_slide: 9.0,
            pause_before: 1.0,
            pause_after: 1.0,
        };
        set_timing(&file, timing).unwrap();
        assert_eq!(state(), AudioState::Ready);
        assert_eq!(timeline::defaults_for(&file).seconds_per_slide, 9.0);
        assert_eq!(timeline::defaults_for(&file).fps, timeline::DEFAULTS.fps);
        fs::remove_dir_all(dir).unwrap();
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
                Entry::made(
                    fingerprint(Provider::OpenAi, "Say A.", "marin", "en"),
                    1.0,
                    None,
                ),
            )]),
            ..Default::default()
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
            Entry::made(
                fingerprint(Provider::OpenAi, "Say A.", "marin", "en"),
                0.5,
                None,
            ),
        );
        manifest.slides.insert(
            "b".into(),
            Entry::made(
                fingerprint(Provider::OpenAi, "Old B.", "marin", "en"),
                1.0,
                None,
            ),
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
