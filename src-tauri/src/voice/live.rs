//! What runs while a recording does: the live transcript of dictation, the teleprompter
//! following the speaker, and narration recordings cut into takes, one per slide visit, each
//! kept as it is cut.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use super::microphone::{silent, LEVEL_INTERVAL, SILENT_MICROPHONE};
use super::whisper::{
    advance, may_hold_speech, split_point, transcribe, transcribe_latest, Engine, Transcript,
    FOLLOW_SECONDS, SEGMENT_SECONDS, WHISPER_RATE,
};
use super::{
    NarrationTarget, RecordMode, FOLLOW_FAILED_EVENT, HEARD_EVENT, NARRATION_FAILED_EVENT,
    NARRATION_KEPT_EVENT, PARTIAL_EVENT,
};
use crate::error::Result;
use crate::{deck, narration, sound};

/// How often the live transcript is brought up to date while recording.
const LIVE_INTERVAL: Duration = Duration::from_millis(700);
/// How long the teleprompter rests between passes, which leaves the machine time for the show.
const FOLLOW_INTERVAL: Duration = Duration::from_millis(120);

/// The slide a narration recording is at. Each time the show comes to a slide is a new visit,
/// though it may be a slide it has been to before.
pub(super) struct Cursor {
    pub(super) slide: String,
    pub(super) visit: u32,
}

/// A piece of a narration recording, all of it said over one slide.
#[derive(Debug)]
pub(super) struct Take {
    pub(super) slide: String,
    pub(super) visit: u32,
    pub(super) samples: Vec<f32>,
}

impl Cursor {
    pub(super) fn take(&self, samples: Vec<f32>) -> Take {
        Take {
            slide: self.slide.clone(),
            visit: self.visit,
            samples,
        }
    }

    /// Moves on to `slide`: what was recorded so far is the take of the slide being left.
    pub(super) fn turn_to(&mut self, slide: &str, samples: &mut Vec<f32>) -> Option<Take> {
        if self.slide == slide {
            return None;
        }
        let take = self.take(std::mem::take(samples));
        self.slide = slide.to_string();
        self.visit += 1;
        Some(take)
    }

    /// A take of the start of `samples` (at `rate`), cut at a pause, once they are long enough:
    /// what is said over a slide lands in the deck as it goes, and no more of it than this can
    /// be lost.
    fn cut_long(&self, samples: &mut Vec<f32>, rate: u32) -> Option<Take> {
        let segment = (SEGMENT_SECONDS * rate as f32) as usize;
        if samples.len() <= segment {
            return None;
        }
        let end = split_point(&samples[..segment], rate);
        Some(self.take(samples.drain(..end).collect()))
    }
}

/// A narration recording's way of handing what it recorded to the worker keeping it.
pub(super) struct Narrating {
    pub(super) cursor: Arc<Mutex<Cursor>>,
    pub(super) takes: mpsc::Sender<Take>,
}

/// Transcribes a recording while it runs, reporting the text so far.
pub(super) struct LiveWorker {
    pub(super) app: AppHandle,
    pub(super) whisper: Arc<Mutex<Option<Engine>>>,
    pub(super) model: PathBuf,
    pub(super) samples: Arc<Mutex<Vec<f32>>>,
    pub(super) rate: u32,
    pub(super) transcript: Arc<Mutex<Transcript>>,
    pub(super) live: Arc<AtomicBool>,
}

impl LiveWorker {
    pub(super) fn run(self) {
        let mut done = 0;
        while next_pass(&self.live, LIVE_INTERVAL) {
            let audio = sound::resample(&self.samples.lock().unwrap(), self.rate, WHISPER_RATE);
            // Wait for at least a quarter second of new audio.
            if audio.len() < done + WHISPER_RATE as usize / 4 {
                continue;
            }
            done = audio.len();
            let mut transcript = self.transcript.lock().unwrap();
            match advance(&self.whisper, &self.model, &audio, &mut transcript) {
                Ok(text) if self.live.load(Ordering::SeqCst) => {
                    let _ = self.app.emit(PARTIAL_EVENT, text);
                }
                Ok(_) => return,
                Err(e) => {
                    log::warn!("live transcription: {e}");
                    return;
                }
            }
        }
    }

    /// Keeps each take of a narration recording in turn, until the recording is over and the
    /// last take is kept. The takes are cut where they are recorded, so the time this takes
    /// does not change which slide anything was said over.
    pub(super) fn narrate(
        self,
        takes: mpsc::Receiver<Take>,
        cursor: Arc<Mutex<Cursor>>,
        target: NarrationTarget,
    ) {
        let mut visit = None;
        loop {
            let take = match takes.recv_timeout(LIVE_INTERVAL) {
                Ok(take) => take,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let mut samples = self.samples.lock().unwrap();
                    let long = cursor.lock().unwrap().cut_long(&mut samples, self.rate);
                    match long {
                        Some(take) => take,
                        None => continue,
                    }
                }
            };
            if silent(&take.samples) {
                let _ = self.app.emit(NARRATION_FAILED_EVENT, SILENT_MICROPHONE);
                continue;
            }
            let goes_on = visit == Some(take.visit);
            let kept = keep_take(&target, &take, self.rate, goes_on, |audio| {
                transcribe(&self.whisper, &self.model, audio)
            });
            match kept {
                Ok(true) => {
                    visit = Some(take.visit);
                    let _ = self.app.emit(NARRATION_KEPT_EVENT, &target.deck);
                }
                Ok(false) => {}
                Err(e) => {
                    let _ = self.app.emit(NARRATION_FAILED_EVENT, e.to_string());
                }
            }
        }
    }

    /// Reports what was said in the last few seconds, over and over, keeping no more audio than
    /// that: whatever transcribing takes, the next pass starts from the present.
    pub(super) fn follow(self) {
        self.follow_speaker();
        if let Some(engine) = self.whisper.lock().unwrap().as_mut() {
            engine.following = None;
        }
    }

    fn follow_speaker(&self) {
        let keep = FOLLOW_SECONDS * self.rate as usize;
        while next_pass(&self.live, FOLLOW_INTERVAL) {
            let (full, audio) = {
                let mut samples = self.samples.lock().unwrap();
                keep_latest(&mut samples, keep);
                let audio = sound::resample(&samples, self.rate, WHISPER_RATE);
                (samples.len() == keep && silent(&samples), audio)
            };
            if full {
                let _ = self.app.emit(FOLLOW_FAILED_EVENT, SILENT_MICROPHONE);
                return;
            }
            match transcribe_latest(&self.whisper, &self.model, &audio) {
                Ok(text) if !text.is_empty() && self.live.load(Ordering::SeqCst) => {
                    let _ = self.app.emit(HEARD_EVENT, text);
                }
                Ok(_) => {}
                Err(e) => {
                    let _ = self.app.emit(FOLLOW_FAILED_EVENT, e.to_string());
                    return;
                }
            }
        }
    }
}

/// Adds `take` (at `rate`) to its slide, the way `target` says; `goes_on` when it continues the
/// last one kept. Returns whether anything was kept: not silence, and nothing of a locked slide.
fn keep_take(
    target: &NarrationTarget,
    take: &Take,
    rate: u32,
    goes_on: bool,
    transcribe: impl FnOnce(&[f32]) -> Result<String>,
) -> Result<bool> {
    let audio = sound::resample(&take.samples, rate, WHISPER_RATE);
    if !may_hold_speech(&audio) || deck::slide_locked(&target.file, &take.slide)? {
        return Ok(false);
    }
    match target.mode {
        RecordMode::Text => {
            let text = transcribe(&audio)?;
            if text.is_empty() {
                return Ok(false);
            }
            deck::append_slide_narration(&target.file, &take.slide, &text, !goes_on)?;
        }
        RecordMode::Audio => {
            narration::append_recording(&target.file, &take.slide, &take.samples, rate)?
        }
    }
    Ok(true)
}

/// Waits `interval` for the next pass; false once the session is over.
fn next_pass(live: &AtomicBool, interval: Duration) -> bool {
    let mut waited = Duration::ZERO;
    while waited < interval {
        if !live.load(Ordering::SeqCst) {
            return false;
        }
        std::thread::sleep(LEVEL_INTERVAL);
        waited += LEVEL_INTERVAL;
    }
    true
}

/// Drops all but the last `keep` of `samples`.
pub fn keep_latest(samples: &mut Vec<f32>, keep: usize) {
    samples.drain(..samples.len().saturating_sub(keep));
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use super::*;
    use crate::error::Error;
    use crate::test_support::TempDir;

    #[test]
    fn a_pass_comes_after_the_interval_unless_the_session_ended() {
        let started = std::time::Instant::now();
        assert!(next_pass(&AtomicBool::new(true), FOLLOW_INTERVAL));
        assert!(started.elapsed() >= FOLLOW_INTERVAL);
        assert!(!next_pass(&AtomicBool::new(false), Duration::from_secs(60)));
    }

    #[test]
    fn following_keeps_only_the_latest_audio() {
        let mut samples = vec![0.1, 0.2, 0.3, 0.4];
        keep_latest(&mut samples, 3);
        assert_eq!(samples, vec![0.2, 0.3, 0.4]);
        keep_latest(&mut samples, 5);
        assert_eq!(samples, vec![0.2, 0.3, 0.4]);
    }

    #[test]
    fn long_takes_are_cut_at_a_pause_and_the_rest_stays() {
        let rate = 48_000;
        let cursor = Cursor {
            slide: "a".into(),
            visit: 3,
        };
        let mut short = vec![0.3; rate * 10];
        assert!(cursor.cut_long(&mut short, rate as u32).is_none());
        assert_eq!(short.len(), rate * 10);

        let mut samples = vec![0.3; rate * 25];
        samples[rate * 17..rate * 17 + rate / 5].fill(0.0);
        let take = cursor.cut_long(&mut samples, rate as u32).unwrap();
        assert_eq!((take.slide.as_str(), take.visit), ("a", 3));
        assert!(
            (rate * 17..rate * 17 + rate / 5).contains(&take.samples.len()),
            "cut at {}",
            take.samples.len()
        );
        assert_eq!(take.samples.len() + samples.len(), rate * 25);
    }

    fn narrated_deck() -> (TempDir, PathBuf) {
        let dir = TempDir::new("voice");
        let file = dir.join("deck.html");
        fs::write(
            &file,
            r#"<!DOCTYPE html><html><head><title>T</title></head><body><main class="deck"><section class="slide" id="a"><aside class="narration">So,</aside></section><section class="slide" id="b" data-locked><h1>B</h1></section></main></body></html>"#,
        )
        .unwrap();
        (dir, file)
    }

    fn target(file: &Path, mode: RecordMode) -> NarrationTarget {
        NarrationTarget {
            deck: file.to_string_lossy().into_owned(),
            file: file.to_path_buf(),
            mode,
        }
    }

    fn speech(slide: &str) -> Take {
        Take {
            slide: slide.into(),
            visit: 0,
            samples: vec![0.2; WHISPER_RATE as usize],
        }
    }

    fn narration_of(file: &Path, slide: &str) -> String {
        let deck = deck::load(file).unwrap();
        let slide = deck.slides.iter().find(|s| s.id == slide).unwrap();
        slide.narration.clone()
    }

    #[test]
    fn text_goes_on_within_a_visit_and_starts_a_paragraph_on_a_new_one() {
        let (_dir, file) = narrated_deck();
        let target = target(&file, RecordMode::Text);
        let say = |text: &'static str, goes_on: bool| {
            keep_take(&target, &speech("a"), WHISPER_RATE, goes_on, |_| {
                Ok(text.into())
            })
        };
        assert!(say("um this one", true).unwrap());
        assert_eq!(narration_of(&file, "a"), "So, um this one");
        assert!(say("and again", false).unwrap());
        assert_eq!(narration_of(&file, "a"), "So, um this one\n\nand again");
        // Whisper heard nothing.
        assert!(!say("", true).unwrap());
        assert_eq!(narration_of(&file, "a"), "So, um this one\n\nand again");
    }

    #[test]
    fn silence_and_locked_slides_are_not_kept() {
        let (_dir, file) = narrated_deck();
        for mode in [RecordMode::Text, RecordMode::Audio] {
            let target = target(&file, mode);
            let never = |_: &[f32]| panic!("nothing to transcribe");
            let locked = keep_take(&target, &speech("b"), WHISPER_RATE, false, never);
            assert!(!locked.unwrap());
            let mut quiet = speech("a");
            quiet.samples.fill(0.0001);
            assert!(!keep_take(&target, &quiet, WHISPER_RATE, false, never).unwrap());
        }
        assert_eq!(narration_of(&file, "a"), "So,");
        assert!(!narration::audio_dir(&file).exists());
    }

    #[test]
    fn audio_goes_to_the_slides_recording_without_transcribing() {
        let (_dir, file) = narrated_deck();
        let target = target(&file, RecordMode::Audio);
        let never = |_: &[f32]| panic!("audio needs no transcript");
        assert!(keep_take(&target, &speech("a"), WHISPER_RATE, false, never).unwrap());
        let audio = narration::statuses(&file, &deck::load(&file).unwrap());
        assert!(audio[0].recorded);
        assert_eq!(audio[0].seconds, Some(1.0));
        assert_eq!(narration_of(&file, "a"), "So,");
    }

    #[test]
    fn transcribing_a_take_that_fails_says_so() {
        let (_dir, file) = narrated_deck();
        let target = target(&file, RecordMode::Text);
        let result = keep_take(&target, &speech("a"), WHISPER_RATE, false, |_| {
            Err(Error::msg("no model"))
        });
        assert_eq!(result.unwrap_err().to_string(), "no model");
    }
}
