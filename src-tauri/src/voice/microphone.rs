//! Recording the default microphone: asking for access where the system requires it, and the
//! audio stream, mixed down to mono, with its input level reported as it goes.

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SizedSample;
use tauri::{AppHandle, Emitter};

use super::whisper::WHISPER_RATE;
use super::LEVEL_EVENT;
use crate::error::{Error, Result};
use crate::sound;

/// Longest recording kept; anything after it is dropped.
const MAX_SECONDS: usize = 10 * 60;
/// How often the recording reports its input level.
pub(super) const LEVEL_INTERVAL: Duration = Duration::from_millis(60);

/// Whether `samples` are long enough to tell and hold nothing at all: a microphone the system
/// keeps the app from hearing delivers exact zeros, never mere quiet.
pub fn silent(samples: &[f32]) -> bool {
    samples.len() >= WHISPER_RATE as usize / 2 && samples.iter().all(|s| *s == 0.0)
}

pub(super) const SILENT_MICROPHONE: &str =
    "The microphone only delivered silence, which usually means \
SlopSlide may not use it. Allow it in System Settings › Privacy & Security › Microphone (when \
SlopSlide runs from a terminal or an editor, allow that app), then try again.";

#[cfg(target_os = "macos")]
const NO_MICROPHONE_ACCESS: &str = "SlopSlide may not use the microphone. Allow it in System \
Settings › Privacy & Security › Microphone (when SlopSlide runs from a terminal or an editor, \
allow that app), then try again.";

/// Makes sure the app may record the microphone, asking the user if they have not decided.
#[cfg(target_os = "macos")]
pub(super) fn microphone_access() -> Result<()> {
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
pub(super) fn microphone_access() -> Result<()> {
    Ok(())
}

/// A microphone recording. The audio stream lives on its own thread, as it cannot move
/// between threads on every platform.
pub(super) struct Recording {
    pub(super) stop: mpsc::Sender<()>,
    pub(super) thread: JoinHandle<()>,
    pub(super) samples: Arc<Mutex<Vec<f32>>>,
    pub(super) rate: u32,
}

impl Recording {
    pub(super) fn start(app: AppHandle) -> Result<Self> {
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
                let _ = app.emit(
                    LEVEL_EVENT,
                    sound::level(&samples[seen.min(samples.len())..]),
                );
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
    pub(super) fn finish(self) -> (Vec<f32>, u32) {
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
                    buffer.extend(sound::downmix(&samples, channels));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_exact_zeros_count_as_a_silent_microphone() {
        let rate = WHISPER_RATE as usize;
        assert!(silent(&vec![0.0; rate]));
        assert!(!silent(&vec![0.0001; rate]));
        assert!(!silent(&[0.0; 10]));
    }
}
