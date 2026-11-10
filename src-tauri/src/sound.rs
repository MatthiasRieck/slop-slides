//! Audio as mono `f32` samples, which voice input, narration and the video export pass around:
//! the helpers they share for mixing, resampling, measuring and decoding it.

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

/// Root mean square of `samples`; 0 for none.
pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

/// Mono 16-bit little-endian PCM as samples; an odd last byte is dropped.
pub fn pcm16(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|b| f32::from(i16::from_le_bytes([b[0], b[1]])) / 32768.0)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(rms(&out) < 0.5, "rms {}", rms(&out));
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
    fn pcm_becomes_samples() {
        let bytes = [0x00, 0x00, 0x00, 0x40, 0x00, 0x80, 0xff, 0x7f, 0x01];
        assert_eq!(pcm16(&bytes), vec![0.0, 0.5, -1.0, 32767.0 / 32768.0]);
    }
}
