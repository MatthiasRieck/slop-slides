//! Encoding the frames: each as BT.709 video, compressed as AV1 with rav1e and written into the
//! MP4 (see mp4.rs) as it comes, a frame held on screen stored once.

use std::collections::VecDeque;
use std::io::{Seek, Write};

use rav1e::color::{
    ChromaSampling, ColorDescription, ColorPrimaries, MatrixCoefficients, PixelRange,
    TransferCharacteristics,
};
use rav1e::data::{FrameType, Packet, Rational};
use rav1e::prelude::{FrameParameters, FrameTypeOverride};
use rav1e::{Config, Context, EncoderConfig, EncoderStatus};

use super::TIMESCALE;
use crate::capture::Image;
use crate::error::{Error, Result};
use crate::mp4::{AudioTrack, Mp4Writer};

/// Frames between keyframes besides the one starting each slide, in seconds of video.
const KEYFRAME_SECONDS: u32 = 4;
/// rav1e's speed preset, 0 (best) to 10 (fastest): slides are mostly still, flat colour.
const SPEED: u8 = 10;
/// rav1e's quantizer, 0 (lossless) to 255: low enough to keep small text sharp.
const QUANTIZER: usize = 80;
/// The AV1 OBU type that starts each temporal unit.
const OBU_TEMPORAL_DELIMITER: u8 = 2;

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

    /// Encodes what is left, adds the `audio` track, if any, and writes the MP4's index.
    pub fn finish(mut self, audio: Option<&AudioTrack>) -> Result<()> {
        self.encoder.flush();
        self.drain()?;
        self.write_ready(u64::MAX)?;
        if let Some(audio) = audio {
            self.mp4.write_audio(audio)?;
        }
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
    use std::io::Cursor;

    use super::super::encode_opus;
    use super::*;

    fn solid(width: u32, height: u32, px: [u8; 4]) -> Image {
        Image {
            width,
            height,
            rgba: px.repeat((width * height) as usize),
        }
    }

    /// Run explicitly to measure the CPU export path without webview capture or narration.
    #[test]
    #[ignore = "1080p encoding benchmark; run with --ignored --nocapture"]
    fn benchmark_video_encoding_1080p() {
        use std::time::Instant;
        let mut image = solid(1920, 1080, [24, 32, 28, 255]);
        let mut video = VideoWriter::new(Cursor::new(Vec::new()), (1920, 1080), 30).unwrap();
        let start = Instant::now();
        for frame in 0..8 {
            // Small moving detail over a still slide, like a deck's looping decoration.
            for y in 800..900 {
                for x in 1600..1700 {
                    let i = (y * 1920 + x) * 4;
                    image.rgba[i] = ((x + y + frame * 8) % 256) as u8;
                }
            }
            let conversion = Instant::now();
            std::hint::black_box(to_yuv(&image, 1920, 1080));
            eprintln!("RGB conversion: {:?}", conversion.elapsed());
            let encode = Instant::now();
            video.push(&image).unwrap();
            eprintln!("Conversion + encoder submission: {:?}", encode.elapsed());
        }
        video.finish(None).unwrap();
        eprintln!(
            "Eight 1080p frames including encoder flush: {:?}",
            start.elapsed()
        );
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
        video.finish(None).unwrap();

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
    fn narrated_videos_carry_an_opus_track() {
        let mut out = Cursor::new(Vec::new());
        let mut video = VideoWriter::new(&mut out, (64, 36), 30).unwrap();
        video.push(&solid(64, 36, [200, 30, 30, 255])).unwrap();
        for _ in 0..29 {
            video.repeat().unwrap();
        }
        let audio = encode_opus(&vec![0.1; AudioTrack::RATE as usize]).unwrap();
        video.finish(Some(&audio)).unwrap();
        let file = out.into_inner();
        assert_eq!(crate::mp4::read::track(&file).durations, [TIMESCALE]);
        let read = crate::mp4::read::audio(&file);
        assert_eq!(read.samples.len(), audio.packets.len());
        assert_eq!(read.pre_skip, audio.pre_skip);
        assert_eq!(read.edit.0, 1000, "a second of audio");
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
}
