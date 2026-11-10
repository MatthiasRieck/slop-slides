//! When each word of a recording is said: Whisper's one-word segments, placed by dynamic time
//! warping against its cross-attention and settled onto the sound, for timing slides to their
//! narration.

use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use whisper_rs::{WhisperContext, WhisperContextParameters};

use super::model::MODEL;
use super::whisper::{
    clean_transcript, may_hold_speech, padded, params, whisper_error, WHISPER_RATE,
};
use crate::error::{Error, Result};
use crate::sound;

/// A word said in a recording, and when: seconds from the recording's start.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Word {
    pub text: String,
    pub start: f64,
    pub end: f64,
}

/// The model at `model`, set up to find when each token starts by dynamic time warping
/// against its cross-attention (DTW), which is much closer to the audio than Whisper's own
/// timestamps: those run from one pause to the next.
pub(super) fn timing_context(model: &Path) -> Result<WhisperContext> {
    if !model.is_file() {
        return Err(Error::msg("The speech model is not downloaded."));
    }
    whisper_rs::install_logging_hooks();
    let mut params = WhisperContextParameters::default();
    params.dtw_parameters(whisper_rs::DtwParameters {
        mode: whisper_rs::DtwMode::ModelPreset {
            model_preset: MODEL.dtw,
        },
        ..Default::default()
    });
    WhisperContext::new_with_params(model, params).map_err(whisper_error)
}

/// Every word said in `audio` (at [`WHISPER_RATE`]) and when, in `language` (an ISO 639-1 code)
/// or whatever language it is in for None.
pub(super) fn transcribe_words(
    timer: &Mutex<Option<WhisperContext>>,
    model: &Path,
    audio: &[f32],
    language: Option<&str>,
) -> Result<Vec<Word>> {
    if !may_hold_speech(audio) {
        return Ok(Vec::new());
    }
    let mut loaded = timer.lock().unwrap();
    if loaded.is_none() {
        *loaded = Some(timing_context(model)?);
    }
    let context = loaded.as_ref().expect("loaded above");
    let mut state = context.create_state().map_err(whisper_error)?;
    let mut params = params();
    params.set_language(Some(language.unwrap_or("auto")));
    // One segment per word.
    params.set_no_timestamps(false);
    params.set_token_timestamps(true);
    params.set_max_len(1);
    params.set_split_on_word(true);
    state.full(params, &padded(audio)).map_err(whisper_error)?;
    let eot = context.token_eot();
    let heard: Vec<Heard> = state
        .as_iter()
        .filter_map(|segment| {
            let text = segment.to_str_lossy().ok()?.into_owned();
            // Where the warping put the end of each of the segment's text tokens.
            let warped = (0..segment.n_tokens())
                .filter_map(|i| segment.get_token(i))
                .map(|token| token.token_data())
                .filter(|data| data.id < eot && data.t_dtw >= 0)
                .map(|data| data.t_dtw)
                .collect();
            Some(Heard {
                text,
                start: segment.start_timestamp(),
                end: segment.end_timestamp(),
                warped,
            })
        })
        .collect();
    let seconds = audio.len() as f64 / f64::from(WHISPER_RATE);
    let loudness: Vec<f32> = audio
        .chunks(WHISPER_RATE as usize / 100)
        .map(sound::rms)
        .collect();
    Ok(spanned(
        words_of(&settled(warped(&heard), &loudness), seconds),
        seconds,
    ))
}

/// One of Whisper's one-word segments: its text, its start and end, and where dynamic time
/// warping put the end of each of its text tokens, in hundredths of a second. whisper.cpp
/// stamps a token with the moment the warping path moves on to the next one: its end.
#[derive(Debug, Clone, Default)]
pub struct Heard {
    pub text: String,
    pub start: i64,
    pub end: i64,
    pub warped: Vec<i64>,
}

/// `heard` segments as [`Span`]s: each word starts where the token before it ends and ends where
/// its own last token does, as the warping put them; without them, Whisper's own segment times
/// stand in.
pub fn warped(heard: &[Heard]) -> Vec<Span> {
    let mut before: Option<i64> = None;
    heard
        .iter()
        .map(|h| {
            let end = h.warped.last().copied().unwrap_or(h.end);
            let start = before.unwrap_or(h.start).min(end);
            if let Some(&last) = h.warped.last() {
                before = Some(last);
            }
            (h.text.clone(), start, end, h.start.clamp(start, end))
        })
        .collect()
}

/// A word as the warping placed it: its text, start and end, and where Whisper's own
/// timestamps start it, in hundredths of a second.
pub type Span = (String, i64, i64, i64);

/// The shortest quiet taken for a pause between words, in hundredths of a second.
const PAUSE: i64 = 4;

/// `spans` as (text, start, end) with each word's start moved up to the sound it ends in, after
/// the last pause in its span, `loudness` being the audio's in each hundredth of a second: the
/// warping counts a pause before a word as part of it. Without a pause there (over music, say)
/// Whisper's own start stands in. A word then lasts at most twice the usual one (one and a
/// half without a pause), as OpenAI's Whisper also keeps words from running long.
pub fn settled(spans: Vec<Span>, loudness: &[f32]) -> Vec<(String, i64, i64)> {
    let mut sorted: Vec<f32> = loudness.to_vec();
    sorted.sort_by(f32::total_cmp);
    let loud = sorted.get(sorted.len() * 9 / 10).copied().unwrap_or(0.0);
    let quiet = |t: i64| loudness.get(t as usize).map_or(true, |&l| l < loud * 0.1);
    let spans: Vec<(String, i64, i64, bool)> = spans
        .into_iter()
        .map(|(text, start, end, said)| {
            // The sound the word ends in starts after the last pause in its span; without
            // one (over music, say), where Whisper put the word's start.
            let sound = (start + PAUSE..end)
                .rev()
                .find(|&t| (t - PAUSE..t).all(quiet) && !quiet(t));
            (text, sound.unwrap_or(said), end, sound.is_some())
        })
        .collect();
    let mut lengths: Vec<i64> = spans
        .iter()
        .map(|(_, s, e, _)| e - s)
        .filter(|&l| l > 0)
        .collect();
    lengths.sort_unstable();
    let usual = lengths.get(lengths.len() / 2).copied().unwrap_or(0);
    spans
        .into_iter()
        .map(|(text, start, end, paused)| {
            // Without a pause to go by, the start is a guess: keep it nearer the end.
            let longest = if paused { usual * 2 } else { usual * 3 / 2 };
            (
                text,
                if usual > 0 {
                    start.max(end - longest)
                } else {
                    start
                },
                end,
            )
        })
        .collect()
}

/// The shortest a word is taken to last, in seconds.
const SHORTEST_WORD: f64 = 0.08;

/// `words` of audio `seconds` long, each lasting a while: one heard as a mere moment (sung
/// words often are) lasts until the next starts, at most as long as the usual word, so it can
/// be highlighted while it is said.
pub fn spanned(mut words: Vec<Word>, seconds: f64) -> Vec<Word> {
    let mut lengths: Vec<f64> = words
        .iter()
        .map(|w| w.end - w.start)
        .filter(|&l| l >= SHORTEST_WORD)
        .collect();
    lengths.sort_by(f64::total_cmp);
    let usual = lengths.get(lengths.len() / 2).copied().unwrap_or(0.3);
    for i in 0..words.len() {
        if words[i].end - words[i].start >= SHORTEST_WORD {
            continue;
        }
        let next = words.get(i + 1).map_or(seconds, |w| w.start);
        let word = &mut words[i];
        word.end = (word.start + usual).min(next).min(seconds).max(word.end);
    }
    words
}

/// The words of Whisper's one-word `segments` (text, start and end in hundredths of a second)
/// of audio `seconds` long: without non-speech annotations, punctuation kept with the word
/// before it, and times within the audio and in order.
pub fn words_of(segments: &[(String, i64, i64)], seconds: f64) -> Vec<Word> {
    let mut words: Vec<Word> = Vec::new();
    for (text, t0, t1) in segments {
        let text = clean_transcript(text);
        if text.is_empty() {
            continue;
        }
        let start = (*t0 as f64 / 100.0).clamp(0.0, seconds);
        let end = (*t1 as f64 / 100.0).clamp(start, seconds);
        let start = words.last().map_or(start, |w| start.max(w.end).min(end));
        match words.last_mut() {
            Some(last) if !text.chars().any(char::is_alphanumeric) => {
                last.text.push_str(&text);
                last.end = last.end.max(end);
            }
            _ => words.push(Word { text, start, end }),
        }
    }
    words
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(text: &str, start: f64, end: f64) -> Word {
        Word {
            text: text.into(),
            start,
            end,
        }
    }

    #[test]
    fn words_come_with_their_times_in_seconds() {
        let segments = vec![
            (" Hello".to_string(), 0, 42),
            (" world".to_string(), 42, 90),
        ];
        assert_eq!(
            words_of(&segments, 2.0),
            vec![word("Hello", 0.0, 0.42), word("world", 0.42, 0.9)]
        );
    }

    #[test]
    fn punctuation_stays_with_its_word_and_annotations_are_no_words() {
        let segments = vec![
            (" [BLANK_AUDIO]".to_string(), 0, 100),
            (" First".to_string(), 100, 150),
            (",".to_string(), 150, 152),
            (" (music)".to_string(), 152, 200),
            (" second".to_string(), 200, 260),
            (".".to_string(), 260, 270),
        ];
        assert_eq!(
            words_of(&segments, 3.0),
            vec![word("First,", 1.0, 1.52), word("second.", 2.0, 2.7)]
        );
        // Punctuation with no word before it is kept as one.
        assert_eq!(
            words_of(&[("¿".to_string(), 0, 10)], 1.0),
            vec![word("¿", 0.0, 0.1)]
        );
    }

    fn heard(text: &str, start: i64, end: i64, warped: &[i64]) -> Heard {
        Heard {
            text: text.into(),
            start,
            end,
            warped: warped.to_vec(),
        }
    }

    #[test]
    fn warped_words_run_from_the_token_before_to_their_last_token() {
        let spans = warped(&[
            heard(" Hello", 0, 90, &[40]),
            heard(" wonderful", 90, 300, &[70, 120]),
            // Without warping, its own times, and the next word starts after them.
            heard(" big", 300, 360, &[]),
            heard(" world", 360, 500, &[210]),
        ]);
        assert_eq!(
            spans,
            vec![
                ("Hello".into(), 0, 40, 0),
                ("wonderful".into(), 40, 120, 90),
                ("big".into(), 120, 360, 300),
                ("world".into(), 120, 210, 210),
            ]
            .into_iter()
            .map(|(t, s, e, w): (String, i64, i64, i64)| (format!(" {t}"), s, e, w))
            .collect::<Vec<_>>()
        );
    }

    #[test]
    fn settled_words_start_after_the_pause_before_them() {
        // Loud from 0.1 s to 0.4 s and from 1.0 s to 1.3 s, quiet between.
        let loudness: Vec<f32> = (0..150)
            .map(|t| {
                if (10..40).contains(&t) || (100..130).contains(&t) {
                    0.5
                } else {
                    0.0
                }
            })
            .collect();
        let spans = vec![
            ("One".to_string(), 0, 40, 5),
            // The warping counts the pause as part of the word.
            ("two".to_string(), 40, 130, 60),
        ];
        assert_eq!(
            settled(spans, &loudness),
            vec![("One".into(), 10, 40), ("two".into(), 100, 130)]
        );
        // Over music there is no pause: Whisper's start stands in, held near the end.
        let music = vec![0.5; 400];
        let spans = vec![
            ("a".to_string(), 0, 30, 10),
            ("b".to_string(), 30, 60, 35),
            ("long".to_string(), 60, 300, 70),
        ];
        assert_eq!(
            settled(spans, &music),
            vec![
                ("a".into(), 10, 30),
                ("b".into(), 35, 60),
                ("long".into(), 263, 300)
            ]
        );
        assert!(settled(Vec::new(), &[]).is_empty());
    }

    #[test]
    fn words_heard_as_a_moment_last_until_the_next() {
        let words = spanned(
            vec![
                word("Hold", 0.0, 0.4),
                word("on", 0.5, 0.8),
                word("Leadership", 1.0, 1.0),
                word("super", 3.0, 3.0),
                word("excited", 3.1, 3.6),
                word("now", 4.0, 4.0),
            ],
            4.1,
        );
        assert_eq!(
            words,
            vec![
                word("Hold", 0.0, 0.4),
                word("on", 0.5, 0.8),
                // As long as the usual word (0.4 s), well before the next.
                word("Leadership", 1.0, 1.4),
                // Up to the next word.
                word("super", 3.0, 3.1),
                word("excited", 3.1, 3.6),
                // Up to the end of the audio.
                word("now", 4.0, 4.1),
            ]
        );
        assert!(spanned(Vec::new(), 1.0).is_empty());
    }

    #[test]
    fn word_times_stay_within_the_audio_and_in_order() {
        let segments = vec![
            (" late".to_string(), 50, 40),
            (" overlap".to_string(), 30, 80),
            (" padding".to_string(), 90, 140),
        ];
        assert_eq!(
            words_of(&segments, 1.2),
            vec![
                word("late", 0.5, 0.5),
                word("overlap", 0.5, 0.8),
                word("padding", 0.9, 1.2)
            ]
        );
        assert!(words_of(&[], 1.0).is_empty());
    }
}
