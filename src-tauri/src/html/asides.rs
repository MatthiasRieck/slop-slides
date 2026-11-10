//! A slide's narration and speaker notes: Markdown text in an `<aside>` of the slide.

use std::ops::Range;

use super::attrs::{NARRATION_CLASS, NOTES_CLASS};
use super::edit::indent_before;
use super::entities::{decode_entities, escape};
use super::scan::{find_ci, has_class, parse_tag, tags};
use super::spans::{find_slides, slide_span};

/// A narration or notes element inside one slide's markup.
#[derive(Debug, Clone, PartialEq)]
pub struct NarrationSpan {
    /// The whole `<aside …>…</aside>`; it runs to the end of `slide` when never closed.
    pub range: Range<usize>,
    /// Between the start and end tags.
    pub inner: Range<usize>,
}

/// Every narration element in `slide` (the markup of one slide), in document order.
pub fn narration_spans(slide: &str) -> Vec<NarrationSpan> {
    aside_spans(slide, NARRATION_CLASS)
}

/// Every `<aside>` of `class` in `slide`, in document order.
fn aside_spans(slide: &str, class: &str) -> Vec<NarrationSpan> {
    // An element never closed runs to the slide's end tag, not past it.
    let limit = slide
        .to_ascii_lowercase()
        .rfind("</section")
        .unwrap_or(slide.len());
    let mut spans: Vec<NarrationSpan> = Vec::new();
    for (start, tag) in tags(slide) {
        if tag.closing || tag.name != "aside" || !has_class(&tag, class) {
            continue;
        }
        if start >= limit || spans.last().is_some_and(|s| s.range.contains(&start)) {
            continue;
        }
        let close = find_ci(slide, tag.end, "</aside").filter(|&c| c < limit);
        let inner = tag.end..close.unwrap_or(limit);
        let end = close
            .and_then(|c| slide[c..].find('>').map(|e| c + e + 1))
            .unwrap_or(limit);
        spans.push(NarrationSpan {
            range: start..end,
            inner,
        });
    }
    spans
}

/// The slide's narration as text: tags dropped, entities decoded, no space at the ends of lines
/// or from the markup's indentation, and blank lines between paragraphs kept (one at most). The
/// indentation that is left means something in Markdown. Empty when it has none.
pub fn narration(slide: &str) -> String {
    aside_text(slide, NARRATION_CLASS)
}

/// The slide's speaker notes as text, read like [`narration`].
pub fn notes(slide: &str) -> String {
    aside_text(slide, NOTES_CLASS)
}

const INDENT: [char; 2] = [' ', '\t'];

/// How much of each line of `inner` is the markup's indentation: only text that starts on a line
/// of its own is indented with the markup, and then all of it is.
fn markup_indent(inner: &str) -> usize {
    let mut lines = inner.lines();
    if lines.next().is_some_and(|first| !first.trim().is_empty()) {
        return 0;
    }
    lines
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.len() - line.trim_start_matches(INDENT).len())
        .min()
        .unwrap_or(0)
}

fn aside_text(slide: &str, class: &str) -> String {
    let Some(span) = aside_spans(slide, class).into_iter().next() else {
        return String::new();
    };
    let inner = &slide[span.inner];
    let indent = markup_indent(inner);
    let mut text = String::new();
    let mut rest = inner;
    while let Some(open) = rest.find('<') {
        text.push_str(&rest[..open]);
        match parse_tag(rest, open) {
            Some(tag) => {
                if !tag.closing && tag.name == "br" {
                    text.push('\n');
                }
                rest = &rest[tag.end..];
            }
            None => {
                text.push('<');
                rest = &rest[open + 1..];
            }
        }
    }
    text.push_str(rest);
    let decoded = decode_entities(&text);
    let mut out = String::new();
    let mut blank = false;
    for line in decoded.lines().map(str::trim_end) {
        let line = &line[indent.min(line.len() - line.trim_start_matches(INDENT).len())..];
        if line.is_empty() {
            blank = !out.is_empty();
            continue;
        }
        if !out.is_empty() {
            out.push_str(if blank { "\n\n" } else { "\n" });
        }
        out.push_str(line);
        blank = false;
    }
    out
}

/// Sets slide `id`'s narration to `text` (trimmed): fills its narration element, adds one at
/// the end of the slide, or removes it when `text` is empty. Leaves the markup untouched when
/// the narration is already `text`.
pub fn set_narration(html: &str, id: &str, text: &str) -> Result<String, String> {
    set_aside(html, id, NARRATION_CLASS, text)
}

/// Adds `text` to the end of slide `id`'s narration: a paragraph of its own with `paragraph`,
/// else going on from the last word.
pub fn append_narration(
    html: &str,
    id: &str,
    text: &str,
    paragraph: bool,
) -> Result<String, String> {
    let slides = find_slides(html);
    let span = slide_span(&slides, id)?;
    let said = narration(&html[span.range.clone()]);
    let joined = match (said.is_empty(), paragraph) {
        (true, _) => text.to_string(),
        (false, true) => format!("{said}\n\n{text}"),
        (false, false) => format!("{said} {text}"),
    };
    set_narration(html, id, &joined)
}

/// Sets slide `id`'s speaker notes to `text`, the way [`set_narration`] does its narration.
pub fn set_notes(html: &str, id: &str, text: &str) -> Result<String, String> {
    set_aside(html, id, NOTES_CLASS, text)
}

fn set_aside(html: &str, id: &str, class: &str, text: &str) -> Result<String, String> {
    let slides = find_slides(html);
    let span = slide_span(&slides, id)?;
    let slide = &html[span.range.clone()];
    let text = text.trim();
    let existing = aside_spans(slide, class);
    if aside_text(slide, class) == text && existing.len() <= 1 {
        return Ok(html.to_string());
    }
    let offset = span.range.start;
    // Only the first one counts; extra ones go.
    let mut out = html.to_string();
    for extra in existing.iter().skip(1).rev() {
        let start = offset + slide[..extra.range.start].trim_end().len();
        out.replace_range(start..offset + extra.range.end, "");
    }
    match (existing.first(), text.is_empty()) {
        (Some(first), true) => {
            let start = offset + slide[..first.range.start].trim_end().len();
            out.replace_range(start..offset + first.range.end, "");
        }
        (Some(first), false) => {
            let inner = offset + first.inner.start..offset + first.inner.end;
            if first.inner.end == first.range.end {
                // Never closed: close it, so the rest of the slide stays outside.
                out.replace_range(inner, &format!("{}</aside>", escape(text)));
            } else {
                out.replace_range(inner, &escape(text));
            }
        }
        (None, true) => {}
        (None, false) => {
            let close = slide
                .to_ascii_lowercase()
                .rfind("</section")
                .unwrap_or(slide.len());
            let at = offset + slide[..close].trim_end().len();
            let indent = indent_before(html, span.range.start);
            out.insert_str(
                at,
                &format!(
                    "\n{indent}  <aside class=\"{class}\">{}</aside>",
                    escape(text)
                ),
            );
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::html::*;

    #[test]
    fn reads_a_slides_narration_as_plain_text() {
        let slide = "<section class=\"slide\" id=\"a\"><h1>Hi</h1>\n  <aside class=\"narration\">\n    Welcome &amp; hello.\n    Second <b>line</b>.<br>Third\n\n\n    New paragraph.\n  </aside>\n</section>";
        assert_eq!(
            narration(slide),
            "Welcome & hello.\nSecond line.\nThird\n\nNew paragraph."
        );
        assert_eq!(
            narration(
                "<section class=\"slide\" id=\"a\"><aside class=\"notes\">x</aside></section>"
            ),
            ""
        );
        assert_eq!(
            narration("<section class=\"slide\" id=\"a\"><aside class=\"narration\">open"),
            "open"
        );
    }

    #[test]
    fn keeps_the_indentation_markdown_needs_but_not_the_markups() {
        let aside = |inner: &str| {
            format!("<section class=\"slide\" id=\"a\"><aside class=\"notes\">{inner}</aside></section>")
        };
        let list = "- One\n  - Inner\n\n      code";
        assert_eq!(notes(&aside(list)), list);
        assert_eq!(
            notes(&aside(
                "\n      - One\n        - Inner\n\n      Next  \n    "
            )),
            "- One\n  - Inner\n\nNext"
        );
        let html = "<section class=\"slide\" id=\"a\"></section>";
        let saved = set_notes(html, "a", list).unwrap();
        assert_eq!(notes(&saved), list);
        assert_eq!(set_notes(&saved, "a", list).unwrap(), saved);
    }

    #[test]
    fn sets_adds_and_removes_a_slides_narration() {
        let html = "<main class=\"deck\">\n  <section class=\"slide\" id=\"a\">\n    <h1>Hi</h1>\n  </section>\n  <section class=\"slide\" id=\"b\"><p>B</p></section>\n</main>";
        let added = set_narration(html, "a", "  Say <hi> & wave\nthen go  ").unwrap();
        assert_eq!(
            added,
            "<main class=\"deck\">\n  <section class=\"slide\" id=\"a\">\n    <h1>Hi</h1>\n    <aside class=\"narration\">Say &lt;hi&gt; &amp; wave\nthen go</aside>\n  </section>\n  <section class=\"slide\" id=\"b\"><p>B</p></section>\n</main>"
        );
        let slide = slide_markup(&added, "a").unwrap();
        assert_eq!(narration(slide), "Say <hi> & wave\nthen go");
        assert_eq!(
            set_narration(&added, "a", "Say <hi> & wave\nthen go").unwrap(),
            added
        );

        let changed = set_narration(&added, "a", "Bye").unwrap();
        assert!(changed.contains("<aside class=\"narration\">Bye</aside>"));
        assert_eq!(set_narration(&changed, "a", "  ").unwrap(), html);
        assert_eq!(set_narration(html, "a", "").unwrap(), html);
        assert!(set_narration(html, "missing", "x").is_err());

        let inline = set_narration(html, "b", "B text").unwrap();
        assert!(
            inline.contains("<p>B</p>\n    <aside class=\"narration\">B text</aside></section>")
        );
    }

    #[test]
    fn reads_sets_and_removes_a_slides_notes_apart_from_its_narration() {
        let html = "<main class=\"deck\">\n  <section class=\"slide\" id=\"a\">\n    <h1>Hi</h1>\n    <aside class=\"narration\">Said</aside>\n  </section>\n</main>";
        let added = set_notes(html, "a", " Mention <b> & pause\nthen go ").unwrap();
        assert!(added.contains("    <aside class=\"notes\">Mention &lt;b&gt; &amp; pause\nthen go</aside>\n  </section>"));
        let slide = slide_markup(&added, "a").unwrap();
        assert_eq!(notes(slide), "Mention <b> & pause\nthen go");
        assert_eq!(narration(slide), "Said");
        assert_eq!(
            set_notes(&added, "a", "Mention <b> & pause\nthen go").unwrap(),
            added
        );
        assert_eq!(set_notes(&added, "a", "").unwrap(), html);
        assert_eq!(notes(html), "");
        assert!(set_notes(html, "missing", "x").is_err());
    }

    #[test]
    fn notes_of_other_classes_and_tags_are_left_alone() {
        let html = "<main class=\"deck\"><section class=\"slide\" id=\"a\"><p class=\"notes\">Shown</p><aside class=\"side notes\">Hi <b>there</b></aside><aside class=\"notes\">Two</aside></section></main>";
        assert_eq!(notes(slide_markup(html, "a").unwrap()), "Hi there");
        assert_eq!(
            set_notes(html, "a", "New").unwrap(),
            "<main class=\"deck\"><section class=\"slide\" id=\"a\"><p class=\"notes\">Shown</p><aside class=\"side notes\">New</aside></section></main>"
        );
    }

    #[test]
    fn appends_to_a_slides_narration() {
        let deck = r#"<section class="slide" id="a"><h1>A</h1></section>"#;
        let said = |html: &str| narration(html);
        let first = append_narration(deck, "a", "Well, so, um.", true).unwrap();
        assert_eq!(said(&first), "Well, so, um.");
        let on = append_narration(&first, "a", "Next bit.", false).unwrap();
        assert_eq!(said(&on), "Well, so, um. Next bit.");
        let back = append_narration(&on, "a", "R&D <costs>.", true).unwrap();
        assert_eq!(said(&back), "Well, so, um. Next bit.\n\nR&D <costs>.");
        assert_eq!(back.matches("class=\"narration\"").count(), 1);
        assert!(append_narration(deck, "nope", "x", true).is_err());
    }

    #[test]
    fn setting_narration_keeps_one_element_and_closes_an_open_one() {
        let two = "<main class=\"deck\"><section class=\"slide\" id=\"a\"><aside class=\"narration x\">One</aside><p>P</p> <aside class=\"narration\">Two</aside></section></main>";
        let out = set_narration(two, "a", "New").unwrap();
        assert_eq!(out, "<main class=\"deck\"><section class=\"slide\" id=\"a\"><aside class=\"narration x\">New</aside><p>P</p></section></main>");
        assert_eq!(set_narration(two, "a", "One").unwrap(), "<main class=\"deck\"><section class=\"slide\" id=\"a\"><aside class=\"narration x\">One</aside><p>P</p></section></main>");
        let spans = narration_spans(slide_markup(two, "a").unwrap());
        assert_eq!(spans.len(), 2);

        let open = "<main class=\"deck\"><section class=\"slide\" id=\"a\"><aside class=\"narration\">Old</section></main>";
        assert_eq!(
            set_narration(open, "a", "New").unwrap(),
            "<main class=\"deck\"><section class=\"slide\" id=\"a\"><aside class=\"narration\">New</aside></section></main>"
        );
    }
}
