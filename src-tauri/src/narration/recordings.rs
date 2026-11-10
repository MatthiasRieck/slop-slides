//! A slide's audio that no service made: the presenter's own recording, which grows take by
//! take, and audio made elsewhere and brought in. Either is the slide's audio whatever its
//! script says, until deleted.

use std::fs;
use std::path::Path;

use super::audio;
use super::manifest::{audio_dir, audio_file, Entry, Manifest};
use crate::error::Result;
use crate::sound;

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
        sound::resample(&kept, kept_rate, audio::RATE)
    } else {
        Vec::new()
    };
    all.extend(sound::resample(samples, rate, audio::RATE));
    audio::replace_wav(&dest, &all, audio::RATE)?;
    Manifest::update(&dir, |manifest| {
        let seconds = all.len() as f64 / f64::from(audio::RATE);
        manifest
            .slides
            .insert(slide.to_string(), Entry::recording(seconds, false));
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
/// says, until deleted; its words are not timed yet (see [`super::time_words`]). Returns how
/// long it plays, in seconds.
pub fn import_audio(file: &Path, slide: &str, source: &Path) -> Result<f64> {
    let (samples, rate) = audio::decode(source)?;
    let samples = sound::resample(&samples, rate, audio::RATE);
    let seconds = samples.len() as f64 / f64::from(audio::RATE);
    let dir = audio_dir(file);
    fs::create_dir_all(&dir)?;
    audio::replace_wav(&audio_file(file, slide), &samples, audio::RATE)?;
    Manifest::update(&dir, |manifest| {
        manifest
            .slides
            .insert(slide.to_string(), Entry::recording(seconds, true));
    })?;
    Ok(seconds)
}

#[cfg(test)]
mod tests {
    use super::super::manifest::fingerprint;
    use super::super::testing::{deck_with, temp_dir};
    use super::super::{ready_audio, statuses, AudioState, Provider};
    use super::*;
    use crate::deck;

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
            let made = fingerprint(Provider::OpenAi, "Say A.", "marin", "en");
            m.slides.insert("a".into(), Entry::made(made, 2.0, None));
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
        assert!(super::super::jobs(&edited, &deck).is_empty());

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
            let made = fingerprint(Provider::OpenAi, "Say A.", "marin", "en");
            m.slides
                .insert("a".into(), Entry::made(made, 1.0, Some(vec![])));
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
}
