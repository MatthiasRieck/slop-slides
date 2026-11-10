//! How a deck plays out with its narration, as a video export or the self-running show plays it
//! (see [`crate::video::Options::timeline`]): when each shown slide starts and ends, when each
//! narration plays, and which slide is showing at any moment. For the agent's timing tools
//! (src/mcp.rs) and the narration lint.

use std::path::Path;

use serde_json::{json, Value};

use crate::deck::Deck;
use crate::video;

use super::{statuses, AudioState};

/// The export's settings the deck does not pin, as the app ships them (src/lib/video.ts): the
/// user may have changed them for their exports, which a slide's `data-duration` and
/// `data-narration-start` override.
pub const DEFAULTS: video::Options = video::Options {
    seconds_per_slide: 5.0,
    fps: 30,
    animate: true,
    narration: true,
    pause_before: 0.5,
    pause_after: 1.0,
};

/// A shown slide on the timeline. Times are seconds from the start of the show.
#[derive(Debug, Clone, PartialEq)]
pub struct Shown {
    pub id: String,
    pub start: f64,
    pub end: f64,
    /// Its `data-duration`, when it pins its length.
    pub duration: Option<f64>,
    /// Its `data-narration-start`, when it pins when its narration starts.
    pub narration_start: Option<f64>,
    pub narration: Option<Clip>,
    /// It has a narration script whose audio is missing or out of date: the export says it
    /// first, so its length is not known yet and it is left out here.
    pub unspoken: bool,
}

/// A slide's narration audio on the timeline.
#[derive(Debug, Clone, PartialEq)]
pub struct Clip {
    pub start: f64,
    pub end: f64,
    /// It is the presenter's own recording or audio made elsewhere, not a narration service's.
    pub recorded: bool,
    /// It is audio made elsewhere.
    pub imported: bool,
    /// When it would have started had the narration before it not still been playing: it
    /// never talks over that one, so it waits.
    pub planned: f64,
}

/// Where a slide's narration audio came from.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Source {
    /// Audio made elsewhere and brought in.
    Imported,
    /// The presenter's own recording.
    Recording,
    /// Speech a narration service made from the script.
    Voice,
}

impl Source {
    /// How the timeline's data names it.
    pub fn id(self) -> &'static str {
        match self {
            Source::Imported => "imported",
            Source::Recording => "recording",
            Source::Voice => "voice",
        }
    }
}

impl Clip {
    pub fn source(&self) -> Source {
        match (self.imported, self.recorded) {
            (true, _) => Source::Imported,
            (_, true) => Source::Recording,
            _ => Source::Voice,
        }
    }

    /// How much later than planned it starts, in seconds: below zero when planned before the
    /// show starts.
    fn late(&self) -> f64 {
        self.start - self.planned.max(0.0)
    }

    /// It starts later than planned, waiting for the narration before it.
    pub fn waited(&self) -> bool {
        self.start > self.planned + 0.005
    }
}

/// Seconds as the timing data saves them: to the millisecond.
pub fn ms(seconds: f64) -> f64 {
    (seconds * 1000.0).round() / 1000.0
}

/// The deck's shown slides on the timeline, laid out with `options`.
pub fn layout(file: &Path, deck: &Deck, options: &video::Options) -> Vec<Shown> {
    let audio = statuses(file, deck);
    let shown: Vec<_> = deck
        .slides
        .iter()
        .zip(&audio)
        .filter(|(slide, _)| !slide.hidden)
        .collect();
    let timings: Vec<video::Timing> = shown
        .iter()
        .map(|(slide, audio)| video::Timing {
            narration: audio.seconds.filter(|_| audio.state == AudioState::Ready),
            duration: slide.duration,
            narration_start: slide.narration_start,
        })
        .collect();
    let timeline = options.timeline(&timings);
    let fps = f64::from(options.fps);
    let mut frames = 0;
    shown
        .iter()
        .zip(&timings)
        .zip(timeline.frames.iter().zip(&timeline.starts))
        .map(|(((slide, audio), timing), (length, clip))| {
            let start = f64::from(frames) / fps;
            frames += length;
            let offset = slide.narration_start.unwrap_or(options.pause_before);
            Shown {
                id: slide.id.clone(),
                start,
                end: f64::from(frames) / fps,
                duration: slide.duration,
                narration_start: slide.narration_start,
                narration: clip.zip(timing.narration).map(|(at, seconds)| Clip {
                    start: at,
                    end: at + seconds,
                    recorded: audio.recorded,
                    imported: audio.imported,
                    planned: start + offset,
                }),
                unspoken: matches!(audio.state, AudioState::Missing | AudioState::Stale),
            }
        })
        .collect()
}

/// The slide showing at `time`: the last one to have started by then.
pub fn showing(slides: &[Shown], time: f64) -> Option<&Shown> {
    slides
        .iter()
        .take_while(|s| s.start <= time + 1e-9)
        .last()
        .or(slides.first())
}

/// A moment of a slide's narration audio placed on the timeline.
#[derive(Debug, Clone, PartialEq)]
pub struct Placed {
    /// Seconds into the show.
    pub at: f64,
    /// The slide showing then, and seconds since it started showing: what an animation
    /// delay on that slide is.
    pub slide: String,
    pub into_slide: f64,
}

/// `seconds` into slide `clip_of`'s narration audio, placed on the timeline.
pub fn place(slides: &[Shown], clip_of: &str, seconds: f64) -> Option<Placed> {
    let clip = slides
        .iter()
        .find(|s| s.id == clip_of)?
        .narration
        .as_ref()?;
    let at = clip.start + seconds;
    let slide = showing(slides, at)?;
    Some(Placed {
        at,
        slide: slide.id.clone(),
        into_slide: at - slide.start,
    })
}

/// A slide whose own narration plays while another's still does, so it has to wait, as the
/// lint reports it (see [`crate::lint::narration_overlaps`]).
#[derive(Debug, Clone, PartialEq)]
pub struct Overlap {
    pub slide: String,
    /// The earlier slide whose narration still plays.
    pub under: String,
    /// How long it waits, in seconds.
    pub waits: f64,
    /// It only starts once the slide stopped showing.
    pub after_end: bool,
}

/// The slides whose narration waits for an earlier slide's, laid out with `options`.
pub fn overlaps(slides: &[Shown]) -> Vec<Overlap> {
    let mut found = Vec::new();
    for (i, slide) in slides.iter().enumerate() {
        let Some(clip) = &slide.narration else {
            continue;
        };
        let waits = clip.late();
        if waits < 0.005 {
            continue;
        }
        let under = slides[..i]
            .iter()
            .rev()
            .find(|s| s.narration.as_ref().is_some_and(|c| c.end > clip.planned))
            .map_or_else(String::new, |s| s.id.clone());
        found.push(Overlap {
            slide: slide.id.clone(),
            under,
            waits,
            after_end: clip.start >= slide.end - 0.005,
        });
    }
    found
}

/// The other slides showing while the narration of `slide` plays.
pub fn plays_over<'a>(slides: &'a [Shown], slide: &Shown) -> Vec<&'a str> {
    let Some(clip) = &slide.narration else {
        return Vec::new();
    };
    slides
        .iter()
        .filter(|s| s.id != slide.id && s.start < clip.end - 0.005 && s.end > clip.start)
        .map(|s| s.id.as_str())
        .collect()
}

/// A word of a slide's narration placed on the timeline.
#[derive(Debug, Clone, PartialEq)]
pub struct PlacedWord {
    pub text: String,
    /// When it is said, in seconds into the show.
    pub start: f64,
    pub end: f64,
    /// The slide showing as it starts, and seconds since that slide started showing.
    pub slide: String,
    pub into_slide: f64,
}

/// When the words of a slide's narration are said.
#[derive(Debug, Clone, PartialEq)]
pub enum Words {
    /// They are not timed (see [`super::time_words`]).
    NotTimed,
    /// No words are heard in it.
    NoneHeard,
    /// Its words that fall on the timeline.
    Said(Vec<PlacedWord>),
}

/// How a deck plays out with its narration, as the agent's narration_timeline tells it.
#[derive(Debug, Clone, PartialEq)]
pub struct Timeline {
    /// The deck's shown slides, laid out with [`DEFAULTS`].
    pub slides: Vec<Shown>,
    /// The words of each shown slide's narration that plays, by its slide id, in slide
    /// order; None when not asked for.
    pub words: Option<Vec<(String, Words)>>,
}

/// How the deck `file` plays out with its narration, laid out with [`DEFAULTS`], with when
/// the words of each narration are said if `with_words`.
pub fn timeline(file: &Path, deck: &Deck, with_words: bool) -> Timeline {
    let slides = layout(file, deck, &DEFAULTS);
    let words = with_words.then(|| {
        slides
            .iter()
            .filter(|s| s.narration.is_some())
            .map(|slide| {
                let words = match super::words(file, &slide.id) {
                    None => Words::NotTimed,
                    Some(words) if words.is_empty() => Words::NoneHeard,
                    Some(words) => Words::Said(
                        words
                            .into_iter()
                            .filter_map(|word| {
                                let at = place(&slides, &slide.id, word.start)?;
                                Some(PlacedWord {
                                    start: at.at,
                                    end: at.at + word.end - word.start,
                                    slide: at.slide,
                                    into_slide: at.into_slide,
                                    text: word.text,
                                })
                            })
                            .collect(),
                    ),
                };
                (slide.id.clone(), words)
            })
            .collect()
    });
    Timeline { slides, words }
}

impl Timeline {
    /// When the show ends, in seconds.
    pub fn end(&self) -> f64 {
        self.slides.last().map_or(0.0, |s| s.end)
    }

    /// The timeline as JSON for the agent's scripts, of the deck `deck` (as the agent named
    /// it), times to the millisecond.
    pub fn data(&self, deck: &str) -> Value {
        let d = DEFAULTS;
        let slides: Vec<Value> = self
            .slides
            .iter()
            .map(|slide| {
                json!({
                    "id": slide.id,
                    "start": ms(slide.start),
                    "end": ms(slide.end),
                    "duration": slide.duration,
                    "narrationStart": slide.narration_start,
                    "narration": slide.narration.as_ref().map(|clip| json!({
                        "start": ms(clip.start),
                        "end": ms(clip.end),
                        "source": clip.source().id(),
                        "waits": ms(clip.late()).max(0.0),
                    })),
                    "unspoken": slide.unspoken,
                })
            })
            .collect();
        let mut words = Vec::new();
        for (audio, said) in self.words.iter().flatten() {
            let Words::Said(said) = said else {
                continue;
            };
            for word in said {
                words.push(json!({
                    "audio": audio,
                    "text": word.text,
                    "start": ms(word.start),
                    "end": ms(word.end),
                    "slide": word.slide,
                    "intoSlide": ms(word.into_slide),
                }));
            }
        }
        json!({
            "deck": deck,
            "assumed": {
                "secondsPerSlide": d.seconds_per_slide,
                "pauseBefore": d.pause_before,
                "pauseAfter": d.pause_after,
            },
            "end": ms(self.end()),
            "slides": slides,
            "words": words,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::narration::audio;
    use crate::narration::recordings::import_audio;
    use std::fs;

    fn deck(slides: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("slopslide-timeline-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("deck.html");
        fs::write(
            &file,
            format!("<html><body><main class=\"deck\">{slides}</main></body></html>"),
        )
        .unwrap();
        (dir, file)
    }

    fn give_audio(dir: &Path, file: &Path, slide: &str, seconds: f64) {
        let source = dir.join(format!("{slide}-take.wav"));
        let samples = vec![0.0; (seconds * f64::from(audio::RATE)) as usize];
        audio::write_wav(&source, &samples, audio::RATE).unwrap();
        import_audio(file, slide, &source).unwrap();
    }

    #[test]
    fn slides_and_narration_are_laid_out_as_the_export_plays_them() {
        let (dir, file) = deck(concat!(
            r#"<section class="slide" id="a"></section>"#,
            r#"<section class="slide" id="b" data-narration-start="0"></section>"#,
            r#"<section class="slide" id="hidden" data-hidden></section>"#,
            r#"<section class="slide" id="c" data-duration="2"><aside class="narration">Not said yet.</aside></section>"#,
        ));
        give_audio(&dir, &file, "a", 6.0);
        give_audio(&dir, &file, "b", 3.0);
        let deck = crate::deck::load(&file).unwrap();
        let slides = layout(&file, &deck, &DEFAULTS);
        let ids: Vec<&str> = slides.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["a", "b", "c"], "hidden slides are not shown");
        // a: 0.5 s pause, 6 s of audio, 1 s after.
        assert_eq!((slides[0].start, slides[0].end), (0.0, 7.5));
        let clip = slides[0].narration.as_ref().unwrap();
        assert_eq!(
            (clip.start, clip.end, clip.recorded, clip.imported),
            (0.5, 6.5, true, true)
        );
        // b pins its narration to its start, and shows at least the 5 s a slide does.
        assert_eq!((slides[1].start, slides[1].end), (7.5, 12.5));
        assert_eq!(slides[1].narration.as_ref().unwrap().start, 7.5);
        // c pins its length; its script has no audio yet.
        assert_eq!((slides[2].start, slides[2].end), (12.5, 14.5));
        assert!(slides[2].narration.is_none() && slides[2].unspoken);
        assert!(overlaps(&slides).is_empty());

        assert_eq!(
            place(&slides, "a", 2.0),
            Some(Placed {
                at: 2.5,
                slide: "a".into(),
                into_slide: 2.5
            })
        );
        assert_eq!(place(&slides, "c", 0.0), None);
        assert_eq!(showing(&slides, 100.0).unwrap().id, "c");
        assert_eq!(showing(&slides, 7.5).unwrap().id, "b");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn audio_pinned_to_a_short_slide_plays_on_over_the_next_ones() {
        let (dir, file) = deck(concat!(
            r#"<section class="slide" id="song" data-duration="2" data-narration-start="0"></section>"#,
            r#"<section class="slide" id="verse" data-duration="4"></section>"#,
            r#"<section class="slide" id="chorus" data-duration="3"></section>"#,
            r#"<section class="slide" id="talk" data-duration="2" data-narration-start="0.5"></section>"#,
            r#"<section class="slide" id="end" data-duration="2"></section>"#,
        ));
        give_audio(&dir, &file, "song", 8.0);
        give_audio(&dir, &file, "talk", 1.0);
        let deck = crate::deck::load(&file).unwrap();
        let slides = layout(&file, &deck, &DEFAULTS);
        // The song plays over verse and chorus.
        let at = |s: f64| place(&slides, "song", s).unwrap();
        assert_eq!((at(1.0).slide.as_str(), at(1.0).into_slide), ("song", 1.0));
        assert_eq!(at(3.0).slide, "verse");
        assert!((at(3.0).into_slide - 1.0).abs() < 1e-9);
        assert_eq!(at(7.0).slide, "chorus");
        // The song is over by 8 s, before talk's narration starts at 9.5 s.
        assert!(overlaps(&slides).is_empty());

        // A longer song runs into talk's own narration, which waits for it, past its end.
        give_audio(&dir, &file, "song", 12.0);
        let slides = layout(&file, &deck, &DEFAULTS);
        let found = overlaps(&slides);
        assert_eq!(found.len(), 1);
        assert_eq!(
            (found[0].slide.as_str(), found[0].under.as_str()),
            ("talk", "song")
        );
        assert!((found[0].waits - 2.5).abs() < 1e-9);
        assert!(
            found[0].after_end,
            "talk shows 9 s to 11 s; its narration waits until 12 s"
        );
        // The last slide stays until the last word.
        assert_eq!(slides.last().unwrap().end, 13.0);
        // The deck's lint reports it.
        let issues = crate::deck::lint(&file, None).unwrap();
        let waiting: Vec<_> = issues
            .iter()
            .filter(|i| i.rule == "narration-overlap")
            .map(|i| i.slide.as_deref())
            .collect();
        assert_eq!(waiting, [Some("talk")]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_timeline_tells_where_each_narration_comes_from_and_when_its_words_are_said() {
        use super::super::manifest::{Entry, Manifest};
        use crate::narration::{append_recording, audio_dir, audio_file, fingerprint, Provider};
        use crate::voice::Word;
        let dir = crate::test_support::TempDir::new("narration-timeline");
        let file = dir.write(
            "deck.html",
            concat!(
                r#"<main class="deck">"#,
                r#"<section class="slide" id="v"><aside class="narration">Say v.</aside></section>"#,
                r#"<section class="slide" id="h" data-hidden></section>"#,
                r#"<section class="slide" id="rec"></section>"#,
                r#"<section class="slide" id="long" data-duration="2" data-narration-start="0"></section>"#,
                r#"<section class="slide" id="w" data-duration="2" data-narration-start="0.5"></section>"#,
                r#"<section class="slide" id="u"><aside class="narration">Not said yet.</aside></section>"#,
                r#"</main>"#,
            ),
        );
        let word = |text: &str, start: f64, end: f64| Word {
            text: text.into(),
            start,
            end,
        };
        // v: speech a service made, its words timed as it said them.
        fs::create_dir_all(audio_dir(&file)).unwrap();
        audio::write_wav(&audio_file(&file, "v"), &[0.1; 36_000], audio::RATE).unwrap();
        Manifest::update(&audio_dir(&file), |m| {
            let made = fingerprint(Provider::OpenAi, "Say v.", "marin", "en");
            let words = vec![word("Say", 0.1, 0.5), word("v.", 0.6, 1.2)];
            m.slides
                .insert("v".into(), Entry::made(made, 1.5, Some(words)));
        })
        .unwrap();
        // rec: the presenter's recording, untimed.
        append_recording(&file, "rec", &[0.1; 16_000], 16_000).unwrap();
        // long: 7 s brought in on a 2 s slide, playing on over w, whose own audio waits.
        give_audio(&dir, &file, "long", 7.0);
        give_audio(&dir, &file, "w", 1.0);
        Manifest::update(&audio_dir(&file), |m| {
            let timed = |e: &mut Entry, words: Vec<Word>| {
                e.words = Some(words);
                e.timing = super::super::manifest::WORD_TIMING;
            };
            timed(
                m.slides.get_mut("long").unwrap(),
                vec![word("later", 3.0, 3.5)],
            );
            timed(m.slides.get_mut("w").unwrap(), vec![]);
        })
        .unwrap();
        let deck = crate::deck::load(&file).unwrap();

        let found = timeline(&file, &deck, true);
        let sources: Vec<Option<Source>> = found
            .slides
            .iter()
            .map(|s| s.narration.as_ref().map(Clip::source))
            .collect();
        assert_eq!(
            sources,
            [
                Some(Source::Voice),
                Some(Source::Recording),
                Some(Source::Imported),
                Some(Source::Imported),
                None
            ]
        );
        let waited: Vec<bool> = found
            .slides
            .iter()
            .filter_map(|s| s.narration.as_ref().map(Clip::waited))
            .collect();
        assert_eq!(waited, [false, false, false, true]);
        let over = |id: &str| {
            plays_over(
                &found.slides,
                found.slides.iter().find(|s| s.id == id).unwrap(),
            )
        };
        assert_eq!(over("long"), ["w", "u"]);
        assert_eq!(over("w"), ["u"]);
        assert!(over("v").is_empty() && over("u").is_empty());
        let words = found.words.as_ref().unwrap();
        let kinds: Vec<(&str, &str)> = words
            .iter()
            .map(|(id, w)| {
                let kind = match w {
                    Words::NotTimed => "not timed",
                    Words::NoneHeard => "none heard",
                    Words::Said(_) => "said",
                };
                (id.as_str(), kind)
            })
            .collect();
        assert_eq!(
            kinds,
            [
                ("v", "said"),
                ("rec", "not timed"),
                ("long", "said"),
                ("w", "none heard")
            ]
        );
        assert_eq!(found.end(), 19.0);
        assert_eq!(
            found.data("deck.html"),
            serde_json::json!({
                "deck": "deck.html",
                "assumed": {"secondsPerSlide": 5.0, "pauseBefore": 0.5, "pauseAfter": 1.0},
                "end": 19.0,
                "slides": [
                    {"id": "v", "start": 0.0, "end": 5.0, "duration": null, "narrationStart": null,
                     "narration": {"start": 0.5, "end": 2.0, "source": "voice", "waits": 0.0}, "unspoken": false},
                    {"id": "rec", "start": 5.0, "end": 10.0, "duration": null, "narrationStart": null,
                     "narration": {"start": 5.5, "end": 6.5, "source": "recording", "waits": 0.0}, "unspoken": false},
                    {"id": "long", "start": 10.0, "end": 12.0, "duration": 2.0, "narrationStart": 0.0,
                     "narration": {"start": 10.0, "end": 17.0, "source": "imported", "waits": 0.0}, "unspoken": false},
                    {"id": "w", "start": 12.0, "end": 14.0, "duration": 2.0, "narrationStart": 0.5,
                     "narration": {"start": 17.0, "end": 18.0, "source": "imported", "waits": 4.5}, "unspoken": false},
                    {"id": "u", "start": 14.0, "end": 19.0, "duration": null, "narrationStart": null,
                     "narration": null, "unspoken": true},
                ],
                "words": [
                    {"audio": "v", "text": "Say", "start": 0.6, "end": 1.0, "slide": "v", "intoSlide": 0.6},
                    {"audio": "v", "text": "v.", "start": 1.1, "end": 1.7, "slide": "v", "intoSlide": 1.1},
                    // Said 3 s into long's audio, as w shows.
                    {"audio": "long", "text": "later", "start": 13.0, "end": 13.5, "slide": "w", "intoSlide": 1.0},
                ],
            })
        );

        // Without words, the slides alone.
        let found = timeline(&file, &deck, false);
        assert_eq!(found.words, None);
        assert_eq!(found.data("deck.html")["words"], serde_json::json!([]));
    }
}
