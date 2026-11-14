//! Who says a deck's narration, in which voice and language, as its `<meta>` tags name them,
//! and the languages narration can be said in. And what the deck keeps next to its audio, in
//! `narration/manifest.json` (see [`DeckSettings`]): how it is said (pace and style), and the
//! times it is laid out with wherever it plays by itself.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::cloud::{Provider, DEFAULT_PROVIDER};
use super::manifest::{audio_dir, Manifest};
use crate::deck;
use crate::error::{Error, Result};
use crate::html::AppMetas;
use crate::video;

/// How fast narration is said.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Pace {
    Slower,
    #[default]
    Normal,
    Faster,
}

impl Pace {
    fn is_normal(&self) -> bool {
        *self == Pace::Normal
    }

    fn id(self) -> &'static str {
        match self {
            Pace::Slower => "slower",
            Pace::Normal => "normal",
            Pace::Faster => "faster",
        }
    }
}

/// The longest a style note may be, in characters: a line, not a script.
pub const MAX_STYLE_CHARS: usize = 200;

/// How a deck's narration is said, beyond who says it: how fast, and in what manner. The
/// pace goes to every service; the style only to one that takes a note on delivery (see
/// [`Provider::takes_style`]).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    #[serde(default, skip_serializing_if = "Pace::is_normal")]
    pub pace: Pace,
    /// A note on the manner, like "warm and calm"; empty for none.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub style: String,
}

impl Delivery {
    /// The delivery with its style tidied: one line, no space around it. Fails for a style
    /// too long to be a note.
    pub fn checked(pace: Pace, style: &str) -> Result<Self> {
        let style = style.split_whitespace().collect::<Vec<_>>().join(" ");
        if style.chars().count() > MAX_STYLE_CHARS {
            return Err(Error::msg(format!(
                "Keep the style note to {MAX_STYLE_CHARS} characters."
            )));
        }
        Ok(Delivery { pace, style })
    }

    /// What of it `provider` is told, for the audio's fingerprint: empty for the plain
    /// delivery, so audio made before there was any stays up to date. A style the provider
    /// does not take changes nothing of its audio.
    pub fn mark(&self, provider: Provider) -> String {
        let style = match provider.takes_style() {
            true => self.style.as_str(),
            false => "",
        };
        match (self.pace, style) {
            (Pace::Normal, "") => String::new(),
            (pace, style) => format!("{}\n{style}", pace.id()),
        }
    }
}

/// The times a deck is laid out with wherever it plays by itself (the timeline, the show's
/// Play, a video): how long a slide without narration shows, and the pauses around narration.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timing {
    pub seconds_per_slide: f64,
    pub pause_before: f64,
    pub pause_after: f64,
}

impl Timing {
    /// Fails for times a video could not be made with (see [`video::Options::check`]).
    pub fn check(&self) -> Result<()> {
        video::Options::from(*self).check()
    }
}

impl From<Timing> for video::Options {
    /// The app's export settings (see [`super::timeline::DEFAULTS`]) with these times.
    fn from(timing: Timing) -> Self {
        video::Options {
            seconds_per_slide: timing.seconds_per_slide,
            pause_before: timing.pause_before,
            pause_after: timing.pause_after,
            ..super::timeline::DEFAULTS
        }
    }
}

/// What a deck keeps next to its audio that is no audio: how its narration is said, and the
/// times it plays with. A deck that never set them has none, and plays with the app's.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckSettings {
    /// None until the deck sets its own: the app's defaults then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timing: Option<Timing>,
    #[serde(flatten)]
    pub delivery: Delivery,
}

impl DeckSettings {
    pub(super) fn is_default(&self) -> bool {
        *self == DeckSettings::default()
    }
}

/// What the deck `file` keeps of how its narration is said and timed.
pub fn deck_settings(file: &Path) -> DeckSettings {
    Manifest::read(&audio_dir(file)).settings
}

/// Changes what the deck `file` keeps of how its narration is said and timed; returns it.
fn change_deck_settings(
    file: &Path,
    change: impl FnOnce(&mut DeckSettings),
) -> Result<DeckSettings> {
    let dir = audio_dir(file);
    std::fs::create_dir_all(&dir)?;
    let mut kept = DeckSettings::default();
    Manifest::update(&dir, |manifest| {
        change(&mut manifest.settings);
        kept = manifest.settings.clone();
    })?;
    Ok(kept)
}

/// Sets the times the deck `file` plays with; returns all it keeps.
pub fn set_timing(file: &Path, timing: Timing) -> Result<DeckSettings> {
    timing.check()?;
    change_deck_settings(file, |settings| settings.timing = Some(timing))
}

/// Sets how the deck `file`'s narration is said; returns all it keeps. Audio made with
/// another delivery is out of date from then on.
pub fn set_delivery(file: &Path, pace: Pace, style: &str) -> Result<DeckSettings> {
    let delivery = Delivery::checked(pace, style)?;
    change_deck_settings(file, |settings| settings.delivery = delivery)
}

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

/// Who says the deck's narration, in which voice and language, as its `<meta>` tags name them
/// (defaults otherwise, also for a voice the provider does not have).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// One of [`super::cloud::PROVIDERS`]' ids.
    pub provider: String,
    pub voice: String,
    pub language: String,
}

impl Settings {
    pub fn of(html: &str) -> Self {
        Self::from_metas(&AppMetas::read(html))
    }

    /// The settings `metas`, a document's app settings read in one pass, name.
    pub fn from_metas(metas: &AppMetas) -> Self {
        let provider = metas
            .narration_provider
            .as_deref()
            .and_then(Provider::parse)
            .unwrap_or(DEFAULT_PROVIDER);
        let voice = metas
            .narration_voice
            .clone()
            .filter(|v| provider.accepts_voice(v))
            .unwrap_or_else(|| provider.default_voice().into());
        let language = metas
            .narration_language
            .clone()
            .filter(|l| language(l).is_some())
            .unwrap_or_else(|| DEFAULT_LANGUAGE.into());
        Settings {
            provider: provider.id().into(),
            voice,
            language,
        }
    }

    /// The provider and language these settings name, which are always known ones.
    pub(super) fn resolved(&self) -> (Provider, &str, &'static Language) {
        (
            Provider::parse(&self.provider).expect("a known provider"),
            &self.voice,
            language(&self.language).expect("a known language"),
        )
    }
}

/// The provider the deck's `<meta>` names; [`DEFAULT_PROVIDER`] without one, or for an
/// unknown one.
pub fn provider_of(html: &str) -> Provider {
    crate::html::narration_provider(html)
        .and_then(|p| Provider::parse(&p))
        .unwrap_or(DEFAULT_PROVIDER)
}

/// Who says the deck `file`'s narration, in which voice and language.
pub(super) fn settings(file: &Path) -> (Provider, String, &'static Language) {
    let html = deck::read_html(file).unwrap_or_default();
    let settings = Settings::of(&html);
    let (provider, voice, language) = settings.resolved();
    (provider, voice.to_string(), language)
}

#[cfg(test)]
mod tests {
    use super::super::cloud;
    use super::super::testing::{deck_with, temp_dir};
    use super::*;

    #[test]
    fn a_deck_keeps_its_times_and_delivery_next_to_its_audio() {
        let dir = temp_dir();
        let file = deck_with(&dir, "deck.html", "", "");
        // Nothing set, nothing kept: the app's times, the plain delivery.
        assert_eq!(deck_settings(&file), DeckSettings::default());
        let timing = Timing {
            seconds_per_slide: 8.0,
            pause_before: 0.0,
            pause_after: 2.0,
        };
        assert_eq!(set_timing(&file, timing).unwrap().timing, Some(timing));
        let kept = set_delivery(&file, Pace::Slower, "  warm\nand   calm ").unwrap();
        assert_eq!(kept.delivery.style, "warm and calm");
        assert_eq!(kept.timing, Some(timing), "the times stay");
        assert_eq!(deck_settings(&file), kept);
        let json = std::fs::read_to_string(audio_dir(&file).join("manifest.json")).unwrap();
        assert!(json.contains(r#""secondsPerSlide": 8.0"#), "{json}");
        assert!(json.contains(r#""pace": "slower""#), "{json}");
        // Times no video could be made with are refused, and a style that is a script.
        let bad = Timing {
            pause_after: 99.0,
            ..timing
        };
        assert!(set_timing(&file, bad).is_err());
        assert!(set_delivery(&file, Pace::Normal, &"x".repeat(MAX_STYLE_CHARS + 1)).is_err());
        assert_eq!(deck_settings(&file), kept);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_manifest_from_before_decks_kept_settings_still_reads() {
        let dir = temp_dir();
        let file = deck_with(&dir, "deck.html", "", "");
        let audio = audio_dir(&file);
        std::fs::create_dir_all(&audio).unwrap();
        std::fs::write(
            audio.join("manifest.json"),
            r#"{"slides":{"a":{"fingerprint":"f","seconds":1.5,"recorded":true}}}"#,
        )
        .unwrap();
        assert_eq!(deck_settings(&file), DeckSettings::default());
        // Setting something keeps what was there, and writes no settings that are the plain ones.
        set_delivery(&file, Pace::Faster, "").unwrap();
        set_delivery(&file, Pace::Normal, "").unwrap();
        let json = std::fs::read_to_string(audio.join("manifest.json")).unwrap();
        assert!(json.contains(r#""recorded": true"#), "{json}");
        assert!(!json.contains("settings"), "{json}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_plain_delivery_leaves_no_mark_and_a_style_only_where_it_is_taken() {
        let plain = Delivery::default();
        assert_eq!(plain.mark(Provider::OpenAi), "");
        let styled = Delivery::checked(Pace::Normal, "warm").unwrap();
        assert_ne!(styled.mark(Provider::OpenAi), "");
        assert_eq!(
            styled.mark(Provider::ElevenLabs),
            "",
            "ElevenLabs takes no style"
        );
        let slow = Delivery::checked(Pace::Slower, "warm").unwrap();
        assert_ne!(slow.mark(Provider::ElevenLabs), "");
        assert_ne!(slow.mark(Provider::OpenAi), styled.mark(Provider::OpenAi));
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
}
