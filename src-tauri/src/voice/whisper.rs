//! Transcribing audio with whisper.cpp: the loaded model, a whole recording (cut into segments
//! at pauses as it grows), and the few seconds the teleprompter follows.

use std::path::Path;
use std::sync::Mutex;

use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
};

use crate::error::{Error, Result};
use crate::sound;

/// Whisper's input sample rate.
pub(super) const WHISPER_RATE: u32 = 16_000;
/// Recordings shorter than this are taken as an accidental click.
const MIN_SECONDS: f32 = 0.3;
/// whisper.cpp wants at least a second of audio; shorter clips are padded with silence.
const PAD_SECONDS: f32 = 1.1;
/// Audio not yet transcribed for good is cut into segments of at most this length, at a pause,
/// so the live transcript does not slow down as the recording grows.
pub(super) const SEGMENT_SECONDS: f32 = 20.0;
/// Audio quieter than this (root mean square) holds no speech; Whisper would make some up.
const SILENCE_RMS: f32 = 0.002;
/// How much of the latest audio the teleprompter transcribes each time. It only needs to know
/// where the speaker is now, so a talk can run for as long as it likes at the same cost.
pub(super) const FOLLOW_SECONDS: usize = 4;
/// How much audio the model looks at while following (it takes 50 of these a second, 1500 by
/// default): enough for what is transcribed, and much faster than looking at all 30 seconds.
const FOLLOW_AUDIO_CONTEXT: i32 = FOLLOW_SECONDS as i32 * 50 + 20;
/// Most tokens a pass may decode. On so short a clip the decoder sometimes repeats a phrase
/// until it runs out of room, holding up the speaker's line by a second.
const FOLLOW_MAX_TOKENS: i32 = 64;

/// The loaded model.
pub(super) struct Engine {
    context: WhisperContext,
    /// What following a speaker keeps between passes: setting it up takes a moment, and it makes
    /// Whisper's language detection look at no more audio than the pass after it.
    pub(super) following: Option<WhisperState>,
}

/// The part of a recording transcribed for good: its text and where it ends, in samples at
/// [`WHISPER_RATE`].
#[derive(Default)]
pub(super) struct Transcript {
    text: String,
    pub(super) offset: usize,
}

/// The whole text of `audio` (at [`WHISPER_RATE`]): `transcript`'s, extended by segments that
/// end at pauses, and the rest. The segments are added to `transcript` for good.
pub(super) fn advance(
    whisper: &Mutex<Option<Engine>>,
    model: &Path,
    audio: &[f32],
    transcript: &mut Transcript,
) -> Result<String> {
    let segment = (SEGMENT_SECONDS * WHISPER_RATE as f32) as usize;
    while audio.len().saturating_sub(transcript.offset) > segment {
        let start = transcript.offset;
        let end = start + split_point(&audio[start..start + segment], WHISPER_RATE);
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

/// Where to cut `audio` (at `rate`) to not cut a word: the middle of its quietest tenth of a
/// second within its last quarter.
pub fn split_point(audio: &[f32], rate: u32) -> usize {
    let window = rate as usize / 10;
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

/// What is said in `audio` (at [`WHISPER_RATE`]); nothing for silence or a click.
pub(super) fn transcribe(
    whisper: &Mutex<Option<Engine>>,
    model: &Path,
    audio: &[f32],
) -> Result<String> {
    if !may_hold_speech(audio) {
        return Ok(String::new());
    }
    let mut loaded = whisper.lock().unwrap();
    let mut state = load(&mut loaded, model)?
        .context
        .create_state()
        .map_err(whisper_error)?;
    run(&mut state, params(), audio)
}

/// Like [`transcribe`], for the few seconds of audio the teleprompter wants heard right away:
/// it takes a fraction of the time and only gets to give a rough answer.
pub(super) fn transcribe_latest(
    whisper: &Mutex<Option<Engine>>,
    model: &Path,
    audio: &[f32],
) -> Result<String> {
    if !may_hold_speech(audio) {
        return Ok(String::new());
    }
    let mut loaded = whisper.lock().unwrap();
    let engine = load(&mut loaded, model)?;
    if engine.following.is_none() {
        engine.following = Some(engine.context.create_state().map_err(whisper_error)?);
    }
    let state = engine.following.as_mut().expect("set above");
    let mut params = params();
    params.set_audio_ctx(FOLLOW_AUDIO_CONTEXT);
    params.set_single_segment(true);
    params.set_max_tokens(FOLLOW_MAX_TOKENS);
    // No second try at a pass gone wrong: the next one is about to start.
    params.set_temperature_inc(0.0);
    run(state, params, audio)
}

pub(super) fn may_hold_speech(audio: &[f32]) -> bool {
    audio.len() as f32 >= MIN_SECONDS * WHISPER_RATE as f32 && sound::rms(audio) >= SILENCE_RMS
}

/// The settings every transcription starts from.
pub(super) fn params() -> FullParams<'static, 'static> {
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
    params
}

/// `audio` padded with silence to the least whisper.cpp takes.
pub(super) fn padded(audio: &[f32]) -> Vec<f32> {
    let mut audio = audio.to_vec();
    let min = (PAD_SECONDS * WHISPER_RATE as f32) as usize;
    if audio.len() < min {
        audio.resize(min, 0.0);
    }
    audio
}

fn run(state: &mut WhisperState, params: FullParams, audio: &[f32]) -> Result<String> {
    state.full(params, &padded(audio)).map_err(whisper_error)?;
    let text: Vec<String> = state
        .as_iter()
        .filter_map(|segment| segment.to_str_lossy().ok().map(|s| s.into_owned()))
        .collect();
    Ok(clean_transcript(&text.join(" ")))
}

/// The loaded model, loading it first if needed.
pub(super) fn load<'a>(loaded: &'a mut Option<Engine>, model: &Path) -> Result<&'a mut Engine> {
    if loaded.is_none() {
        if !model.is_file() {
            return Err(Error::msg("The speech model is not downloaded."));
        }
        whisper_rs::install_logging_hooks();
        let context = WhisperContext::new_with_params(model, WhisperContextParameters::default())
            .map_err(whisper_error)?;
        *loaded = Some(Engine {
            context,
            following: None,
        });
    }
    Ok(loaded.as_mut().expect("loaded above"))
}

pub(super) fn whisper_error(e: whisper_rs::WhisperError) -> Error {
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

#[cfg(test)]
mod tests {
    use super::*;

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
        let err = load(&mut loaded, Path::new("/nonexistent/model.bin"))
            .err()
            .unwrap();
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
        assert_eq!(transcribe_latest(&whisper, model, &quiet).unwrap(), "");
        assert_eq!(transcribe_latest(&whisper, model, &[0.5; 100]).unwrap(), "");
        assert!(transcribe_latest(&whisper, model, &speech).is_err());
    }

    // Following looks at all of the audio it keeps, and no more than the model can. Each unit of
    // audio context covers two 10 ms frames.
    const _: () = assert!(FOLLOW_AUDIO_CONTEXT as usize * 2 >= FOLLOW_SECONDS * 100);
    const _: () = assert!(FOLLOW_AUDIO_CONTEXT <= 1500);

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
        let cut = split_point(&audio, WHISPER_RATE);
        assert!(
            (rate * 17..rate * 17 + rate / 5).contains(&cut),
            "cut {cut}"
        );
        // A pause early on is ignored: the segment should stay long.
        let mut early = vec![0.3; rate * 20];
        early[rate..rate * 2].fill(0.0);
        assert!(split_point(&early, WHISPER_RATE) >= rate * 15);
        assert_eq!(split_point(&[0.1; 100], WHISPER_RATE), 100);
    }

    #[test]
    fn joins_transcript_parts_with_a_space() {
        assert_eq!(join_text("", "Hello"), "Hello");
        assert_eq!(join_text("Hello", ""), "Hello");
        assert_eq!(join_text("Hello", "world"), "Hello world");
    }
}
