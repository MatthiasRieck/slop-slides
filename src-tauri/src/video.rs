//! Video export: the deck as an AV1 MP4, each shown slide on screen for the same time, with
//! its entrance animations, slide fades and hero morphs playing as the presenter shows them.
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

use std::collections::VecDeque;
use std::fs::File;
use std::io::{BufWriter, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use rav1e::color::{
    ChromaSampling, ColorDescription, ColorPrimaries, MatrixCoefficients, PixelRange,
    TransferCharacteristics,
};
use rav1e::data::{FrameType, Packet, Rational};
use rav1e::prelude::{FrameParameters, FrameTypeOverride};
use rav1e::{Config, Context, EncoderConfig, EncoderStatus};
use serde::{Deserialize, Serialize};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::{mpsc, oneshot};

use crate::capture::{decode_png, Image, Rect, Size};
use crate::error::{Error, Result};
use crate::mp4::Mp4Writer;
use crate::{deck, html, pdf, protocol};

/// Where the page's helper answers; the navigation is caught, never made.
const SIGNAL_PATH: &str = "/.video-signal";
/// The page's helper, run once it has loaded; it starts by reporting when it is ready.
const VIDEO_JS: &str = include_str!("../assets/video.js");
/// The frame rates offered; each divides [`TIMESCALE`].
pub const FRAME_RATES: [u32; 3] = [24, 30, 60];
/// The video track's time units per second.
const TIMESCALE: u32 = 90_000;
/// The shortest and longest time a slide may be shown, in seconds.
pub const MIN_SECONDS: f64 = 0.5;
pub const MAX_SECONDS: f64 = 600.0;
/// The largest video, in pixels: 4K UHD. Larger slides are scaled down to fit.
const MAX_SIZE: (u32, u32) = (3840, 2160);
/// Frames between keyframes besides the one starting each slide, in seconds of video.
const KEYFRAME_SECONDS: u32 = 4;
/// rav1e's speed preset, 0 (best) to 10 (fastest): slides are mostly still, flat colour.
const SPEED: u8 = 10;
/// rav1e's quantizer, 0 (lossless) to 255: low enough to keep small text sharp.
const QUANTIZER: usize = 80;
/// The AV1 OBU type that starts each temporal unit.
const OBU_TEMPORAL_DELIMITER: u8 = 2;
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
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    /// How long each slide is shown, in seconds.
    pub seconds_per_slide: f64,
    /// Frames per second, one of [`FRAME_RATES`].
    pub fps: u32,
    /// Play entrance animations, slide fades and morphs; otherwise each slide is a still.
    pub animate: bool,
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
        Ok(())
    }

    /// How many frames each slide is shown for: at least one.
    pub fn frames_per_slide(&self) -> u32 {
        (self.seconds_per_slide * f64::from(self.fps))
            .round()
            .max(1.0) as u32
    }

    /// When frame `n` is shown, in milliseconds of video.
    fn millis(&self, n: u32) -> f64 {
        f64::from(n) * 1000.0 / f64::from(self.fps)
    }
}

/// How far the export has got, sent to the frontend after each frame.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Progress {
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
    let canvas = html::slide_size(&deck::read_html(file)?).pixels();
    let dest = pdf::absolute_dest(dest)?;
    let query = if options.animate {
        "print"
    } else {
        "static&print"
    };
    let url = protocol::file_url(file, query)
        .parse()
        .map_err(|e| Error::msg(format!("cannot open the deck for recording: {e}")))?;

    let (window_width, window_height) = pdf::window_size(canvas, pdf::screen_area(app));
    let (signal_tx, signals) = mpsc::unbounded_channel::<Url>();
    let label = format!("video-export-{}", uuid::Uuid::new_v4().simple());
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::CustomProtocol(url))
        .title("Video export")
        .inner_size(window_width, window_height)
        .visible(false)
        // No title bar: WebKit would inset the page under it, and captures would be off.
        .decorations(false)
        .focused(false)
        .skip_taskbar(true)
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = webview.eval(VIDEO_JS);
            }
        })
        .on_navigation(move |url| {
            if url.path() != SIGNAL_PATH {
                return true;
            }
            let _ = signal_tx.send(url.clone());
            false
        })
        .build()
        .map_err(|e| Error::msg(format!("cannot open the deck for recording: {e}")))?;

    let mut helper = pdf::Helper {
        window: &window,
        signals,
        task: TASK,
    };
    let recorded = record(
        &mut helper,
        &dest,
        video_size(canvas.0, canvas.1),
        options,
        progress,
    )
    .await;
    let _ = window.destroy();
    if recorded.is_err() {
        let _ = std::fs::remove_file(&dest);
    }
    recorded
}

/// Plays the deck in the helper's window, frame by frame, into the MP4 at `dest`.
async fn record(
    helper: &mut pdf::Helper<'_>,
    dest: &Path,
    size: (u32, u32),
    options: Options,
    progress: impl Fn(Progress),
) -> Result<()> {
    let ready = helper.answer("ready").await?;
    let slides: u32 = ready
        .get("slides")
        .and_then(|n| n.parse().ok())
        .unwrap_or(0);
    if slides == 0 {
        return Err(Error::msg("the deck has no shown slides to export"));
    }
    let (rect, viewport) = pdf::geometry(&ready)?;
    let rect = pdf::inside_whole_points(rect);
    let per_slide = options.frames_per_slide();
    let frames = per_slide.saturating_mul(slides);

    let (jobs, encoded) = spawn_encoder(dest.to_path_buf(), size, options.fps)?;
    let encoder_gone = || Error::msg("the video encoder stopped");
    let played = async {
        for slide in 0..slides {
            let first = slide * per_slide;
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
                    Job::Png(capture(helper.window, rect, viewport, size.0).await?)
                };
                jobs.send(job).await.map_err(|_| encoder_gone())?;
                progress(Progress {
                    frame: n + 1,
                    frames,
                });
            }
        }
        Ok(())
    }
    .await;
    // Closing the queue lets the encoder finish the file (or stop, after a failure).
    drop(jobs);
    let written = encoded.await.map_err(|_| encoder_gone())?;
    played.and(written)
}

/// A PNG of `rect` of the window, `width` pixels wide.
async fn capture(
    window: &WebviewWindow,
    rect: Rect,
    viewport: Size,
    width: u32,
) -> Result<Vec<u8>> {
    #[cfg(target_os = "macos")]
    return crate::capture::render_region(window.as_ref(), rect, viewport, width).await;
    #[cfg(not(target_os = "macos"))]
    return crate::capture::snapshot(window.as_ref(), rect, viewport, width).await;
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
                video.finish()
            })();
            let _ = done.send(result);
        })?;
    Ok((jobs, encoded))
}

/// Encodes frames as AV1 into an MP4, one video track. A frame shown again only lasts longer:
/// each sample's duration is how long its frame stays on screen.
pub struct VideoWriter<W: Write + Seek> {
    encoder: Context<u8>,
    mp4: Mp4Writer<W>,
    width: u32,
    height: u32,
    fps: u32,
    /// How long each frame sent to the encoder is shown, in track time units.
    durations: Vec<u32>,
    /// Whether the next frame must be a keyframe.
    key: bool,
    /// Encoded frames waiting until their duration is known: until a later frame is sent.
    encoded: VecDeque<Packet<u8>>,
}

impl<W: Write + Seek> VideoWriter<W> {
    pub fn new(out: W, (width, height): (u32, u32), fps: u32) -> Result<Self> {
        if width % 2 != 0 || height % 2 != 0 || width == 0 || height == 0 {
            return Err(Error::msg(format!(
                "cannot encode a {width}×{height} video"
            )));
        }
        let config = EncoderConfig {
            width: width as usize,
            height: height as usize,
            time_base: Rational::new(1, u64::from(fps)),
            bit_depth: 8,
            chroma_sampling: ChromaSampling::Cs420,
            pixel_range: PixelRange::Limited,
            color_description: Some(ColorDescription {
                color_primaries: ColorPrimaries::BT709,
                transfer_characteristics: TransferCharacteristics::BT709,
                matrix_coefficients: MatrixCoefficients::BT709,
            }),
            // Frames come out as they go in, with no lookahead to wait for.
            low_latency: true,
            max_key_frame_interval: u64::from(fps * KEYFRAME_SECONDS),
            quantizer: QUANTIZER,
            // Rows and columns of tiles encode in parallel.
            tiles: ((width * height) / (640 * 360)).clamp(1, 16) as usize,
            ..EncoderConfig::with_speed_preset(SPEED)
        };
        let encoder = Config::new()
            .with_encoder_config(config)
            .new_context()
            .map_err(|e| Error::msg(format!("cannot start the video encoder: {e}")))?;
        let mp4 = Mp4Writer::start(
            out,
            (width, height),
            TIMESCALE,
            encoder.container_sequence_header(),
        )?;
        Ok(VideoWriter {
            encoder,
            mp4,
            width,
            height,
            fps,
            durations: Vec::new(),
            key: true,
            encoded: VecDeque::new(),
        })
    }

    /// Adds `image` as the next frame, scaled to the video's size.
    pub fn push(&mut self, image: &Image) -> Result<()> {
        let (w, h) = (self.width as usize, self.height as usize);
        let yuv = to_yuv(image, self.width, self.height);
        let (luma, chroma) = yuv.split_at(w * h);
        let (u, v) = chroma.split_at(w * h / 4);
        let mut frame = self.encoder.new_frame();
        frame.planes[0].copy_from_raw_u8(luma, w, 1);
        frame.planes[1].copy_from_raw_u8(u, w / 2, 1);
        frame.planes[2].copy_from_raw_u8(v, w / 2, 1);
        let params = FrameParameters {
            frame_type_override: if self.key {
                FrameTypeOverride::Key
            } else {
                FrameTypeOverride::No
            },
            ..FrameParameters::default()
        };
        self.key = false;
        self.encoder
            .send_frame((frame, params))
            .map_err(encode_error)?;
        self.durations.push(self.frame_duration());
        self.drain()?;
        // Every frame before this one now has its final duration.
        self.write_ready(self.durations.len() as u64 - 1)
    }

    /// Shows the last frame for one more frame (black before any).
    pub fn repeat(&mut self) -> Result<()> {
        let duration = self.frame_duration();
        match self.durations.last_mut() {
            Some(last) => *last += duration,
            None => self.push(&Image {
                width: 1,
                height: 1,
                rgba: vec![0, 0, 0, 255],
            })?,
        }
        Ok(())
    }

    /// Makes the next frame a keyframe.
    pub fn keyframe(&mut self) {
        self.key = true;
    }

    /// Encodes what is left and writes the MP4's index.
    pub fn finish(mut self) -> Result<()> {
        self.encoder.flush();
        self.drain()?;
        self.write_ready(u64::MAX)?;
        self.mp4.finish()?;
        Ok(())
    }

    /// The track time each frame lasts.
    fn frame_duration(&self) -> u32 {
        TIMESCALE / self.fps
    }

    /// Takes every frame the encoder has finished.
    fn drain(&mut self) -> Result<()> {
        loop {
            match self.encoder.receive_packet() {
                Ok(packet) => self.encoded.push_back(packet),
                Err(EncoderStatus::Encoded) => {}
                Err(EncoderStatus::NeedMoreData | EncoderStatus::LimitReached) => return Ok(()),
                Err(e) => return Err(encode_error(e)),
            }
        }
    }

    /// Writes the encoded frames sent before frame `before`.
    fn write_ready(&mut self, before: u64) -> Result<()> {
        while self
            .encoded
            .front()
            .is_some_and(|p| p.input_frameno < before)
        {
            let packet = self.encoded.pop_front().expect("a packet");
            let duration = self.durations[packet.input_frameno as usize];
            self.mp4.write_sample(
                &without_temporal_delimiters(&packet.data),
                duration,
                packet.frame_type == FrameType::KEY,
            )?;
        }
        Ok(())
    }
}

fn encode_error(e: EncoderStatus) -> Error {
    Error::msg(format!("cannot encode the video: {e}"))
}

/// An AV1 temporal unit without its temporal delimiter OBUs, which MP4 samples leave out.
pub fn without_temporal_delimiters(unit: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(unit.len());
    let mut at = 0;
    while at < unit.len() {
        let header = unit[at];
        let kind = (header >> 3) & 0x0f;
        let extension = usize::from((header >> 2) & 1);
        let has_size = (header >> 1) & 1 == 1;
        let mut end = at + 1 + extension;
        if !has_size {
            // Runs to the end of the unit.
            end = unit.len();
        } else {
            let mut size = 0usize;
            for shift in 0..8 {
                let Some(&byte) = unit.get(end) else {
                    return unit.to_vec();
                };
                end += 1;
                size |= usize::from(byte & 0x7f) << (7 * shift);
                if byte & 0x80 == 0 {
                    break;
                }
            }
            end += size;
        }
        if end > unit.len() {
            return unit.to_vec();
        }
        if kind != OBU_TEMPORAL_DELIMITER {
            out.extend_from_slice(&unit[at..end]);
        }
        at = end;
    }
    out
}

/// `image` as a `width` × `height` (both even) frame of BT.709 video, stretched to that size
/// if it is not already, transparent parts over black.
/// Planes in order: Y, then U and V at half the width and height.
pub fn to_yuv(image: &Image, width: u32, height: u32) -> Vec<u8> {
    let (w, h) = (width as usize, height as usize);
    let sample = sampler(image, width, height);
    let mut yuv = vec![0u8; w * h * 3 / 2];
    let (luma, chroma) = yuv.split_at_mut(w * h);
    let (u_plane, v_plane) = chroma.split_at_mut(w * h / 4);
    for by in 0..h / 2 {
        for bx in 0..w / 2 {
            let mut sum = [0.0f32; 3];
            for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                let (x, y) = (bx * 2 + dx, by * 2 + dy);
                let [r, g, b] = sample(x, y);
                luma[y * w + x] = (16.0 + 219.0 * luma_of(r, g, b)).round() as u8;
                sum[0] += r;
                sum[1] += g;
                sum[2] += b;
            }
            let [r, g, b] = sum.map(|c| c / 4.0);
            let y = luma_of(r, g, b);
            let i = by * (w / 2) + bx;
            u_plane[i] = (128.0 + 224.0 * (b - y) / 1.8556).round().clamp(0.0, 255.0) as u8;
            v_plane[i] = (128.0 + 224.0 * (r - y) / 1.5748).round().clamp(0.0, 255.0) as u8;
        }
    }
    yuv
}

/// BT.709 luma of gamma-encoded `r`, `g`, `b` in 0–1.
fn luma_of(r: f32, g: f32, b: f32) -> f32 {
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

/// The colour at each pixel of `image` stretched to `width` × `height`, in 0–1, over black.
/// The same size reads pixels as they are; another blends the nearest four.
fn sampler(image: &Image, width: u32, height: u32) -> impl Fn(usize, usize) -> [f32; 3] + '_ {
    let (iw, ih) = (image.width.max(1) as usize, image.height.max(1) as usize);
    let same = iw == width as usize && ih == height as usize;
    let sx = iw as f32 / width as f32;
    let sy = ih as f32 / height as f32;
    let px = move |x: usize, y: usize| -> [f32; 3] {
        let i = (y.min(ih - 1) * iw + x.min(iw - 1)) * 4;
        match image.rgba.get(i..i + 4) {
            Some(&[r, g, b, a]) => {
                let a = f32::from(a) / 255.0;
                [r, g, b].map(|c| f32::from(c) / 255.0 * a)
            }
            _ => [0.0; 3],
        }
    };
    move |x, y| {
        if same {
            return px(x, y);
        }
        // Pixel centres, mapped into the image.
        let fx = ((x as f32 + 0.5) * sx - 0.5).max(0.0);
        let fy = ((y as f32 + 0.5) * sy - 0.5).max(0.0);
        let (x0, y0) = (fx.floor() as usize, fy.floor() as usize);
        let (tx, ty) = (fx - x0 as f32, fy - y0 as f32);
        let mix = |a: [f32; 3], b: [f32; 3], t: f32| [0, 1, 2].map(|c| a[c] + (b[c] - a[c]) * t);
        let top = mix(px(x0, y0), px(x0 + 1, y0), tx);
        let bottom = mix(px(x0, y0 + 1), px(x0 + 1, y0 + 1), tx);
        mix(top, bottom, ty)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn options(seconds: f64, fps: u32) -> Options {
        Options {
            seconds_per_slide: seconds,
            fps,
            animate: true,
        }
    }

    fn solid(width: u32, height: u32, px: [u8; 4]) -> Image {
        Image {
            width,
            height,
            rgba: px.repeat((width * height) as usize),
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
                animate: false
            }
        );
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
    fn videos_are_the_slide_size_in_even_pixels_up_to_4k() {
        assert_eq!(video_size(1920, 1080), (1920, 1080));
        assert_eq!(video_size(1080, 1350), (1080, 1350));
        assert_eq!(video_size(1281, 721), (1282, 722));
        assert_eq!(video_size(7680, 4320), (3840, 2160));
        assert_eq!(video_size(1080, 5000), (466, 2160));
        assert_eq!(video_size(0, 0), (2, 2));
    }

    #[test]
    fn converts_colours_to_bt709_video_levels() {
        let frame = |px| {
            let raw = to_yuv(&solid(4, 2, px), 4, 2);
            (raw[0], raw[8], raw[10])
        };
        assert_eq!(frame([0, 0, 0, 255]), (16, 128, 128));
        assert_eq!(frame([255, 255, 255, 255]), (235, 128, 128));
        assert_eq!(frame([255, 0, 0, 255]), (63, 102, 240));
        assert_eq!(
            frame([255, 255, 255, 0]),
            (16, 128, 128),
            "transparent is black"
        );
    }

    #[test]
    fn stretches_frames_to_the_video_size() {
        // Left half white, right half black, captured at half the size.
        let mut image = solid(4, 2, [0, 0, 0, 255]);
        for y in 0..2 {
            for x in 0..2 {
                let i = (y * 4 + x) * 4;
                image.rgba[i..i + 3].copy_from_slice(&[255, 255, 255]);
            }
        }
        let yuv = to_yuv(&image, 8, 4);
        let luma = &yuv[..32];
        assert_eq!(luma[0], 235);
        assert_eq!(luma[7], 16);
        assert_eq!(luma[24], 235);
        assert!(
            luma[3] > 16 && luma[3] < 235,
            "the edge blends: {}",
            luma[3]
        );
    }

    #[test]
    fn writes_av1_frames_into_an_mp4_lasting_as_long_as_they_show() {
        let mut out = Cursor::new(Vec::new());
        let mut video = VideoWriter::new(&mut out, (64, 36), 30).unwrap();
        video.keyframe();
        video.push(&solid(64, 36, [200, 30, 30, 255])).unwrap();
        video.push(&solid(64, 36, [210, 40, 30, 255])).unwrap();
        for _ in 0..28 {
            video.repeat().unwrap();
        }
        video.keyframe();
        video.push(&solid(32, 18, [30, 30, 200, 255])).unwrap();
        for _ in 0..14 {
            video.repeat().unwrap();
        }
        video.finish().unwrap();

        let track = crate::mp4::read::track(&out.into_inner());
        assert_eq!(
            (track.width, track.height, track.timescale),
            (64, 36, TIMESCALE)
        );
        let frame = TIMESCALE / 30;
        assert_eq!(
            track.durations,
            [frame, 29 * frame, 15 * frame],
            "held frames are stored once"
        );
        assert_eq!(track.keys, [1, 3], "each slide starts on a keyframe");
        // av1C version 1; each keyframe starts with the sequence header OBU.
        assert_eq!(track.config.len(), 4);
        assert_eq!(track.config[0], 0x81);
        let obu = |sample: &Vec<u8>| (sample[0] >> 3) & 0x0f;
        assert_eq!(obu(&track.samples[0]), 1);
        assert_eq!(obu(&track.samples[2]), 1);
        assert!(track
            .samples
            .iter()
            .all(|s| obu(s) != OBU_TEMPORAL_DELIMITER));
    }

    #[test]
    fn leaves_temporal_delimiters_out_of_samples() {
        let unit = [
            0x12, 0x00, // temporal delimiter, empty
            0x0a, 0x02, 0xaa, 0xbb, // sequence header, two bytes
            0x32, 0x01, 0xcc, // frame, one byte
        ];
        assert_eq!(
            without_temporal_delimiters(&unit),
            [0x0a, 0x02, 0xaa, 0xbb, 0x32, 0x01, 0xcc]
        );
        // Malformed data is kept as it is.
        assert_eq!(
            without_temporal_delimiters(&[0x0a, 0x05, 1]),
            [0x0a, 0x05, 1]
        );
    }

    #[test]
    fn refuses_odd_video_sizes() {
        assert!(VideoWriter::new(Cursor::new(Vec::new()), (63, 36), 30).is_err());
        assert!(VideoWriter::new(Cursor::new(Vec::new()), (0, 0), 30).is_err());
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
