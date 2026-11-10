//! The app-managed blocks of JSON at the end of a deck's `<body>`, holding what the user put
//! on slides apart from their markup, by slide id: the review marks (see [`crate::review`]) and
//! the comments (see [`crate::comments`]).
//!
//! ```html
//! <!-- slopslide:<name> (managed by SlopSlide, do not edit) -->
//! <script type="application/json" id="slopslide-<name>">{"<slide id>":[…]}</script>
//! <!-- /slopslide:<name> -->
//! ```

use std::collections::{BTreeMap, HashSet};
use std::ops::Range;

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::html::{self, find_ci, JS_START};

/// What a block holds: a list of entries for each slide, by its id.
pub type BySlide<T> = BTreeMap<String, Vec<T>>;

/// An app-managed block of JSON at the end of `<body>`: the review marks, or the comments.
pub struct Block {
    pub start: &'static str,
    pub end: &'static str,
    pub script_id: &'static str,
    /// What error messages call the block.
    pub name: &'static str,
    /// What error messages call its entries.
    pub entries: &'static str,
    /// What error messages say is wrong with an entry that is not valid.
    pub problem: &'static str,
}

impl Block {
    /// The whole block, from its start comment to the end of its end comment.
    pub fn range(&self, html: &str) -> Option<Range<usize>> {
        let start = html.find(self.start)?;
        let end = html[start..].find(self.end)? + start + self.end.len();
        Some(start..end)
    }

    /// The JSON in the block; None when `html` has no block. Fails when the block is damaged.
    fn json<'a>(&self, html: &'a str) -> Result<Option<&'a str>, String> {
        let Some(range) = self.range(html) else {
            if html.contains(self.start) {
                return Err(format!(
                    "The {} block has no closing {}.",
                    self.name, self.end
                ));
            }
            return Ok(None);
        };
        let block = &html[range];
        find_ci(block, 0, "<script")
            .and_then(|s| block[s..].find('>').map(|e| s + e + 1))
            .and_then(|open| find_ci(block, open, "</script").map(|close| &block[open..close]))
            .map(Some)
            .ok_or_else(|| format!("The {} block has no <script> holding its data.", self.name))
    }

    /// `html` with the block holding `json`, or without the block when it is None.
    fn put(&self, html: &str, json: Option<&str>) -> String {
        let existing = self.range(html);
        let Some(json) = json else {
            let Some(range) = existing else {
                return html.to_string();
            };
            // Take the line break and indent before the block with it, undoing the insertion.
            return html::remove(html, &range);
        };
        // JSON has `<` only inside strings, where the escape keeps `</script>` out of the markup.
        let json = json.replace('<', "\\u003c");
        let block = format!(
            "{}\n  <script type=\"application/json\" id=\"{}\">{json}</script>\n  {}",
            self.start, self.script_id, self.end
        );
        if let Some(range) = existing {
            return format!("{}{block}{}", &html[..range.start], &html[range.end..]);
        }
        // On its own line just before the player script (so the data is there when the player
        // starts), else before `</body>`.
        let before = html.find(JS_START).unwrap_or_else(|| {
            html.to_ascii_lowercase()
                .rfind("</body")
                .unwrap_or(html.len())
        });
        let at = html[..before].trim_end().len();
        format!("{}\n  {block}{}", &html[..at], &html[at..])
    }

    /// The entries in `html`; empty when there is no block. Fails when the block is damaged or
    /// holds an entry that is not `valid`.
    pub fn parse<T: DeserializeOwned>(
        &self,
        html: &str,
        valid: impl Fn(&T) -> bool,
    ) -> Result<BySlide<T>, String> {
        let Some(json) = self.json(html)? else {
            return Ok(BySlide::new());
        };
        let entries: BySlide<T> = serde_json::from_str(json)
            .map_err(|e| format!("The {} are not valid: {e}", self.entries))?;
        if let Some((slide, _)) = entries
            .iter()
            .find(|(_, entries)| !entries.iter().all(&valid))
        {
            return Err(format!(
                "The {} for slide `{slide}` have {}.",
                self.entries, self.problem
            ));
        }
        Ok(entries)
    }

    /// `html` with the block holding `entries`: slides without any are left out, and the block
    /// is removed when nothing is left. Entries that are not `valid` are dropped.
    pub fn write<T: Serialize + Clone>(
        &self,
        html: &str,
        entries: &BySlide<T>,
        valid: impl Fn(&T) -> bool,
    ) -> String {
        let kept: BySlide<T> = entries
            .iter()
            .map(|(slide, entries)| {
                let entries: Vec<T> = entries.iter().filter(|e| valid(e)).cloned().collect();
                (slide.clone(), entries)
            })
            .filter(|(_, entries)| !entries.is_empty())
            .collect();
        if kept.is_empty() {
            return self.put(html, None);
        }
        let json = serde_json::to_string(&kept).expect("the entries serialize");
        self.put(html, Some(&json))
    }

    /// Drops the entries of slides that are gone; None when there is nothing to drop (or the
    /// block is damaged, which lint reports instead).
    pub fn prune<T: DeserializeOwned + Serialize + Clone>(
        &self,
        html: &str,
        slide_ids: &HashSet<&str>,
        valid: impl Fn(&T) -> bool,
    ) -> Option<String> {
        let entries = self.parse(html, &valid).ok()?;
        let kept: BySlide<T> = entries
            .iter()
            .filter(|(slide, _)| slide_ids.contains(slide.as_str()))
            .map(|(slide, entries)| (slide.clone(), entries.clone()))
            .collect();
        (kept.len() != entries.len()).then(|| self.write(html, &kept, valid))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = "<html>\n<body>\n  <main class=\"deck\"></main>\n  <!-- slopslide:runtime-js (managed by SlopSlide, do not edit) -->\n  <script></script>\n  <!-- /slopslide:runtime-js -->\n</body>\n</html>\n";

    /// A block of notes: non-empty strings.
    const NOTES: Block = Block {
        start: "<!-- slopslide:notes (managed by SlopSlide, do not edit) -->",
        end: "<!-- /slopslide:notes -->",
        script_id: "slopslide-notes",
        name: "notes",
        entries: "notes",
        problem: "an empty note",
    };

    // The check takes the entries as the block holds them, `String`s.
    #[allow(clippy::ptr_arg)]
    fn valid(note: &String) -> bool {
        !note.is_empty()
    }

    fn notes(entries: &[(&str, &[&str])]) -> BySlide<String> {
        entries
            .iter()
            .map(|(id, notes)| {
                (
                    id.to_string(),
                    notes.iter().map(|n| n.to_string()).collect(),
                )
            })
            .collect()
    }

    fn write(html: &str, entries: &BySlide<String>) -> String {
        NOTES.write(html, entries, valid)
    }

    fn parse(html: &str) -> Result<BySlide<String>, String> {
        NOTES.parse(html, valid)
    }

    #[test]
    fn a_deck_without_a_block_has_no_entries() {
        assert_eq!(parse(DOC), Ok(BySlide::new()));
        assert_eq!(write(DOC, &BySlide::new()), DOC);
    }

    #[test]
    fn writes_the_block_before_the_player_script_and_reads_it_back() {
        let all = notes(&[("intro", &["One"])]);
        let html = write(DOC, &all);
        assert!(NOTES.range(&html).unwrap().end < html.find(JS_START).unwrap());
        assert!(html.contains(r#"<script type="application/json" id="slopslide-notes">"#));
        assert_eq!(parse(&html), Ok(all));
    }

    #[test]
    fn inserts_before_body_end_without_a_player_script() {
        let doc = "<body>\n<main></main>\n</body>";
        let html = write(doc, &notes(&[("a", &["x"])]));
        assert!(NOTES.range(&html).unwrap().end < html.find("</body").unwrap());
        assert_eq!(parse(&html).unwrap().len(), 1);
    }

    #[test]
    fn rewriting_replaces_the_block_and_removing_every_entry_restores_the_file() {
        let once = write(DOC, &notes(&[("intro", &["One"])]));
        let twice = write(&once, &notes(&[("plan", &["Two"])]));
        assert_eq!(twice.matches(NOTES.start).count(), 1);
        assert_eq!(parse(&twice).unwrap().keys().collect::<Vec<_>>(), ["plan"]);
        assert_eq!(write(&twice, &notes(&[("plan", &[])])), DOC);
    }

    #[test]
    fn markup_in_slide_ids_and_entries_stays_out_of_the_file() {
        let text = "</script><!-- /slopslide:notes --><b>";
        let html = write(DOC, &notes(&[("</script><b>", &[text])]));
        assert!(!html.contains("</script><b>") && !html.contains("</script><!--"));
        assert_eq!(parse(&html).unwrap()["</script><b>"], [text]);
    }

    #[test]
    fn drops_invalid_entries_when_writing() {
        let html = write(DOC, &notes(&[("a", &["", "Kept"]), ("b", &[""])]));
        assert_eq!(parse(&html), Ok(notes(&[("a", &["Kept"])])));
    }

    #[test]
    fn reports_damaged_blocks() {
        let html = write(DOC, &notes(&[("a", &["One"])]));
        let bad_json = parse(&html.replace("[\"One\"]", "[1]")).unwrap_err();
        assert!(
            bad_json.starts_with("The notes are not valid: "),
            "{bad_json}"
        );
        assert_eq!(
            parse(&html.replace("\"One\"", "\"\"")).unwrap_err(),
            "The notes for slide `a` have an empty note."
        );
        assert_eq!(
            parse(&html.replace(NOTES.end, "")).unwrap_err(),
            "The notes block has no closing <!-- /slopslide:notes -->."
        );
        assert_eq!(
            parse(&html.replace("</script>\n", "\n")).unwrap_err(),
            "The notes block has no <script> holding its data."
        );
    }

    #[test]
    fn prunes_entries_of_slides_that_are_gone() {
        let html = write(DOC, &notes(&[("kept", &["One"]), ("gone", &["Two"])]));
        let ids = HashSet::from(["kept"]);
        let pruned = NOTES.prune(&html, &ids, valid).unwrap();
        assert_eq!(parse(&pruned).unwrap().keys().collect::<Vec<_>>(), ["kept"]);
        assert_eq!(NOTES.prune(&pruned, &ids, valid), None);
        assert_eq!(
            NOTES.prune(&pruned, &HashSet::new(), valid).as_deref(),
            Some(DOC)
        );
    }
}
