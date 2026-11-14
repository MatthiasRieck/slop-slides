//! Narration said by a hosted text-to-speech service: ElevenLabs or OpenAI. The deck names
//! which in its `slopslide-narration-provider` meta (see [`crate::html::narration_provider`]);
//! without one it is [`DEFAULT_PROVIDER`].
//!
//! Both are asked for raw 16-bit PCM at [`audio::RATE`], so their audio is kept, played and
//! exported the same way as recordings. ElevenLabs also says when each
//! character is spoken, which becomes the slide's word timing at once (see [`words_of`]).
//!
//! The API keys are the user's, shared by every deck: saved in `~/.slopslides/speech-keys.json`
//! (readable by the user only), or else taken from `ELEVENLABS_API_KEY` / `OPENAI_API_KEY` in
//! the environment. They never go into a deck, and the frontend only learns whether one is set.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::audio;
use super::settings::{Delivery, Pace};
use crate::error::{Error, Result};
use crate::sound;
use crate::voice::Word;

/// Who says a deck's narration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    ElevenLabs,
    OpenAi,
}

/// Every provider, the default first.
pub const PROVIDERS: [Provider; 2] = [Provider::OpenAi, Provider::ElevenLabs];

/// Who says a deck's narration when it names nobody (or someone unknown).
pub const DEFAULT_PROVIDER: Provider = Provider::OpenAi;

impl Provider {
    /// The id the deck names it by.
    pub fn id(self) -> &'static str {
        match self {
            Provider::ElevenLabs => "elevenlabs",
            Provider::OpenAi => "openai",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Provider::ElevenLabs => "ElevenLabs",
            Provider::OpenAi => "OpenAI",
        }
    }

    pub fn parse(id: &str) -> Option<Provider> {
        PROVIDERS.into_iter().find(|p| p.id() == id)
    }

    /// The provider with id `id`; an error naming it when there is none.
    pub fn named(id: &str) -> Result<Provider> {
        Provider::parse(id).ok_or_else(|| Error::msg(format!("unknown narration provider: {id}")))
    }

    /// The hosted model that says it; part of every audio fingerprint.
    pub fn model(self) -> &'static str {
        match self {
            Provider::ElevenLabs => ELEVENLABS_MODEL,
            Provider::OpenAi => OPENAI_MODEL,
        }
    }

    /// The environment variable its key may come from.
    fn key_env(self) -> &'static str {
        match self {
            Provider::ElevenLabs => "ELEVENLABS_API_KEY",
            Provider::OpenAi => "OPENAI_API_KEY",
        }
    }

    /// Its built-in voices, the default first. ElevenLabs has many more (the account's own
    /// too, see [`elevenlabs_voices`]); any of its voice ids will do.
    pub fn voices(self) -> &'static [CloudVoice] {
        match self {
            Provider::ElevenLabs => ELEVENLABS_VOICES,
            Provider::OpenAi => OPENAI_VOICES,
        }
    }

    /// Whether it takes a note on the manner narration is said in (see
    /// [`Delivery::style`]): OpenAI's model follows instructions, ElevenLabs' has none.
    pub fn takes_style(self) -> bool {
        matches!(self, Provider::OpenAi)
    }

    pub fn default_voice(self) -> &'static str {
        self.voices()[0].id
    }

    /// Whether the deck may name `voice` for it.
    pub fn accepts_voice(self, voice: &str) -> bool {
        match self {
            Provider::OpenAi => OPENAI_VOICES.iter().any(|v| v.id == voice),
            Provider::ElevenLabs => is_elevenlabs_voice_id(voice),
        }
    }
}

/// A hosted voice the app knows of.
#[derive(Debug, Clone, Copy)]
pub struct CloudVoice {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
}

const ELEVENLABS_MODEL: &str = "eleven_multilingual_v2";
const OPENAI_MODEL: &str = "gpt-4o-mini-tts";

/// ElevenLabs' premade voices, there for every account.
pub const ELEVENLABS_VOICES: &[CloudVoice] = &[
    CloudVoice {
        id: "JBFqnCBsd6RMkjVDRZzb",
        name: "George",
        description: "Warm British male narrator",
    },
    CloudVoice {
        id: "EXAVITQu4vr4xnSDxMaL",
        name: "Sarah",
        description: "Soft American female voice",
    },
    CloudVoice {
        id: "nPczCjzI2devNBz1zQrb",
        name: "Brian",
        description: "Deep American male voice",
    },
    CloudVoice {
        id: "Xb7hH8MSUJpSbSDYk0k2",
        name: "Alice",
        description: "Confident British female voice",
    },
    CloudVoice {
        id: "onwK4e9ZLuTAKqWW03F9",
        name: "Daniel",
        description: "Authoritative British male voice",
    },
    CloudVoice {
        id: "pFZP5JQG7iQjIQuC4Bku",
        name: "Lily",
        description: "Warm British female voice",
    },
    CloudVoice {
        id: "IKne3meq5aSn9XLyUdCD",
        name: "Charlie",
        description: "Casual Australian male voice",
    },
    CloudVoice {
        id: "XrExE9yKIg1WjnnlVkGX",
        name: "Matilda",
        description: "Friendly American female voice",
    },
];

/// OpenAI's voices for [`OPENAI_MODEL`].
pub const OPENAI_VOICES: &[CloudVoice] = &[
    CloudVoice {
        id: "marin",
        name: "Marin",
        description: "Natural, clear voice",
    },
    CloudVoice {
        id: "cedar",
        name: "Cedar",
        description: "Natural, warm voice",
    },
    CloudVoice {
        id: "alloy",
        name: "Alloy",
        description: "Neutral, balanced voice",
    },
    CloudVoice {
        id: "ash",
        name: "Ash",
        description: "Clear, confident voice",
    },
    CloudVoice {
        id: "ballad",
        name: "Ballad",
        description: "Soft, expressive voice",
    },
    CloudVoice {
        id: "coral",
        name: "Coral",
        description: "Warm, friendly voice",
    },
    CloudVoice {
        id: "echo",
        name: "Echo",
        description: "Calm voice",
    },
    CloudVoice {
        id: "fable",
        name: "Fable",
        description: "Storytelling voice",
    },
    CloudVoice {
        id: "nova",
        name: "Nova",
        description: "Bright, energetic voice",
    },
    CloudVoice {
        id: "onyx",
        name: "Onyx",
        description: "Deep voice",
    },
    CloudVoice {
        id: "sage",
        name: "Sage",
        description: "Calm, thoughtful voice",
    },
    CloudVoice {
        id: "shimmer",
        name: "Shimmer",
        description: "Light, gentle voice",
    },
    CloudVoice {
        id: "verse",
        name: "Verse",
        description: "Versatile, expressive voice",
    },
];

/// The most text OpenAI says in one request.
pub const OPENAI_MAX_CHARS: usize = 4096;
/// The most text ElevenLabs' [`ELEVENLABS_MODEL`] says in one request.
pub const ELEVENLABS_MAX_CHARS: usize = 10_000;

/// ElevenLabs voice ids are letters and digits (premade ones are 20 long).
pub fn is_elevenlabs_voice_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric())
}

const KEYS_FILE: &str = "speech-keys.json";

/// `~/.slopslides/speech-keys.json`.
pub fn keys_file(home: &Path) -> PathBuf {
    home.join(KEYS_FILE)
}

/// Where a provider's key comes from.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KeySource {
    /// Saved in the app (and removable there).
    Saved,
    /// The provider's environment variable.
    Environment,
}

fn read_keys(home: &Path) -> BTreeMap<String, String> {
    fs::read_to_string(keys_file(home))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// The key to call `provider` with, and where it comes from.
pub fn key(home: &Path, provider: Provider) -> Option<(String, KeySource)> {
    let saved = read_keys(home)
        .remove(provider.id())
        .filter(|k| !k.trim().is_empty());
    if let Some(saved) = saved {
        return Some((saved, KeySource::Saved));
    }
    // A key exported in the shell's profile (see [`crate::env`]).
    crate::env::ready();
    let env = std::env::var(provider.key_env()).ok()?;
    let env = env.trim();
    (!env.is_empty()).then(|| (env.to_string(), KeySource::Environment))
}

/// Saves `provider`'s key, or forgets the saved one for None. The file is the user's alone.
pub fn set_key(home: &Path, provider: Provider, key: Option<&str>) -> Result<()> {
    let mut keys = read_keys(home);
    match key.map(str::trim).filter(|k| !k.is_empty()) {
        Some(key) => {
            if key.chars().any(|c| c.is_whitespace() || c.is_control()) {
                return Err(Error::msg("An API key has no spaces in it."));
            }
            keys.insert(provider.id().to_string(), key.to_string());
        }
        None => {
            keys.remove(provider.id());
        }
    }
    fs::create_dir_all(home)?;
    let file = keys_file(home);
    let part = file.with_extension("json.part");
    let json = serde_json::to_string_pretty(&keys).map_err(|e| Error::msg(e.to_string()))?;
    write_private(&part, &(json + "\n"))?;
    fs::rename(part, file)?;
    Ok(())
}

#[cfg(unix)]
fn write_private(path: &Path, text: &str) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(text.as_bytes())?;
    Ok(())
}

#[cfg(not(unix))]
fn write_private(path: &Path, text: &str) -> Result<()> {
    fs::write(path, text)?;
    Ok(())
}

/// A request to a provider, ready to send: kept apart from sending so it can be checked.
#[derive(Debug, PartialEq)]
pub struct Request {
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Value,
}

/// What OpenAI's model is told about how to say narration in the language named `language`:
/// the pace in words, as its model has no speed to set, and the deck's style note after it.
fn openai_instructions(language: &str, delivery: &Delivery) -> String {
    let pace = match delivery.pace {
        Pace::Slower => "Speak slowly and deliberately, with a clear pause between sentences.",
        Pace::Normal => "Keep a natural, steady pace.",
        Pace::Faster => "Speak at a brisk, energetic pace, every word still clear.",
    };
    let mut instructions =
        format!("Speak in {language}, as a clear, engaging presenter narrating a slide. {pace}");
    if !delivery.style.is_empty() {
        instructions.push_str(&format!(
            " Manner: {}.",
            delivery.style.trim_end_matches('.')
        ));
    }
    instructions
}

/// How fast ElevenLabs speaks at `pace`, as its `voice_settings.speed` (1 is the voice's own;
/// it takes 0.7 to 1.2).
fn elevenlabs_speed(pace: Pace) -> f64 {
    match pace {
        Pace::Slower => 0.85,
        Pace::Normal => 1.0,
        Pace::Faster => 1.15,
    }
}

/// How to ask `provider` to say `text` in `voice`, in the language named `language` (English,
/// German…), with `key`, the way `delivery` says.
pub fn request(
    provider: Provider,
    key: &str,
    text: &str,
    voice: &str,
    language: &str,
    delivery: &Delivery,
) -> Result<Request> {
    let too_long = |max: usize| {
        Error::msg(format!(
            "{} says at most {max} characters at a time; this narration has {}. Shorten it or split the slide.",
            provider.name(),
            text.chars().count()
        ))
    };
    match provider {
        Provider::ElevenLabs => {
            // It goes into the URL.
            if !is_elevenlabs_voice_id(voice) {
                return Err(Error::msg(format!(
                    "\"{voice}\" is no ElevenLabs voice id."
                )));
            }
            if text.chars().count() > ELEVENLABS_MAX_CHARS {
                return Err(too_long(ELEVENLABS_MAX_CHARS));
            }
            let mut body = json!({ "text": text, "model_id": ELEVENLABS_MODEL });
            // The voice's own settings stand unless the deck asks for another pace.
            if delivery.pace != Pace::Normal {
                body["voice_settings"] = json!({ "speed": elevenlabs_speed(delivery.pace) });
            }
            Ok(Request {
                url: format!(
                    "https://api.elevenlabs.io/v1/text-to-speech/{voice}/with-timestamps?output_format=pcm_{}",
                    audio::RATE
                ),
                headers: vec![("xi-api-key", key.to_string())],
                body,
            })
        }
        Provider::OpenAi => {
            if text.chars().count() > OPENAI_MAX_CHARS {
                return Err(too_long(OPENAI_MAX_CHARS));
            }
            Ok(Request {
                url: "https://api.openai.com/v1/audio/speech".into(),
                headers: vec![("Authorization", format!("Bearer {key}"))],
                body: json!({
                    "model": OPENAI_MODEL,
                    "voice": voice,
                    "input": text,
                    // Raw 16-bit mono PCM at 24 kHz.
                    "response_format": "pcm",
                    "instructions": openai_instructions(language, delivery),
                }),
            })
        }
    }
}

/// What a provider said: the samples at [`audio::RATE`], and when each word is, if it says.
#[derive(Debug, PartialEq)]
pub struct Said {
    pub samples: Vec<f32>,
    pub words: Option<Vec<Word>>,
}

/// ElevenLabs' `with-timestamps` answer: its audio, and its words from the characters' times.
pub fn parse_elevenlabs(body: &[u8]) -> Result<Said> {
    #[derive(Deserialize)]
    struct Answer {
        audio_base64: String,
        alignment: Option<Alignment>,
    }
    #[derive(Deserialize)]
    struct Alignment {
        characters: Vec<String>,
        character_start_times_seconds: Vec<f64>,
        character_end_times_seconds: Vec<f64>,
    }
    use base64::Engine as _;
    let answer: Answer = serde_json::from_slice(body)
        .map_err(|e| Error::msg(format!("ElevenLabs answered in an unknown way: {e}")))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(answer.audio_base64.trim())
        .map_err(|e| Error::msg(format!("ElevenLabs sent unreadable audio: {e}")))?;
    let words = answer.alignment.map(|a| {
        words_of(
            &a.characters,
            &a.character_start_times_seconds,
            &a.character_end_times_seconds,
        )
    });
    Ok(Said {
        samples: sound::pcm16(&bytes),
        words: words.filter(|w| !w.is_empty()),
    })
}

/// The words in spoken `characters`, each from its first character's start to its last one's
/// end. Runs of punctuation alone (a dash between words) are no word.
pub fn words_of(characters: &[String], starts: &[f64], ends: &[f64]) -> Vec<Word> {
    let mut words = Vec::new();
    let mut current: Option<Word> = None;
    let finish = |current: &mut Option<Word>, words: &mut Vec<Word>| {
        if let Some(word) = current.take() {
            if word.text.chars().any(char::is_alphanumeric) {
                words.push(word);
            }
        }
    };
    let timed = characters.len().min(starts.len()).min(ends.len());
    for i in 0..timed {
        let c = &characters[i];
        if c.chars().all(char::is_whitespace) {
            finish(&mut current, &mut words);
            continue;
        }
        match current.as_mut() {
            Some(word) => {
                word.text.push_str(c);
                word.end = ends[i].max(word.end);
            }
            None => {
                current = Some(Word {
                    text: c.clone(),
                    start: starts[i],
                    end: ends[i],
                })
            }
        }
    }
    finish(&mut current, &mut words);
    words
}

/// The message in a provider's error answer, if it has one.
pub fn error_message(body: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let found = [
        &value["error"]["message"],
        &value["detail"]["message"],
        &value["detail"],
        &value["message"],
    ]
    .into_iter()
    .find_map(|v| v.as_str().map(str::to_string));
    found.filter(|m| !m.trim().is_empty())
}

/// What to tell the user when `provider` answered with `status` and `body`.
pub fn failure(provider: Provider, status: u16, body: &[u8]) -> Error {
    let name = provider.name();
    let detail = error_message(body);
    let message = match status {
        401 | 403 => format!(
            "{name} did not accept the API key{}. Check it in the Narration panel.",
            detail.map(|d| format!(" ({d})")).unwrap_or_default()
        ),
        429 => format!(
            "{name} is limiting requests or the account is out of credit{}. Try again later.",
            detail.map(|d| format!(" ({d})")).unwrap_or_default()
        ),
        _ => format!(
            "{name} could not say the narration (HTTP {status}){}",
            detail.map(|d| format!(": {d}")).unwrap_or_default()
        ),
    };
    Error::msg(message)
}

fn client() -> Result<reqwest::Client> {
    // It reads the proxy to go through from the shell's environment (see [`crate::env`]).
    crate::env::ready();
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| Error::msg(e.to_string()))
}

/// Has `provider` say `text`.
pub async fn say(
    provider: Provider,
    key: &str,
    text: &str,
    voice: &str,
    language: &str,
    delivery: &Delivery,
) -> Result<Said> {
    let request = request(provider, key, text, voice, language, delivery)?;
    let mut call = client()?
        .post(&request.url)
        .header("Content-Type", "application/json")
        .body(request.body.to_string());
    for (name, value) in &request.headers {
        call = call.header(*name, value);
    }
    let unreachable =
        |e: reqwest::Error| Error::msg(format!("Could not reach {}: {e}", provider.name()));
    let response = call.send().await.map_err(unreachable)?;
    let status = response.status();
    let body = response.bytes().await.map_err(unreachable)?;
    if !status.is_success() {
        return Err(failure(provider, status.as_u16(), &body));
    }
    let said = match provider {
        Provider::ElevenLabs => parse_elevenlabs(&body)?,
        _ => Said {
            samples: sound::pcm16(&body),
            words: None,
        },
    };
    if said.samples.is_empty() {
        return Err(Error::msg(format!("{} sent no audio.", provider.name())));
    }
    Ok(said)
}

/// A voice to pick in the Narration panel.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceOption {
    pub id: String,
    pub name: String,
    pub description: String,
}

impl From<&CloudVoice> for VoiceOption {
    fn from(v: &CloudVoice) -> Self {
        VoiceOption {
            id: v.id.into(),
            name: v.name.into(),
            description: v.description.into(),
        }
    }
}

/// The voices of ElevenLabs' `/v1/voices` answer: the premade ones and the account's own.
pub fn parse_elevenlabs_voices(body: &[u8]) -> Result<Vec<VoiceOption>> {
    let value: Value = serde_json::from_slice(body)
        .map_err(|e| Error::msg(format!("ElevenLabs answered in an unknown way: {e}")))?;
    let voices = value["voices"].as_array().cloned().unwrap_or_default();
    Ok(voices
        .iter()
        .filter_map(|v| {
            let id = v["voice_id"]
                .as_str()
                .filter(|id| is_elevenlabs_voice_id(id))?;
            let name = v["name"].as_str().unwrap_or(id);
            let labels = &v["labels"];
            let mut about: Vec<&str> =
                ["descriptive", "description", "gender", "accent", "use_case"]
                    .iter()
                    .filter_map(|k| labels[*k].as_str())
                    .filter(|s| !s.is_empty())
                    .collect();
            about.dedup();
            let mut description = about.join(", ");
            if v["category"].as_str().is_some_and(|c| c != "premade") {
                description = match description.is_empty() {
                    true => "Your voice".into(),
                    false => format!("Your voice, {description}"),
                };
            }
            Some(VoiceOption {
                id: id.into(),
                name: name.into(),
                description,
            })
        })
        .collect())
}

/// Every voice the ElevenLabs account with `key` can use.
pub async fn elevenlabs_voices(key: &str) -> Result<Vec<VoiceOption>> {
    let unreachable = |e: reqwest::Error| Error::msg(format!("Could not reach ElevenLabs: {e}"));
    let response = client()?
        .get("https://api.elevenlabs.io/v1/voices")
        .header("xi-api-key", key)
        .send()
        .await
        .map_err(unreachable)?;
    let status = response.status();
    let body = response.bytes().await.map_err(unreachable)?;
    if !status.is_success() {
        return Err(failure(Provider::ElevenLabs, status.as_u16(), &body));
    }
    parse_elevenlabs_voices(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("slopslide-speech-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn providers_are_named_by_id() {
        for p in PROVIDERS {
            assert_eq!(Provider::parse(p.id()), Some(p));
        }
        assert_eq!(Provider::parse("ElevenLabs"), None);
        assert_eq!(Provider::parse("google"), None);
        assert_eq!(Provider::named("elevenlabs").unwrap(), Provider::ElevenLabs);
        assert_eq!(
            Provider::named("google").unwrap_err().to_string(),
            "unknown narration provider: google"
        );
    }

    #[test]
    fn each_provider_has_its_own_voices() {
        assert_eq!(Provider::OpenAi.default_voice(), "marin");
        assert_eq!(Provider::ElevenLabs.default_voice(), "JBFqnCBsd6RMkjVDRZzb");
        assert!(Provider::OpenAi.accepts_voice("coral"));
        assert!(!Provider::OpenAi.accepts_voice("ryan"));
        // Any ElevenLabs voice id, the account's own too.
        assert!(Provider::ElevenLabs.accepts_voice("21m00Tcm4TlvDq8ikWAM"));
        for bad in [
            "",
            "ryan",
            "has space here",
            "../../etc/passwd",
            "a/b/c/d/e/f",
        ] {
            assert!(!Provider::ElevenLabs.accepts_voice(bad), "{bad}");
        }
        assert!(ELEVENLABS_VOICES
            .iter()
            .all(|v| is_elevenlabs_voice_id(v.id)));
    }

    #[test]
    fn keys_are_saved_for_the_user_alone_and_can_be_forgotten() {
        let home = temp_home();
        assert!(key(&home, Provider::OpenAi).is_none_or(|(_, s)| s == KeySource::Environment));
        set_key(&home, Provider::OpenAi, Some("  sk-test  ")).unwrap();
        assert_eq!(
            key(&home, Provider::OpenAi),
            Some(("sk-test".into(), KeySource::Saved))
        );
        set_key(&home, Provider::ElevenLabs, Some("el-key")).unwrap();
        assert_eq!(key(&home, Provider::OpenAi).unwrap().0, "sk-test");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(keys_file(&home)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        set_key(&home, Provider::OpenAi, None).unwrap();
        assert!(key(&home, Provider::OpenAi).is_none_or(|(_, s)| s == KeySource::Environment));
        assert_eq!(key(&home, Provider::ElevenLabs).unwrap().0, "el-key");
        assert!(set_key(&home, Provider::OpenAi, Some("two words")).is_err());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn elevenlabs_is_asked_for_pcm_with_timestamps() {
        let r = request(
            Provider::ElevenLabs,
            "k",
            "Hello.",
            "JBFqnCBsd6RMkjVDRZzb",
            "German",
            &Delivery::default(),
        )
        .unwrap();
        assert_eq!(
            r.url,
            "https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/with-timestamps?output_format=pcm_24000"
        );
        assert_eq!(r.headers, vec![("xi-api-key", "k".to_string())]);
        assert_eq!(r.body["text"], "Hello.");
        assert_eq!(r.body["model_id"], "eleven_multilingual_v2");
        assert!(
            r.body["voice_settings"].is_null(),
            "the voice's own settings"
        );
    }

    #[test]
    fn the_pace_and_style_go_to_each_service_the_way_it_takes_them() {
        let plain = Delivery::default();
        let slow = Delivery::checked(Pace::Slower, "warm and calm.").unwrap();
        let openai = |delivery: &Delivery| {
            let r = request(Provider::OpenAi, "sk", "Hi.", "coral", "English", delivery).unwrap();
            r.body["instructions"].as_str().unwrap().to_string()
        };
        // The plain delivery asks as it always did, so nothing made before sounds different.
        assert_eq!(
            openai(&plain),
            "Speak in English, as a clear, engaging presenter narrating a slide. Keep a natural, steady pace."
        );
        assert!(openai(&slow).contains("slowly"), "{}", openai(&slow));
        assert!(
            openai(&slow).ends_with("Manner: warm and calm."),
            "{}",
            openai(&slow)
        );
        let fast = Delivery::checked(Pace::Faster, "").unwrap();
        assert!(openai(&fast).contains("brisk"));
        // ElevenLabs has a speed to set, and no note to take.
        let eleven = |delivery: &Delivery| {
            request(
                Provider::ElevenLabs,
                "k",
                "Hi.",
                "JBFqnCBsd6RMkjVDRZzb",
                "English",
                delivery,
            )
            .unwrap()
            .body
        };
        assert_eq!(eleven(&slow)["voice_settings"]["speed"], 0.85);
        assert_eq!(eleven(&fast)["voice_settings"]["speed"], 1.15);
        assert!(!eleven(&slow).to_string().contains("warm"));
        assert!(Provider::OpenAi.takes_style() && !Provider::ElevenLabs.takes_style());
    }

    #[test]
    fn openai_is_asked_for_pcm_in_the_narrations_language() {
        let r = request(
            Provider::OpenAi,
            "sk",
            "Hallo.",
            "coral",
            "German",
            &Delivery::default(),
        )
        .unwrap();
        assert_eq!(r.url, "https://api.openai.com/v1/audio/speech");
        assert_eq!(r.headers, vec![("Authorization", "Bearer sk".to_string())]);
        assert_eq!(r.body["model"], "gpt-4o-mini-tts");
        assert_eq!(r.body["voice"], "coral");
        assert_eq!(r.body["input"], "Hallo.");
        assert_eq!(r.body["response_format"], "pcm");
        assert!(r.body["instructions"].as_str().unwrap().contains("German"));
    }

    #[test]
    fn too_long_a_narration_is_refused_before_sending() {
        let long = "a".repeat(OPENAI_MAX_CHARS + 1);
        let plain = Delivery::default();
        let err = request(Provider::OpenAi, "sk", &long, "coral", "English", &plain).unwrap_err();
        assert!(err.to_string().contains("4096"), "{err}");
        assert!(request(
            Provider::ElevenLabs,
            "k",
            &long,
            "JBFqnCBsd6RMkjVDRZzb",
            "English",
            &plain
        )
        .is_ok());
        assert!(request(
            Provider::ElevenLabs,
            "k",
            "Hi",
            "../voices",
            "English",
            &plain
        )
        .is_err());
    }

    #[test]
    fn character_times_become_words() {
        let chars: Vec<String> = "Hi, all — go!".chars().map(String::from).collect();
        let starts: Vec<f64> = (0..chars.len()).map(|i| i as f64 * 0.1).collect();
        let ends: Vec<f64> = starts.iter().map(|s| s + 0.1).collect();
        let words = words_of(&chars, &starts, &ends);
        let texts: Vec<&str> = words.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(texts, ["Hi,", "all", "go!"]);
        assert_eq!(words[0].start, 0.0);
        assert!((words[0].end - 0.3).abs() < 1e-9);
        assert!((words[1].start - 0.4).abs() < 1e-9);
        assert!(words_of(&[], &[], &[]).is_empty());
        // Missing times cut it short rather than failing.
        assert_eq!(words_of(&chars, &starts[..2], &ends).len(), 1);
    }

    #[test]
    fn elevenlabs_answers_carry_audio_and_word_times() {
        use base64::Engine as _;
        let audio = base64::engine::general_purpose::STANDARD.encode([0x00, 0x40, 0x00, 0xc0]);
        let body = json!({
            "audio_base64": audio,
            "alignment": {
                "characters": ["H", "i", " ", "y", "o", "u"],
                "character_start_times_seconds": [0.0, 0.1, 0.2, 0.3, 0.4, 0.5],
                "character_end_times_seconds": [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]
            },
            "normalized_alignment": null
        });
        let said = parse_elevenlabs(body.to_string().as_bytes()).unwrap();
        assert_eq!(said.samples, vec![0.5, -0.5]);
        let words = said.words.unwrap();
        assert_eq!(words.len(), 2);
        assert_eq!(words[1].text, "you");
        assert_eq!(words[1].start, 0.3);
        let bare = json!({ "audio_base64": audio });
        assert_eq!(
            parse_elevenlabs(bare.to_string().as_bytes()).unwrap().words,
            None
        );
        assert!(parse_elevenlabs(b"<html>").is_err());
        assert!(parse_elevenlabs(br#"{"audio_base64":"!!"}"#).is_err());
    }

    #[test]
    fn failures_say_what_went_wrong() {
        let openai = br#"{"error":{"message":"Incorrect API key provided"}}"#;
        let err = failure(Provider::OpenAi, 401, openai).to_string();
        assert!(err.contains("OpenAI did not accept the API key"), "{err}");
        assert!(err.contains("Incorrect API key"), "{err}");
        let eleven = br#"{"detail":{"status":"quota_exceeded","message":"Out of credits"}}"#;
        let err = failure(Provider::ElevenLabs, 429, eleven).to_string();
        assert!(
            err.contains("out of credit") && err.contains("Out of credits"),
            "{err}"
        );
        let err = failure(Provider::ElevenLabs, 500, b"oops").to_string();
        assert!(err.contains("HTTP 500"), "{err}");
        assert_eq!(
            error_message(br#"{"detail":"Not found"}"#).as_deref(),
            Some("Not found")
        );
    }

    #[test]
    fn elevenlabs_voices_are_listed_with_the_accounts_own_marked() {
        let body = json!({ "voices": [
            { "voice_id": "JBFqnCBsd6RMkjVDRZzb", "name": "George", "category": "premade",
              "labels": { "accent": "british", "gender": "male" } },
            { "voice_id": "abcdefghij1234567890", "name": "Me", "category": "cloned", "labels": {} },
            { "voice_id": "bad id", "name": "Broken" }
        ]});
        let voices = parse_elevenlabs_voices(body.to_string().as_bytes()).unwrap();
        assert_eq!(voices.len(), 2);
        assert_eq!(voices[0].description, "male, british");
        assert_eq!(voices[1].name, "Me");
        assert_eq!(voices[1].description, "Your voice");
        assert!(parse_elevenlabs_voices(b"{}").unwrap().is_empty());
    }
}
