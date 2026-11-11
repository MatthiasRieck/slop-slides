//! Comments: what the user wrote about elements on slides, kept inside deck.html so they travel
//! with the deck like the review marks. They live in one app-managed block at the end of
//! `<body>`, keyed by slide id:
//!
//! ```html
//! <!-- slopslide:comments (managed by SlopSlide, do not edit) -->
//! <script type="application/json" id="slopslide-comments">{"intro":[{"id":"…","text":"…",…}]}</script>
//! <!-- /slopslide:comments -->
//! ```
//!
//! The block is not part of any slide, so commenting never reloads a slide's preview, and works
//! on locked slides. The player ignores it.

use std::collections::HashSet;
use std::ops::Range;

use serde::{Deserialize, Serialize};

use crate::app_block::{Block, BySlide};

pub const START: &str = "<!-- slopslide:comments (managed by SlopSlide, do not edit) -->";
pub const END: &str = "<!-- /slopslide:comments -->";
const BLOCK: Block = Block {
    start: START,
    end: END,
    script_id: "slopslide-comments",
    name: "comments",
    entries: "comments",
    problem: "a missing id or text, a bad position, a bad area, or a bad time",
};

/// The element a comment is about, so its pin can follow it when the slide changes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    /// Child indexes from the slide down to the element, when the comment was made.
    pub path: Vec<usize>,
    /// Its lowercase tag name.
    pub tag: String,
    /// The start of its text (or an image's description), empty when it has none.
    #[serde(default)]
    pub label: String,
    /// Where on the element the pin sits, in fractions of its size.
    pub at: [f64; 2],
}

/// How the user outlined an area of the slide.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Shape {
    /// `points` are two opposite corners.
    Rect,
    /// `points` are two opposite corners of the box the ellipse fills.
    Ellipse,
    /// `points` are the corners of a freehand outline.
    Lasso,
}

/// An area of the slide a comment is about, in fractions of the slide.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Area {
    pub shape: Shape,
    pub points: Vec<[f64; 2]>,
}

impl Area {
    fn valid(&self) -> bool {
        let count = self.points.len();
        let enough = match self.shape {
            Shape::Rect | Shape::Ellipse => count == 2,
            Shape::Lasso => count >= 3,
        };
        enough && self.points.iter().flatten().all(|v| v.is_finite())
    }
}

/// A comment on a slide, pinned at a point given in fractions of the slide.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Comment {
    pub id: String,
    pub text: String,
    pub x: f64,
    pub y: f64,
    /// None for a comment on the slide itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<Target>,
    /// The area outlined on the slide, for a comment on an area rather than an element.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub area: Option<Area>,
    /// The moment the comment is about, in seconds since the slide showed: where the timeline's
    /// playhead held the slide when it was made. None for a comment on the slide whenever.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<f64>,
}

/// Comments by slide id.
pub type Comments = BySlide<Comment>;

/// The whole block, from its start comment to the end of its end comment.
pub fn block_range(html: &str) -> Option<Range<usize>> {
    BLOCK.range(html)
}

/// The comments in `html`; empty when there is no block. Fails when the block is damaged.
pub fn parse(html: &str) -> Result<Comments, String> {
    BLOCK.parse(html, valid)
}

/// The comments in `html`, or none when the block is missing or damaged.
pub fn read(html: &str) -> Comments {
    parse(html).unwrap_or_default()
}

fn valid(comment: &Comment) -> bool {
    let at = comment.target.iter().flat_map(|t| t.at);
    !comment.id.is_empty()
        && !comment.text.trim().is_empty()
        && [comment.x, comment.y]
            .into_iter()
            .chain(at)
            .all(f64::is_finite)
        && comment.area.as_ref().map_or(true, Area::valid)
        && comment.time.map_or(true, |t| t.is_finite() && t >= 0.0)
}

/// `html` with its comments block holding `comments`: slides without any are left out, and the
/// block is removed when nothing is left. Comments that are not valid are dropped.
pub fn write(html: &str, comments: &Comments) -> String {
    BLOCK.write(html, comments, valid)
}

/// Drops the comments of slides that are gone; None when there is nothing to drop (or the
/// block is damaged, which lint reports instead).
pub fn prune(html: &str, slide_ids: &HashSet<&str>) -> Option<String> {
    BLOCK.prune(html, slide_ids, valid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::html::JS_START;
    use crate::review;

    const DOC: &str = "<html>\n<body>\n  <main class=\"deck\"></main>\n  <!-- slopslide:runtime-js (managed by SlopSlide, do not edit) -->\n  <script></script>\n  <!-- /slopslide:runtime-js -->\n</body>\n</html>\n";

    fn comment(id: &str, text: &str) -> Comment {
        Comment {
            id: id.into(),
            text: text.into(),
            x: 0.25,
            y: 0.5,
            target: Some(Target {
                path: vec![0, 2],
                tag: "h2".into(),
                label: "Our vision".into(),
                at: [0.1, 0.9],
            }),
            area: None,
            time: None,
        }
    }

    fn area(shape: Shape, points: &[[f64; 2]]) -> Comment {
        Comment {
            target: None,
            area: Some(Area {
                shape,
                points: points.to_vec(),
            }),
            ..comment("area", "Too crowded")
        }
    }

    fn comments(entries: &[(&str, Vec<Comment>)]) -> Comments {
        entries
            .iter()
            .map(|(id, c)| (id.to_string(), c.clone()))
            .collect()
    }

    #[test]
    fn writes_the_block_before_the_player_script_and_reads_it_back() {
        let all = comments(&[("intro", vec![comment("a", "Bigger, please")])]);
        let html = write(DOC, &all);
        assert!(block_range(&html).unwrap().end < html.find(JS_START).unwrap());
        assert!(html.contains(r#"<script type="application/json" id="slopslide-comments">"#));
        assert_eq!(parse(&html), Ok(all));
    }

    #[test]
    fn a_comment_on_the_slide_itself_has_no_target() {
        let all = comments(&[(
            "intro",
            vec![Comment {
                target: None,
                ..comment("a", "Too busy")
            }],
        )]);
        let html = write(DOC, &all);
        assert!(!html.contains("target"));
        assert_eq!(parse(&html), Ok(all));
    }

    #[test]
    fn a_comment_on_an_area_keeps_its_outline() {
        let all = comments(&[(
            "intro",
            vec![
                area(Shape::Rect, &[[0.1, 0.2], [0.4, 0.5]]),
                area(Shape::Ellipse, &[[0.1, 0.2], [0.4, 0.5]]),
                area(Shape::Lasso, &[[0.1, 0.2], [0.4, 0.2], [0.3, 0.6]]),
            ],
        )]);
        let html = write(DOC, &all);
        assert!(html.contains(r#""area":{"shape":"rect","points":[[0.1,0.2],[0.4,0.5]]}"#));
        assert!(!html.contains("target"));
        assert_eq!(parse(&html), Ok(all));
    }

    #[test]
    fn a_comment_on_a_moment_keeps_its_time() {
        let at = |time| Comment {
            time: Some(time),
            ..comment("a", "Too fast")
        };
        let all = comments(&[("intro", vec![at(3.25)])]);
        let html = write(DOC, &all);
        assert!(html.contains(r#""time":3.25"#));
        assert_eq!(parse(&html), Ok(all));
        // Without a moment, nothing is written about one.
        let plain = write(DOC, &comments(&[("intro", vec![comment("a", "Too fast")])]));
        assert!(!plain.contains(r#""time""#));
        // A moment before the slide shows, or none at all, is no moment.
        for bad in [-1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(write(DOC, &comments(&[("intro", vec![at(bad)])])), DOC);
        }
    }

    #[test]
    fn drops_areas_without_enough_points() {
        let all = comments(&[(
            "a",
            vec![
                area(Shape::Rect, &[[0.1, 0.2]]),
                area(Shape::Lasso, &[[0.1, 0.2], [0.4, 0.5]]),
                area(Shape::Ellipse, &[[0.1, f64::NAN], [0.4, 0.5]]),
            ],
        )]);
        assert_eq!(write(DOC, &all), DOC);
        let html = write(
            DOC,
            &comments(&[("a", vec![area(Shape::Rect, &[[0.1, 0.2], [0.4, 0.5]])])]),
        );
        assert!(parse(&html.replace("[[0.1,0.2],[0.4,0.5]]", "[[0.1,0.2]]")).is_err());
        assert!(parse(&html.replace("\"rect\"", "\"star\"")).is_err());
    }

    #[test]
    fn sits_next_to_the_review_marks_without_disturbing_them() {
        let stroke = review::Stroke {
            tool: review::InkTool::Pen,
            color: "#000".into(),
            points: vec![[0.1, 0.2]],
        };
        let marks: review::Review = [("intro".to_string(), vec![stroke])].into();
        let all = comments(&[("intro", vec![comment("a", "One")])]);
        let html = write(&review::write(DOC, &marks), &all);
        assert_eq!(review::parse(&html), Ok(marks));
        assert_eq!(parse(&html), Ok(all.clone()));
        let without_marks = review::write(&html, &review::Review::new());
        assert_eq!(parse(&without_marks), Ok(all));
        assert_eq!(write(&without_marks, &Comments::new()), DOC);
    }

    #[test]
    fn drops_invalid_comments_when_writing() {
        let mut no_position = comment("c", "Text");
        no_position.x = f64::NAN;
        let all = comments(&[(
            "a",
            vec![
                comment("", "No id"),
                comment("b", "  "),
                no_position,
                comment("d", "Kept"),
            ],
        )]);
        assert_eq!(read(&write(DOC, &all))["a"], vec![comment("d", "Kept")]);
    }

    #[test]
    fn reports_damaged_blocks() {
        let html = write(DOC, &comments(&[("a", vec![comment("x", "One")])]));
        assert!(parse(&html.replace("\"text\"", "\"note\"")).is_err());
        assert!(parse(&html.replace("\"x\",", "\"\",")).is_err());
        assert_eq!(read(&html.replace("\"text\"", "\"note\"")), Comments::new());
    }
}
