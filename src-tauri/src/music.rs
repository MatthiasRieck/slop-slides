//! A deck's background music: one audio file from its `assets/`, named in the deck's
//! `slopslide-music` meta and played on a loop under the whole show at the volume of its
//! `slopslide-music-volume` meta.
//!
//! The player (`assets/runtime.js`) plays it when presenting and in exported files, so the
//! webview or browser decodes it there; a video export decodes it here to mix it into the
//! soundtrack. [`EXTENSIONS`] lists what works in both.

use std::fs::File;
use std::path::Path;

use serde::Serialize;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as DecodeError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use crate::error::{Error, Result};
use crate::mp4::AudioTrack;
use crate::{html, voice};

/// The file types music can be: every platform's webview plays them, and [`decode`] reads them.
/// Keep in step with `MUSIC_EXTENSIONS` in src/lib/api.ts and the deck rules in prompts/system.md.
///
/// Bare `.aac` files are left out: they play, but Apple's encoder gives them the MPEG-2 ADTS
/// header, which symphonia does not recognize. AAC comes in `.m4a`.
pub const EXTENSIONS: [&str; 5] = ["mp3", "m4a", "wav", "flac", "ogg"];
/// The volume, in percent of the file's own, without a volume meta: under a spoken narration.
pub const DEFAULT_VOLUME: u8 = 30;
/// How long the music fades out at the end of a video, in seconds.
const FADE_SECONDS: usize = 2;

/// The deck's music, as the editor shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Settings {
    /// Relative to the deck file, as the meta has it: `assets/<file>`.
    pub file: String,
    /// In percent.
    pub volume: u8,
}

impl Settings {
    /// The music of the deck `html`, if it has any.
    pub fn of(html: &str) -> Option<Self> {
        Some(Self {
            file: html::music(html)?,
            volume: html::music_volume(html),
        })
    }
}

/// Whether `path` has one of the [`EXTENSIONS`].
pub fn supported(path: &str) -> bool {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    path.contains('.') && EXTENSIONS.contains(&ext.as_str())
}

/// The audio file at `path`, mono, at [`AudioTrack::RATE`].
pub fn decode(path: &Path) -> Result<Vec<f32>> {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let failed = |e: DecodeError| Error::msg(format!("cannot read the music {name}: {e}"));
    let stream = MediaSourceStream::new(Box::new(File::open(path)?), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let mut format = symphonia::default::get_probe()
        .format(
            &hint,
            stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(failed)?
        .format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| Error::msg(format!("the music {name} has no audio")))?;
    let id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(failed)?;

    let mut mono = Vec::new();
    let mut rate = AudioTrack::RATE;
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(DecodeError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(failed(e)),
        };
        if packet.track_id() != id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(audio) => {
                let spec = *audio.spec();
                let mut samples = SampleBuffer::<f32>::new(audio.capacity() as u64, spec);
                samples.copy_interleaved_ref(audio);
                rate = spec.rate;
                mono.extend(voice::downmix(samples.samples(), spec.channels.count()));
            }
            // A damaged frame: the rest of the file still plays.
            Err(DecodeError::DecodeError(_)) => continue,
            Err(e) => return Err(failed(e)),
        }
    }
    if mono.is_empty() {
        return Err(Error::msg(format!("the music {name} has no audio")));
    }
    Ok(voice::resample(&mono, rate, AudioTrack::RATE))
}

/// Adds `music` (mono, at [`AudioTrack::RATE`]) under `track` at `volume` percent, looped to
/// its length and fading out at its end.
pub fn mix(track: &mut [f32], music: &[f32], volume: u8) {
    if music.is_empty() {
        return;
    }
    let gain = f32::from(volume) / 100.0;
    let len = track.len();
    let fade = (FADE_SECONDS * AudioTrack::RATE as usize).min(len);
    for (i, sample) in track.iter_mut().enumerate() {
        let left = len - i;
        let faded = if left < fade {
            left as f32 / fade as f32
        } else {
            1.0
        };
        *sample = (*sample + music[i % music.len()] * gain * faded).clamp(-1.0, 1.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::narration::audio::write_wav;
    use symphonia::core::codecs::{CODEC_TYPE_AAC, CODEC_TYPE_FLAC, CODEC_TYPE_MP3};
    use symphonia::core::codecs::{CODEC_TYPE_ALAC, CODEC_TYPE_VORBIS};

    const RATE: usize = AudioTrack::RATE as usize;

    #[test]
    fn knows_the_supported_file_types() {
        for path in ["assets/a.mp3", "a.M4A", "a.wav", "a.flac", "a.b.ogg"] {
            assert!(supported(path), "{path}");
        }
        for path in [
            "a.aiff",
            "a.aac",
            "a.opus",
            "a.webm",
            "a.mp4",
            "mp3",
            "assets/mp3",
            "",
        ] {
            assert!(!supported(path), "{path}");
        }
    }

    #[test]
    fn every_supported_codec_is_compiled_in() {
        let codecs = symphonia::default::get_codecs();
        for codec in [
            CODEC_TYPE_MP3,
            CODEC_TYPE_AAC,
            CODEC_TYPE_ALAC,
            CODEC_TYPE_FLAC,
            CODEC_TYPE_VORBIS,
        ] {
            assert!(codecs.get_codec(codec).is_some(), "{codec}");
        }
    }

    #[test]
    fn decodes_to_mono_at_the_track_rate() {
        let dir = std::env::temp_dir().join(format!("slopslide-music-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("tone.wav");
        write_wav(&wav, &vec![0.5; 24_000], 24_000).unwrap();

        let decoded = decode(&wav).unwrap();
        assert_eq!(decoded.len(), RATE, "one second");
        assert!((decoded[RATE / 2] - 0.5).abs() < 0.01);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn decodes_compressed_formats() {
        for (name, bytes) in [
            (
                "tone.m4a",
                &include_bytes!("../../fixtures/audio/tone.m4a")[..],
            ),
            (
                "tone.flac",
                &include_bytes!("../../fixtures/audio/tone.flac")[..],
            ),
        ] {
            let dir =
                std::env::temp_dir().join(format!("slopslide-music-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let file = dir.join(name);
            std::fs::write(&file, bytes).unwrap();

            let decoded = decode(&file).unwrap();
            assert!(decoded.len() > RATE / 10, "{name}: {}", decoded.len());
            assert!(decoded.iter().any(|s| s.abs() > 0.05), "{name} is silent");

            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn refuses_files_that_are_not_audio() {
        let dir = std::env::temp_dir().join(format!("slopslide-music-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("song.mp3");
        std::fs::write(&file, b"not audio").unwrap();

        let message = decode(&file).unwrap_err().to_string();
        assert!(message.contains("song.mp3"), "{message}");
        assert!(decode(&dir.join("missing.mp3")).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mixes_the_music_looped_under_the_track_at_its_volume() {
        let mut track = vec![0.1; 10 * RATE];
        mix(&mut track, &[0.5, 0.0], 50);
        assert!((track[0] - 0.35).abs() < 1e-6);
        assert!((track[1] - 0.1).abs() < 1e-6);
        assert!((track[2] - 0.35).abs() < 1e-6, "loops");
    }

    #[test]
    fn fades_the_music_out_at_the_end() {
        let mut track = vec![0.0; 3 * RATE];
        mix(&mut track, &[1.0], 100);
        assert_eq!(track[RATE - 1], 1.0, "before the fade");
        assert!((track[2 * RATE] - 0.5).abs() < 1e-3, "halfway through it");
        assert!(track[3 * RATE - 1] < 0.001, "silent at the end");
    }

    #[test]
    fn mixing_keeps_loud_tracks_in_range_and_takes_silence() {
        let mut track = vec![0.9; 8 * RATE];
        mix(&mut track, &[1.0], 100);
        assert_eq!(track[0], 1.0, "clipped, not wrapped");

        let mut untouched = vec![0.25; 4];
        mix(&mut untouched, &[], 100);
        assert_eq!(untouched, [0.25; 4]);
    }
}
