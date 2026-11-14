//! What the app shows of one slide besides its markup, read in one pass over it.

use super::asides::{aside_limit, aside_span, text_of};
use super::attrs::{NARRATION_CLASS, NOTES_CLASS};
use super::scan::{has_class, tags};
use super::slides::is_moved;

/// What [`slide_content`] reads from a slide's markup.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SlideContent {
    /// Whether an element was moved or added by hand (see [`has_moved`](super::has_moved)).
    pub moved: bool,
    /// What is said over the slide (see [`narration`](super::narration)).
    pub narration: String,
    /// The speaker notes (see [`notes`](super::notes)).
    pub notes: String,
}

/// The same as [`has_moved`](super::has_moved), [`narration`](super::narration) and
/// [`notes`](super::notes) of `slide`, from one scan of its markup instead of three: loading a
/// deck asks all of them of every slide.
pub fn slide_content(slide: &str) -> SlideContent {
    let limit = aside_limit(slide);
    let mut content = SlideContent::default();
    let (mut narration, mut notes) = (None, None);
    for (start, tag) in tags(slide) {
        if tag.closing {
            continue;
        }
        content.moved = content.moved || is_moved(&tag);
        if start >= limit || !tag.is("aside") {
            continue;
        }
        // Only the first aside of each kind counts.
        if narration.is_none() && has_class(&tag, NARRATION_CLASS) {
            narration = Some(aside_span(slide, start, &tag, limit));
        }
        if notes.is_none() && has_class(&tag, NOTES_CLASS) {
            notes = Some(aside_span(slide, start, &tag, limit));
        }
    }
    let text = |span: Option<super::asides::NarrationSpan>| {
        span.map_or_else(String::new, |span| text_of(&slide[span.inner]))
    };
    content.narration = text(narration);
    content.notes = text(notes);
    content
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::html::fixtures::*;
    use crate::html::*;

    /// One pass reads what the three separate scans do, for every slide of `html`.
    fn assert_same_as_separate_scans(html: &str) {
        for span in find_slides(html) {
            let slide = &html[span.range];
            assert_eq!(
                slide_content(slide),
                SlideContent {
                    moved: has_moved(slide),
                    narration: narration(slide),
                    notes: notes(slide),
                },
                "{slide}"
            );
        }
    }

    #[test]
    fn one_pass_reads_what_the_separate_scans_read() {
        assert_same_as_separate_scans(DECK);
        assert_same_as_separate_scans(&big_deck(3));
        let tricky = [
            // Both kinds, in either order, and one element that is both.
            r#"<section class="slide" id="a"><aside class="notes">N</aside><p data-moved>x</p><aside class="narration">S <b>aid</b><br>more</aside></section>"#,
            r#"<section class="slide" id="a"><aside class="narration notes">Both</aside><aside class="notes">Second</aside></section>"#,
            // Notes inside the narration, and an aside never closed.
            r#"<section class="slide" id="a"><aside class="narration">Out <aside class="notes">In</aside> more</aside></section>"#,
            r#"<section class="slide" id="a"><div data-added="shape"></div><aside class="notes">Open</section>"#,
            r#"<SECTION CLASS="slide" ID="a"><ASIDE CLASS="narration">Upper</ASIDE><P DATA-MOVED>x</P></SECTION>"#,
            // An aside after the slide's end tag is not the slide's.
            r#"<section class="slide" id="a"><p>x</p></section>"#,
            r#"<section class="slide" id="a"><!-- <aside class="narration">ghost</aside> --><script>'<p data-moved>'</script></section>"#,
        ];
        for html in tricky {
            assert_same_as_separate_scans(html);
        }
    }
}
