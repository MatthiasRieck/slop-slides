//! What changed in a slide's words: the text on the slide line by line, its speaker notes and
//! its narration, each as it was and as it is. Pure text work, no git.

use serde::Serialize;

use crate::find;
use crate::html;

/// Where on a slide a text is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TextPlace {
    /// On the slide itself.
    Slide,
    Notes,
    Narration,
}

/// A text of a slide that changed: lines next to each other that differ, or the whole of its
/// notes or narration. Either side is empty when the text is new or gone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextChange {
    #[serde(rename = "where")]
    pub place: TextPlace,
    pub before: String,
    pub after: String,
}

/// Elements whose content is not text of the slide.
const RAW_TEXT: &[&str] = &["script", "style", "textarea", "title", "template"];
/// Elements that sit inside a line of text; any other tag starts a new line.
const INLINE: &[&str] = &[
    "a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "del", "dfn", "em", "font", "i", "ins",
    "kbd", "mark", "q", "s", "samp", "small", "span", "strong", "sub", "sup", "time", "tspan", "u",
    "var", "wbr",
];
/// The editor's invisible stand-ins, whose text is not the slide's.
const PLACEHOLDERS: &[&str] = &[html::RESIZE_PLACEHOLDER_ATTR, html::DELETE_PLACEHOLDER_ATTR];
/// The asides that do not show on the slide; they are compared on their own.
const OFF_SLIDE: &[&str] = &[html::NOTES_CLASS, html::NARRATION_CLASS];
/// Slides with more lines than this are compared as one text, to keep the comparison quick.
const MAX_LINES: usize = 400;

/// Reads one aside's text out of a slide's markup.
type ReadAside = fn(&str) -> String;

/// The texts that differ between the slide `old` and the slide `new` (their markup): first what
/// shows on the slide, top to bottom, then the notes, then the narration.
pub(super) fn text_changes(old: &str, new: &str) -> Vec<TextChange> {
    let mut changes = line_changes(&lines(old), &lines(new));
    let asides: [(TextPlace, ReadAside); 2] = [
        (TextPlace::Notes, html::notes),
        (TextPlace::Narration, html::narration),
    ];
    for (place, read) in asides {
        let (before, after) = (read(old), read(new));
        if before != after {
            changes.push(TextChange {
                place,
                before,
                after,
            });
        }
    }
    changes
}

/// The text that shows on a slide, one entry for each run of text between elements that break
/// the line (a heading, a paragraph, a list item, a `<br>`).
pub(super) fn lines(markup: &str) -> Vec<String> {
    let bytes = markup.as_bytes();
    let mut lines = Vec::new();
    // Where the line being read starts.
    let mut start = 0;
    let mut i = 0;
    let mut flush = |from: usize, to: usize| {
        let text = find::plain_text(&markup[from..to]);
        if !text.is_empty() {
            lines.push(text);
        }
    };
    while i < markup.len() {
        if markup[i..].starts_with("<!--") {
            i = markup[i..].find("-->").map_or(markup.len(), |e| i + e + 3);
            continue;
        }
        let tag = match bytes[i] {
            b'<' => html::parse_tag(markup, i),
            _ => None,
        };
        let Some(tag) = tag else {
            i += markup[i..].chars().next().map_or(1, char::len_utf8);
            continue;
        };
        if !tag.closing && tag.is_any(RAW_TEXT) {
            // Stays in the line, whole: reading the line leaves it out.
            i = element_end(markup, &tag);
        } else if !tag.closing && is_left_out(&tag) {
            flush(start, i);
            i = element_end(markup, &tag);
            start = i;
        } else if tag.is_any(INLINE) {
            i = tag.end;
        } else {
            flush(start, i);
            i = tag.end;
            start = i;
        }
    }
    flush(start, markup.len());
    lines
}

/// Whether `tag` opens an element whose text is not on the slide: notes, narration, a placeholder.
fn is_left_out(tag: &html::Tag) -> bool {
    OFF_SLIDE.iter().any(|class| html::has_class(tag, class))
        || tag
            .attrs()
            .any(|a| PLACEHOLDERS.iter().any(|name| a.is(name)))
}

/// Where the element `tag` opens ends: after the end tag that closes it, counting the elements
/// of its name inside it, or at the end of `markup` when it is never closed.
fn element_end(markup: &str, tag: &html::Tag) -> usize {
    if tag.is_any(html::VOID_ELEMENTS) || markup[..tag.end].ends_with("/>") {
        return tag.end;
    }
    let mut depth = 1;
    let mut i = tag.end;
    while let Some(at) = markup[i..].find('<').map(|e| i + e) {
        let Some(inner) = html::parse_tag(markup, at) else {
            i = at + 1;
            continue;
        };
        i = inner.end;
        if inner.is(tag.raw_name()) {
            depth = if inner.closing { depth - 1 } else { depth + 1 };
            if depth == 0 {
                return i;
            }
        }
    }
    markup.len()
}

/// The lines that differ between `old` and `new`, those next to each other as one change.
fn line_changes(old: &[String], new: &[String]) -> Vec<TextChange> {
    let change = |before: &[String], after: &[String]| TextChange {
        place: TextPlace::Slide,
        before: before.join("\n"),
        after: after.join("\n"),
    };
    if old == new {
        return Vec::new();
    }
    if old.len() > MAX_LINES || new.len() > MAX_LINES {
        return vec![change(old, new)];
    }
    // common[i][j]: how many lines `old[i..]` and `new[j..]` have in common, in order.
    let mut common = vec![vec![0usize; new.len() + 1]; old.len() + 1];
    for i in (0..old.len()).rev() {
        for j in (0..new.len()).rev() {
            common[i][j] = if old[i] == new[j] {
                common[i + 1][j + 1] + 1
            } else {
                common[i + 1][j].max(common[i][j + 1])
            };
        }
    }
    let mut changes = Vec::new();
    let (mut i, mut j) = (0, 0);
    // Where the change being read starts in each.
    let (mut from_old, mut from_new) = (0, 0);
    loop {
        let same = i < old.len() && j < new.len() && old[i] == new[j];
        if same || (i == old.len() && j == new.len()) {
            if from_old < i || from_new < j {
                changes.push(change(&old[from_old..i], &new[from_new..j]));
            }
            if !same {
                break;
            }
            i += 1;
            j += 1;
            (from_old, from_new) = (i, j);
        } else if j == new.len() || (i < old.len() && common[i + 1][j] >= common[i][j + 1]) {
            i += 1;
        } else {
            j += 1;
        }
    }
    changes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slide(body: &str) -> String {
        format!("<section class=\"slide\" id=\"a\">{body}</section>")
    }

    fn on_slide(before: &str, after: &str) -> TextChange {
        TextChange {
            place: TextPlace::Slide,
            before: before.into(),
            after: after.into(),
        }
    }

    #[test]
    fn reads_a_slide_line_by_line() {
        let markup = slide(
            "<h1>Plan <em>B</em> &amp; more</h1>\n  <ul><li>One</li><li>Two<br>and a half</li></ul>\
             <style>h1 { color: red }</style><!-- <p>not shown</p> -->",
        );
        assert_eq!(
            lines(&markup),
            ["Plan B & more", "One", "Two", "and a half"]
        );
    }

    #[test]
    fn leaves_out_what_does_not_show_on_the_slide() {
        let markup = slide(
            "<p>Shown</p><aside class=\"notes\"><p>Say <b>hello</b></p></aside>\
             <aside class=\"narration\">Welcome</aside>\
             <div data-resize-placeholder><div><p>Stand-in</p></div></div><p>Also shown</p>",
        );
        assert_eq!(lines(&markup), ["Shown", "Also shown"]);
    }

    #[test]
    fn pairs_the_lines_that_changed_and_leaves_the_rest() {
        let old = slide("<h1>Pricing</h1><p>Basic: $10</p><p>Pro: $20</p><p>Ask us</p>");
        let new = slide("<h1>Pricing</h1><p>Basic: $12</p><p>Pro: $20</p><p>Call us</p>");
        assert_eq!(
            text_changes(&old, &new),
            [
                on_slide("Basic: $10", "Basic: $12"),
                on_slide("Ask us", "Call us")
            ]
        );
    }

    #[test]
    fn new_and_removed_lines_have_one_side() {
        let old = slide("<h1>Title</h1><p>Old line</p>");
        let new = slide("<p>Intro</p><h1>Title</h1>");
        assert_eq!(
            text_changes(&old, &new),
            [on_slide("", "Intro"), on_slide("Old line", "")]
        );
    }

    #[test]
    fn lines_next_to_each_other_are_one_change() {
        let old = slide("<p>A</p><p>B</p><p>C</p>");
        let new = slide("<p>A</p><p>X</p><p>Y</p><p>Z</p>");
        assert_eq!(text_changes(&old, &new), [on_slide("B\nC", "X\nY\nZ")]);
    }

    #[test]
    fn notes_and_narration_are_compared_on_their_own() {
        let old = slide("<p>A</p><aside class=\"notes\">Say hi</aside>");
        let new = slide(
            "<p>A</p><aside class=\"notes\">Say hello</aside><aside class=\"narration\">Welcome</aside>",
        );
        assert_eq!(
            text_changes(&old, &new),
            [
                TextChange {
                    place: TextPlace::Notes,
                    before: "Say hi".into(),
                    after: "Say hello".into()
                },
                TextChange {
                    place: TextPlace::Narration,
                    before: String::new(),
                    after: "Welcome".into()
                },
            ]
        );
    }

    #[test]
    fn a_change_to_the_markup_alone_is_no_change_to_the_text() {
        let old = slide("<h1>Title</h1>");
        let new = slide("<h1 style=\"color: blue\">Title</h1>");
        assert!(text_changes(&old, &new).is_empty());
    }

    #[test]
    fn a_very_long_slide_is_compared_as_one_text() {
        let body = |word: &str| -> String {
            (0..=MAX_LINES)
                .map(|n| format!("<p>{word} {n}</p>"))
                .collect()
        };
        let found = text_changes(&slide(&body("old")), &slide(&body("new")));
        assert_eq!(found.len(), 1);
        assert!(found[0].before.starts_with("old 0\nold 1"));
    }

    #[test]
    fn serializes_where_the_text_is() {
        let json = serde_json::to_string(&on_slide("a", "b")).unwrap();
        assert_eq!(json, r#"{"where":"slide","before":"a","after":"b"}"#);
    }
}
