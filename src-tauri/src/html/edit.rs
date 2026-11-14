//! Small edits of the document the slide operations share.

use std::ops::Range;

use super::scan::{find_ci, rfind_ci};

/// `snippet` put in right after the `<head>` tag, or at the start without one.
pub(super) fn insert_after_head(html: &str, snippet: &str) -> String {
    let at = find_ci(html, 0, "<head")
        .and_then(|s| html[s..].find('>').map(|e| s + e + 1))
        .unwrap_or(0);
    format!("{}{}{}", &html[..at], snippet, &html[at..])
}

/// Whitespace between the previous line break and `at`, used to indent inserted slides.
pub(crate) fn indent_before(html: &str, at: usize) -> &str {
    let line_start = html[..at].rfind('\n').map_or(0, |p| p + 1);
    let indent = &html[line_start..at];
    if indent.trim().is_empty() {
        indent
    } else {
        "    "
    }
}

/// Where new content goes in a deck without slides: just before the end of `<main>`.
pub(crate) fn end_of_deck(html: &str) -> Result<usize, String> {
    let at = rfind_ci(html, "</main")
        .or_else(|| rfind_ci(html, "</body"))
        .ok_or("The deck has no <main class=\"deck\"> container.")?;
    Ok(html[..at].trim_end().len())
}

/// `range` of `html` together with the whitespace before it, so that taking it out leaves the
/// lines around it as they were before it was put in.
pub(crate) fn with_indent(html: &str, range: &Range<usize>) -> Range<usize> {
    html[..range.start].trim_end().len()..range.end
}

/// `html` without `range` and the whitespace before it (see [`with_indent`]).
pub(crate) fn remove(html: &str, range: &Range<usize>) -> String {
    let cut = with_indent(html, range);
    format!("{}{}", &html[..cut.start], &html[cut.end..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_a_range_with_the_whitespace_before_it() {
        let html = "<main>\n  <p>a</p>\n  <p>b</p>\n</main>";
        let b = html.find("<p>b").unwrap()..html.find("</main").unwrap() - 1;
        assert_eq!(with_indent(html, &b).start, html.find("</p>").unwrap() + 4);
        assert_eq!(remove(html, &b), "<main>\n  <p>a</p>\n</main>");
        assert_eq!(remove("<p>x</p>", &(0..8)), "");
    }
}
