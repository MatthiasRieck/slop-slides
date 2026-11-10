//! Voice input for the chat composer, the presenter's teleprompter and recording a deck's
//! narration in the presenter view: records the default microphone and transcribes it on this
//! machine with whisper.cpp. The speech-to-text model is downloaded once, on first use, to
//! `~/.slopslides/models/` and shared by every workspace.

mod live;
mod microphone;
mod model;
mod timing;
mod whisper;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use whisper_rs::WhisperContext;

use crate::error::{Error, Result};
use crate::sound;
use live::{Cursor, LiveWorker, Narrating};
use microphone::{microphone_access, silent, Recording, SILENT_MICROPHONE};
use model::{model_path, MODEL};
use timing::transcribe_words;
pub use timing::Word;
use whisper::{advance, Engine, Transcript, WHISPER_RATE};

/// Emitted while the model downloads.
pub const DOWNLOAD_EVENT: &str = "voice-download";
/// Emitted while recording: the input level, 0 to 1.
pub const LEVEL_EVENT: &str = "voice-level";
/// Emitted while recording: everything said so far.
pub const PARTIAL_EVENT: &str = "voice-partial";
/// Emitted while following a speaker: the words of the last few seconds.
pub const HEARD_EVENT: &str = "voice-heard";
/// Emitted when following a speaker fails for good: what went wrong.
pub const FOLLOW_FAILED_EVENT: &str = "voice-follow-failed";
/// Emitted when recording narration goes wrong: what went wrong.
pub const NARRATION_FAILED_EVENT: &str = "narration-record-failed";
/// Emitted when recording kept something of a slide's narration: the deck's id.
pub const NARRATION_KEPT_EVENT: &str = "narration-recorded";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    /// The model is downloaded and voice input can start at once.
    pub model_ready: bool,
    /// The model's download size, to tell the user before downloading it.
    pub model_bytes: u64,
    pub downloading: bool,
    pub recording: bool,
}

/// Voice input state, managed by Tauri: the recording in progress, the loaded model, and
/// whether a download runs.
#[derive(Default)]
pub struct Voice {
    session: Mutex<Option<Session>>,
    /// Loaded on the first transcription and kept: loading takes a moment.
    whisper: Arc<Mutex<Option<Engine>>>,
    /// The model again, set up to find when each word starts (see [`timing::timing_context`]):
    /// loaded on the first timing and kept. Voice input does without, as it costs time.
    timer: Arc<Mutex<Option<WhisperContext>>>,
    downloading: AtomicBool,
}

/// What recording narration keeps of what is said.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecordMode {
    /// The words, added to the narration of the slide on screen.
    Text,
    /// The voice, added to the narration audio of the slide on screen.
    Audio,
}

/// The deck a narration recording goes to, and what it keeps.
pub struct NarrationTarget {
    pub deck: String,
    pub file: PathBuf,
    pub mode: RecordMode,
}

/// What a session is for.
enum Purpose {
    Dictation,
    /// The teleprompter in this window.
    Following(String),
    /// Recording narration in this window, starting at this slide.
    Narrating(String, NarrationTarget, String),
}

/// A recording and its live transcription.
struct Session {
    /// Label of the window using this session, which goes with it; dictation has none.
    follower: Option<String>,
    /// Set while recording narration.
    narrating: Option<Narrating>,
    recording: Recording,
    transcript: Arc<Mutex<Transcript>>,
    live: Arc<AtomicBool>,
    live_thread: JoinHandle<()>,
}

impl Voice {
    pub fn status(&self, home: &Path) -> VoiceStatus {
        VoiceStatus {
            model_ready: model_path(home).is_file(),
            model_bytes: MODEL.bytes,
            downloading: self.downloading.load(Ordering::SeqCst),
            recording: self.session.lock().unwrap().is_some(),
        }
    }

    /// Downloads the model unless it is there, reporting progress as [`DOWNLOAD_EVENT`].
    pub async fn download(&self, app: &AppHandle, home: &Path) -> Result<()> {
        let dest = model_path(home);
        if dest.is_file() {
            return Ok(());
        }
        if self.downloading.swap(true, Ordering::SeqCst) {
            // Another window or click started it: wait for that download instead.
            while self.downloading.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            return match dest.is_file() {
                true => Ok(()),
                false => Err(Error::msg("Downloading the speech model failed.")),
            };
        }
        let result = model::download(app, &MODEL, &dest).await;
        self.downloading.store(false, Ordering::SeqCst);
        result
    }

    /// Starts recording the default microphone (asking for access first, where the system
    /// requires it) and transcribing it live, reported as [`PARTIAL_EVENT`].
    pub async fn start(&self, app: AppHandle, home: &Path) -> Result<()> {
        self.open(app, home, Purpose::Dictation).await
    }

    /// Starts listening for the teleprompter in `window`: until cancelled, reports the words of
    /// the last few seconds as [`HEARD_EVENT`]. Nothing is kept.
    pub async fn follow(&self, app: AppHandle, home: &Path, window: String) -> Result<()> {
        self.open(app, home, Purpose::Following(window)).await
    }

    /// Starts recording narration for `window` at `slide`: what is said goes to the slide on
    /// screen (see [`Voice::narrate_slide`]), piece by piece, as `target` says. Cut off on the
    /// way out of the slide or at a pause, each piece is kept even if the session then just
    /// ends: this is the one recording that is not thrown away by cancelling it.
    pub async fn record_narration(
        &self,
        app: AppHandle,
        home: &Path,
        window: String,
        target: NarrationTarget,
        slide: String,
    ) -> Result<()> {
        self.open(app, home, Purpose::Narrating(window, target, slide))
            .await
    }

    /// Tells the narration recording which slide is on screen now.
    pub fn narrate_slide(&self, slide: &str) {
        let session = self.session.lock().unwrap();
        let Some(session) = session.as_ref() else {
            return;
        };
        let Some(narrating) = &session.narrating else {
            return;
        };
        let mut samples = session.recording.samples.lock().unwrap();
        let take = narrating
            .cursor
            .lock()
            .unwrap()
            .turn_to(slide, &mut samples);
        if let Some(take) = take {
            let _ = narrating.takes.send(take);
        }
    }

    /// Ends the narration recording, if there is one, once all of it is kept.
    pub async fn stop_narration(&self) -> Result<()> {
        let session = {
            let mut session = self.session.lock().unwrap();
            match session.as_ref().is_some_and(|s| s.narrating.is_some()) {
                true => session.take(),
                false => None,
            }
        };
        let Some(session) = session else {
            return Ok(());
        };
        tauri::async_runtime::spawn_blocking(move || {
            let _ = wrap_up(session).join();
        })
        .await
        .map_err(|e| Error::msg(e.to_string()))
    }

    async fn open(&self, app: AppHandle, home: &Path, purpose: Purpose) -> Result<()> {
        tauri::async_runtime::spawn_blocking(microphone_access)
            .await
            .map_err(|e| Error::msg(e.to_string()))??;
        let mut session = self.session.lock().unwrap();
        if session.is_some() {
            return Err(Error::msg("Already recording."));
        }
        let recording = Recording::start(app.clone())?;
        let transcript = Arc::new(Mutex::new(Transcript::default()));
        let live = Arc::new(AtomicBool::new(true));
        let worker = LiveWorker {
            app,
            whisper: self.whisper.clone(),
            model: model_path(home),
            samples: recording.samples.clone(),
            rate: recording.rate,
            transcript: transcript.clone(),
            live: live.clone(),
        };
        let (follower, narrating, live_thread) = match purpose {
            Purpose::Dictation => (None, None, std::thread::spawn(move || worker.run())),
            Purpose::Following(window) => (
                Some(window),
                None,
                std::thread::spawn(move || worker.follow()),
            ),
            Purpose::Narrating(window, target, slide) => {
                let cursor = Arc::new(Mutex::new(Cursor { slide, visit: 0 }));
                let (takes, incoming) = mpsc::channel();
                let narrating = Narrating {
                    cursor: cursor.clone(),
                    takes,
                };
                let thread = std::thread::spawn(move || worker.narrate(incoming, cursor, target));
                (Some(window), Some(narrating), thread)
            }
        };
        *session = Some(Session {
            follower,
            narrating,
            recording,
            transcript,
            live,
            live_thread,
        });
        Ok(())
    }

    /// Stops recording; returns all that was said.
    pub async fn stop(&self, home: &Path) -> Result<String> {
        let session = self.session.lock().unwrap().take();
        let session = session.ok_or_else(|| Error::msg("Not recording."))?;
        session.live.store(false, Ordering::SeqCst);
        let (samples, rate) = session.recording.finish();
        if silent(&samples) {
            return Err(Error::msg(SILENT_MICROPHONE));
        }
        let audio = sound::resample(&samples, rate, WHISPER_RATE);
        let (whisper, model) = (self.whisper.clone(), model_path(home));
        tauri::async_runtime::spawn_blocking(move || {
            // The live transcription finishes its pass first; what it committed is kept.
            let _ = session.live_thread.join();
            advance(
                &whisper,
                &model,
                &audio,
                &mut session.transcript.lock().unwrap(),
            )
        })
        .await
        .map_err(|e| Error::msg(e.to_string()))?
    }

    /// Stops recording and throws it away; a narration recording is kept (see
    /// [`Voice::record_narration`]).
    pub fn cancel(&self) {
        if let Some(session) = self.session.lock().unwrap().take() {
            wrap_up(session);
        }
    }

    /// Stops listening for `window`, which closed: a window that is gone cannot ask, and the
    /// microphone must not stay on.
    pub fn window_closed(&self, window: &str) {
        let session = self.session.lock().unwrap();
        if session.as_ref().and_then(|s| s.follower.as_deref()) == Some(window) {
            drop(session);
            self.cancel();
        }
    }

    /// Ends any recording and frees the model; called as the app exits. ggml aborts the process
    /// when its Metal device is torn down while a model still holds buffers on it.
    pub fn shutdown(&self) {
        let session = self
            .session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(session) = session {
            let _ = wrap_up(session).join();
        }
        // Waits for a transcription still running. Both models hold Metal buffers, which ggml
        // aborts the process over when the device is torn down while they are still loaded.
        self.whisper
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        self.timer.lock().unwrap_or_else(|e| e.into_inner()).take();
    }
}

/// Ends a session: the microphone goes off, and the last of a narration recording goes to the
/// worker keeping it. Returns the worker's thread, which is done once it has kept all of it.
fn wrap_up(session: Session) -> JoinHandle<()> {
    session.live.store(false, Ordering::SeqCst);
    let (samples, _) = session.recording.finish();
    if let Some(narrating) = session.narrating {
        let take = narrating.cursor.lock().unwrap().take(samples);
        let _ = narrating.takes.send(take);
    }
    session.live_thread
}

impl Voice {
    /// Every word said in `samples` (mono, at `rate`) and when, in `language` (an ISO 639-1
    /// code) or whatever language it is in for None: what timing a slide to its narration
    /// goes by.
    pub async fn time_words(
        &self,
        home: &Path,
        samples: Vec<f32>,
        rate: u32,
        language: Option<String>,
    ) -> Result<Vec<Word>> {
        let (timer, model) = (self.timer.clone(), model_path(home));
        tauri::async_runtime::spawn_blocking(move || {
            let audio = sound::resample(&samples, rate, WHISPER_RATE);
            transcribe_words(&timer, &model, &audio, language.as_deref())
        })
        .await
        .map_err(|e| Error::msg(e.to_string()))?
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::test_support::TempDir;
    use live::Take;

    #[test]
    fn shutdown_without_a_recording_or_model_does_nothing() {
        let voice = Voice::default();
        voice.shutdown();
        assert!(voice.whisper.lock().unwrap().is_none());
        assert!(!voice.status(&TempDir::new("voice")).recording);
    }

    #[test]
    fn shutdown_frees_a_loaded_model() {
        let home = crate::files::app_home().unwrap();
        let model = model_path(&home);
        if !model.is_file() {
            return; // the model is not downloaded on this machine
        }
        let voice = Voice::default();
        whisper::load(&mut voice.whisper.lock().unwrap(), &model).unwrap();
        voice.shutdown();
        assert!(voice.whisper.lock().unwrap().is_none());
    }

    #[test]
    fn shutdown_frees_the_word_timing_model_too() {
        let home = crate::files::app_home().unwrap();
        let model = model_path(&home);
        if !model.is_file() {
            return; // the model is not downloaded on this machine
        }
        let voice = Voice::default();
        *voice.timer.lock().unwrap() = Some(timing::timing_context(&model).unwrap());
        assert!(voice.timer.lock().unwrap().is_some());
        voice.shutdown();
        assert!(voice.timer.lock().unwrap().is_none());
    }

    #[test]
    fn status_reports_whether_the_model_is_downloaded() {
        let home = TempDir::new("voice");
        let voice = Voice::default();
        let status = voice.status(&home);
        assert!(!status.model_ready);
        assert!(!status.recording);
        assert_eq!(status.model_bytes, MODEL.bytes);
        fs::create_dir_all(model_path(&home).parent().unwrap()).unwrap();
        fs::write(model_path(&home), b"model").unwrap();
        assert!(voice.status(&home).model_ready);
    }

    #[test]
    fn status_serializes_in_camel_case() {
        let status = Voice::default().status(Path::new("/nonexistent"));
        let json = serde_json::to_value(status).unwrap();
        assert_eq!(json["modelReady"], false);
        assert_eq!(json["modelBytes"], MODEL.bytes);
        assert_eq!(json["downloading"], false);
    }

    /// A session as `open` leaves it, without opening a microphone.
    fn session(follower: Option<&str>) -> Session {
        Session {
            follower: follower.map(String::from),
            narrating: None,
            recording: Recording {
                stop: mpsc::channel().0,
                thread: std::thread::spawn(|| {}),
                samples: Arc::default(),
                rate: WHISPER_RATE,
            },
            transcript: Arc::default(),
            live: Arc::new(AtomicBool::new(true)),
            live_thread: std::thread::spawn(|| {}),
        }
    }

    #[test]
    fn closing_the_following_window_turns_the_microphone_off() {
        let voice = Voice::default();
        *voice.session.lock().unwrap() = Some(session(Some("presenter-1")));
        voice.window_closed("main");
        assert!(voice.session.lock().unwrap().is_some());
        voice.window_closed("presenter-1");
        assert!(voice.session.lock().unwrap().is_none());
    }

    #[test]
    fn closing_a_window_leaves_dictation_alone() {
        let voice = Voice::default();
        *voice.session.lock().unwrap() = Some(session(None));
        voice.window_closed("main");
        assert!(voice.session.lock().unwrap().is_some());
        voice.cancel();
    }

    /// A narration session at slide `a`, with what the microphone delivered so far.
    fn narrating_session(samples: Vec<f32>) -> (Session, mpsc::Receiver<Take>) {
        let (takes, incoming) = mpsc::channel();
        let mut session = session(Some("presenter-1"));
        *session.recording.samples.lock().unwrap() = samples;
        session.narrating = Some(Narrating {
            cursor: Arc::new(Mutex::new(Cursor {
                slide: "a".into(),
                visit: 0,
            })),
            takes,
        });
        (session, incoming)
    }

    #[test]
    fn turning_to_a_slide_cuts_what_was_said_over_the_last_one() {
        let (session, takes) = narrating_session(vec![0.1, 0.2]);
        let voice = Voice::default();
        *voice.session.lock().unwrap() = Some(session);

        voice.narrate_slide("a");
        assert!(takes.try_recv().is_err(), "still on the same slide");

        voice.narrate_slide("b");
        let take = takes.try_recv().unwrap();
        assert_eq!(
            (take.slide.as_str(), take.visit, take.samples),
            ("a", 0, vec![0.1, 0.2])
        );

        // Back to a slide: another visit, so what is said now starts a new paragraph.
        voice.narrate_slide("a");
        let take = takes.try_recv().unwrap();
        assert_eq!((take.slide.as_str(), take.visit), ("b", 1));
        voice.cancel();
        let last = takes.try_recv().unwrap();
        assert_eq!((last.slide.as_str(), last.visit), ("a", 2));
    }

    #[test]
    fn other_sessions_have_no_slides_to_turn_to() {
        let voice = Voice::default();
        voice.narrate_slide("a");
        *voice.session.lock().unwrap() = Some(session(None));
        voice.narrate_slide("a");
        tauri::async_runtime::block_on(voice.stop_narration()).unwrap();
        assert!(voice.session.lock().unwrap().is_some(), "dictation goes on");
        voice.cancel();
    }

    #[test]
    fn closing_the_recording_window_keeps_what_was_said() {
        let (session, takes) = narrating_session(vec![0.1, 0.2]);
        let voice = Voice::default();
        *voice.session.lock().unwrap() = Some(session);
        voice.window_closed("main");
        assert!(voice.session.lock().unwrap().is_some());
        voice.window_closed("presenter-1");
        assert!(voice.session.lock().unwrap().is_none());
        assert_eq!(takes.try_recv().unwrap().samples, vec![0.1, 0.2]);
    }

    #[test]
    fn stopping_keeps_the_last_of_the_recording() {
        let (session, takes) = narrating_session(vec![0.3]);
        let voice = Voice::default();
        *voice.session.lock().unwrap() = Some(session);
        tauri::async_runtime::block_on(voice.stop_narration()).unwrap();
        assert!(voice.session.lock().unwrap().is_none());
        assert_eq!(takes.try_recv().unwrap().samples, vec![0.3]);
    }

    #[test]
    fn the_record_mode_comes_from_the_frontend_in_lower_case() {
        let mode = |json| serde_json::from_str::<RecordMode>(json).unwrap();
        assert_eq!(mode("\"text\""), RecordMode::Text);
        assert_eq!(mode("\"audio\""), RecordMode::Audio);
    }

    /// Prints the words timed in the audio file `SLOP_TIME_PROBE` with the downloaded model:
    /// `SLOP_TIME_PROBE=talk.wav cargo test probe_word_times -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn probe_word_times() {
        let path = std::env::var("SLOP_TIME_PROBE").expect("SLOP_TIME_PROBE");
        let (samples, rate) = crate::narration::audio::decode(Path::new(&path)).unwrap();
        let home = crate::files::app_home().unwrap();
        let voice = Voice::default();
        let words =
            tauri::async_runtime::block_on(voice.time_words(&home, samples, rate, None)).unwrap();
        for w in words {
            println!("{:7.2} {:7.2} {}", w.start, w.end, w.text);
        }
    }

    #[test]
    fn timing_silence_finds_no_words_without_the_model() {
        let voice = Voice::default();
        let quiet = vec![0.0; WHISPER_RATE as usize * 2];
        let words = tauri::async_runtime::block_on(voice.time_words(
            Path::new("/nonexistent"),
            quiet,
            WHISPER_RATE,
            Some("en".into()),
        ));
        assert!(words.unwrap().is_empty());
        let speech: Vec<f32> = (0..WHISPER_RATE * 2)
            .map(|i| (i as f32 / 20.0).sin() * 0.3)
            .collect();
        let missing = tauri::async_runtime::block_on(voice.time_words(
            Path::new("/nonexistent"),
            speech,
            WHISPER_RATE,
            None,
        ));
        assert_eq!(
            missing.unwrap_err().to_string(),
            "The speech model is not downloaded."
        );
    }

    #[test]
    fn stopping_without_a_recording_fails() {
        let voice = Voice::default();
        let err = tauri::async_runtime::block_on(voice.stop(Path::new("/nonexistent")));
        assert_eq!(err.unwrap_err().to_string(), "Not recording.");
        voice.cancel();
    }
}
