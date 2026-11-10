//! Narration audio: reading and writing it as WAV files, drawing its waveform, and decoding
//! audio made elsewhere.

use std::fs;
use std::io::{Read, Write};
use std::path::Path;

use crate::error::{Error, Result};
use crate::sound;

/// The sample rate narration audio is kept at (and the services are asked for).
pub const RATE: u32 = 24_000;
/// How finely the timeline draws a waveform.
const PEAKS_PER_SECOND: u32 = 25;

/// Writes `samples` (mono, at `rate`) as a 16-bit PCM WAV file.
pub fn write_wav(path: &Path, samples: &[f32], rate: u32) -> Result<()> {
    let data = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes());
    }
    fs::File::create(path)?.write_all(&out)?;
    Ok(())
}

/// Writes `samples` (mono, at `rate`) as the WAV file `path` in one step, through a `.part`
/// file next to it, so nothing reads half of it.
pub fn replace_wav(path: &Path, samples: &[f32], rate: u32) -> Result<()> {
    let part = path.with_extension("wav.part");
    write_wav(&part, samples, rate)?;
    fs::rename(&part, path)?;
    Ok(())
}

/// How loud `samples` (at `rate`) are along their length: the loudest in each of
/// [`PEAKS_PER_SECOND`] slices of a second, 0 to 1.
pub fn peaks(samples: &[f32], rate: u32) -> Vec<f32> {
    samples
        .chunks((rate / PEAKS_PER_SECOND).max(1) as usize)
        .map(|chunk| {
            chunk
                .iter()
                .fold(0.0_f32, |peak, s| peak.max(s.abs()))
                .min(1.0)
        })
        .collect()
}

/// A mono 16-bit PCM WAV file, as [`write_wav`] writes it: its samples and their rate.
pub fn read_wav(path: &Path) -> Result<(Vec<f32>, u32)> {
    let mut bytes = Vec::new();
    fs::File::open(path)?.read_to_end(&mut bytes)?;
    parse_wav(&bytes)
        .ok_or_else(|| Error::msg(format!("{} is not a usable WAV file", path.display())))
}

fn parse_wav(bytes: &[u8]) -> Option<(Vec<f32>, u32)> {
    if bytes.get(0..4)? != b"RIFF" || bytes.get(8..12)? != b"WAVE" {
        return None;
    }
    let u16_at = |at: usize| Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?));
    let u32_at = |at: usize| Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?));
    let mut at = 12;
    let mut rate = None;
    while at + 8 <= bytes.len() {
        let size = u32_at(at + 4)? as usize;
        let body = at + 8;
        match bytes.get(at..at + 4)? {
            b"fmt " => {
                let (format, channels, bits) =
                    (u16_at(body)?, u16_at(body + 2)?, u16_at(body + 14)?);
                if format != 1 || channels != 1 || bits != 16 {
                    return None;
                }
                rate = Some(u32_at(body + 4)?);
            }
            b"data" => {
                let data = bytes.get(body..(body + size).min(bytes.len()))?;
                return Some((sound::pcm16(data), rate?));
            }
            _ => {}
        }
        at = body + size + size % 2;
    }
    None
}

/// The sound of an audio file made elsewhere (WAV, MP3, AAC or ALAC in M4A, FLAC, Ogg Vorbis or
/// AIFF), mixed down to mono: its samples and their rate.
pub fn decode(path: &Path) -> Result<(Vec<f32>, u32)> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
    use symphonia::core::errors::Error as Decoding;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let unusable = |why: &dyn std::fmt::Display| {
        Error::msg(format!("{} is no usable audio: {why}", path.display()))
    };
    let stream = MediaSourceStream::new(Box::new(fs::File::open(path)?), Default::default());
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
        .map_err(|e| unusable(&e))?
        .format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| unusable(&"it has no audio track"))?;
    let (track_id, mut rate) = (track.id, track.codec_params.sample_rate);
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| unusable(&e))?;
    let mut samples = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(Decoding::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(Decoding::ResetRequired) => break,
            Err(e) => return Err(unusable(&e)),
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                rate.get_or_insert(spec.rate);
                let mut buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
                buffer.copy_interleaved_ref(decoded);
                samples.extend(sound::downmix(buffer.samples(), spec.channels.count()));
            }
            // A damaged packet: the rest still plays.
            Err(Decoding::DecodeError(_)) => continue,
            Err(e) => return Err(unusable(&e)),
        }
    }
    match rate {
        Some(rate) if rate > 0 && !samples.is_empty() => Ok((samples, rate)),
        _ => Err(unusable(&"it holds no sound")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peaks_are_the_loudest_sample_of_each_slice() {
        let slice = (RATE / PEAKS_PER_SECOND) as usize;
        let mut samples = vec![0.0; slice * 2 + 1];
        samples[3] = -0.5;
        samples[slice + 1] = 0.25;
        samples[slice * 2] = 1.5;
        assert_eq!(peaks(&samples, RATE), [0.5, 0.25, 1.0]);
        assert!(peaks(&[], RATE).is_empty());
        assert_eq!(peaks(&[0.5], 1), [0.5]);
    }

    #[test]
    fn wav_files_round_trip() {
        let dir = std::env::temp_dir().join(format!("slopslide-wav-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.wav");
        let samples: Vec<f32> = (0..RATE).map(|i| (i as f32 / 100.0).sin() * 0.5).collect();
        write_wav(&path, &samples, RATE).unwrap();
        let (read, rate) = read_wav(&path).unwrap();
        assert_eq!(rate, RATE);
        assert_eq!(read.len(), samples.len());
        assert!(read.iter().zip(&samples).all(|(a, b)| (a - b).abs() < 1e-4));
        fs::write(dir.join("bad.wav"), b"not a wav").unwrap();
        assert!(read_wav(&dir.join("bad.wav")).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    /// A 16-bit PCM WAV file of `channels` interleaved channels.
    fn pcm_wav(frames: &[Vec<i16>], rate: u32) -> Vec<u8> {
        let channels = frames[0].len() as u16;
        let data = (frames.len() * channels as usize * 2) as u32;
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&channels.to_le_bytes());
        out.extend_from_slice(&rate.to_le_bytes());
        out.extend_from_slice(&(rate * u32::from(channels) * 2).to_le_bytes());
        out.extend_from_slice(&(channels * 2).to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data.to_le_bytes());
        for frame in frames {
            for s in frame {
                out.extend_from_slice(&s.to_le_bytes());
            }
        }
        out
    }

    #[test]
    fn audio_made_elsewhere_decodes_to_mono() {
        let dir = std::env::temp_dir().join(format!("slopslide-decode-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        // Stereo at 44.1 kHz: left and right are averaged.
        let frames: Vec<Vec<i16>> = (0..4410).map(|_| vec![16384, 0]).collect();
        fs::write(dir.join("stereo.wav"), pcm_wav(&frames, 44_100)).unwrap();
        let (samples, rate) = decode(&dir.join("stereo.wav")).unwrap();
        assert_eq!(rate, 44_100);
        assert_eq!(samples.len(), 4410);
        assert!(
            samples.iter().all(|s| (s - 0.25).abs() < 1e-3),
            "{:?}",
            &samples[..4]
        );
        // What write_wav writes decodes too, whatever its extension says.
        let tone: Vec<f32> = (0..RATE / 10)
            .map(|i| (i as f32 / 10.0).sin() * 0.5)
            .collect();
        write_wav(&dir.join("tone.audio"), &tone, RATE).unwrap();
        let (samples, rate) = decode(&dir.join("tone.audio")).unwrap();
        assert_eq!((samples.len(), rate), (tone.len(), RATE));
        // Not audio, no sound, or no file at all.
        fs::write(dir.join("notes.mp3"), b"not audio at all").unwrap();
        let err = decode(&dir.join("notes.mp3")).unwrap_err().to_string();
        assert!(err.contains("is no usable audio"), "{err}");
        fs::write(dir.join("empty.wav"), &pcm_wav(&[vec![0]], 8_000)[..44]).unwrap();
        assert!(decode(&dir.join("empty.wav")).is_err());
        assert!(decode(&dir.join("missing.wav")).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
