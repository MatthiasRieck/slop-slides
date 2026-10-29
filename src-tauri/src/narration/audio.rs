//! Narration audio: cutting a script into pieces the speech engine says well, joining what it
//! says back together with pauses, and reading and writing it as WAV files.

use std::fs;
use std::io::{Read, Write};
use std::path::Path;

use crate::error::{Error, Result};

/// The speech engine's sample rate.
pub const RATE: u32 = 24_000;
/// The longest piece of a script said at once, in characters. The engine says up to about
/// 45 seconds at a time; this is well inside it at a narrator's pace.
const MAX_PIECE: usize = 300;
/// Silence between sentences said apart, and between paragraphs, in seconds.
const SENTENCE_PAUSE: f32 = 0.3;
const PARAGRAPH_PAUSE: f32 = 0.7;
/// Samples quieter than this are silence, when trimming it from the ends of a piece.
const SILENCE: f32 = 0.01;
/// Silence kept at each end of a trimmed piece, in seconds, so words do not start abruptly.
const KEEP: f32 = 0.05;

/// A piece of a script, said in one go, and whether a new paragraph starts with it.
#[derive(Debug, Clone, PartialEq)]
pub struct Piece {
    pub text: String,
    pub paragraph: bool,
}

/// `script` cut into pieces of at most [`MAX_PIECE`] characters: whole sentences where they
/// fit, a long sentence at its commas or, failing that, between words.
pub fn pieces(script: &str) -> Vec<Piece> {
    let mut out = Vec::new();
    for paragraph in script.split("\n\n") {
        let text = paragraph.split_whitespace().collect::<Vec<_>>().join(" ");
        let mut first = true;
        let mut current = String::new();
        for sentence in split_keeping(&text, &['.', '!', '?', '…']) {
            for part in fit(sentence) {
                if !current.is_empty() && current.len() + 1 + part.len() > MAX_PIECE {
                    out.push(Piece {
                        text: std::mem::take(&mut current),
                        paragraph: std::mem::take(&mut first) && !out.is_empty(),
                    });
                }
                if !current.is_empty() {
                    current.push(' ');
                }
                current.push_str(&part);
            }
        }
        if !current.is_empty() {
            out.push(Piece {
                text: current,
                paragraph: first && !out.is_empty(),
            });
        }
    }
    out
}

/// `sentence` in parts of at most [`MAX_PIECE`] characters.
fn fit(sentence: &str) -> Vec<String> {
    if sentence.len() <= MAX_PIECE {
        return vec![sentence.to_string()];
    }
    let mut parts = Vec::new();
    let mut current = String::new();
    for clause in split_keeping(sentence, &[',', ';', ':']) {
        for word in clause.split(' ') {
            if !current.is_empty() && current.len() + 1 + word.len() > MAX_PIECE {
                parts.push(std::mem::take(&mut current));
            }
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(word);
        }
        // A clause boundary is a good place to stop once the part is well under way.
        if current.len() > MAX_PIECE / 2 {
            parts.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

/// `text` split after each of `ends` that is followed by a space, keeping the mark.
fn split_keeping<'a>(text: &'a str, ends: &[char]) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut chars = text.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        if ends.contains(&c) && chars.peek().is_some_and(|(_, next)| *next == ' ') {
            let end = at + c.len_utf8();
            out.push(text[start..end].trim());
            start = end;
        }
    }
    out.push(text[start..].trim());
    out.retain(|s| !s.is_empty());
    out
}

/// `samples` without the silence at either end, keeping [`KEEP`] of it.
pub fn trim(samples: &[f32]) -> &[f32] {
    let keep = (KEEP * RATE as f32) as usize;
    let loud = |s: &f32| s.abs() > SILENCE;
    let Some(first) = samples.iter().position(loud) else {
        return &[];
    };
    let last = samples.iter().rposition(loud).unwrap_or(first);
    &samples[first.saturating_sub(keep)..(last + 1 + keep).min(samples.len())]
}

/// The pieces' audio, each trimmed, one after the other with a pause between them.
pub fn join(said: &[(Piece, Vec<f32>)]) -> Vec<f32> {
    let mut out = Vec::new();
    for (i, (piece, samples)) in said.iter().enumerate() {
        if i > 0 {
            let pause = if piece.paragraph {
                PARAGRAPH_PAUSE
            } else {
                SENTENCE_PAUSE
            };
            out.resize(out.len() + (pause * RATE as f32) as usize, 0.0);
        }
        out.extend_from_slice(trim(samples));
    }
    out
}

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
                let samples = data
                    .chunks_exact(2)
                    .map(|b| f32::from(i16::from_le_bytes([b[0], b[1]])) / 32768.0)
                    .collect();
                return Some((samples, rate?));
            }
            _ => {}
        }
        at = body + size + size % 2;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(script: &str) -> Vec<(String, bool)> {
        pieces(script)
            .into_iter()
            .map(|p| (p.text, p.paragraph))
            .collect()
    }

    #[test]
    fn short_scripts_are_said_in_one_piece_per_paragraph() {
        assert_eq!(
            texts("Hello there. How are you?\n\nNext  point,\nsaid here."),
            [
                ("Hello there. How are you?".into(), false),
                ("Next point, said here.".into(), true),
            ]
        );
        assert_eq!(texts(""), Vec::<(String, bool)>::new());
        assert_eq!(texts("\n\n  \n\n"), Vec::<(String, bool)>::new());
    }

    #[test]
    fn long_paragraphs_are_cut_between_sentences() {
        let sentence = "This sentence is about sixty characters long, more or less.";
        let script = [sentence; 12].join(" ");
        let cut = pieces(&script);
        assert!(cut.len() > 1);
        assert!(cut.iter().all(|p| p.text.len() <= MAX_PIECE), "{cut:?}");
        assert!(cut.iter().all(|p| p.text.ends_with('.')));
        assert!(cut.iter().all(|p| !p.paragraph));
        assert_eq!(
            cut.iter()
                .map(|p| p.text.as_str())
                .collect::<Vec<_>>()
                .join(" "),
            script
        );
    }

    #[test]
    fn overlong_sentences_are_cut_at_clauses_or_words() {
        let clause = "and then another clause follows here";
        let sentence = format!("{}.", [clause; 20].join(", "));
        let cut = pieces(&sentence);
        assert!(cut.len() > 1);
        assert!(cut.iter().all(|p| p.text.len() <= MAX_PIECE), "{cut:?}");
        let words = "word ".repeat(200);
        assert!(pieces(&words).iter().all(|p| p.text.len() <= MAX_PIECE));
        // Every word is still said, in order.
        let said: Vec<String> = pieces(&words).into_iter().map(|p| p.text).collect();
        assert_eq!(said.join(" "), words.trim());
    }

    #[test]
    fn decimals_and_abbreviations_without_a_space_stay_together() {
        assert_eq!(
            texts("It grew 2.5 times."),
            [("It grew 2.5 times.".into(), false)]
        );
    }

    #[test]
    fn trimming_keeps_a_little_silence_around_the_sound() {
        let mut samples = vec![0.0; RATE as usize];
        samples.extend(vec![0.5; 100]);
        samples.extend(vec![0.0; RATE as usize]);
        let keep = (KEEP * RATE as f32) as usize;
        assert_eq!(trim(&samples).len(), 100 + 2 * keep);
        assert!(trim(&[0.0; 500]).is_empty());
    }

    #[test]
    fn pieces_are_joined_with_sentence_and_paragraph_pauses() {
        let piece = |paragraph| Piece {
            text: "x".into(),
            paragraph,
        };
        let sound = vec![0.5; 10];
        let joined = join(&[
            (piece(false), sound.clone()),
            (piece(false), sound.clone()),
            (piece(true), sound.clone()),
        ]);
        let pauses = ((SENTENCE_PAUSE + PARAGRAPH_PAUSE) * RATE as f32) as usize;
        assert_eq!(joined.len(), 30 + pauses);
        assert_eq!(join(&[]), Vec::<f32>::new());
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
}
