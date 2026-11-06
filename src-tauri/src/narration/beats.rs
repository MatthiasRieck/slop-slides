//! The beat of narration audio that is music: its tempo and when each beat falls, for timing
//! animations to it. Onsets come from how much the spectrum grows from one moment to the next
//! (spectral flux), the tempo from how that repeats, and the beats from dynamic programming
//! that keeps them on strong onsets and evenly spaced (Ellis, "Beat Tracking by Dynamic
//! Programming", 2007, as librosa does it).

use symphonia::core::dsp::complex::Complex;
use symphonia::core::dsp::fft::Fft;

use crate::voice;

/// The rate the audio is looked at.
const RATE: u32 = 16_000;
const WINDOW: usize = 1024;
/// Samples between onset measurements: 16 ms.
const HOP: usize = 256;
/// The tempos looked for, in beats per minute, and the one taken to be likeliest.
const SLOWEST: f64 = 50.0;
const FASTEST: f64 = 220.0;
const LIKELIEST: f64 = 120.0;
/// How strongly beats keep to the tempo rather than to the loudest onsets.
const TIGHTNESS: f64 = 100.0;

/// The beat of some audio.
#[derive(Debug, Clone, PartialEq)]
pub struct Beats {
    /// Beats per minute.
    pub tempo: f64,
    /// Each beat: when it falls, in seconds into the audio, and how strong the onset there
    /// is, 0 to 1 (1 the strongest of them).
    pub beats: Vec<(f64, f64)>,
}

/// The beat of `samples` (mono, at `rate`); None when there is none to find, as in silence or
/// audio shorter than a few beats.
pub fn find(samples: &[f32], rate: u32) -> Option<Beats> {
    let audio = voice::resample(samples, rate, RATE);
    let onsets = onset_strength(&audio);
    let fps = f64::from(RATE) / HOP as f64;
    let period = tempo_period(&onsets, fps)?;
    let frames = track(&onsets, period);
    if frames.len() < 2 {
        return None;
    }
    let strongest = frames
        .iter()
        .map(|&f| onsets[f])
        .fold(0.0_f64, f64::max)
        .max(f64::EPSILON);
    Some(Beats {
        tempo: 60.0 * fps / period,
        beats: frames
            .iter()
            // A sharp onset shows the hop before it most: its window, centred on that hop,
            // already reaches it.
            .map(|&f| {
                (
                    (f + 1) as f64 / fps,
                    (onsets[f] / strongest).clamp(0.0, 1.0),
                )
            })
            .collect(),
    })
}

/// How sharply sound sets in at each hop of `audio`: the growth of its log spectrum since the
/// hop before, summed over frequencies, with the slow swell of loudness taken out.
fn onset_strength(audio: &[f32]) -> Vec<f64> {
    if audio.len() < WINDOW {
        return Vec::new();
    }
    let fft = Fft::new(WINDOW);
    let window: Vec<f32> = (0..WINDOW)
        .map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / WINDOW as f32).cos())
        .collect();
    // Windows centred on each hop, the audio padded with silence at both ends.
    let half = WINDOW / 2;
    let sample = |i: isize| {
        usize::try_from(i)
            .ok()
            .and_then(|i| audio.get(i))
            .copied()
            .unwrap_or(0.0)
    };
    let hops = audio.len() / HOP + 1;
    let mut previous: Option<Vec<f64>> = None;
    let mut flux = Vec::with_capacity(hops);
    let mut frame = vec![Complex::default(); WINDOW];
    for hop in 0..hops {
        let at = (hop * HOP) as isize - half as isize;
        for (i, c) in frame.iter_mut().enumerate() {
            *c = Complex::new(sample(at + i as isize) * window[i], 0.0);
        }
        fft.fft_inplace(&mut frame);
        let spectrum: Vec<f64> = frame[..half]
            .iter()
            .map(|c| (1.0 + 100.0 * f64::from((c.re * c.re + c.im * c.im).sqrt())).ln())
            .collect();
        flux.push(previous.as_ref().map_or(0.0, |before: &Vec<f64>| {
            spectrum
                .iter()
                .zip(before)
                .map(|(now, then)| (now - then).max(0.0))
                .sum::<f64>()
        }));
        previous = Some(spectrum);
    }
    // Take out the local average (about half a second either way), so only onsets stand out.
    let reach = 30;
    let mut sums = vec![0.0; flux.len() + 1];
    for (i, f) in flux.iter().enumerate() {
        sums[i + 1] = sums[i] + f;
    }
    let mut onsets: Vec<f64> = (0..flux.len())
        .map(|i| {
            let (a, b) = (i.saturating_sub(reach), (i + reach + 1).min(flux.len()));
            (flux[i] - (sums[b] - sums[a]) / (b - a) as f64).max(0.0)
        })
        .collect();
    let spread = (onsets.iter().map(|o| o * o).sum::<f64>() / onsets.len().max(1) as f64).sqrt();
    if spread > 0.0 {
        onsets.iter_mut().for_each(|o| *o /= spread);
    }
    onsets
}

/// The beat period, in hops, that best fits how `onsets` (at `fps`) repeat, weighed toward
/// [`LIKELIEST`]; None when nothing repeats.
fn tempo_period(onsets: &[f64], fps: f64) -> Option<f64> {
    let shortest = (60.0 * fps / FASTEST).floor() as usize;
    let longest = (60.0 * fps / SLOWEST).ceil() as usize;
    if onsets.len() < longest * 3 || onsets.iter().all(|&o| o == 0.0) {
        return None;
    }
    let mean = onsets.iter().sum::<f64>() / onsets.len() as f64;
    let centred: Vec<f64> = onsets.iter().map(|o| o - mean).collect();
    let correlation = |lag: usize| -> f64 {
        centred[lag..]
            .iter()
            .zip(&centred)
            .map(|(a, b)| a * b)
            .sum::<f64>()
            / (centred.len() - lag) as f64
    };
    let scores: Vec<f64> = (shortest..=longest + 1).map(correlation).collect();
    let weighed = |lag: usize, score: f64| {
        let bpm = 60.0 * fps / lag as f64;
        // One octave either way of the likeliest tempo halves the weight… roughly.
        let octaves = (bpm / LIKELIEST).log2();
        score * (-0.5 * octaves * octaves).exp()
    };
    let (best, score) = (shortest..=longest)
        .map(|lag| (lag, weighed(lag, scores[lag - shortest])))
        .max_by(|a, b| a.1.total_cmp(&b.1))?;
    if score <= 0.0 {
        return None;
    }
    // Between whole hops: the peak of a parabola through the best lag and its neighbours.
    let at = |lag: usize| scores[lag - shortest];
    let refined = if best > shortest && best <= longest {
        let (a, b, c) = (at(best - 1), at(best), at(best + 1));
        let bend = a - 2.0 * b + c;
        if bend < 0.0 {
            best as f64 + (0.5 * (a - c) / bend).clamp(-0.5, 0.5)
        } else {
            best as f64
        }
    } else {
        best as f64
    };
    Some(refined)
}

/// The hops of `onsets` that are beats `period` hops apart, more or less: each beat scores its
/// onset plus the best of the beats a period before it, less how far that is from a period.
fn track(onsets: &[f64], period: f64) -> Vec<usize> {
    let n = onsets.len();
    let mut score = vec![0.0; n];
    let mut back: Vec<Option<usize>> = vec![None; n];
    let (near, far) = (
        (period / 2.0).round() as usize,
        (period * 2.0).round() as usize,
    );
    for t in 0..n {
        // Beats between half a period and two periods before.
        let (from, to) = (t.saturating_sub(far), t.saturating_sub(near.max(1)));
        let mut best: Option<(usize, f64)> = None;
        for (before, &earlier) in score.iter().enumerate().take(to + 1).skip(from) {
            if before >= t {
                break;
            }
            let off = ((t - before) as f64 / period).ln();
            let s = earlier - TIGHTNESS * off * off;
            if best.map_or(true, |(_, b)| s > b) {
                best = Some((before, s));
            }
        }
        score[t] = onsets[t] + best.map_or(0.0, |(_, s)| s.max(0.0));
        back[t] = best.filter(|(_, s)| *s > 0.0).map(|(b, _)| b);
    }
    // The last beat: the best-scoring hop of the last period with an onset worth one.
    let typical = {
        let mut sorted: Vec<f64> = onsets.iter().copied().filter(|&o| o > 0.0).collect();
        sorted.sort_by(f64::total_cmp);
        sorted.get(sorted.len() / 2).copied().unwrap_or(0.0)
    };
    let tail = n.saturating_sub(far.max(1));
    let Some(last) = (tail..n)
        .filter(|&t| onsets[t] >= typical)
        .max_by(|&a, &b| score[a].total_cmp(&score[b]))
    else {
        return Vec::new();
    };
    let mut beats = vec![last];
    while let Some(before) = back[*beats.last().expect("one at least")] {
        beats.push(before);
    }
    beats.reverse();
    // Leave out beats in the quiet before the music starts and after it stops.
    let strong = onsets.iter().map(|o| o * o).sum::<f64>() / n.max(1) as f64;
    let weak = |&&t: &&usize| onsets[t] * onsets[t] < strong * 0.05;
    let first = beats.iter().position(|t| !weak(&t)).unwrap_or(beats.len());
    let end = beats
        .iter()
        .rposition(|t| !weak(&t))
        .map_or(first, |i| i + 1);
    beats[first..end].to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `seconds` of a kick drum every beat at `bpm`, from `from` seconds, over a quiet pad.
    fn drums(bpm: f64, from: f64, seconds: f64, rate: u32) -> Vec<f32> {
        let beat = 60.0 / bpm;
        (0..(seconds * f64::from(rate)) as usize)
            .map(|i| {
                let t = i as f64 / f64::from(rate);
                let pad = 0.05 * (std::f64::consts::TAU * 220.0 * t).sin();
                if t < from {
                    return pad as f32;
                }
                let since = (t - from) % beat;
                let kick = (-since * 25.0).exp()
                    * (std::f64::consts::TAU * (50.0 + 120.0 * (-since * 40.0).exp()) * t).sin();
                (pad + 0.8 * kick) as f32
            })
            .collect()
    }

    #[test]
    fn finds_the_tempo_and_where_the_beats_fall() {
        for (bpm, from) in [(120.0, 0.3), (92.0, 1.0), (140.0, 0.0)] {
            let found = find(&drums(bpm, from, 20.0, 44_100), 44_100).unwrap();
            assert!((found.tempo - bpm).abs() < 1.5, "{bpm}: {}", found.tempo);
            let beat = 60.0 / bpm;
            for (at, strength) in &found.beats {
                let off = ((at - from) / beat - ((at - from) / beat).round()) * beat;
                assert!(off.abs() < 0.012, "{bpm}: a beat at {at} is {off} s off");
                assert!((0.0..=1.0).contains(strength));
            }
            let expected = ((20.0 - from) / beat) as usize;
            assert!(
                found.beats.len() + 2 >= expected,
                "{bpm}: {} beats of {expected}",
                found.beats.len()
            );
            assert!(
                found.beats[0].0 >= from - 0.03,
                "no beats before the drums start"
            );
        }
    }

    /// Prints the beat of the audio file `SLOP_BEAT_PROBE`:
    /// `SLOP_BEAT_PROBE=song.m4a cargo test probe_beats -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn probe_beats() {
        let path = std::env::var("SLOP_BEAT_PROBE").expect("SLOP_BEAT_PROBE");
        let (samples, rate) = crate::narration::audio::decode(std::path::Path::new(&path)).unwrap();
        let started = std::time::Instant::now();
        let found = find(&samples, rate).unwrap();
        println!(
            "{:.1} BPM, {} beats in {:?}",
            found.tempo,
            found.beats.len(),
            started.elapsed()
        );
        for (at, strength) in found.beats.iter().take(40) {
            println!("{at:7.3} {strength:.2}");
        }
    }

    #[test]
    fn silence_and_short_sounds_have_no_beat() {
        assert_eq!(find(&vec![0.0; 16_000 * 10], 16_000), None);
        assert_eq!(find(&drums(120.0, 0.0, 1.0, 16_000), 16_000), None);
        assert_eq!(find(&[], 16_000), None);
    }
}
