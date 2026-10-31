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

use std::collections::{BTreeMap, HashSet};
use std::ops::Range;

use serde::{Deserialize, Serialize};

use crate::review::Block;

pub const START: &str = "<!-- slopslide:comments (managed by SlopSlide, do not edit) -->";
pub const END: &str = "<!-- /slopslide:comments -->";
const BLOCK: Block = Block {
    start: START,
    end: END,
    script_id: "slopslide-comments",
    name: "comments",
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
}

/// Comments by slide id.
pub type Comments = BTreeMap<String, Vec<Comment>>;

/// The whole block, from its start comment to the end of its end comment.
pub fn block_range(html: &str) -> Option<Range<usize>> {
    BLOCK.range(html)
}

/// The comments in `html`; empty when there is no block. Fails when the block is damaged.
pub fn parse(html: &str) -> Result<Comments, String> {
    let Some(json) = BLOCK.json(html)? else {
        return Ok(Comments::new());
    };
    let comments: Comments =
        serde_json::from_str(json).map_err(|e| format!("The comments are not valid: {e}"))?;
    if let Some((slide, _)) = comments
        .iter()
        .find(|(_, comments)| !comments.iter().all(valid))
    {
        return Err(format!(
            "The comments for slide `{slide}` have a missing id or text, or a bad position."
        ));
    }
    Ok(comments)
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
}

/// `html` with its comments block holding `comments`: slides without any are left out, and the
/// block is removed when nothing is left. Comments that are not valid are dropped.
pub fn write(html: &str, comments: &Comments) -> String {
    let kept: Comments = comments
        .iter()
        .map(|(slide, comments)| {
            let comments: Vec<Comment> = comments.iter().filter(|c| valid(c)).cloned().collect();
            (slide.clone(), comments)
        })
        .filter(|(_, comments)| !comments.is_empty())
        .collect();
    if kept.is_empty() {
        return BLOCK.put(html, None);
    }
    let json = serde_json::to_string(&kept).expect("comments serialize");
    BLOCK.put(html, Some(&json))
}

/// Drops the comments of slides that are gone; None when there is nothing to drop (or the
/// block is damaged, which lint reports instead).
pub fn prune(html: &str, slide_ids: &HashSet<&str>) -> Option<String> {
    let comments = parse(html).ok()?;
    let kept: Comments = comments
        .iter()
        .filter(|(slide, _)| slide_ids.contains(slide.as_str()))
        .map(|(slide, comments)| (slide.clone(), comments.clone()))
        .collect();
    (kept.len() != comments.len()).then(|| write(html, &kept))
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
        }
    }

    fn comments(entries: &[(&str, Vec<Comment>)]) -> Comments {
        entries
            .iter()
            .map(|(id, c)| (id.to_string(), c.clone()))
            .collect()
    }

    #[test]
    fn a_deck_without_a_block_has_no_comments() {
        assert_eq!(parse(DOC), Ok(Comments::new()));
        assert_eq!(write(DOC, &Comments::new()), DOC);
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
    fn rewriting_replaces_the_block_and_removing_every_comment_restores_the_file() {
        let once = write(DOC, &comments(&[("intro", vec![comment("a", "One")])]));
        let twice = write(&once, &comments(&[("plan", vec![comment("b", "Two")])]));
        assert_eq!(twice.matches(START).count(), 1);
        assert_eq!(read(&twice).keys().collect::<Vec<_>>(), ["plan"]);
        assert_eq!(write(&twice, &comments(&[("plan", vec![])])), DOC);
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
    fn markup_in_a_comment_stays_out_of_the_file() {
        let text = "</script><!-- /slopslide:comments --><b>";
        let html = write(DOC, &comments(&[("a", vec![comment("x", text)])]));
        assert!(!html.contains("</script><!--"));
        assert_eq!(read(&html)["a"][0].text, text);
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
        assert!(parse(&html.replace(END, "")).is_err());
        assert!(parse(&html.replace("</script>\n", "\n")).is_err());
        assert_eq!(read(&html.replace(END, "")), Comments::new());
    }

    #[test]
    fn prunes_comments_of_slides_that_are_gone() {
        let html = write(
            DOC,
            &comments(&[
                ("kept", vec![comment("a", "One")]),
                ("gone", vec![comment("b", "Two")]),
            ]),
        );
        let ids = HashSet::from(["kept"]);
        let pruned = prune(&html, &ids).unwrap();
        assert_eq!(read(&pruned).keys().collect::<Vec<_>>(), ["kept"]);
        assert_eq!(prune(&pruned, &ids), None);
        assert_eq!(prune(&pruned, &HashSet::new()).as_deref(), Some(DOC));
    }
}
