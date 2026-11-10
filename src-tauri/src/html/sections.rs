//! Adding, renaming and removing section markers.

use super::attrs::{SECTION_CLASS, SECTION_TITLE_ATTR};
use super::edit::{end_of_deck, indent_before, remove};
use super::entities::escape_attr;
use super::spans::{find_sections, find_slides, slide_span, SectionSpan};

fn section_span(sections: &[SectionSpan], index: usize) -> Result<&SectionSpan, String> {
    sections
        .get(index)
        .ok_or_else(|| format!("Section not found: {index}"))
}

/// Starts a new section with `title` right before slide `before`, or after the last slide
/// when `before` is `None`.
pub fn add_section(html: &str, before: Option<&str>, title: &str) -> Result<String, String> {
    let slides = find_slides(html);
    let marker = format!(
        "<div class=\"{SECTION_CLASS}\" {SECTION_TITLE_ATTR}=\"{}\"></div>",
        escape_attr(title.trim())
    );
    match before {
        Some(id) => {
            let span = slide_span(&slides, id)?;
            let at = span.range.start;
            let indent = indent_before(html, at);
            Ok(format!("{}{marker}\n{indent}{}", &html[..at], &html[at..]))
        }
        None => {
            let (at, indent) = match slides.last() {
                Some(last) => (
                    last.range.end,
                    indent_before(html, last.range.start).to_string(),
                ),
                None => (end_of_deck(html)?, "    ".to_string()),
            };
            Ok(format!("{}\n{indent}{marker}{}", &html[..at], &html[at..]))
        }
    }
}

/// Sets the title of the section with this document-order index, keeping its other attributes.
pub fn rename_section(html: &str, index: usize, title: &str) -> Result<String, String> {
    let sections = find_sections(html);
    let span = section_span(&sections, index)?;
    let title = escape_attr(title.trim());
    Ok(match &span.title_value {
        Some(value) => format!("{}{title}{}", &html[..value.start], &html[value.end..]),
        None => format!(
            "{} {SECTION_TITLE_ATTR}=\"{title}\"{}",
            &html[..span.tag_name_end],
            &html[span.tag_name_end..]
        ),
    })
}

/// Removes a section marker; its slides stay and join the previous section.
pub fn delete_section(html: &str, index: usize) -> Result<String, String> {
    let sections = find_sections(html);
    let span = section_span(&sections, index)?;
    Ok(remove(html, &span.range))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::html::fixtures::*;

    const THREE_SLIDES: &str = "<html><body><main class=\"deck\">\n  <section class=\"slide\" id=\"a\">A</section>\n  <section class=\"slide\" id=\"b\">B</section>\n  <section class=\"slide\" id=\"c\">C</section>\n</main></body></html>";

    #[test]
    fn adds_a_section_before_a_slide_with_matching_indent() {
        let out = add_section(THREE_SLIDES, Some("b"), "Part \"2\" & more").unwrap();
        assert_eq!(
            out,
            THREE_SLIDES.replace(
                "  <section class=\"slide\" id=\"b\">",
                "  <div class=\"deck-section\" data-title=\"Part &quot;2&quot; &amp; more\"></div>\n  <section class=\"slide\" id=\"b\">"
            )
        );
        assert_eq!(section_titles(&out), [("Part \"2\" & more".to_string(), 1)]);
        assert_eq!(ids(&out), ["a", "b", "c"]);
    }

    #[test]
    fn adds_a_section_at_the_end_or_into_an_empty_deck() {
        let out = add_section(THREE_SLIDES, None, "End").unwrap();
        assert_eq!(section_titles(&out), [("End".to_string(), 3)]);
        assert!(out.ends_with("</div>\n</main></body></html>"));
        let empty = "<main class=\"deck\">\n</main>";
        let out = add_section(empty, None, "Only").unwrap();
        assert_eq!(section_titles(&out), [("Only".to_string(), 0)]);
        assert!(add_section("<p>x</p>", None, "x").is_err());
        assert!(add_section(THREE_SLIDES, Some("nope"), "x").is_err());
    }

    #[test]
    fn renames_a_section_and_keeps_other_attributes() {
        let out = rename_section(SECTIONED, 1, "Closing <b>").unwrap();
        assert_eq!(section_titles(&out)[1], ("Closing <b>".to_string(), 3),);
        assert!(out.contains("data-title=\"Closing &lt;b&gt;\" ></div>"));
        assert_eq!(section_titles(&out)[0].0, "Intro & \"goals\"");
        let bare = "<div class=\"deck-section\" id=\"s\"></div>";
        let out = rename_section(bare, 0, "New").unwrap();
        assert_eq!(
            out,
            "<div data-title=\"New\" class=\"deck-section\" id=\"s\"></div>"
        );
        assert!(rename_section(SECTIONED, 2, "x").is_err());
    }

    #[test]
    fn deletes_only_the_marker() {
        let out = delete_section(SECTIONED, 0).unwrap();
        assert_eq!(section_titles(&out), [("Wrap up".to_string(), 3)]);
        assert_eq!(ids(&out), ["a", "b", "c", "d"]);
        assert!(!out.contains("Intro"));
        assert!(out.contains("<section class=\"slide\" id=\"b\">"));
        assert!(delete_section(SECTIONED, 5).is_err());
    }
}
