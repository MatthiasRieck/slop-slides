//! Voice input for the chat composer: records the default microphone and transcribes it on
//! this machine with whisper.cpp. The speech-to-text model is downloaded once, on first use,
//! to `~/.slopslides/models/` and shared by every workspace.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SizedSample;
use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::error::{Error, Result};

/// A speech-to-text model file and where it comes from.
pub struct Model {
    pub file: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
}

/// Whisper small, multilingual, 5-bit quantized: about 190 MB, good on dictation in any of
/// Whisper's languages and fast on a laptop CPU (and the GPU, on macOS). Pinned to a commit
/// so the checksum stays valid.
pub const MODEL: Model = Model {
    file: "ggml-small-q5_1.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small-q5_1.bin",
    sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
    bytes: 190_085_487,
};

/// Whisper's input sample rate.
const WHISPER_RATE: u32 = 16_000;
/// Longest recording kept; anything after it is dropped.
const MAX_SECONDS: usize = 10 * 60;
/// Recordings shorter than this are taken as an accidental click.
const MIN_SECONDS: f32 = 0.3;
/// whisper.cpp wants at least a second of audio; shorter clips are padded with silence.
const PAD_SECONDS: f32 = 1.1;
/// How often the recording reports its input level.
const LEVEL_INTERVAL: Duration = Duration::from_millis(60);
/// How often the live transcript is brought up to date while recording.
const LIVE_INTERVAL: Duration = Duration::from_millis(700);
/// Audio not yet transcribed for good is cut into segments of at most this length, at a pause,
/// so the live transcript does not slow down as the recording grows.
const SEGMENT_SECONDS: f32 = 20.0;
/// Audio quieter than this (root mean square) holds no speech; Whisper would make some up.
const SILENCE_RMS: f32 = 0.002;

/// Emitted while the model downloads.
pub const DOWNLOAD_EVENT: &str = "voice-download";
/// Emitted while recording: the input level, 0 to 1.
pub const LEVEL_EVENT: &str = "voice-level";
/// Emitted while recording: everything said so far.
pub const PARTIAL_EVENT: &str = "voice-partial";

/// `~/.slopslides/models`, where downloaded speech models live.
pub fn models_dir(home: &Path) -> PathBuf {
    home.join("models")
}

pub fn model_path(home: &Path) -> PathBuf {
    models_dir(home).join(MODEL.file)
}

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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    received: u64,
    total: u64,
}

/// Voice input state, managed by Tauri: the recording in progress, the loaded model, and
/// whether a download runs.
#[derive(Default)]
pub struct Voice {
    session: Mutex<Option<Session>>,
    /// Loaded on the first transcription and kept: loading takes a moment.
    whisper: Arc<Mutex<Option<WhisperContext>>>,
    downloading: AtomicBool,
}

/// A recording and its live transcription.
struct Session {
    recording: Recording,
    transcript: Arc<Mutex<Transcript>>,
    live: Arc<AtomicBool>,
    live_thread: JoinHandle<()>,
}

/// The part of a recording transcribed for good: its text and where it ends, in samples at
/// [`WHISPER_RATE`].
#[derive(Default)]
struct Transcript {
    text: String,
    offset: usize,
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
        let result = download(app, &MODEL, &dest).await;
        self.downloading.store(false, Ordering::SeqCst);
        result
    }

    /// Starts recording the default microphone (asking for access first, where the system
    /// requires it) and transcribing it live, reported as [`PARTIAL_EVENT`].
    pub async fn start(&self, app: AppHandle, home: &Path) -> Result<()> {
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
        *session = Some(Session {
            recording,
            transcript,
            live,
            live_thread: std::thread::spawn(move || worker.run()),
        });
        Ok(())
    }

    /// Stops recording; returns all that was said.
    pub async fn stop(&self, home: &Path) -> Result<String> {
        let session = self.session.lock().unwrap().take();
        let session = session.ok_or_else(|| Error::msg("Not recording."))?;
        session.live.store(false, Ordering::SeqCst);
        let (samples, rate) = session.recording.finish();
        if samples.len() >= WHISPER_RATE as usize / 2 && samples.iter().all(|s| *s == 0.0) {
            return Err(Error::msg(SILENT_MICROPHONE));
        }
        let audio = resample(&samples, rate, WHISPER_RATE);
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

    /// Stops recording and throws it away.
    pub fn cancel(&self) {
        if let Some(session) = self.session.lock().unwrap().take() {
            session.live.store(false, Ordering::SeqCst);
            session.recording.finish();
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
            session.live.store(false, Ordering::SeqCst);
            session.recording.finish();
            let _ = session.live_thread.join();
        }
        // Waits for a transcription still running.
        self.whisper
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
    }
}

/// Transcribes a recording while it runs, reporting the text so far.
struct LiveWorker {
    app: AppHandle,
    whisper: Arc<Mutex<Option<WhisperContext>>>,
    model: PathBuf,
    samples: Arc<Mutex<Vec<f32>>>,
    rate: u32,
    transcript: Arc<Mutex<Transcript>>,
    live: Arc<AtomicBool>,
}

impl LiveWorker {
    fn run(self) {
        let mut done = 0;
        loop {
            let mut waited = Duration::ZERO;
            while waited < LIVE_INTERVAL {
                if !self.live.load(Ordering::SeqCst) {
                    return;
                }
                std::thread::sleep(LEVEL_INTERVAL);
                waited += LEVEL_INTERVAL;
            }
            let audio = resample(&self.samples.lock().unwrap(), self.rate, WHISPER_RATE);
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
}

/// The whole text of `audio` (at [`WHISPER_RATE`]): `transcript`'s, extended by segments that
/// end at pauses, and the rest. The segments are added to `transcript` for good.
fn advance(
    whisper: &Mutex<Option<WhisperContext>>,
    model: &Path,
    audio: &[f32],
    transcript: &mut Transcript,
) -> Result<String> {
    let segment = (SEGMENT_SECONDS * WHISPER_RATE as f32) as usize;
    while audio.len().saturating_sub(transcript.offset) > segment {
        let start = transcript.offset;
        let end = start + split_point(&audio[start..start + segment]);
        let text = transcribe(whisper, model, &audio[start..end])?;
        transcript.text = join_text(&transcript.text, &text);
        transcript.offset = end;
    }
    let rest = audio.get(transcript.offset..).unwrap_or_default();
    Ok(join_text(
        &transcript.text,
        &transcribe(whisper, model, rest)?,
    ))
}

/// Where to cut `audio` (at [`WHISPER_RATE`]) to not cut a word: the middle of its quietest
/// tenth of a second within its last quarter.
pub fn split_point(audio: &[f32]) -> usize {
    let window = WHISPER_RATE as usize / 10;
    if audio.len() < window * 2 {
        return audio.len();
    }
    let energy = |at: usize| audio[at..at + window].iter().map(|s| s * s).sum::<f32>();
    let from = audio.len() * 3 / 4;
    (from..=audio.len() - window)
        .step_by(window / 4)
        .min_by(|a, b| energy(*a).total_cmp(&energy(*b)))
        .map_or(audio.len(), |at| at + window / 2)
}

pub fn join_text(a: &str, b: &str) -> String {
    match (a.is_empty(), b.is_empty()) {
        (true, _) => b.to_string(),
        (_, true) => a.to_string(),
        _ => format!("{a} {b}"),
    }
}

const SILENT_MICROPHONE: &str = "The microphone only delivered silence, which usually means \
SlopSlide may not use it. Allow it in System Settings › Privacy & Security › Microphone (when \
SlopSlide runs from a terminal or an editor, allow that app), then try again.";

#[cfg(target_os = "macos")]
const NO_MICROPHONE_ACCESS: &str = "SlopSlide may not use the microphone. Allow it in System \
Settings › Privacy & Security › Microphone (when SlopSlide runs from a terminal or an editor, \
allow that app), then try again.";

/// Makes sure the app may record the microphone, asking the user if they have not decided.
#[cfg(target_os = "macos")]
fn microphone_access() -> Result<()> {
    use objc2::runtime::Bool;
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};

    let denied = || Error::msg(NO_MICROPHONE_ACCESS);
    // SAFETY: a constant AVFoundation exports.
    let Some(audio) = (unsafe { AVMediaTypeAudio }) else {
        return Ok(());
    };
    // SAFETY: plain class methods; the completion handler only sends on a channel.
    match unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio) } {
        AVAuthorizationStatus::Authorized => Ok(()),
        AVAuthorizationStatus::NotDetermined => {
            let (tx, rx) = mpsc::channel();
            let tx = Mutex::new(tx);
            let handler = block2::RcBlock::new(move |granted: Bool| {
                let _ = tx.lock().unwrap().send(granted.as_bool());
            });
            unsafe {
                AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &handler)
            };
            match rx.recv() {
                Ok(true) => Ok(()),
                _ => Err(denied()),
            }
        }
        _ => Err(denied()),
    }
}

#[cfg(not(target_os = "macos"))]
fn microphone_access() -> Result<()> {
    Ok(())
}

/// A microphone recording. The audio stream lives on its own thread, as it cannot move
/// between threads on every platform.
struct Recording {
    stop: mpsc::Sender<()>,
    thread: JoinHandle<()>,
    samples: Arc<Mutex<Vec<f32>>>,
    rate: u32,
}

impl Recording {
    fn start(app: AppHandle) -> Result<Self> {
        let samples = Arc::new(Mutex::new(Vec::new()));
        let (stop, stopped) = mpsc::channel();
        let (ready, started) = mpsc::channel();
        let buffer = samples.clone();
        let thread = std::thread::spawn(move || {
            let stream = match open_input(buffer.clone()) {
                Ok((stream, rate)) => {
                    let _ = ready.send(Ok(rate));
                    stream
                }
                Err(e) => {
                    let _ = ready.send(Err(e));
                    return;
                }
            };
            let mut seen = 0;
            while let Err(mpsc::RecvTimeoutError::Timeout) = stopped.recv_timeout(LEVEL_INTERVAL) {
                let samples = buffer.lock().unwrap();
                let _ = app.emit(LEVEL_EVENT, level(&samples[seen.min(samples.len())..]));
                seen = samples.len();
            }
            drop(stream);
        });
        let rate = started
            .recv()
            .map_err(|_| Error::msg("The microphone could not be opened."))??;
        Ok(Recording {
            stop,
            thread,
            samples,
            rate,
        })
    }

    /// Ends the recording: its mono samples and their sample rate.
    fn finish(self) -> (Vec<f32>, u32) {
        let _ = self.stop.send(());
        let _ = self.thread.join();
        let samples = std::mem::take(&mut *self.samples.lock().unwrap());
        (samples, self.rate)
    }
}

/// Opens and starts the default input device, appending its audio, mixed down to mono, to
/// `buffer`. Returns the stream and its sample rate.
fn open_input(buffer: Arc<Mutex<Vec<f32>>>) -> Result<(cpal::Stream, u32)> {
    let device = cpal::default_host()
        .default_input_device()
        .ok_or_else(|| Error::msg("No microphone found."))?;
    let supported = device.default_input_config().map_err(mic_error)?;
    let config = supported.config();
    let (channels, rate) = (config.channels as usize, config.sample_rate);
    let max = MAX_SECONDS * rate as usize;
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => build::<f32>(&device, &config, buffer, channels, max),
        cpal::SampleFormat::I16 => build::<i16>(&device, &config, buffer, channels, max),
        cpal::SampleFormat::I32 => build::<i32>(&device, &config, buffer, channels, max),
        cpal::SampleFormat::U16 => build::<u16>(&device, &config, buffer, channels, max),
        cpal::SampleFormat::U8 => build::<u8>(&device, &config, buffer, channels, max),
        format => {
            return Err(Error::msg(format!(
                "Unsupported microphone format {format}."
            )))
        }
    }?;
    stream.play().map_err(mic_error)?;
    Ok((stream, rate))
}

fn build<T: SizedSample>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    buffer: Arc<Mutex<Vec<f32>>>,
    channels: usize,
    max: usize,
) -> Result<cpal::Stream>
where
    f32: cpal::FromSample<T>,
{
    device
        .build_input_stream(
            *config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                let mut buffer = buffer.lock().unwrap();
                if buffer.len() < max {
                    let samples: Vec<f32> = data.iter().map(|s| s.to_sample::<f32>()).collect();
                    buffer.extend(downmix(&samples, channels));
                }
            },
            |e| log::warn!("microphone: {e}"),
            None,
        )
        .map_err(mic_error)
}

fn mic_error(e: impl std::fmt::Display) -> Error {
    Error::msg(format!("The microphone could not be opened: {e}"))
}

/// Interleaved frames of `channels` channels, averaged to one.
pub fn downmix(samples: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return samples.to_vec();
    }
    samples
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect()
}

/// `samples` at `from` Hz resampled to `to` Hz, averaging the input under each output sample
/// when downsampling so higher frequencies do not fold back into speech.
pub fn resample(samples: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || samples.is_empty() {
        return samples.to_vec();
    }
    let step = from as f64 / to as f64;
    let len = (samples.len() as f64 / step).floor() as usize;
    (0..len)
        .map(|i| {
            let start = i as f64 * step;
            if step > 1.0 {
                let (a, b) = (start as usize, ((start + step) as usize).min(samples.len()));
                let window = &samples[a..b.max(a + 1)];
                window.iter().sum::<f32>() / window.len() as f32
            } else {
                let (a, t) = (start as usize, (start.fract()) as f32);
                let next = samples.get(a + 1).copied().unwrap_or(samples[a]);
                samples[a] + (next - samples[a]) * t
            }
        })
        .collect()
}

/// Root mean square of `samples`, scaled so normal speech fills most of 0 to 1.
pub fn level(samples: &[f32]) -> f32 {
    (rms(samples) * 4.0).min(1.0)
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

/// What is said in `audio` (at [`WHISPER_RATE`]); nothing for silence or a click.
fn transcribe(
    whisper: &Mutex<Option<WhisperContext>>,
    model: &Path,
    audio: &[f32],
) -> Result<String> {
    if (audio.len() as f32) < MIN_SECONDS * WHISPER_RATE as f32 || rms(audio) < SILENCE_RMS {
        return Ok(String::new());
    }
    let mut loaded = whisper.lock().unwrap();
    let context = load(&mut loaded, model)?;
    let mut audio = audio.to_vec();
    let min = (PAD_SECONDS * WHISPER_RATE as f32) as usize;
    if audio.len() < min {
        audio.resize(min, 0.0);
    }
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("auto"));
    params.set_n_threads(threads());
    params.set_no_timestamps(true);
    params.set_suppress_blank(true);
    params.set_suppress_nst(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    let mut state = context.create_state().map_err(whisper_error)?;
    state.full(params, &audio).map_err(whisper_error)?;
    let text: Vec<String> = state
        .as_iter()
        .filter_map(|segment| segment.to_str_lossy().ok().map(|s| s.into_owned()))
        .collect();
    Ok(clean_transcript(&text.join(" ")))
}

/// The loaded model, loading it first if needed.
fn load<'a>(loaded: &'a mut Option<WhisperContext>, model: &Path) -> Result<&'a WhisperContext> {
    if loaded.is_none() {
        if !model.is_file() {
            return Err(Error::msg("The speech model is not downloaded."));
        }
        whisper_rs::install_logging_hooks();
        let context = WhisperContext::new_with_params(model, WhisperContextParameters::default())
            .map_err(whisper_error)?;
        *loaded = Some(context);
    }
    Ok(loaded.as_ref().expect("loaded above"))
}

fn whisper_error(e: whisper_rs::WhisperError) -> Error {
    Error::msg(format!("Transcription failed: {e}"))
}

fn threads() -> i32 {
    std::thread::available_parallelism().map_or(4, |n| n.get().min(8) as i32)
}

/// Whisper's text without its non-speech annotations (`[BLANK_AUDIO]`, `(music)`, …) and
/// with the spacing tidied up.
pub fn clean_transcript(text: &str) -> String {
    let mut out = String::new();
    let mut depth = 0;
    let mut close = ' ';
    for c in text.chars() {
        match c {
            '[' | '(' if depth == 0 => {
                depth = 1;
                close = if c == '[' { ']' } else { ')' };
            }
            c if depth > 0 && c == close => depth = 0,
            _ if depth > 0 => {}
            c => out.push(c),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

async fn download(app: &AppHandle, model: &Model, dest: &Path) -> Result<()> {
    let dir = dest.parent().expect("model path has a folder");
    fs::create_dir_all(dir)?;
    let part = dest.with_extension("part");
    let result = fetch(app, model, &part).await;
    if result.is_err() {
        let _ = fs::remove_file(&part);
    }
    let hash = result?;
    finish_download(&part, dest, &hash, model.sha256)
}

/// Streams the model to `part`; returns its SHA-256, hex.
async fn fetch(app: &AppHandle, model: &Model, part: &Path) -> Result<String> {
    let failed =
        |e: reqwest::Error| Error::msg(format!("Downloading the speech model failed: {e}"));
    let response = reqwest::get(model.url)
        .await
        .and_then(|r| r.error_for_status())
        .map_err(failed)?;
    let total = response.content_length().unwrap_or(model.bytes);
    let mut file = fs::File::create(part)?;
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    let mut reported = 0u64;
    let mut body = response.bytes_stream();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(failed)?;
        file.write_all(&chunk)?;
        hasher.update(&chunk);
        received += chunk.len() as u64;
        // About every half percent, so the progress bar moves without flooding the frontend.
        if received - reported >= total / 200 || received == total {
            reported = received;
            let _ = app.emit(DOWNLOAD_EVENT, DownloadProgress { received, total });
        }
    }
    file.sync_all()?;
    Ok(hex(&hasher.finalize()))
}

/// Moves a finished download into place if its checksum matches; otherwise deletes it.
pub fn finish_download(part: &Path, dest: &Path, hash: &str, expected: &str) -> Result<()> {
    if !hash.eq_ignore_ascii_case(expected) {
        let _ = fs::remove_file(part);
        return Err(Error::msg(
            "The downloaded speech model is damaged (checksum mismatch). Try again.",
        ));
    }
    fs::rename(part, dest)?;
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("slopslide-voice-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn shutdown_without_a_recording_or_model_does_nothing() {
        let voice = Voice::default();
        voice.shutdown();
        assert!(voice.whisper.lock().unwrap().is_none());
        assert!(!voice.status(&temp_dir()).recording);
    }

    #[test]
    fn shutdown_frees_a_loaded_model() {
        let home = crate::deck::app_home().unwrap();
        let model = model_path(&home);
        if !model.is_file() {
            return; // the model is not downloaded on this machine
        }
        let voice = Voice::default();
        load(&mut voice.whisper.lock().unwrap(), &model).unwrap();
        voice.shutdown();
        assert!(voice.whisper.lock().unwrap().is_none());
    }

    #[test]
    fn the_model_lives_in_the_app_home_models_folder() {
        let home = Path::new("/home/me/.slopslides");
        assert_eq!(
            model_path(home),
            Path::new("/home/me/.slopslides/models/ggml-small-q5_1.bin")
        );
    }

    #[test]
    fn the_model_url_is_pinned_to_a_commit_and_names_the_file() {
        assert!(MODEL.url.starts_with("https://"));
        assert!(MODEL.url.ends_with(MODEL.file));
        assert!(!MODEL.url.contains("/resolve/main/"));
        assert_eq!(MODEL.sha256.len(), 64);
    }

    #[test]
    fn status_reports_whether_the_model_is_downloaded() {
        let home = temp_dir();
        let voice = Voice::default();
        let status = voice.status(&home);
        assert!(!status.model_ready);
        assert!(!status.recording);
        assert_eq!(status.model_bytes, MODEL.bytes);
        fs::create_dir_all(models_dir(&home)).unwrap();
        fs::write(model_path(&home), b"model").unwrap();
        assert!(voice.status(&home).model_ready);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn status_serializes_in_camel_case() {
        let status = Voice::default().status(Path::new("/nonexistent"));
        let json = serde_json::to_value(status).unwrap();
        assert_eq!(json["modelReady"], false);
        assert_eq!(json["modelBytes"], MODEL.bytes);
        assert_eq!(json["downloading"], false);
    }

    #[test]
    fn a_download_with_the_right_checksum_moves_into_place() {
        let dir = temp_dir();
        let (part, dest) = (dir.join("m.part"), dir.join("m.bin"));
        fs::write(&part, b"hello").unwrap();
        let hash = hex(&Sha256::digest(b"hello"));
        finish_download(&part, &dest, &hash, &hash.to_uppercase()).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"hello");
        assert!(!part.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_damaged_download_is_deleted() {
        let dir = temp_dir();
        let (part, dest) = (dir.join("m.part"), dir.join("m.bin"));
        fs::write(&part, b"hello").unwrap();
        let err = finish_download(&part, &dest, "abc", MODEL.sha256).unwrap_err();
        assert!(err.to_string().contains("checksum"));
        assert!(!part.exists());
        assert!(!dest.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn hashes_as_lowercase_hex() {
        assert_eq!(
            hex(&Sha256::digest(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn downmix_averages_the_channels_of_each_frame() {
        assert_eq!(downmix(&[0.2, 0.4, -1.0, 1.0], 2), vec![0.3, 0.0]);
        assert_eq!(downmix(&[0.1, 0.2], 1), vec![0.1, 0.2]);
    }

    #[test]
    fn resampling_keeps_the_duration() {
        let second = vec![0.5; 48_000];
        let out = resample(&second, 48_000, 16_000);
        assert_eq!(out.len(), 16_000);
        assert!(out.iter().all(|s| (s - 0.5).abs() < 1e-6));
        assert_eq!(resample(&vec![0.0; 8_000], 8_000, 16_000).len(), 16_000);
        assert_eq!(resample(&[0.1, 0.2], 16_000, 16_000), vec![0.1, 0.2]);
        assert!(resample(&[], 44_100, 16_000).is_empty());
    }

    #[test]
    fn downsampling_averages_away_high_frequencies() {
        // A tone at the input's Nyquist frequency cannot be represented at 16 kHz.
        let tone: Vec<f32> = (0..48_000)
            .map(|i| if i % 2 == 0 { 1.0 } else { -1.0 })
            .collect();
        let out = resample(&tone, 48_000, 16_000);
        let rms = (out.iter().map(|s| s * s).sum::<f32>() / out.len() as f32).sqrt();
        assert!(rms < 0.5, "rms {rms}");
    }

    #[test]
    fn upsampling_interpolates_between_samples() {
        assert_eq!(
            resample(&[0.0, 1.0], 8_000, 16_000),
            vec![0.0, 0.5, 1.0, 1.0]
        );
    }

    #[test]
    fn level_is_silent_for_silence_and_capped_for_loud_input() {
        assert_eq!(level(&[]), 0.0);
        assert_eq!(level(&[0.0; 100]), 0.0);
        assert_eq!(level(&[1.0; 100]), 1.0);
        assert!(level(&[0.1; 100]) > 0.3);
    }

    #[test]
    fn transcripts_lose_non_speech_annotations() {
        assert_eq!(clean_transcript("[BLANK_AUDIO]"), "");
        assert_eq!(
            clean_transcript(" Make the title bigger. (keyboard clicking)  And blue. "),
            "Make the title bigger. And blue."
        );
        assert_eq!(clean_transcript("Hallo [Musik] Welt"), "Hallo Welt");
    }

    #[test]
    fn loading_a_missing_model_fails_without_caching_anything() {
        let mut loaded = None;
        let err = load(&mut loaded, Path::new("/nonexistent/model.bin")).unwrap_err();
        assert_eq!(err.to_string(), "The speech model is not downloaded.");
        assert!(loaded.is_none());
    }

    #[test]
    fn silence_is_not_transcribed_so_whisper_cannot_make_words_up() {
        // The model is missing: running Whisper would fail.
        let (whisper, model) = (Mutex::new(None), Path::new("/nonexistent/model.bin"));
        let quiet = vec![0.001; WHISPER_RATE as usize * 3];
        assert_eq!(transcribe(&whisper, model, &quiet).unwrap(), "");
        assert_eq!(transcribe(&whisper, model, &[0.5; 100]).unwrap(), "");
        let speech = vec![0.2; WHISPER_RATE as usize * 3];
        assert!(transcribe(&whisper, model, &speech).is_err());
    }

    #[test]
    fn long_recordings_are_committed_in_segments_ending_at_pauses() {
        let (whisper, model) = (Mutex::new(None), Path::new("/nonexistent/model.bin"));
        let rate = WHISPER_RATE as usize;
        // 45 s of near silence (below the speech threshold), slightly louder except for pauses.
        let mut audio = vec![0.0015; rate * 45];
        for pause in [rate * 18, rate * 37] {
            audio[pause..pause + rate / 5].fill(0.0);
        }
        let mut transcript = Transcript::default();
        assert_eq!(
            advance(&whisper, model, &audio, &mut transcript).unwrap(),
            ""
        );
        // Cut in the first pause, then the second, leaving the rest pending.
        let first = rate * 18;
        assert!(
            transcript.offset > first + rate * 19,
            "offset {}",
            transcript.offset
        );
        assert!(transcript.offset < rate * 37 + rate / 5);
        assert!(audio.len() - transcript.offset <= rate * 20);
    }

    #[test]
    fn segments_end_in_the_quietest_moment_near_their_end() {
        let rate = WHISPER_RATE as usize;
        let mut audio = vec![0.3; rate * 20];
        audio[rate * 17..rate * 17 + rate / 5].fill(0.0);
        let cut = split_point(&audio);
        assert!(
            (rate * 17..rate * 17 + rate / 5).contains(&cut),
            "cut {cut}"
        );
        // A pause early on is ignored: the segment should stay long.
        let mut early = vec![0.3; rate * 20];
        early[rate..rate * 2].fill(0.0);
        assert!(split_point(&early) >= rate * 15);
        assert_eq!(split_point(&[0.1; 100]), 100);
    }

    #[test]
    fn joins_transcript_parts_with_a_space() {
        assert_eq!(join_text("", "Hello"), "Hello");
        assert_eq!(join_text("Hello", ""), "Hello");
        assert_eq!(join_text("Hello", "world"), "Hello world");
    }

    #[test]
    fn stopping_without_a_recording_fails() {
        let voice = Voice::default();
        let err = tauri::async_runtime::block_on(voice.stop(Path::new("/nonexistent")));
        assert_eq!(err.unwrap_err().to_string(), "Not recording.");
        voice.cancel();
    }
}
