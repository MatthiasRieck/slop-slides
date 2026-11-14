//! Captions for a narrated video: a `.srt` or `.vtt` file next to the MP4, which players and
//! video sites show under the picture. What is said comes from each slide's narration script,
//! cut into lines short enough to read; when each line shows comes from when its words are said
//! (see narration/words.rs), or, for audio whose words are not timed, from spreading the script
//! evenly over the audio.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::voice::Word;

/// The longest a caption is, in characters: two lines of 42, as broadcasters keep them.
const MAX_CHARS: usize = 84;
/// The shortest a caption stays up, in seconds, where the audio leaves room for it.
const MIN_SECONDS: f64 = 0.7;

/// The file captions are written as.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    /// SubRip, which nearly every player and video site reads.
    Srt,
    /// WebVTT, the web's own, for a `<track>` beside a `<video>`.
    Vtt,
}

impl Format {
    pub fn extension(self) -> &'static str {
        match self {
            Format::Srt => "srt",
            Format::Vtt => "vtt",
        }
    }
}

/// Where the captions of the video at `video` go: beside it, under its name.
pub fn file_for(video: &Path, format: Format) -> PathBuf {
    video.with_extension(format.extension())
}

/// One slide's narration in the video.
#[derive(Debug, Clone, PartialEq)]
pub struct Spoken<'a> {
    /// What is said, as plain text (see [`crate::narration::spoken`]).
    pub text: &'a str,
    /// When its audio starts in the video, and how long it lasts, in seconds.
    pub start: f64,
    pub length: f64,
    /// When each word is said, in seconds from the start of the audio, where that is known.
    pub words: Option<&'a [Word]>,
}

/// A caption: what shows from `start` to `end`, in seconds of video.
#[derive(Debug, Clone, PartialEq)]
pub struct Cue {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// `text` cut into captions' worth of words: at the ends of sentences, and inside a sentence
/// longer than [`MAX_CHARS`] at a comma where there is one, else between two words.
pub fn phrases(text: &str) -> Vec<String> {
    let mut phrases: Vec<String> = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        let fits =
            current.is_empty() || current.chars().count() + 1 + word.chars().count() <= MAX_CHARS;
        if !fits {
            // Back to the last comma, when that leaves a caption of some length.
            let comma = current
                .rfind([',', ';', ':'])
                .filter(|at| *at >= current.len() / 3 && *at + 1 < current.len());
            match comma {
                Some(at) => {
                    let rest = current.split_off(at + 1);
                    phrases.push(std::mem::take(&mut current));
                    current = rest.trim().to_string();
                }
                None => phrases.push(std::mem::take(&mut current)),
            }
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(word);
        let ends_sentence = word
            .trim_end_matches(['"', '\'', ')', ']', '”', '’'])
            .ends_with(['.', '!', '?', '…']);
        if ends_sentence {
            phrases.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        phrases.push(current);
    }
    phrases
}

/// The captions of one slide's narration.
fn cues_of(spoken: &Spoken) -> Vec<Cue> {
    let phrases = phrases(spoken.text);
    let counts: Vec<usize> = phrases
        .iter()
        .map(|p| p.split_whitespace().count())
        .collect();
    let total: usize = counts.iter().sum();
    if total == 0 || spoken.length <= 0.0 {
        return Vec::new();
    }
    let words = spoken.words.filter(|w| !w.is_empty());
    // When the script's word `n` is said, in seconds from the start of the audio: the heard
    // word standing where it does (the two counts differ where a number is spelled out), or
    // its share of the audio.
    let said_at = |n: usize| -> f64 {
        if n >= total {
            return spoken.length;
        }
        match words {
            Some(words) => words[n * words.len() / total].start,
            None => spoken.length * n as f64 / total as f64,
        }
    };
    let mut cues = Vec::with_capacity(phrases.len());
    let mut before = 0;
    for (phrase, count) in phrases.into_iter().zip(counts) {
        let from = said_at(before).clamp(0.0, spoken.length);
        before += count;
        let to = said_at(before).clamp(from, spoken.length);
        cues.push(Cue {
            start: spoken.start + from,
            end: spoken.start + to,
            text: phrase,
        });
    }
    // A caption too short to read stays until the next one, or its own least time.
    let last = spoken.start + spoken.length;
    for index in 0..cues.len() {
        let limit = cues
            .get(index + 1)
            .map_or(last.max(cues[index].start + MIN_SECONDS), |next| next.start);
        let least = (cues[index].start + MIN_SECONDS).min(limit);
        cues[index].end = cues[index].end.max(least).min(limit.max(cues[index].start));
    }
    cues.retain(|cue| cue.end > cue.start);
    cues
}

/// The captions of the whole video: each narration's, in the order they are said. A caption
/// ends when the next one starts, should narrations run into one another.
pub fn cues(spoken: &[Spoken]) -> Vec<Cue> {
    let mut all: Vec<Cue> = spoken.iter().flat_map(cues_of).collect();
    all.sort_by(|a, b| a.start.total_cmp(&b.start));
    for index in 1..all.len() {
        let next = all[index].start;
        if all[index - 1].end > next {
            all[index - 1].end = next;
        }
    }
    all.retain(|cue| cue.end > cue.start);
    all
}

/// `seconds` as `00:01:02,345` (SubRip) or `00:01:02.345` (WebVTT).
fn timestamp(seconds: f64, separator: char) -> String {
    let millis = (seconds.max(0.0) * 1000.0).round() as u64;
    format!(
        "{:02}:{:02}:{:02}{separator}{:03}",
        millis / 3_600_000,
        millis / 60_000 % 60,
        millis / 1000 % 60,
        millis % 1000
    )
}

/// A caption's text on two lines when it is longer than one: broken at the space nearest its
/// middle.
fn two_lines(text: &str) -> String {
    let length = text.chars().count();
    if length <= MAX_CHARS / 2 {
        return text.to_string();
    }
    let middle = text
        .char_indices()
        .nth(length / 2)
        .map_or(text.len(), |(at, _)| at);
    let before = text[..middle].rfind(' ');
    let after = text[middle..].find(' ').map(|at| at + middle);
    let at = match (before, after) {
        (Some(b), Some(a)) if middle - b <= a - middle => b,
        (_, Some(a)) => a,
        (Some(b), None) => b,
        (None, None) => return text.to_string(),
    };
    format!("{}\n{}", &text[..at], &text[at + 1..])
}

/// The captions as the text of a file of `format`.
pub fn write(format: Format, cues: &[Cue]) -> String {
    let mut out = String::new();
    if format == Format::Vtt {
        out.push_str("WEBVTT\n\n");
    }
    let separator = match format {
        Format::Srt => ',',
        Format::Vtt => '.',
    };
    for (index, cue) in cues.iter().enumerate() {
        if format == Format::Srt {
            out.push_str(&format!("{}\n", index + 1));
        }
        // WebVTT reads "-->" and markup in a caption as its own; SubRip takes text as it is.
        let text = match format {
            Format::Srt => two_lines(&cue.text),
            Format::Vtt => two_lines(&cue.text)
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;"),
        };
        out.push_str(&format!(
            "{} --> {}\n{text}\n\n",
            timestamp(cue.start, separator),
            timestamp(cue.end, separator),
        ));
    }
    out
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

    fn spoken(text: &str, start: f64, length: f64) -> Spoken<'_> {
        Spoken {
            text,
            start,
            length,
            words: None,
        }
    }

    #[test]
    fn captions_go_beside_the_video_under_its_name() {
        let video = Path::new("/out/Q3 plan.v2.mp4");
        assert_eq!(
            file_for(video, Format::Srt),
            Path::new("/out/Q3 plan.v2.srt")
        );
        assert_eq!(
            file_for(video, Format::Vtt),
            Path::new("/out/Q3 plan.v2.vtt")
        );
        assert_eq!(
            serde_json::from_str::<Format>("\"vtt\"").unwrap(),
            Format::Vtt
        );
    }

    #[test]
    fn a_script_is_cut_at_the_ends_of_sentences() {
        assert_eq!(
            phrases("Welcome, everyone. This is our plan!  Any questions?"),
            ["Welcome, everyone.", "This is our plan!", "Any questions?"]
        );
        assert_eq!(
            phrases("She said \"go.\" Then we left"),
            ["She said \"go.\"", "Then we left"]
        );
        assert!(phrases("  \n ").is_empty());
    }

    #[test]
    fn a_long_sentence_is_cut_at_a_comma_or_between_words() {
        let long = "We looked at every option the team proposed over the last quarter, and in the end the one that costs the least also turned out to be the one people liked most";
        let cut = phrases(long);
        assert!(cut.len() >= 2, "{cut:?}");
        assert!(
            cut.iter().all(|p| p.chars().count() <= MAX_CHARS),
            "{cut:?}"
        );
        assert!(cut[0].ends_with("quarter,"), "{cut:?}");
        assert_eq!(cut.join(" "), long, "no word is lost");
        let no_commas = "word ".repeat(40);
        let cut = phrases(&no_commas);
        assert!(cut.iter().all(|p| p.chars().count() <= MAX_CHARS));
        assert_eq!(cut.iter().map(|p| p.split(' ').count()).sum::<usize>(), 40);
    }

    #[test]
    fn untimed_words_are_spread_evenly_over_the_audio() {
        let cues = cues(&[spoken(
            "One two three four. Five six seven eight.",
            10.0,
            8.0,
        )]);
        assert_eq!(cues.len(), 2);
        assert_eq!((cues[0].start, cues[0].end), (10.0, 14.0));
        assert_eq!((cues[1].start, cues[1].end), (14.0, 18.0));
        assert_eq!(cues[1].text, "Five six seven eight.");
    }

    #[test]
    fn timed_words_say_when_each_caption_shows() {
        let words = [
            word("Hello", 0.2, 0.5),
            word("there.", 0.5, 0.9),
            word("Now", 2.5, 2.7),
            word("we", 2.7, 2.8),
            word("begin.", 2.8, 3.4),
        ];
        let said = Spoken {
            text: "Hello there. Now we begin.",
            start: 1.0,
            length: 4.0,
            words: Some(&words),
        };
        let cues = cues(&[said]);
        assert_eq!(cues.len(), 2);
        assert!((cues[0].start - 1.2).abs() < 1e-9, "{cues:?}");
        assert!((cues[0].end - 3.5).abs() < 1e-9, "it stays until the next");
        assert!((cues[1].start - 3.5).abs() < 1e-9);
        assert!(
            (cues[1].end - 5.0).abs() < 1e-9,
            "the last until the audio ends"
        );
    }

    #[test]
    fn heard_words_that_differ_in_number_from_the_script_still_time_it() {
        // "2024" is heard as three words.
        let words = [
            word("In", 0.0, 0.2),
            word("twenty", 0.2, 0.5),
            word("twenty", 0.5, 0.8),
            word("four.", 0.8, 1.2),
            word("Done.", 3.0, 3.5),
        ];
        let said = Spoken {
            text: "In 2024. Done.",
            start: 0.0,
            length: 4.0,
            words: Some(&words),
        };
        let cues = cues(&[said]);
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].start, 0.0);
        assert!(cues[1].start > 0.5 && cues[1].start <= 3.0, "{cues:?}");
        assert_eq!(cues[1].end, 4.0);
    }

    #[test]
    fn narrations_that_run_into_one_another_do_not_overlap_in_the_captions() {
        let cues = cues(&[
            spoken("First slide talks long.", 0.0, 6.0),
            spoken("Second starts early.", 5.0, 3.0),
            spoken("", 9.0, 2.0),
        ]);
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].end, 5.0);
        assert_eq!((cues[1].start, cues[1].end), (5.0, 8.0));
    }

    #[test]
    fn writes_subrip() {
        let cues = [
            Cue {
                start: 0.5,
                end: 2.25,
                text: "Hello <there> & welcome.".into(),
            },
            Cue {
                start: 3723.004,
                end: 3725.0,
                text: "This caption is long enough that it has to go on two lines to be read."
                    .into(),
            },
        ];
        assert_eq!(
            write(Format::Srt, &cues),
            "1\n00:00:00,500 --> 00:00:02,250\nHello <there> & welcome.\n\n2\n01:02:03,004 --> 01:02:05,000\nThis caption is long enough that it\nhas to go on two lines to be read.\n\n"
        );
        assert_eq!(write(Format::Srt, &[]), "");
    }

    #[test]
    fn writes_webvtt_with_its_header_and_escaped_text() {
        let cues = [Cue {
            start: 0.5,
            end: 2.25,
            text: "Hello <there> & welcome.".into(),
        }];
        assert_eq!(
            write(Format::Vtt, &cues),
            "WEBVTT\n\n00:00:00.500 --> 00:00:02.250\nHello &lt;there&gt; &amp; welcome.\n\n"
        );
        assert_eq!(write(Format::Vtt, &[]), "WEBVTT\n\n");
    }
}
