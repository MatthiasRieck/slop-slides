//! Video export: the deck as an AV1 MP4, each shown slide on screen for the same time, with
//! its entrance animations, slide fades and hero morphs playing as the presenter shows them.
//! With narration, each slide's narration (see narration/) is said over it, after a pause,
//! and the slide stays until a pause after it ends: longer than the set time, if need be.
//! The narration timeline can set otherwise: how long a slide shows and when its narration
//! starts, which can then run over into the slides around it ([`Options::timeline`]).
//! Narration without up-to-date audio is said first.
//!
//! A hidden window plays the deck (`?print`, its runtime current, as pdf.rs prints it) and the
//! page's helper (`assets/video.js`) takes over the clock of every animation in it, so each
//! frame is set to its exact moment before it is captured, however long a capture takes. Once
//! a slide has nothing left moving, the rest of its time repeats the last frame instead of
//! capturing more. A hidden page skips view transitions, so the helper plays hero morphs
//! itself, with animations that follow the same clock. Without animations (`?static&print`) each slide is captured once.
//!
//! Frames are encoded on a thread of their own as AV1, a royalty-free codec, with rav1e
//! (written in Rust, so every platform encodes the same way), and written to the MP4 (see
//! mp4.rs) as they come. A frame held on screen is stored once, lasting as long as it shows.
//! The narration is one Opus audio track, royalty-free too, encoded once the frames are.

mod encoder;

use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::sync::{mpsc, oneshot};

use crate::capture::decode_png;
use crate::error::{Error, Result};
use crate::export_window::{self, Helper, Page};
use crate::mp4::AudioTrack;
use crate::narration::{self, Narration};
use crate::{deck, html, pdf, sound};
pub use encoder::VideoWriter;

/// Where the page's helper answers; the navigation is caught, never made.
const SIGNAL_PATH: &str = "/.video-signal";
/// The page's helper, run once it has loaded; it starts by reporting when it is ready.
const VIDEO_JS: &str = include_str!("../../assets/video.js");
/// The frame rates offered; each divides [`TIMESCALE`].
pub const FRAME_RATES: [u32; 3] = [24, 30, 60];
/// The video track's time units per second.
const TIMESCALE: u32 = 90_000;
/// The shortest and longest time a slide may be shown, in seconds.
pub const MIN_SECONDS: f64 = 0.5;
pub const MAX_SECONDS: f64 = 600.0;
/// The longest pause before or after a slide's narration, in seconds.
pub const MAX_PAUSE: f64 = 10.0;
/// The narration's bit rate: clear speech, mono.
const OPUS_BITRATE: i32 = 64_000;
/// The largest video, in pixels: 4K UHD. Larger slides are scaled down to fit.
const MAX_SIZE: (u32, u32) = (3840, 2160);
/// Frames waiting to be encoded; captures stop while the encoder catches up.
const QUEUE: usize = 4;
/// What the hidden window is for, as its errors name it.
const TASK: &str = "recording the video";
/// The error an export the user cancelled ends with.
pub const CANCELLED: &str = "the video export was cancelled";

/// Whether an export is running; only one may at a time.
static RUNNING: AtomicBool = AtomicBool::new(false);
/// Set to stop the running export.
static CANCEL: AtomicBool = AtomicBool::new(false);

/// How the video is made, as the export dialog chose.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    /// How long each slide is shown, in seconds; with narration, at least.
    pub seconds_per_slide: f64,
    /// Frames per second, one of [`FRAME_RATES`].
    pub fps: u32,
    /// Play entrance animations, slide fades and morphs; otherwise each slide is a still.
    pub animate: bool,
    /// Say each slide's narration over it.
    #[serde(default)]
    pub narration: bool,
    /// Silence before and after a slide's narration, in seconds.
    #[serde(default)]
    pub pause_before: f64,
    #[serde(default)]
    pub pause_after: f64,
}

impl Options {
    pub fn check(&self) -> Result<()> {
        if !FRAME_RATES.contains(&self.fps) {
            return Err(Error::msg(format!("unsupported frame rate: {}", self.fps)));
        }
        if !(MIN_SECONDS..=MAX_SECONDS).contains(&self.seconds_per_slide) {
            return Err(Error::msg(format!(
                "each slide must be shown for {MIN_SECONDS} to {MAX_SECONDS} seconds"
            )));
        }
        if !(0.0..=MAX_PAUSE).contains(&self.pause_before)
            || !(0.0..=MAX_PAUSE).contains(&self.pause_after)
        {
            return Err(Error::msg(format!(
                "the pauses around narration must be 0 to {MAX_PAUSE} seconds"
            )));
        }
        Ok(())
    }

    /// How many frames each slide is shown for: at least one.
    pub fn frames_per_slide(&self) -> u32 {
        (self.seconds_per_slide * f64::from(self.fps))
            .round()
            .max(1.0) as u32
    }

    /// How many frames a slide whose narration lasts `narration` seconds is shown for: the
    /// set time, or longer to fit the narration and its pauses.
    pub fn slide_frames(&self, narration: Option<f64>) -> u32 {
        let least = self.frames_per_slide();
        match narration {
            Some(seconds) => {
                let needed = (self.pause_before + seconds + self.pause_after) * f64::from(self.fps);
                least.max(needed.ceil() as u32)
            }
            None => least,
        }
    }

    /// How the video's `slides` play out. A slide shows for its `duration`, or else works out
    /// its length with [`Self::slide_frames`]; its narration starts `narration_start` (or the
    /// pause before) into it. Narration never talks over the narration before it, and the
    /// last slide stays until the last word. src/lib/timeline.ts lays it out the same way.
    pub fn timeline(&self, slides: &[Timing]) -> Timeline {
        let fps = f64::from(self.fps);
        let mut frames = Vec::with_capacity(slides.len());
        let mut starts = Vec::with_capacity(slides.len());
        let mut shown = 0;
        let mut voice = 0.0_f64;
        // Where the slides so far end, unrounded: a pinned length ends its slide on the frame
        // nearest that, so rounding to frames never adds up over slides at any frame rate.
        let mut exact = 0.0_f64;
        for slide in slides {
            let offset = slide.narration_start.unwrap_or(self.pause_before);
            let length = match slide.duration {
                Some(seconds) => {
                    exact += seconds;
                    ((exact * fps).round() as u32).saturating_sub(shown).max(1)
                }
                None => Options {
                    pause_before: offset.max(0.0),
                    ..*self
                }
                .slide_frames(slide.narration),
            };
            if slide.duration.is_none() {
                exact = f64::from(shown + length) / fps;
            }
            let start = slide.narration.map(|seconds| {
                let start = (f64::from(shown) / fps + offset).max(voice);
                voice = start + seconds;
                start
            });
            frames.push(length);
            starts.push(start);
            shown += length;
        }
        if let Some(last) = frames.last_mut() {
            *last += ((voice * fps).ceil() as u32).saturating_sub(shown);
        }
        Timeline { frames, starts }
    }

    /// When frame `n` is shown, in milliseconds of video.
    fn millis(&self, n: u32) -> f64 {
        f64::from(n) * 1000.0 / f64::from(self.fps)
    }
}

/// A shown slide's part in the video's timing.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Timing {
    /// How long its narration lasts, in seconds; None without any.
    pub narration: Option<f64>,
    /// How long the narration timeline shows it, in seconds, when it set that.
    pub duration: Option<f64>,
    /// When its narration starts, in seconds after the slide, when the timeline set that.
    pub narration_start: Option<f64>,
}

/// How a video's slides play out: see [`Options::timeline`].
#[derive(Debug, Clone, PartialEq)]
pub struct Timeline {
    /// How many frames each slide shows for.
    pub frames: Vec<u32>,
    /// When each slide's narration starts in the video, in seconds; None without any.
    pub starts: Vec<Option<f64>>,
}

/// A shown slide as the export gets it: its narration audio, at [`narration::audio::RATE`], and
/// what the narration timeline set for it.
#[derive(Debug, Default)]
struct Cue {
    clip: Option<Vec<f32>>,
    duration: Option<f64>,
    narration_start: Option<f64>,
}

/// What the export is doing.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// Saying narration that has no up-to-date audio; `frame` counts slides.
    Narration,
    /// Recording the frames.
    Video,
}

/// How far the export has got, sent to the frontend after each frame.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Progress {
    pub phase: Phase,
    pub frame: u32,
    pub frames: u32,
}

/// Stops the running export, if any; it ends with [`CANCELLED`].
pub fn cancel() {
    if RUNNING.load(Ordering::SeqCst) {
        CANCEL.store(true, Ordering::SeqCst);
    }
}

/// Lets the next export start when this one ends, however it ends.
struct Running;

impl Running {
    fn start() -> Result<Running> {
        if RUNNING.swap(true, Ordering::SeqCst) {
            return Err(Error::msg("a video is already being exported"));
        }
        CANCEL.store(false, Ordering::SeqCst);
        Ok(Running)
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

/// The video's size for slides `width` × `height`: theirs, scaled down to fit [`MAX_SIZE`],
/// in even pixels, as 4:2:0 chroma needs.
pub fn video_size(width: u32, height: u32) -> (u32, u32) {
    let (w, h) = (f64::from(width.max(1)), f64::from(height.max(1)));
    let scale = (f64::from(MAX_SIZE.0) / w)
        .min(f64::from(MAX_SIZE.1) / h)
        .min(1.0);
    let even = |v: f64| (((v * scale) / 2.0).round() as u32 * 2).max(2);
    (even(w), even(h))
}

/// Records the deck `file` (in the open workspace) to `dest` as an MP4, calling `progress`
/// after each frame. A failed or cancelled export leaves no file behind.
pub async fn export(
    app: &AppHandle,
    file: &Path,
    dest: &Path,
    options: Options,
    progress: impl Fn(Progress),
) -> Result<()> {
    options.check()?;
    let _running = Running::start()?;
    let cues = match options.narration {
        true => narrate(app, file, &progress).await?,
        false => Vec::new(),
    };
    let canvas = html::slide_size(&deck::read_html(file)?).pixels();
    let dest = pdf::absolute_dest(dest)?;
    let query = if options.animate {
        "print"
    } else {
        "static&print"
    };
    let (window, signals) = export_window::open(
        app,
        file,
        canvas,
        Page {
            label: "video-export",
            title: "Video export",
            query,
            script: VIDEO_JS,
            signal: SIGNAL_PATH,
            purpose: "recording",
            out_of_sight: true,
        },
    )?;
    let mut helper = Helper {
        window: &window,
        signals,
        task: TASK,
    };
    let recorded = record(
        &mut helper,
        &dest,
        video_size(canvas.0, canvas.1),
        options,
        &cues,
        progress,
    )
    .await;
    let _ = window.destroy();
    if recorded.is_err() {
        let _ = std::fs::remove_file(&dest);
    }
    recorded
}

/// Says the shown slides' narration that has no up-to-date audio yet, then gives each shown
/// slide's narration audio and timing, in order.
async fn narrate(app: &AppHandle, file: &Path, progress: &impl Fn(Progress)) -> Result<Vec<Cue>> {
    use tauri::Manager;
    let shown: Vec<String> = deck::load(file)?
        .slides
        .into_iter()
        .filter(|s| !s.hidden)
        .map(|s| s.id)
        .collect();
    let home = deck::app_home()?;
    let render = app
        .state::<Narration>()
        .inner()
        .render(&home, file, Some(&shown), |p| {
            progress(Progress {
                phase: Phase::Narration,
                frame: p.done as u32,
                frames: p.total as u32,
            })
        });
    tokio::select! {
        rendered = render => { rendered?; }
        _ = cancelled() => return Err(Error::msg(CANCELLED)),
    }
    let deck = deck::load(file)?;
    let mut ready = narration::ready_audio(file, &deck);
    Ok(deck
        .slides
        .iter()
        .filter(|s| !s.hidden)
        .map(|s| Cue {
            clip: ready.remove(&s.id).map(|(samples, rate)| match rate {
                narration::audio::RATE => samples,
                rate => sound::resample(&samples, rate, narration::audio::RATE),
            }),
            duration: s.duration,
            narration_start: s.narration_start,
        })
        .collect())
}

/// Resolves once the export is cancelled.
async fn cancelled() {
    while !CANCEL.load(Ordering::SeqCst) {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

/// The video's soundtrack, at [`AudioTrack::RATE`], as long as its `frames`: `clips` (at
/// [`narration::audio::RATE`]), each starting at its time in seconds.
pub fn soundtrack(frames: u32, fps: u32, clips: &[(f64, &[f32])]) -> Vec<f32> {
    let rate = f64::from(AudioTrack::RATE);
    let mut out = vec![0.0; (f64::from(frames) / f64::from(fps) * rate).round() as usize];
    for (start, clip) in clips {
        let from = ((start * rate).round() as usize).min(out.len());
        let clip = sound::resample(clip, narration::audio::RATE, AudioTrack::RATE);
        let len = clip.len().min(out.len() - from);
        out[from..from + len].copy_from_slice(&clip[..len]);
    }
    out
}

/// `samples` (mono, at [`AudioTrack::RATE`]) encoded as an Opus track.
pub fn encode_opus(samples: &[f32]) -> Result<AudioTrack> {
    let failed = |e: opus::Error| Error::msg(format!("cannot encode the narration: {e}"));
    let mut encoder = opus::Encoder::new(
        AudioTrack::RATE,
        opus::Channels::Mono,
        opus::Application::Audio,
    )
    .map_err(failed)?;
    encoder
        .set_bitrate(opus::Bitrate::Bits(OPUS_BITRATE))
        .map_err(failed)?;
    let pre_skip = encoder.get_lookahead().map_err(failed)?.clamp(0, 0xffff) as usize;
    // The decoder drops the first `pre_skip` samples; pad the end by as much, so none of the
    // audio is lost, and to whole packets.
    let packet = AudioTrack::PACKET as usize;
    let mut padded = samples.to_vec();
    padded.resize((samples.len() + pre_skip).div_ceil(packet) * packet, 0.0);
    let packets = padded
        .chunks(packet)
        .map(|chunk| encoder.encode_vec_float(chunk, 4000).map_err(failed))
        .collect::<Result<_>>()?;
    Ok(AudioTrack {
        packets,
        pre_skip: pre_skip as u16,
        input_rate: narration::audio::RATE,
        length: samples.len() as u64,
    })
}

/// Plays the deck in the helper's window, frame by frame, into the MP4 at `dest`.
async fn record(
    helper: &mut Helper<'_>,
    dest: &Path,
    size: (u32, u32),
    options: Options,
    cues: &[Cue],
    progress: impl Fn(Progress),
) -> Result<()> {
    let ready = helper.answer("ready").await?;
    export_window::check_view(&ready)?;
    let slides: u32 = ready
        .get("slides")
        .and_then(|n| n.parse().ok())
        .unwrap_or(0);
    if slides == 0 {
        return Err(Error::msg("the deck has no shown slides to export"));
    }
    let (rect, viewport) = export_window::geometry(&ready)?;
    let rect = export_window::inside_whole_points(rect);
    let timings: Vec<Timing> = (0..slides as usize)
        .map(|i| {
            cues.get(i).map_or_else(Timing::default, |cue| Timing {
                narration: cue
                    .clip
                    .as_ref()
                    .map(|c| c.len() as f64 / f64::from(narration::audio::RATE)),
                duration: cue.duration,
                narration_start: cue.narration_start,
            })
        })
        .collect();
    let timeline = options.timeline(&timings);
    let lengths = timeline.frames;
    let frames = lengths.iter().sum();
    let clips: Vec<(f64, &[f32])> = cues
        .iter()
        .zip(&timeline.starts)
        .filter_map(|(cue, start)| Some(((*start)?, cue.clip.as_deref()?)))
        .collect();
    let audio = (!clips.is_empty()).then(|| soundtrack(frames, options.fps, &clips));

    let (jobs, encoded) = spawn_encoder(dest.to_path_buf(), size, options.fps, audio)?;
    let encoder_gone = || Error::msg("the video encoder stopped");
    let played = async {
        let mut first = 0;
        for (slide, per_slide) in lengths.iter().copied().enumerate() {
            if slide > 0 {
                let at = options.millis(first);
                helper
                    .run(&format!("window.__slopVideo.next({at:.3})"), "next")
                    .await?;
            }
            // Each slide starts on a keyframe, so a player can jump straight to it.
            jobs.send(Job::Keyframe).await.map_err(|_| encoder_gone())?;
            let mut settled = false;
            for n in first..first + per_slide {
                if CANCEL.load(Ordering::SeqCst) {
                    return Err(Error::msg(CANCELLED));
                }
                let job = if settled {
                    Job::Repeat
                } else {
                    let at = options.millis(n);
                    let answer = helper
                        .run(&format!("window.__slopVideo.frame({at:.3})"), "frame")
                        .await?;
                    settled = answer.get("busy").map(String::as_str) == Some("0");
                    Job::Png(export_window::capture(helper.window, rect, viewport, size.0).await?)
                };
                jobs.send(job).await.map_err(|_| encoder_gone())?;
                progress(Progress {
                    phase: Phase::Video,
                    frame: n + 1,
                    frames,
                });
            }
            first += per_slide;
        }
        Ok(())
    }
    .await;
    // Closing the queue lets the encoder finish the file (or stop, after a failure).
    drop(jobs);
    let written = encoded.await.map_err(|_| encoder_gone())?;
    played.and(written)
}

/// What the encoder does next.
enum Job {
    /// Encode this captured frame.
    Png(Vec<u8>),
    /// Show the last frame for one more frame.
    Repeat,
    /// Make the next frame a keyframe.
    Keyframe,
}

/// Starts the encoder thread writing `dest`; it ends when the job queue closes, with how the
/// file came out.
fn spawn_encoder(
    dest: PathBuf,
    size: (u32, u32),
    fps: u32,
    audio: Option<Vec<f32>>,
) -> Result<(mpsc::Sender<Job>, oneshot::Receiver<Result<()>>)> {
    let (jobs, mut queue) = mpsc::channel::<Job>(QUEUE);
    let (done, encoded) = oneshot::channel();
    let out = BufWriter::new(File::create(&dest)?);
    std::thread::Builder::new()
        .name("video-encoder".into())
        .spawn(move || {
            let result = (|| {
                let mut video = VideoWriter::new(out, size, fps)?;
                while let Some(job) = queue.blocking_recv() {
                    match job {
                        Job::Png(png) => video.push(&decode_png(&png)?)?,
                        Job::Repeat => video.repeat()?,
                        Job::Keyframe => video.keyframe(),
                    }
                }
                let audio = audio.as_deref().map(encode_opus).transpose()?;
                video.finish(audio.as_ref())
            })();
            let _ = done.send(result);
        })?;
    Ok((jobs, encoded))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(seconds: f64, fps: u32) -> Options {
        Options {
            seconds_per_slide: seconds,
            fps,
            animate: true,
            narration: false,
            pause_before: 0.0,
            pause_after: 0.0,
        }
    }

    #[test]
    fn accepts_the_offered_rates_and_slide_times() {
        assert!(options(5.0, 30).check().is_ok());
        assert!(options(MIN_SECONDS, 24).check().is_ok());
        assert!(options(MAX_SECONDS, 60).check().is_ok());
        assert!(options(5.0, 29).check().is_err());
        assert!(options(0.1, 30).check().is_err());
        assert!(options(601.0, 30).check().is_err());
        assert!(options(f64::NAN, 30).check().is_err());
        for fps in FRAME_RATES {
            assert_eq!(TIMESCALE % fps, 0, "{fps} fps has whole frame durations");
        }
    }

    #[test]
    fn reads_options_from_the_frontend() {
        let parsed: Options =
            serde_json::from_str(r#"{"secondsPerSlide":2.5,"fps":60,"animate":false}"#).unwrap();
        assert_eq!(
            parsed,
            Options {
                seconds_per_slide: 2.5,
                fps: 60,
                animate: false,
                narration: false,
                pause_before: 0.0,
                pause_after: 0.0,
            }
        );
        let narrated: Options = serde_json::from_str(
            r#"{"secondsPerSlide":3,"fps":30,"animate":true,"narration":true,"pauseBefore":0.5,"pauseAfter":1}"#,
        )
        .unwrap();
        assert!(narrated.narration);
        assert_eq!((narrated.pause_before, narrated.pause_after), (0.5, 1.0));
    }

    #[test]
    fn each_slide_gets_its_share_of_frames() {
        assert_eq!(options(5.0, 30).frames_per_slide(), 150);
        assert_eq!(options(2.5, 24).frames_per_slide(), 60);
        assert_eq!(options(0.5, 60).frames_per_slide(), 30);
        assert_eq!(options(1.0 / 70.0, 60).frames_per_slide(), 1);
        assert_eq!(options(1.0, 30).millis(15), 500.0);
        assert!((options(1.0, 24).millis(1) - 41.667).abs() < 0.001);
    }

    #[test]
    fn pauses_around_narration_are_checked() {
        let mut o = options(5.0, 30);
        o.pause_before = 0.5;
        o.pause_after = MAX_PAUSE;
        assert!(o.check().is_ok());
        o.pause_after = MAX_PAUSE + 0.1;
        assert!(o.check().is_err());
        o.pause_after = 1.0;
        o.pause_before = -0.1;
        assert!(o.check().is_err());
        o.pause_before = f64::NAN;
        assert!(o.check().is_err());
    }

    #[test]
    fn narrated_slides_stay_until_their_narration_and_pauses_end() {
        let mut o = options(5.0, 30);
        o.pause_before = 0.5;
        o.pause_after = 1.0;
        // The set time is the least a slide is shown.
        assert_eq!(o.slide_frames(None), 150);
        assert_eq!(o.slide_frames(Some(2.0)), 150);
        // 0.5 + 10 + 1 seconds, at 30 fps.
        assert_eq!(o.slide_frames(Some(10.0)), 345);
        // A part of a frame rounds up, so the narration is never cut short.
        assert_eq!(o.slide_frames(Some(10.01)), 346);
    }

    fn spoken(seconds: f64) -> Timing {
        Timing {
            narration: Some(seconds),
            ..Timing::default()
        }
    }

    #[test]
    fn without_a_set_timing_the_timeline_fits_each_slide_to_its_narration() {
        let o = Options {
            pause_before: 0.5,
            pause_after: 1.0,
            narration: true,
            ..options(3.0, 30)
        };
        let t = o.timeline(&[spoken(10.0), Timing::default(), spoken(1.0)]);
        assert_eq!(t.frames, [345, 90, 90]);
        assert_eq!(t.starts, [Some(0.5), None, Some(14.5 + 0.5)]);
    }

    #[test]
    fn a_set_timing_shows_the_slide_for_it_and_lets_narration_run_over() {
        let o = Options {
            pause_before: 0.5,
            narration: true,
            ..options(3.0, 30)
        };
        let t = o.timeline(&[
            // Cut short: its narration goes on over the next slide.
            Timing {
                duration: Some(2.0),
                ..spoken(5.0)
            },
            // Its narration starts before it does, right as the first one ends.
            Timing {
                duration: Some(6.0),
                narration_start: Some(3.5),
                ..spoken(1.0)
            },
        ]);
        assert_eq!(t.frames, [60, 180]);
        assert_eq!(t.starts, [Some(0.5), Some(5.5)]);
    }

    #[test]
    fn narration_waits_for_the_narration_before_it() {
        let o = Options {
            narration: true,
            ..options(1.0, 30)
        };
        let t = o.timeline(&[
            Timing {
                duration: Some(1.0),
                ..spoken(5.0)
            },
            spoken(1.0),
        ]);
        assert_eq!(t.starts, [Some(0.0), Some(5.0)]);
    }

    #[test]
    fn the_last_slide_stays_until_the_last_word() {
        let o = Options {
            narration: true,
            ..options(1.0, 30)
        };
        let t = o.timeline(&[Timing {
            duration: Some(1.0),
            ..spoken(4.0)
        }]);
        assert_eq!(t.frames, [120]);
        assert!(o.timeline(&[]).frames.is_empty());
    }

    #[test]
    fn a_narration_start_replaces_the_pause_when_the_length_is_automatic() {
        let o = Options {
            pause_before: 0.5,
            pause_after: 1.0,
            narration: true,
            ..options(1.0, 30)
        };
        let late = Timing {
            narration_start: Some(2.0),
            ..spoken(1.0)
        };
        let early = Timing {
            narration_start: Some(-1.0),
            ..spoken(1.0)
        };
        assert_eq!(o.timeline(&[late]).frames, [120]);
        // Before the slide starts means the video's start, for the first slide.
        assert_eq!(o.timeline(&[early]).starts, [Some(0.0)]);
    }

    #[test]
    fn pinned_lengths_do_not_drift_by_rounding_to_frames() {
        // Twenty slides of 3.33 s: each rounded alone, 80 frames at 24 fps (3.333 s) would put
        // the last start 0.07 s late; they end on the frames nearest where they should.
        let pinned = Timing {
            duration: Some(3.33),
            ..Timing::default()
        };
        for fps in [24, 30, 60] {
            let o = options(1.0, fps);
            let frames = o.timeline(&[pinned; 20]).frames;
            let mut shown = 0;
            for (i, length) in frames.iter().enumerate() {
                shown += length;
                let should = 3.33 * (i + 1) as f64;
                let off = (f64::from(shown) / f64::from(fps) - should).abs();
                assert!(
                    off <= 0.5 / f64::from(fps) + 1e-9,
                    "{fps} fps, slide {i}: {off} s off"
                );
            }
        }
        // After a slide that follows its narration, pinned slides count from where it ended.
        let o = Options {
            pause_before: 0.5,
            pause_after: 1.0,
            narration: true,
            ..options(1.0, 24)
        };
        let frames = o.timeline(&[spoken(1.01), pinned, pinned]).frames;
        assert_eq!(frames[0], 61);
        assert_eq!(frames[0] + frames[1] + frames[2], 61 + 160);
    }

    #[test]
    fn the_soundtrack_says_each_clip_at_its_time() {
        let rate = narration::audio::RATE as usize;
        let out_rate = AudioTrack::RATE as usize;
        let short = vec![0.5; rate / 2];
        let long = vec![0.25; rate * 2];
        // Three seconds at 30 fps.
        let track = soundtrack(90, 30, &[(0.25, &short), (2.25, &long)]);
        assert_eq!(track.len(), 3 * out_rate, "as long as the video");
        let quarter = out_rate / 4;
        assert!(track[..quarter].iter().all(|s| *s == 0.0), "before it");
        assert!(track[quarter + 10..quarter + out_rate / 2 - 10]
            .iter()
            .all(|s| (*s - 0.5).abs() < 1e-6));
        assert!(track[out_rate..2 * out_rate + quarter]
            .iter()
            .all(|s| *s == 0.0));
        // Past the video's end, it is cut.
        assert!(track[2 * out_rate + quarter + 10..]
            .iter()
            .all(|s| (*s - 0.25).abs() < 1e-6));
        assert!(soundtrack(30, 30, &[(5.0, &short)])
            .iter()
            .all(|s| *s == 0.0));
        assert_eq!(soundtrack(60, 30, &[]), vec![0.0; 2 * out_rate]);
    }

    #[test]
    fn narration_is_encoded_as_opus_that_decodes_to_the_same_length() {
        let rate = AudioTrack::RATE as usize;
        let tone: Vec<f32> = (0..rate)
            .map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin() * 0.3)
            .collect();
        let track = encode_opus(&tone).unwrap();
        assert!(track.pre_skip > 0);
        assert_eq!(track.input_rate, narration::audio::RATE);
        let mut decoder = opus::Decoder::new(AudioTrack::RATE, opus::Channels::Mono).unwrap();
        let mut decoded = Vec::new();
        for packet in &track.packets {
            let mut out = vec![0.0; AudioTrack::PACKET as usize];
            let n = decoder.decode_float(packet, &mut out, false).unwrap();
            decoded.extend_from_slice(&out[..n]);
        }
        let decoded = &decoded[track.pre_skip as usize..];
        assert!(decoded.len() >= tone.len(), "none of the audio is lost");
        assert!(decoded.len() < tone.len() + AudioTrack::PACKET as usize);
        let energy = |s: &[f32]| s.iter().map(|x| x * x).sum::<f32>() / s.len() as f32;
        let (a, b) = (energy(&tone), energy(&decoded[..tone.len()]));
        assert!((a - b).abs() / a < 0.1, "{a} vs {b}");
    }

    #[test]
    fn videos_are_the_slide_size_in_even_pixels_up_to_4k() {
        assert_eq!(video_size(1920, 1080), (1920, 1080));
        assert_eq!(video_size(1080, 1350), (1080, 1350));
        assert_eq!(video_size(1281, 721), (1282, 722));
        assert_eq!(video_size(7680, 4320), (3840, 2160));
        assert_eq!(video_size(1080, 5000), (466, 2160));
        assert_eq!(video_size(0, 0), (2, 2));
    }

    #[test]
    fn the_helper_answers_on_the_signal_path() {
        assert!(VIDEO_JS.contains(&format!("location.origin + \"{SIGNAL_PATH}?\"")));
        assert!(VIDEO_JS.contains("window.__slopVideo.ready();"));
    }

    #[test]
    fn only_one_export_runs_at_a_time() {
        let first = Running::start().unwrap();
        assert!(Running::start().is_err());
        cancel();
        assert!(CANCEL.load(Ordering::SeqCst));
        drop(first);
        let again = Running::start().unwrap();
        assert!(
            !CANCEL.load(Ordering::SeqCst),
            "a new export starts uncancelled"
        );
        drop(again);
        cancel();
        assert!(!CANCEL.load(Ordering::SeqCst), "nothing to cancel");
    }
}
