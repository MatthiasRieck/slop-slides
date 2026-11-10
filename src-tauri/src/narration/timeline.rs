//! How a deck plays out with its narration, as a video export or the self-running show plays it
//! (see [`crate::video::Options::timeline`]): when each shown slide starts and ends, when each
//! narration plays, and which slide is showing at any moment. For the agent's timing tools
//! (src/mcp.rs) and the narration lint.

use std::path::Path;

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
        let waits = clip.start - clip.planned.max(0.0);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::narration::{audio, import_audio};
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
}
