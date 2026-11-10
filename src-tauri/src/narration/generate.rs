//! Saying the narration of some of a deck's slides on request (the agent's
//! generate_narration_audio, src/mcp/narration_tools.rs): which of them are said, and what
//! each one ended up with.

use std::path::Path;

use super::{statuses, AudioState, Narration, SlideAudio};
use crate::deck::{Deck, Slide};
use crate::error::Result;

/// What saying the narration left one slide with.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Outcome {
    /// It is locked: its audio is left as it was.
    Locked,
    /// It keeps audio made elsewhere (see [`super::set_audio`]).
    KeepsImported,
    /// It keeps the presenter's own recording.
    KeepsRecording,
    /// It has no narration script, so nothing to say.
    NoScript,
    /// Its audio was up to date already.
    UpToDate,
    /// Its audio was said now.
    Said,
    /// It has no audio.
    NoAudio,
}

/// A slide asked for, and what it ended up with.
#[derive(Debug, Clone, PartialEq)]
pub struct SlideOutcome {
    pub slide: String,
    pub outcome: Outcome,
    /// How long its audio plays now, in seconds, if it has any.
    pub seconds: Option<f64>,
}

/// Whether `slide` is locked: in the deck, or in the running turn's guard in the workspace's
/// `session` (see [`crate::guard`]), which a turn's edits cannot have undone.
fn locked_in(guarded: &[crate::html::LockedSlide], slide: &Slide) -> bool {
    slide.locked || guarded.iter().any(|l| l.id == slide.id)
}

/// What a slide ended up with, from its audio `was` before saying and `now` after.
fn outcome(locked: bool, was: Option<&SlideAudio>, now: Option<&SlideAudio>) -> Outcome {
    match now {
        _ if locked => Outcome::Locked,
        Some(a) if a.recorded && a.imported => Outcome::KeepsImported,
        Some(a) if a.recorded => Outcome::KeepsRecording,
        Some(a) if a.state == AudioState::None => Outcome::NoScript,
        Some(a) if a.state == AudioState::Ready => {
            if was.is_some_and(|w| w.state == AudioState::Ready) {
                Outcome::UpToDate
            } else {
                Outcome::Said
            }
        }
        _ => Outcome::NoAudio,
    }
}

impl Narration {
    /// Says the narration of the deck `file`'s `asked` slides (every slide for None) that are
    /// not locked (see [`locked_in`]) and whose audio is missing or out of date, with the API
    /// key in `home`. What each slide asked for ended up with, in slide order. It fails only
    /// when saying fails.
    pub async fn say_slides(
        &self,
        home: &Path,
        file: &Path,
        deck: &Deck,
        asked: Option<&[String]>,
        session: Option<&Path>,
    ) -> Result<Vec<SlideOutcome>> {
        let guard = crate::guard::read_guard(file, session);
        let wanted: Vec<&Slide> = deck
            .slides
            .iter()
            .filter(|s| asked.map_or(true, |ids| ids.contains(&s.id)))
            .collect();
        let to_say: Vec<String> = wanted
            .iter()
            .filter(|s| !locked_in(&guard, s))
            .map(|s| s.id.clone())
            .collect();
        let before = statuses(file, deck);
        let after = if to_say.is_empty() {
            before.clone()
        } else {
            self.render(home, file, Some(&to_say), |_| {}).await?
        };
        let state_of = |all: &[SlideAudio], id: &str| all.iter().find(|a| a.slide == id).cloned();
        Ok(wanted
            .iter()
            .map(|slide| {
                let was = state_of(&before, &slide.id);
                let now = state_of(&after, &slide.id);
                SlideOutcome {
                    slide: slide.id.clone(),
                    outcome: outcome(locked_in(&guard, slide), was.as_ref(), now.as_ref()),
                    seconds: now.and_then(|a| a.seconds),
                }
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::narration::recordings::import_audio;
    use crate::narration::Provider;
    use crate::narration::{append_recording, audio, audio_file, fingerprint};
    use crate::test_support::TempDir;

    fn audio_of(state: AudioState, recorded: bool, imported: bool) -> SlideAudio {
        SlideAudio {
            slide: "a".into(),
            state,
            seconds: Some(1.0),
            recorded,
            imported,
            timed: false,
        }
    }

    #[test]
    fn each_slide_ends_up_with_what_its_audio_tells() {
        let ready = audio_of(AudioState::Ready, false, false);
        let missing = audio_of(AudioState::Missing, false, false);
        let recorded = audio_of(AudioState::Ready, true, false);
        let imported = audio_of(AudioState::Ready, true, true);
        let none = audio_of(AudioState::None, false, false);
        // A locked slide is locked, whatever its audio.
        assert_eq!(outcome(true, Some(&missing), Some(&ready)), Outcome::Locked);
        assert_eq!(outcome(true, None, None), Outcome::Locked);
        assert_eq!(
            outcome(false, Some(&imported), Some(&imported)),
            Outcome::KeepsImported
        );
        assert_eq!(
            outcome(false, Some(&recorded), Some(&recorded)),
            Outcome::KeepsRecording
        );
        assert_eq!(outcome(false, Some(&none), Some(&none)), Outcome::NoScript);
        assert_eq!(
            outcome(false, Some(&ready), Some(&ready)),
            Outcome::UpToDate
        );
        // Ready now and not before: said now.
        assert_eq!(outcome(false, Some(&missing), Some(&ready)), Outcome::Said);
        assert_eq!(outcome(false, None, Some(&ready)), Outcome::Said);
        let stale = audio_of(AudioState::Stale, false, false);
        assert_eq!(outcome(false, Some(&stale), Some(&stale)), Outcome::NoAudio);
        assert_eq!(outcome(false, None, None), Outcome::NoAudio);
    }

    /// Says the asked slides of the deck `file`, with no API key in the app home `dir`.
    fn say(
        dir: &Path,
        file: &Path,
        asked: Option<&[String]>,
        session: Option<&Path>,
    ) -> Result<Vec<SlideOutcome>> {
        let deck = crate::deck::load(file).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(Narration::default().say_slides(dir, file, &deck, asked, session))
    }

    #[test]
    fn only_unlocked_slides_without_up_to_date_audio_are_said() {
        let dir = TempDir::new("narration-generate");
        let file = dir.write(
            "deck.html",
            concat!(
                r#"<main class="deck">"#,
                r#"<section class="slide" id="locked" data-locked><aside class="narration">Hi.</aside></section>"#,
                r#"<section class="slide" id="plain"><h1>No script</h1></section>"#,
                r#"<section class="slide" id="own"><aside class="narration">Mine.</aside></section>"#,
                r#"<section class="slide" id="set"></section>"#,
                r#"<section class="slide" id="ready"><aside class="narration">Ready.</aside></section>"#,
                r#"<section class="slide" id="talk"><aside class="narration">Say this.</aside></section>"#,
                r#"</main>"#,
            ),
        );
        append_recording(&file, "own", &[0.1; 8_000], 16_000).unwrap();
        audio::write_wav(&dir.join("set.wav"), &[0.1; 16_000], 16_000).unwrap();
        import_audio(&file, "set", &dir.join("set.wav")).unwrap();
        audio::write_wav(&audio_file(&file, "ready"), &[0.1; 24_000], audio::RATE).unwrap();
        let made = fingerprint(Provider::OpenAi, "Ready.", "marin", "en");
        let manifest = dir.join("narration/manifest.json");
        let mut json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&manifest).unwrap()).unwrap();
        json["slides"]["ready"] = serde_json::json!({"fingerprint": made, "seconds": 1.0});
        std::fs::write(&manifest, json.to_string()).unwrap();

        // Nothing asked for needs saying, so no key is needed.
        let asked: Vec<String> = ["locked", "plain", "own", "set", "ready"]
            .map(String::from)
            .into();
        let found = say(&dir, &file, Some(&asked), None).unwrap();
        let outcomes: Vec<(&str, Outcome, Option<f64>)> = found
            .iter()
            .map(|o| (o.slide.as_str(), o.outcome, o.seconds))
            .collect();
        assert_eq!(
            outcomes,
            [
                ("locked", Outcome::Locked, None),
                ("plain", Outcome::NoScript, None),
                ("own", Outcome::KeepsRecording, Some(0.5)),
                ("set", Outcome::KeepsImported, Some(1.0)),
                ("ready", Outcome::UpToDate, Some(1.0)),
            ]
        );
        assert!(
            !audio_file(&file, "locked").exists(),
            "a locked slide is not said"
        );

        // Every slide: `talk` has a script to say, which needs the key.
        if std::env::var_os("OPENAI_API_KEY").is_none() {
            let err = say(&dir, &file, None, None).unwrap_err().to_string();
            assert!(err.contains("Add your OpenAI API key"), "{err}");
        }
    }

    #[test]
    fn a_slide_locked_in_the_turn_is_not_said() {
        let dir = TempDir::new("narration-generate");
        let session = dir.join("session");
        std::fs::create_dir_all(&session).unwrap();
        let slides = r#"<main class="deck"><section class="slide" id="talk"{}><aside class="narration">Say this.</aside></section></main>"#;
        let file = dir.write("deck.html", slides.replace("{}", " data-locked"));
        crate::guard::guard_locked(&file, &session).unwrap();
        // The turn unlocked it; the guard still holds it locked.
        dir.write("deck.html", slides.replace("{}", ""));
        let asked = ["talk".to_string()];
        let found = say(&dir, &file, Some(&asked), Some(&session)).unwrap();
        assert_eq!(found[0].outcome, Outcome::Locked);
    }
}
