//! Slide operations: ids, adding, removing, moving, replacing and copying slides.

use std::collections::HashSet;
use std::ops::Range;

use super::attrs::{ADDED_ATTR, MOVED_ATTR};
#[cfg(test)]
use super::edit::remove;
use super::edit::{end_of_deck, indent_before};
#[cfg(test)]
use super::scan::tags;
use super::scan::Tag;
use super::slide_attrs::set_locked;
use super::spans::{find_sections, find_slides, section_key, slide_span, span_of, SlideSpan};

pub fn slugify(text: &str) -> String {
    let mut slug = String::new();
    for ch in text.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    let slug: String = slug.trim_end_matches('-').chars().take(48).collect();
    slug.trim_end_matches('-').to_string()
}

pub(super) fn unique_id(taken: &HashSet<String>, base: &str) -> String {
    let base = if base.is_empty() { "slide" } else { base };
    if !taken.contains(base) {
        return base.to_string();
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|c| !taken.contains(c))
        .expect("unbounded")
}

/// Gives every slide a unique, non-empty id. Returns `None` when nothing changed.
pub fn normalize_ids(html: &str) -> Option<String> {
    let slides = find_slides(html);
    let mut taken = HashSet::new();
    let mut edits: Vec<(Range<usize>, String)> = Vec::new();
    for (index, slide) in slides.iter().enumerate() {
        match &slide.id {
            Some(id) if taken.insert(id.clone()) => {}
            existing => {
                let base = existing
                    .as_deref()
                    .map(slugify)
                    .unwrap_or_else(|| format!("slide-{}", index + 1));
                let id = unique_id(&taken, &base);
                taken.insert(id.clone());
                match &slide.id_value {
                    Some(range) => edits.push((range.clone(), id)),
                    None => edits.push((
                        slide.tag_name_end..slide.tag_name_end,
                        format!(" id=\"{id}\""),
                    )),
                }
            }
        }
    }
    if edits.is_empty() {
        return None;
    }
    let mut out = html.to_string();
    for (range, text) in edits.into_iter().rev() {
        out.replace_range(range, &text);
    }
    Some(out)
}

/// Reorders slides and section markers. `order` lists every slide id and every marker key
/// (see [`section_key`]) in the new order; the items trade places, everything between them
/// stays where it is.
pub fn reorder(html: &str, order: &[String]) -> Result<String, String> {
    let slides = find_slides(html);
    let sections = find_sections(html);
    let mut items: Vec<(Range<usize>, Option<String>)> = slides
        .iter()
        .map(|s| (s.range.clone(), s.id.clone()))
        .chain(
            sections
                .iter()
                .enumerate()
                .map(|(i, s)| (s.range.clone(), Some(section_key(i)))),
        )
        .collect();
    items.sort_by_key(|(range, _)| range.start);
    let mut current: Vec<_> = items.iter().filter_map(|(_, key)| key.clone()).collect();
    let mut proposed = order.to_vec();
    current.sort();
    proposed.sort();
    if current != proposed || current.len() != items.len() {
        return Err("The slides changed while reordering; try again.".into());
    }
    let range_of = |key: &str| {
        items
            .iter()
            .find(|(_, k)| k.as_deref() == Some(key))
            .map(|(range, _)| range.clone())
            .expect("keys were validated")
    };
    let mut out = String::with_capacity(html.len());
    let mut at = 0;
    for ((slot, _), key) in items.iter().zip(order) {
        out.push_str(&html[at..slot.start]);
        out.push_str(&html[range_of(key)]);
        at = slot.end;
    }
    out.push_str(&html[at..]);
    Ok(out)
}

/// `html` without slide `id`. The app deletes slides several at once (see
/// [`super::edit_slides`]); this is the change to one, which tests hold that against.
#[cfg(test)]
pub fn delete(html: &str, id: &str) -> Result<String, String> {
    let slides = find_slides(html);
    let span = slide_span(&slides, id)?;
    Ok(remove(html, &span.range))
}

/// Inserts `section` (with `{{ID}}` replaced) after slide `after`, after the last slide,
/// or at the end of the `.deck` container when the deck is empty. Returns the new id.
pub fn insert(
    html: &str,
    after: Option<&str>,
    section: &str,
    id_hint: &str,
) -> Result<(String, String), String> {
    let slides = find_slides(html);
    let taken: HashSet<String> = slides.iter().filter_map(|s| s.id.clone()).collect();
    let id = unique_id(&taken, &slugify(id_hint));
    let section = section.replace(ID_PLACEHOLDER, &id);
    let anchor = after.and_then(|a| span_of(&slides, a)).or(slides.last());
    let (at, indent) = match anchor {
        Some(span) => (
            span.range.end,
            indent_before(html, span.range.start).to_string(),
        ),
        None => (end_of_deck(html)?, "    ".to_string()),
    };
    let out = format!(
        "{}\n{}{}{}",
        &html[..at],
        indent,
        section.trim(),
        &html[at..]
    );
    Ok((out, id))
}

/// Whether `tag` opens an element moved or added by hand.
pub(super) fn is_moved(tag: &Tag) -> bool {
    tag.attrs().any(|a| a.is(MOVED_ATTR) || a.is(ADDED_ATTR))
}

/// Whether the slide markup contains an element moved or added by hand (see [`MOVED_ATTR`] and
/// [`ADDED_ATTR`]). The app reads it along with the rest it shows of a slide (see
/// [`super::slide_content`]); this is the question by itself, which tests hold that against.
#[cfg(test)]
pub fn has_moved(slide: &str) -> bool {
    tags(slide).any(|(_, tag)| !tag.closing && is_moved(&tag))
}

/// Replaces slide `id` with `markup`, which must be one whole `<section class="slide">` with
/// the same id. Returns the new document and the slide's previous markup.
pub fn replace_slide(html: &str, id: &str, markup: &str) -> Result<(String, String), String> {
    let markup = whole_slide(markup, id)?;
    let slides = find_slides(html);
    Ok(put_slide(html, slide_span(&slides, id)?, markup))
}

/// What [`replace_slide_at`] made of a document.
pub struct ReplacedSlide {
    /// The new document.
    pub html: String,
    /// The slide's markup before.
    pub previous: String,
    /// The slide as it is in the new document: the span the whole document's scan would give
    /// it, found by scanning the new markup alone.
    pub span: SlideSpan,
}

/// [`replace_slide`] of the slide at `span`, one of `html`'s slides already found; also says
/// where the new slide is (see [`ReplacedSlide`]).
pub fn replace_slide_at(
    html: &str,
    span: &SlideSpan,
    markup: &str,
) -> Result<ReplacedSlide, String> {
    let id = span.id.as_deref().unwrap_or_default();
    let (markup, mut new_span) = whole_slide_span(markup, id)?;
    // The slide starts where the old one did, where the document's scan is between tags as it
    // is at the start of the markup alone; and the markup ends that scan between tags too (it
    // ends with the slide's `</section>`), so everything after it reads as before.
    new_span.shift(span.range.start as isize);
    let (html, previous) = put_slide(html, span, markup);
    Ok(ReplacedSlide {
        html,
        previous,
        span: new_span,
    })
}

/// `markup` trimmed, when it is one whole `<section class="slide">` with the id `id`.
fn whole_slide<'a>(markup: &'a str, id: &str) -> Result<&'a str, String> {
    whole_slide_span(markup, id).map(|(markup, _)| markup)
}

/// [`whole_slide`], with the slide's span in the trimmed markup.
fn whole_slide_span<'a>(markup: &'a str, id: &str) -> Result<(&'a str, SlideSpan), String> {
    let markup = markup.trim();
    let mut replacement = find_slides(markup);
    match replacement.as_slice() {
        [only] if only.range == (0..markup.len()) && only.id.as_deref() == Some(id) => {
            Ok((markup, replacement.remove(0)))
        }
        _ => Err(format!("The edited markup is not slide `{id}`.")),
    }
}

/// `html` with `markup` in place of the slide at `span`, and that slide's markup.
fn put_slide(html: &str, span: &SlideSpan, markup: &str) -> (String, String) {
    let previous = html[span.range.clone()].to_string();
    let out = format!(
        "{}{markup}{}",
        &html[..span.range.start],
        &html[span.range.end..]
    );
    (out, previous)
}

/// What [`insert`] replaces with the new slide's id in the markup it is given.
pub(super) const ID_PLACEHOLDER: &str = "{{ID}}";

/// Slide `id` of `html` with its id replaced by the placeholder [`insert`] fills in.
fn slide_with_id_placeholder(html: &str, id: &str) -> Result<String, String> {
    let slides = find_slides(html);
    Ok(with_id_placeholder(html, slide_span(&slides, id)?))
}

/// The slide at `span` of `html`, which has an id, with [`ID_PLACEHOLDER`] for it.
pub(super) fn with_id_placeholder(html: &str, span: &SlideSpan) -> String {
    let range = span
        .id_value
        .clone()
        .expect("slides with ids have id ranges");
    format!(
        "{}{ID_PLACEHOLDER}{}",
        &html[span.range.start..range.start],
        &html[range.end..span.range.end]
    )
}

/// Inserts a copy of slide `id` right after it. The copy is not locked, so it can be changed.
/// The app duplicates slides several at once (see [`super::edit_slides`]); this is the change
/// to one, which tests hold that against.
#[cfg(test)]
pub fn duplicate(html: &str, id: &str) -> Result<(String, String), String> {
    let copy = slide_with_id_placeholder(html, id)?;
    let (out, new_id) = insert(html, Some(id), &copy, &format!("{id}-copy"))?;
    Ok((set_locked(&out, &new_id, false)?, new_id))
}

/// Inserts a copy of slide `slide` of the document `source` (a template) after `after`,
/// keeping its id when the deck does not use it yet. Returns the document and the new id.
pub fn copy_slide(
    html: &str,
    after: Option<&str>,
    source: &str,
    slide: &str,
) -> Result<(String, String), String> {
    let copy = slide_with_id_placeholder(source, slide)?;
    let (out, id) = insert(html, after, &copy, slide)?;
    Ok((set_locked(&out, &id, false)?, id))
}

/// The markup of slide `id`, as it is in the document.
pub fn slide_markup<'a>(html: &'a str, id: &str) -> Result<&'a str, String> {
    let slides = find_slides(html);
    let span = slide_span(&slides, id)?;
    Ok(&html[span.range.clone()])
}

/// Inserts `markup`, one slide copied from a deck (this one or another), after `after`,
/// keeping its id when the deck does not use it yet. Returns the document and the new id.
pub fn paste_slide(
    html: &str,
    after: Option<&str>,
    markup: &str,
) -> Result<(String, String), String> {
    let markup = markup.trim();
    let slides = find_slides(markup);
    let [slide] = slides.as_slice() else {
        return Err("The clipboard holds no slide.".into());
    };
    if slide.range != (0..markup.len()) {
        return Err("The clipboard holds no slide.".into());
    }
    let markup = normalize_ids(markup).unwrap_or_else(|| markup.to_string());
    let id = find_slides(&markup)[0].id.clone().expect("normalized");
    copy_slide(html, after, &markup, &id)
}

/// `html` without its slides and section markers: the deck's shell (styles, runtime).
pub fn strip_slides(html: &str) -> String {
    let mut ranges: Vec<Range<usize>> = find_slides(html)
        .into_iter()
        .map(|s| s.range)
        .chain(find_sections(html).into_iter().map(|s| s.range))
        .collect();
    ranges.sort_by_key(|r| r.start);
    let mut out = String::with_capacity(html.len());
    let mut at = 0;
    for range in ranges {
        let start = html[at..range.start].trim_end().len() + at;
        out.push_str(&html[at..start]);
        at = range.end;
    }
    out.push_str(&html[at..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::html::fixtures::*;
    use crate::html::*;

    #[test]
    fn replaces_one_slide_and_returns_the_old_markup() {
        let html = "<main class=\"deck\">\n  <section class=\"slide\" id=\"a\"><p>A</p></section>\n  <section class=\"slide\" id=\"b\">B</section>\n</main>";
        let edited = "  <section class=\"slide\" id=\"a\"><p style=\"translate: 4px 2px\" data-moved=\"\">A!</p></section>\n";
        let (out, previous) = replace_slide(html, "a", edited).unwrap();
        assert_eq!(
            previous,
            "<section class=\"slide\" id=\"a\"><p>A</p></section>"
        );
        assert_eq!(
            out,
            "<main class=\"deck\">\n  <section class=\"slide\" id=\"a\"><p style=\"translate: 4px 2px\" data-moved=\"\">A!</p></section>\n  <section class=\"slide\" id=\"b\">B</section>\n</main>"
        );
        // Restoring the previous markup undoes the edit exactly.
        assert_eq!(replace_slide(&out, "a", &previous).unwrap().0, html);
    }

    #[test]
    fn refuses_markup_that_is_not_the_slide() {
        let html = "<main class=\"deck\"><section class=\"slide\" id=\"a\">A</section></main>";
        for bad in [
            "<section class=\"slide\" id=\"b\">A</section>",
            "<section class=\"slide\">A</section>",
            "<div>A</div>",
            "<section class=\"slide\" id=\"a\">A</section><section class=\"slide\" id=\"a\">A</section>",
            "<section class=\"slide\" id=\"a\">A</section><p>trailing</p>",
            "<section class=\"slide\" id=\"a\">unclosed",
            "",
        ] {
            assert!(replace_slide(html, "a", bad).is_err(), "accepted {bad:?}");
        }
        assert!(
            replace_slide(html, "zz", "<section class=\"slide\" id=\"zz\"></section>").is_err()
        );
    }

    #[test]
    fn detects_hand_moved_elements() {
        assert!(has_moved(
            r#"<section class="slide" id="a"><p data-moved style="translate: 1px 2px">A</p></section>"#
        ));
        assert!(!has_moved(
            r#"<section class="slide" id="a"><p>data-moved</p><!-- <p data-moved> --></section>"#
        ));
        assert!(has_moved(
            r#"<section class="slide" id="a"><div data-added="shape" style="position: absolute; left: 10px; top: 20px"></div></section>"#
        ));
        assert!(!has_moved(
            r#"<section class="slide" id="a"><p>data-added</p></section>"#
        ));
    }

    #[test]
    fn normalizes_missing_and_duplicate_ids() {
        let fixed = normalize_ids(DECK).unwrap();
        assert_eq!(ids(&fixed), ["intro", "plan", "slide-3"]);
        let dup = r#"<main class="deck"><section class="slide" id="a"></section><section class="slide" id="a"></section></main>"#;
        assert_eq!(ids(&normalize_ids(dup).unwrap()), ["a", "a-2"]);
        assert!(normalize_ids(&fixed).is_none());
    }

    #[test]
    fn reorders_deletes_duplicates_and_inserts() {
        let deck = normalize_ids(DECK).unwrap();
        let order = vec![
            "slide-3".to_string(),
            "intro".to_string(),
            "plan".to_string(),
        ];
        assert_eq!(ids(&reorder(&deck, &order).unwrap()), order);
        assert!(reorder(&deck, &order[..2]).is_err());

        assert_eq!(ids(&delete(&deck, "plan").unwrap()), ["intro", "slide-3"]);

        let (copied, id) = duplicate(&deck, "intro").unwrap();
        assert_eq!(id, "intro-copy");
        assert_eq!(ids(&copied), ["intro", "intro-copy", "plan", "slide-3"]);

        let (added, id) = insert(
            &deck,
            Some("intro"),
            r#"<section class="slide" id="{{ID}}"></section>"#,
            "slide",
        )
        .unwrap();
        assert_eq!(id, "slide");
        assert_eq!(ids(&added), ["intro", "slide", "plan", "slide-3"]);
    }

    #[test]
    fn copies_of_locked_slides_are_unlocked() {
        let deck = set_locked(&normalize_ids(DECK).unwrap(), "intro", true).unwrap();
        let (copied, id) = duplicate(&deck, "intro").unwrap();
        assert_eq!(id, "intro-copy");
        assert_eq!(locked(&copied), [true, false, false, false]);

        let (copied, id) = copy_slide(&normalize_ids(DECK).unwrap(), None, &deck, "intro").unwrap();
        assert_eq!(id, "intro-2");
        assert_eq!(locked(&copied), [false, false, false, false]);
    }

    #[test]
    fn duplicating_a_hidden_slide_keeps_it_hidden() {
        let deck = set_hidden(&normalize_ids(DECK).unwrap(), "intro", true).unwrap();
        let (copied, _) = duplicate(&deck, "intro").unwrap();
        assert_eq!(hidden(&copied), [true, true, false, false]);
    }

    #[test]
    fn slugify_cases() {
        assert_eq!(slugify("Hello, World!"), "hello-world");
        assert_eq!(
            slugify("  --Leading and trailing--  "),
            "leading-and-trailing"
        );
        assert_eq!(slugify("Q3   2024 / Plan"), "q3-2024-plan");
        assert_eq!(slugify("ÜBER café"), "ber-caf");
        assert_eq!(slugify("日本語"), "");
        assert_eq!(slugify(""), "");
        let long = slugify(&"word ".repeat(30));
        assert!(long.len() <= 48, "{long}");
        assert!(!long.ends_with('-'), "{long}");
    }

    #[test]
    fn unique_id_appends_the_first_free_number() {
        let taken: HashSet<String> = ["slide", "slide-2", "slide-4"].map(String::from).into();
        assert_eq!(unique_id(&taken, "slide"), "slide-3");
        assert_eq!(unique_id(&taken, "other"), "other");
        assert_eq!(
            unique_id(&taken, ""),
            "slide-3",
            "empty base falls back to 'slide'"
        );
    }

    #[test]
    fn normalize_ids_slugifies_duplicates_and_fills_empty_ids_in_place() {
        let html = r#"<main><section class="slide" id="Big Idea"></section><section class="slide" id="Big Idea"></section><section class="slide" id=""></section></main>"#;
        let out = normalize_ids(html).unwrap();
        assert_eq!(ids(&out), ["Big Idea", "big-idea", "slide-3"]);
        assert!(
            !out.contains(r#"id="""#),
            "empty id replaced, not duplicated"
        );
        assert_eq!(out.matches(" id=").count(), 3);
    }

    #[test]
    fn normalize_ids_never_collides_with_later_ids() {
        // Slide 1 has no id; "slide-1" is not taken yet when it is assigned, but slide 2
        // already claims it, so the second gets a suffix.
        let html =
            r#"<section class="slide"></section><section class="slide" id="slide-1"></section>"#;
        let out = normalize_ids(html).unwrap();
        let found = ids(&out);
        assert_eq!(found.len(), 2);
        assert_ne!(found[0], found[1]);
    }

    #[test]
    fn normalize_ids_leaves_the_rest_of_the_document_alone() {
        let html = "<html>\n<section class=\"slide\">A</section>\n<p>tail</p></html>";
        let out = normalize_ids(html).unwrap();
        assert_eq!(
            out,
            "<html>\n<section id=\"slide-1\" class=\"slide\">A</section>\n<p>tail</p></html>"
        );
    }

    #[test]
    fn reorder_rejects_unknown_or_missing_ids() {
        let deck = normalize_ids(DECK).unwrap();
        let order = |ids: &[&str]| ids.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(reorder(&deck, &order(&["intro", "plan", "nope"])).is_err());
        assert!(reorder(&deck, &order(&["intro", "plan", "slide-3", "extra"])).is_err());
        assert!(reorder(&deck, &order(&["intro", "intro", "plan"])).is_err());
        // A slide without an id cannot be addressed, so reordering is refused.
        assert!(reorder(DECK, &order(&["intro", "plan"])).is_err());
    }

    #[test]
    fn reorder_keeps_whitespace_and_surrounding_markup() {
        let deck = normalize_ids(DECK).unwrap();
        let same = reorder(&deck, &["intro".into(), "plan".into(), "slide-3".into()]).unwrap();
        assert_eq!(same, deck);
        let swapped = reorder(&deck, &["plan".into(), "intro".into(), "slide-3".into()]).unwrap();
        assert_eq!(swapped.len(), deck.len());
        assert_eq!(
            shell_hash(&swapped, &find_slides(&swapped), &find_sections(&swapped)),
            shell_hash(&deck, &find_slides(&deck), &find_sections(&deck))
        );
    }

    #[test]
    fn delete_removes_the_slide_and_its_leading_whitespace() {
        let html = "<main>\n  <section class=\"slide\" id=\"a\">A</section>\n  <section class=\"slide\" id=\"b\">B</section>\n</main>";
        assert_eq!(
            delete(html, "b").unwrap(),
            "<main>\n  <section class=\"slide\" id=\"a\">A</section>\n</main>"
        );
        assert_eq!(
            delete(html, "a").unwrap(),
            "<main>\n  <section class=\"slide\" id=\"b\">B</section>\n</main>"
        );
        let err = delete(html, "zzz").unwrap_err();
        assert!(err.contains("zzz"), "{err}");
    }

    #[test]
    fn duplicate_copies_markup_with_a_fresh_unique_id() {
        let deck = normalize_ids(DECK).unwrap();
        let (once, first) = duplicate(&deck, "plan").unwrap();
        let (twice, second) = duplicate(&once, "plan").unwrap();
        assert_eq!(first, "plan-copy");
        assert_eq!(second, "plan-copy-2");
        assert_eq!(
            ids(&twice),
            ["intro", "plan", "plan-copy-2", "plan-copy", "slide-3"]
        );
        let copy = find_slides(&twice)
            .into_iter()
            .find(|s| s.id.as_deref() == Some("plan-copy-2"))
            .unwrap();
        assert_eq!(
            &twice[copy.range],
            "<section class='slide' id=plan-copy-2><p>Plan</p></section>"
        );
        assert!(duplicate(&deck, "missing").is_err());
    }

    #[test]
    fn duplicate_keeps_nested_sections() {
        let deck = normalize_ids(DECK).unwrap();
        let (out, id) = duplicate(&deck, "intro").unwrap();
        let copy = find_slides(&out)
            .into_iter()
            .find(|s| s.id.as_deref() == Some(id.as_str()))
            .unwrap();
        assert!(out[copy.range].contains(r#"<section class="inner">x</section>"#));
    }

    #[test]
    fn insert_matches_the_indentation_of_the_anchor_slide() {
        let html = "<main>\n      <section class=\"slide\" id=\"a\"></section>\n</main>";
        let (out, _) = insert(
            html,
            Some("a"),
            "<section class=\"slide\" id=\"{{ID}}\"></section>\n",
            "b",
        )
        .unwrap();
        assert_eq!(
            out,
            "<main>\n      <section class=\"slide\" id=\"a\"></section>\n      <section class=\"slide\" id=\"b\"></section>\n</main>"
        );
    }

    #[test]
    fn insert_after_unknown_slide_appends_at_the_end() {
        let deck = normalize_ids(DECK).unwrap();
        let section = r#"<section class="slide" id="{{ID}}"></section>"#;
        let (out, id) = insert(&deck, Some("ghost"), section, "intro").unwrap();
        assert_eq!(id, "intro-2", "hint collides with an existing id");
        assert_eq!(ids(&out), ["intro", "plan", "slide-3", "intro-2"]);
        let (out, _) = insert(&deck, None, section, "x").unwrap();
        assert_eq!(ids(&out).last().map(String::as_str), Some("x"));
    }

    #[test]
    fn insert_into_empty_deck_goes_into_main_or_body_or_fails() {
        let section = r#"<section class="slide" id="{{ID}}"></section>"#;
        let empty = "<html><body>\n  <main class=\"deck\">\n  </main>\n</body></html>";
        let (out, id) = insert(empty, None, section, "Title").unwrap();
        assert_eq!(id, "title");
        assert_eq!(ids(&out), ["title"]);
        assert!(out.find("id=\"title\"").unwrap() < out.find("</main>").unwrap());

        let (out, id) = insert("<html><BODY>\n</BODY></html>", None, section, "").unwrap();
        assert_eq!(id, "slide");
        assert!(out.find(&format!("id=\"{id}\"")).unwrap() < out.find("</BODY>").unwrap());
        assert!(insert("<p>no container</p>", None, section, "x").is_err());
    }

    #[test]
    fn reorder_moves_markers_together_with_slides() {
        let html = "<main>\n<section class=\"slide\" id=\"a\">A</section>\n<div class=\"deck-section\" data-title=\"One\"></div>\n<section class=\"slide\" id=\"b\">B</section>\n<section class=\"slide\" id=\"c\">C</section>\n</main>";
        let order = |keys: &[&str]| keys.iter().map(|k| k.to_string()).collect::<Vec<_>>();
        let out = reorder(html, &order(&["a", "b", "section:0", "c"])).unwrap();
        assert_eq!(section_titles(&out), [("One".to_string(), 2)]);
        assert_eq!(ids(&out), ["a", "b", "c"]);
        let out = reorder(html, &order(&["section:0", "c", "b", "a"])).unwrap();
        assert_eq!(section_titles(&out), [("One".to_string(), 0)]);
        assert_eq!(ids(&out), ["c", "b", "a"]);
        assert!(out.starts_with("<main>\n<div class=\"deck-section\""));
        assert!(out.ends_with("</section>\n</main>"));
    }

    #[test]
    fn reorder_requires_every_marker() {
        let err = reorder(SECTIONED, &["a".into(), "b".into(), "c".into(), "d".into()]);
        assert!(err.is_err(), "markers missing from the order");
        let all: Vec<String> = ["a", "section:0", "b", "c", "section:1", "d"]
            .map(String::from)
            .into();
        assert_eq!(reorder(SECTIONED, &all).unwrap(), SECTIONED);
    }

    #[test]
    fn inserting_and_duplicating_slides_keeps_markers() {
        let (out, new) = duplicate(SECTIONED, "a").unwrap();
        assert_eq!(new, "a-copy");
        assert_eq!(
            section_titles(&out)
                .iter()
                .map(|(_, before)| *before)
                .collect::<Vec<_>>(),
            [2, 4]
        );
        let (out, _) = insert(
            SECTIONED,
            Some("c"),
            "<section class=\"slide\" id=\"{{ID}}\"></section>",
            "new",
        )
        .unwrap();
        assert_eq!(section_titles(&out)[1].1, 4);
    }

    #[test]
    fn strips_slides_and_sections_but_keeps_the_shell() {
        let shell = strip_slides(STYLED);
        assert!(find_slides(&shell).is_empty());
        assert!(find_sections(&shell).is_empty());
        assert!(shell.contains("<style>.x {}</style>"));
        assert!(
            shell.contains("<main class=\"deck\">\n  </main>"),
            "{shell}"
        );
    }

    #[test]
    fn copies_a_slide_from_another_document() {
        let deck = "<main class=\"deck\">\n    <section class=\"slide\" id=\"a\">A</section>\n    <section class=\"slide\" id=\"z\">Z</section>\n</main>";
        let (out, id) = copy_slide(deck, Some("a"), STYLED, "b").unwrap();
        assert_eq!(id, "b", "keeps the template's id when free");
        let ids: Vec<_> = find_slides(&out).into_iter().filter_map(|s| s.id).collect();
        assert_eq!(ids, ["a", "b", "z"]);
        assert!(out.contains("NASA said"));
        let (again, second) = copy_slide(&out, None, STYLED, "b").unwrap();
        assert_eq!(second, "b-2");
        assert_eq!(
            find_slides(&again).last().unwrap().id.as_deref(),
            Some("b-2")
        );
        assert!(copy_slide(deck, None, STYLED, "missing").is_err());
    }

    #[test]
    fn reads_one_slides_markup() {
        let deck = "<main class=\"deck\">\n  <section class=\"slide\" id=\"a\"><h1>A</h1></section>\n</main>";
        assert_eq!(
            slide_markup(deck, "a").unwrap(),
            "<section class=\"slide\" id=\"a\"><h1>A</h1></section>"
        );
        assert!(slide_markup(deck, "b").is_err());
    }

    #[test]
    fn pastes_a_copied_slide_after_the_selected_one() {
        let deck = "<main class=\"deck\">\n    <section class=\"slide\" id=\"a\">A</section>\n    <section class=\"slide\" id=\"z\">Z</section>\n</main>";
        let copied = "<section class=\"slide\" id=\"plan\" data-locked><p>Plan</p></section>";
        let (out, id) = paste_slide(deck, Some("a"), copied).unwrap();
        assert_eq!(id, "plan", "keeps its id when free");
        let ids: Vec<_> = find_slides(&out).into_iter().filter_map(|s| s.id).collect();
        assert_eq!(ids, ["a", "plan", "z"]);
        assert!(!is_locked(&out, "plan"), "a pasted copy can be changed");
        assert!(out.contains("    <section class=\"slide\" id=\"plan\""));

        let (again, second) = paste_slide(&out, Some("a"), copied).unwrap();
        assert_eq!(
            second, "plan-2",
            "the same slide pasted twice gets a new id"
        );
        let ids: Vec<_> = find_slides(&again)
            .into_iter()
            .filter_map(|s| s.id)
            .collect();
        assert_eq!(ids, ["a", "plan-2", "plan", "z"]);
    }

    #[test]
    fn a_pasted_slide_without_an_id_gets_one() {
        let deck = "<main class=\"deck\">\n</main>";
        let (out, id) = paste_slide(
            deck,
            None,
            "  <section class=\"slide\"><p>x</p></section>\n",
        )
        .unwrap();
        assert_eq!(id, "slide-1");
        assert_eq!(find_slides(&out)[0].id.as_deref(), Some("slide-1"));
    }

    #[test]
    fn only_a_single_slide_can_be_pasted() {
        let deck = "<main class=\"deck\"></main>";
        for markup in [
            "<p>Not a slide</p>",
            "<section class=\"slide\" id=\"a\"></section><section class=\"slide\" id=\"b\"></section>",
            "<div><section class=\"slide\" id=\"a\"></section></div>",
            "<section class=\"slide\" id=\"a\"></section><script>x()</script>",
        ] {
            assert!(paste_slide(deck, None, markup).is_err(), "{markup}");
        }
    }
}
