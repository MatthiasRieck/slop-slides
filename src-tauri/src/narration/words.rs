//! When each word of a slide's audio is said: heard again by the speech-to-text model (see
//! [`crate::voice::Voice::time_words`]) and kept in the manifest with the audio it was heard in.

use std::path::Path;

use serde::Serialize;

use super::manifest::{audio_dir, audio_file, Entry, Manifest, WORD_TIMING};
use super::settings::settings;
use super::{audio, statuses, AudioState, SlideAudio};
use crate::deck;
use crate::error::{Error, Result};
use crate::voice::{self, Word};

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
pub fn words(file: &Path, slide: &str) -> Option<Vec<Word>> {
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
fn keep_words(dir: &Path, slide: &str, heard: &Entry, words: Vec<Word>) -> Result<()> {
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

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Mutex;

    use super::super::manifest::{fingerprint, MANIFEST};
    use super::super::testing::{deck_with, temp_dir};
    use super::super::{append_recording, Provider};
    use super::*;

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
        let entry = |text: &str| {
            Entry::made(
                fingerprint(Provider::OpenAi, text, "marin", "en"),
                1.0,
                None,
            )
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
        let said = vec![Word {
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
}
