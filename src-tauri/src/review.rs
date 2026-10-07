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

use std::collections::{BTreeMap, HashSet};
use std::ops::Range;

use serde::{Deserialize, Serialize};

use crate::html::{find_ci, JS_START};

pub const START: &str = "<!-- slopslide:review (managed by SlopSlide, do not edit) -->";
pub const END: &str = "<!-- /slopslide:review -->";
pub const SCRIPT_ID: &str = "slopslide-review";

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
pub type Review = BTreeMap<String, Vec<Stroke>>;

/// The whole block, from its start comment to the end of its end comment.
pub fn block_range(html: &str) -> Option<Range<usize>> {
    let start = html.find(START)?;
    let end = html[start..].find(END)? + start + END.len();
    Some(start..end)
}

/// The review marks in `html`; empty when there is no block. Fails when the block is damaged.
pub fn parse(html: &str) -> Result<Review, String> {
    let Some(range) = block_range(html) else {
        if html.contains(START) {
            return Err(format!("The review block has no closing {END}."));
        }
        return Ok(Review::new());
    };
    let block = &html[range];
    let json = find_ci(block, 0, "<script")
        .and_then(|s| block[s..].find('>').map(|e| s + e + 1))
        .and_then(|open| find_ci(block, open, "</script").map(|close| &block[open..close]))
        .ok_or("The review block has no <script> holding the marks.")?;
    let review: Review =
        serde_json::from_str(json).map_err(|e| format!("The review marks are not valid: {e}"))?;
    if let Some((slide, _)) = review
        .iter()
        .find(|(_, strokes)| !strokes.iter().all(valid))
    {
        return Err(format!(
            "The review marks for slide `{slide}` have a bad color or point."
        ));
    }
    Ok(review)
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
    let kept: Review = review
        .iter()
        .map(|(slide, strokes)| {
            let strokes: Vec<Stroke> = strokes.iter().filter(|s| valid(s)).cloned().collect();
            (slide.clone(), strokes)
        })
        .filter(|(_, strokes)| !strokes.is_empty())
        .collect();
    let existing = block_range(html);
    if kept.is_empty() {
        let Some(range) = existing else {
            return html.to_string();
        };
        // Take the line break and indent before the block with it, undoing the insertion.
        let start = html[..range.start].trim_end().len();
        return format!("{}{}", &html[..start], &html[range.end..]);
    }
    // JSON has `<` only inside strings, where the escape keeps `</script>` out of the markup.
    let json = serde_json::to_string(&kept)
        .expect("strokes serialize")
        .replace('<', "\\u003c");
    let block = format!(
        "{START}\n  <script type=\"application/json\" id=\"{SCRIPT_ID}\">{json}</script>\n  {END}"
    );
    if let Some(range) = existing {
        return format!("{}{block}{}", &html[..range.start], &html[range.end..]);
    }
    // On its own line just before the player script (so the marks are there when the player
    // starts), else before `</body>`.
    let before = html.find(JS_START).unwrap_or_else(|| {
        html.to_ascii_lowercase()
            .rfind("</body")
            .unwrap_or(html.len())
    });
    let at = html[..before].trim_end().len();
    format!("{}\n  {block}{}", &html[..at], &html[at..])
}

/// Drops the marks of slides that are gone; None when there is nothing to drop (or the
/// block is damaged, which lint reports instead).
pub fn prune(html: &str, slide_ids: &HashSet<&str>) -> Option<String> {
    let review = parse(html).ok()?;
    let kept: Review = review
        .iter()
        .filter(|(slide, _)| slide_ids.contains(slide.as_str()))
        .map(|(slide, strokes)| (slide.clone(), strokes.clone()))
        .collect();
    (kept.len() != review.len()).then(|| write(html, &kept))
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn a_deck_without_a_block_has_no_marks() {
        assert_eq!(parse(DOC), Ok(Review::new()));
        assert_eq!(write(DOC, &Review::new()), DOC);
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
    fn rewriting_replaces_the_block_and_removing_every_mark_restores_the_file() {
        let once = write(DOC, &review(&[("intro", vec![stroke("#ef4444")])]));
        let twice = write(&once, &review(&[("plan", vec![stroke("#fff")])]));
        assert_eq!(twice.matches(START).count(), 1);
        assert_eq!(read(&twice).keys().collect::<Vec<_>>(), ["plan"]);
        assert_eq!(write(&twice, &review(&[("plan", vec![])])), DOC);
    }

    #[test]
    fn inserts_before_body_end_without_a_player_script() {
        let doc = "<body>\n<main></main>\n</body>";
        let html = write(doc, &review(&[("a", vec![stroke("#000")])]));
        assert!(block_range(&html).unwrap().end < html.find("</body").unwrap());
        assert_eq!(read(&html).len(), 1);
    }

    #[test]
    fn escapes_markup_in_slide_ids() {
        let html = write(DOC, &review(&[("</script><b>", vec![stroke("#000")])]));
        assert!(!html.contains("</script><b>"));
        assert!(read(&html).contains_key("</script><b>"));
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
        assert!(parse(&html.replace(END, "")).is_err());
        assert!(parse(&html.replace("</script>\n", "\n")).is_err());
        assert_eq!(read(&html.replace("[[", "[")), Review::new());
    }

    #[test]
    fn prunes_marks_of_slides_that_are_gone() {
        let html = write(
            DOC,
            &review(&[
                ("kept", vec![stroke("#000")]),
                ("gone", vec![stroke("#000")]),
            ]),
        );
        let ids = HashSet::from(["kept"]);
        let pruned = prune(&html, &ids).unwrap();
        assert_eq!(read(&pruned).keys().collect::<Vec<_>>(), ["kept"]);
        assert_eq!(prune(&pruned, &ids), None);
        assert_eq!(prune(&pruned, &HashSet::new()).as_deref(), Some(DOC));
    }
}
