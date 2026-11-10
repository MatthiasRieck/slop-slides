//! Who says a deck's narration, in which voice and language, as its `<meta>` tags name them,
//! and the languages narration can be said in.

use std::path::Path;

use serde::Serialize;

use super::cloud::{Provider, DEFAULT_PROVIDER};
use crate::deck;

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

/// Who says the deck `file`'s narration, in which voice and language.
pub(super) fn settings(file: &Path) -> (Provider, String, &'static Language) {
    let html = deck::read_html(file).unwrap_or_default();
    let settings = Settings::of(&html);
    (
        Provider::parse(&settings.provider).expect("a known provider"),
        settings.voice,
        language(&settings.language).expect("a known language"),
    )
}

#[cfg(test)]
mod tests {
    use super::super::cloud;
    use super::*;

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
