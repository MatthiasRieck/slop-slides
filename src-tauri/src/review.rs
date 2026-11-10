//! Review marks: what the user drew on slides in the editor, kept inside deck.html so the
//! marks travel with the deck like review comments. They live in one app-managed block at the
//! end of `<body>`, keyed by slide id:
//!
//! ```html
//! <!-- slopslide:review (managed by SlopSlide, do not edit) -->
//! <script type="application/json" id="slopslide-review">{"intro":[{"tool":"pen",…}]}</script>
//! <!-- /slopslide:review -->
//! ```
//!
//! The block is not part of any slide, so drawing never reloads a slide's preview. The player
//! hides the marks until the viewer toggles them (R).

use std::collections::HashSet;
use std::ops::Range;

use serde::{Deserialize, Serialize};

use crate::app_block::{Block, BySlide};

pub const START: &str = "<!-- slopslide:review (managed by SlopSlide, do not edit) -->";
pub const END: &str = "<!-- /slopslide:review -->";
pub const SCRIPT_ID: &str = "slopslide-review";
const BLOCK: Block = Block {
    start: START,
    end: END,
    script_id: SCRIPT_ID,
    name: "review",
    entries: "review marks",
    problem: "a bad color or point",
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InkTool {
    Pen,
    Highlighter,
}

/// A freehand line, in fractions of the slide (as the editor's ink layer stores it).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Stroke {
    pub tool: InkTool,
    pub color: String,
    pub points: Vec<[f64; 2]>,
}

/// Strokes by slide id.
pub type Review = BySlide<Stroke>;

/// The whole block, from its start comment to the end of its end comment.
pub fn block_range(html: &str) -> Option<Range<usize>> {
    BLOCK.range(html)
}

/// The review marks in `html`; empty when there is no block. Fails when the block is damaged.
pub fn parse(html: &str) -> Result<Review, String> {
    BLOCK.parse(html, valid)
}

/// The review marks in `html`, or none when the block is missing or damaged.
pub fn read(html: &str) -> Review {
    parse(html).unwrap_or_default()
}

fn valid(stroke: &Stroke) -> bool {
    let hex = stroke.color.strip_prefix('#').unwrap_or("");
    matches!(hex.len(), 3 | 4 | 6 | 8)
        && hex.bytes().all(|b| b.is_ascii_hexdigit())
        && !stroke.points.is_empty()
        && stroke.points.iter().flatten().all(|n| n.is_finite())
}

/// `html` with its review block holding `review`: slides without strokes are left out, and
/// the block is removed when nothing is left. Strokes that are not valid are dropped.
pub fn write(html: &str, review: &Review) -> String {
    BLOCK.write(html, review, valid)
}

/// Drops the marks of slides that are gone; None when there is nothing to drop (or the
/// block is damaged, which lint reports instead).
pub fn prune(html: &str, slide_ids: &HashSet<&str>) -> Option<String> {
    BLOCK.prune(html, slide_ids, valid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::html::JS_START;

    const DOC: &str = "<html>\n<body>\n  <main class=\"deck\"></main>\n  <!-- slopslide:runtime-js (managed by SlopSlide, do not edit) -->\n  <script></script>\n  <!-- /slopslide:runtime-js -->\n</body>\n</html>\n";

    fn stroke(color: &str) -> Stroke {
        Stroke {
            tool: InkTool::Pen,
            color: color.into(),
            points: vec![[0.1, 0.2], [0.3, 0.4]],
        }
    }

    fn review(entries: &[(&str, Vec<Stroke>)]) -> Review {
        entries
            .iter()
            .map(|(id, s)| (id.to_string(), s.clone()))
            .collect()
    }

    #[test]
    fn writes_the_block_before_the_player_script_and_reads_it_back() {
        let marks = review(&[("intro", vec![stroke("#ef4444")])]);
        let html = write(DOC, &marks);
        let block = block_range(&html).unwrap();
        assert!(block.end < html.find(JS_START).unwrap());
        assert!(html.contains(r#"<script type="application/json" id="slopslide-review">"#));
        assert_eq!(parse(&html), Ok(marks));
    }

    #[test]
    fn drops_invalid_strokes_when_writing() {
        let mut bad_points = stroke("#000");
        bad_points.points.clear();
        let marks = review(&[("a", vec![stroke("red; x"), bad_points, stroke("#12345678")])]);
        assert_eq!(read(&write(DOC, &marks))["a"], vec![stroke("#12345678")]);
    }

    #[test]
    fn reports_damaged_blocks() {
        let html = write(DOC, &review(&[("a", vec![stroke("#000")])]));
        assert!(parse(&html.replace("\"pen\"", "\"brush\"")).is_err());
        assert!(parse(&html.replace("#000", "url(x)")).is_err());
        assert!(parse(&html.replace("[[", "[")).is_err());
        assert_eq!(read(&html.replace("[[", "[")), Review::new());
    }
}
