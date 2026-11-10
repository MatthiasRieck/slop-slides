//! Where a deck's narration audio lives, and `narration/manifest.json` next to it: what each
//! slide's audio was made from (its fingerprint), how long it is, whether it is the presenter's
//! own, and when its words are said.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::cloud::Provider;
use crate::deck;
use crate::error::{Error, Result};
use crate::voice::Word;

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
        format!(
            "slide-{}",
            &format!("{:x}", Sha256::digest(slide.as_bytes()))[..12]
        )
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
    format!("{:x}", hasher.finalize())
}

pub(super) const MANIFEST: &str = "manifest.json";

/// `narration/manifest.json`: what each slide's audio was made from, and how long it is.
#[derive(Debug, Default, Serialize, Deserialize)]
pub(super) struct Manifest {
    #[serde(default)]
    pub(super) slides: BTreeMap<String, Entry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct Entry {
    /// Empty for a recording, which is made from no script.
    pub(super) fingerprint: String,
    pub(super) seconds: f64,
    /// The presenter's own voice rather than the service's.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(super) recorded: bool,
    /// The audio was made elsewhere and brought in (see [`super::import_audio`]); kept like a
    /// recording, but a recording replaces it rather than going on from its end.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(super) imported: bool,
    /// Every word said in the audio and when, once it was heard again by the speech-to-text
    /// model (see [`super::time_words`]). Made audio is a new entry, without them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) words: Option<Vec<Word>>,
    /// How `words` were timed: [`WORD_TIMING`], or older and less exact ones heard again.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub(super) timing: u32,
}

/// The way [`super::time_words`] times words now: 3 places them by dynamic time warping and
/// gives each a span (see [`crate::voice::Voice::time_words`]); 2 left some a mere moment, and
/// 0 (or none) was Whisper's own timestamps.
pub(super) const WORD_TIMING: u32 = 3;

fn is_zero(n: &u32) -> bool {
    *n == 0
}

impl Entry {
    /// Audio a service made from the script `fingerprint` names, `seconds` long, with when it
    /// said each word if it said so: as good as hearing it again.
    pub(super) fn made(fingerprint: String, seconds: f64, words: Option<Vec<Word>>) -> Entry {
        Entry {
            fingerprint,
            seconds,
            recorded: false,
            imported: false,
            timing: if words.is_some() { WORD_TIMING } else { 0 },
            words,
        }
    }

    /// The presenter's own recording, or audio made elsewhere when `imported`, `seconds` long;
    /// its words are not timed yet.
    pub(super) fn recording(seconds: f64, imported: bool) -> Entry {
        Entry {
            fingerprint: String::new(),
            seconds,
            recorded: true,
            imported,
            words: None,
            timing: 0,
        }
    }

    /// When each word of the audio is said, if timed the way [`super::time_words`] times them
    /// now.
    pub(super) fn timed_words(&self) -> Option<&Vec<Word>> {
        self.words.as_ref().filter(|_| self.timing == WORD_TIMING)
    }
}

/// Held while changing a manifest: a recording and a render may finish slides at the same time.
static MANIFEST_CHANGE: Mutex<()> = Mutex::new(());

impl Manifest {
    /// The manifest in `dir`; an empty one when it is missing or unreadable.
    pub(super) fn read(dir: &Path) -> Self {
        fs::read_to_string(dir.join(MANIFEST))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    /// Changes the manifest in `dir`.
    pub(super) fn update(dir: &Path, change: impl FnOnce(&mut Self)) -> Result<()> {
        let _one_at_a_time = MANIFEST_CHANGE.lock().unwrap_or_else(|e| e.into_inner());
        let mut manifest = Self::read(dir);
        change(&mut manifest);
        manifest.write(dir)
    }

    pub(super) fn write(&self, dir: &Path) -> Result<()> {
        let json = serde_json::to_string_pretty(self).map_err(|e| Error::msg(e.to_string()))?;
        let part = dir.join(format!("{MANIFEST}.part"));
        fs::write(&part, json + "\n")?;
        fs::rename(part, dir.join(MANIFEST))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::temp_dir;
    use super::*;

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
            hasher
                .finalize()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
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
}
