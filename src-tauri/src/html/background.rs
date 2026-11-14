//! A slide's own background in its markup, as the slide editor sets it on the slide being
//! edited (see `setBackground` in `assets/editor/70-look.js`): for giving every slide the same
//! in one change.

use std::ops::Range;

use super::scan::parse_tag;
use super::spans::{find_slides, SlideSpan};

/// The properties a slide's own background sets in its `style`.
const BACKGROUND: [&str; 2] = ["background-color", "background-image"];

/// The declarations of an inline style, split at the semicolons that are not inside brackets
/// or quotes (a data URL has its own).
fn declarations(style: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let (mut depth, mut quote, mut from) = (0usize, None, 0);
    for (i, c) in style.char_indices() {
        match (quote, c) {
            (Some(q), _) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'') => quote = Some(c),
            (None, '(') => depth += 1,
            (None, ')') => depth = depth.saturating_sub(1),
            (None, ';') if depth == 0 => {
                parts.push(&style[from..i]);
                from = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&style[from..]);
    parts
        .into_iter()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect()
}

/// The property a declaration sets, in lowercase.
fn property(declaration: &str) -> String {
    declaration
        .split(':')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

/// What gives the slide at `span` `color` as its own background (None: the deck's again),
/// keeping the rest of its style; None when it has that already.
fn background_edit(
    html: &str,
    span: &SlideSpan,
    color: Option<&str>,
) -> Option<(Range<usize>, String)> {
    let tag = parse_tag(html, span.range.start)?;
    let style = tag.attr("style");
    let current = style.as_ref().map_or("", |s| s.value);
    let mut next: Vec<String> = declarations(current)
        .into_iter()
        .filter(|d| !BACKGROUND.contains(&property(d).as_str()))
        .map(str::to_string)
        .collect();
    if let Some(color) = color {
        next.push(format!("background-color: {color}"));
        next.push("background-image: none".into());
    }
    let next = next.join("; ").replace('"', "'");
    match style {
        Some(style) if next.is_empty() => {
            // Out with the space before it.
            let start = html[..style.range.start].trim_end().len();
            Some((start..style.range.end, String::new()))
        }
        Some(style) => {
            let attribute = format!("style=\"{next}\"");
            (html[style.range.clone()] != attribute).then_some((style.range, attribute))
        }
        None if next.is_empty() => None,
        None => {
            let at = span.tag_name_end;
            Some((at..at, format!(" style=\"{next}\"")))
        }
    }
}

/// `html` with `color` as the own background of every slide that is not locked (None: the
/// deck's again), and how many slides that changed: one scan of the document, one copy of it.
pub fn set_background_of_all(html: &str, color: Option<&str>) -> (String, usize) {
    let edits: Vec<_> = find_slides(html)
        .iter()
        .filter(|span| span.locked.is_none())
        .filter_map(|span| background_edit(html, span, color))
        .collect();
    let mut out = String::with_capacity(html.len() + edits.len() * 64);
    let mut at = 0;
    for (range, text) in &edits {
        out.push_str(&html[at..range.start]);
        out.push_str(text);
        at = range.end;
    }
    out.push_str(&html[at..]);
    (out, edits.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deck(slides: &[&str]) -> String {
        format!("<main class=\"deck\">\n{}\n</main>", slides.join("\n"))
    }

    #[test]
    fn gives_every_slide_its_own_background_over_the_decks() {
        let (out, changed) = set_background_of_all(
            &deck(&[r#"<section class="slide" id="a"><h1>Hi</h1></section>"#]),
            Some("#ff0000"),
        );
        assert_eq!(changed, 1);
        assert_eq!(
            out,
            deck(&[
                r#"<section style="background-color: #ff0000; background-image: none" class="slide" id="a"><h1>Hi</h1></section>"#
            ])
        );
    }

    #[test]
    fn replaces_a_background_it_had_keeping_the_rest_of_its_style() {
        let (out, _) = set_background_of_all(
            &deck(&[
                r#"<section class="slide" id="a" style="color: red; background-color: #000; background-image: url('x;y.png')">A</section>"#,
            ]),
            Some("#00ff00"),
        );
        assert_eq!(
            out,
            deck(&[
                r#"<section class="slide" id="a" style="color: red; background-color: #00ff00; background-image: none">A</section>"#
            ])
        );
    }

    #[test]
    fn takes_its_own_background_off_with_none() {
        let (out, changed) = set_background_of_all(
            &deck(&[
                r#"<section class="slide" id="a" style="background-color: #000; background-image: none">A</section>"#,
                r#"<section class="slide" id="b" style="padding: 0; background-color: #000">B</section>"#,
                r#"<section class="slide" id="c">C</section>"#,
            ]),
            None,
        );
        assert_eq!(changed, 2, "the third had none");
        assert_eq!(
            out,
            deck(&[
                r#"<section class="slide" id="a">A</section>"#,
                r#"<section class="slide" id="b" style="padding: 0">B</section>"#,
                r#"<section class="slide" id="c">C</section>"#,
            ])
        );
    }

    #[test]
    fn leaves_locked_slides_and_those_with_that_background_alone() {
        let same = r#"<section class="slide" id="a" style="background-color: #fff; background-image: none">A</section>"#;
        let locked = r#"<section class="slide" id="b" data-locked>B</section>"#;
        let html = deck(&[same, locked]);
        assert_eq!(
            set_background_of_all(&html, Some("#fff")),
            (html.clone(), 0)
        );
    }

    #[test]
    fn splits_a_style_only_where_a_declaration_ends() {
        assert_eq!(
            declarations("a: url(data:x;y); b: 'p;q' ; ;c:d"),
            ["a: url(data:x;y)", "b: 'p;q'", "c:d"]
        );
        assert_eq!(property(" Background-Color : red"), "background-color");
    }
}
