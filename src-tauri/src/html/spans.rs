//! Where the slides and section markers of a document are, and hashes of them.

use std::hash::{Hash, Hasher};
use std::ops::Range;

use super::attrs::{
    DURATION_ATTR, HIDDEN_ATTR, LOCKED_ATTR, NARRATION_START_ATTR, SECTION_CLASS,
    SECTION_TITLE_ATTR, TIME_ATTR,
};
use super::edit::with_indent;
use super::entities::decode_entities;
use super::scan::{find_ci, has_class, parse_tag, tags, Tag};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlideSpan {
    /// The whole `<section …>…</section>`.
    pub range: Range<usize>,
    pub id: Option<String>,
    /// Byte range of the id attribute's value, when present.
    pub id_value: Option<Range<usize>>,
    /// Byte offset just after `<section`.
    pub tag_name_end: usize,
    /// Byte range of the whole `data-hidden` attribute, when the slide is hidden.
    pub hidden: Option<Range<usize>>,
    /// Byte range of the whole `data-locked` attribute, when the slide is locked.
    pub locked: Option<Range<usize>>,
    /// Byte range of the whole `data-time` attribute, and its value, when the slide has one.
    pub time: Option<(Range<usize>, String)>,
    /// The same for the `data-duration` attribute.
    pub duration: Option<(Range<usize>, String)>,
    /// The same for the `data-narration-start` attribute.
    pub narration_start: Option<(Range<usize>, String)>,
}

/// `range` moved `by` bytes.
fn shifted(range: &Range<usize>, by: isize) -> Range<usize> {
    range.start.wrapping_add_signed(by)..range.end.wrapping_add_signed(by)
}

impl SlideSpan {
    /// Moves the span `by` bytes, as the slide moves when something before it grows or shrinks.
    pub fn shift(&mut self, by: isize) {
        self.range = shifted(&self.range, by);
        self.tag_name_end = self.tag_name_end.wrapping_add_signed(by);
        for range in [&mut self.id_value, &mut self.hidden, &mut self.locked]
            .into_iter()
            .flatten()
        {
            *range = shifted(range, by);
        }
        for (range, _) in [
            &mut self.time,
            &mut self.duration,
            &mut self.narration_start,
        ]
        .into_iter()
        .flatten()
        {
            *range = shifted(range, by);
        }
    }
}

impl SectionSpan {
    /// Moves the span `by` bytes (see [`SlideSpan::shift`]).
    pub fn shift(&mut self, by: isize) {
        self.range = shifted(&self.range, by);
        self.tag_name_end = self.tag_name_end.wrapping_add_signed(by);
        if let Some(range) = &mut self.title_value {
            *range = shifted(range, by);
        }
    }
}

/// Key of the section marker with this document-order index, as used by [`reorder`](super::reorder).
pub fn section_key(index: usize) -> String {
    format!("section:{index}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SectionSpan {
    /// The marker element, including an immediately following `</div>`.
    pub range: Range<usize>,
    /// Decoded `data-title`; empty when missing.
    pub title: String,
    /// Byte range of the title attribute's value, when present.
    pub title_value: Option<Range<usize>>,
    /// Byte offset just after `<div`.
    pub tag_name_end: usize,
    /// Number of slides that come before the marker.
    pub before: usize,
    /// Whether the marker has no content besides its own end tag.
    pub empty: bool,
}

/// Top-level slide sections in document order.
pub fn find_slides(html: &str) -> Vec<SlideSpan> {
    scan(html, None)
}

/// Section markers between slides, in document order. Markers inside a slide are content
/// of that slide, not sections.
pub fn find_sections(html: &str) -> Vec<SectionSpan> {
    find_spans(html).1
}

/// The slides and the section markers between them, found in one pass over the document.
pub fn find_spans(html: &str) -> (Vec<SlideSpan>, Vec<SectionSpan>) {
    let mut sections = Vec::new();
    let slides = scan(html, Some(&mut sections));
    (slides, sections)
}

#[cfg(test)]
thread_local! {
    static SCANS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// How many times this thread has scanned a document for its slides, for tests that pin how
/// often an operation does.
#[cfg(test)]
pub(crate) fn scans() -> usize {
    SCANS.get()
}

/// One pass over the document's tags: the slides, and the section markers too when asked.
fn scan(html: &str, mut sections: Option<&mut Vec<SectionSpan>>) -> Vec<SlideSpan> {
    #[cfg(test)]
    SCANS.set(SCANS.get() + 1);
    let mut slides = Vec::new();
    let mut open: Option<(SlideSpan, usize)> = None; // (slide, nested <section> depth)
                                                     // Markers found since the open slide started: content of it once it closes, and markers
                                                     // between slides if it never does (it is no slide then).
    let mut markers_in_open = 0;
    for (i, tag) in tags(html) {
        if !tag.is("section") {
            if let Some(sections) = sections.as_deref_mut() {
                if let Some(section) = section_span(html, i, &tag, slides.len()) {
                    sections.push(section);
                }
            }
            continue;
        }
        match (&mut open, tag.closing) {
            (Some((_, depth)), false) => *depth += 1,
            (Some((_, depth)), true) if *depth > 0 => *depth -= 1,
            (Some(_), true) => {
                let (mut slide, _) = open.take().unwrap();
                slide.range.end = tag.end;
                slides.push(slide);
                if let Some(sections) = sections.as_deref_mut() {
                    sections.truncate(markers_in_open);
                }
            }
            (None, false) if has_class(&tag, "slide") => {
                let mut slide = SlideSpan {
                    range: i..i,
                    id: None,
                    id_value: None,
                    tag_name_end: tag.name_end,
                    hidden: None,
                    locked: None,
                    time: None,
                    duration: None,
                    narration_start: None,
                };
                // The first of each attribute counts, as it does in a browser.
                for attr in tag.attrs() {
                    let valued = || Some((attr.range.clone(), attr.value.to_string()));
                    if attr.is("id") && slide.id_value.is_none() {
                        slide.id = Some(attr.value.to_string()).filter(|v| !v.is_empty());
                        slide.id_value = Some(attr.value_range.clone());
                    } else if attr.is(HIDDEN_ATTR) && slide.hidden.is_none() {
                        slide.hidden = Some(attr.range.clone());
                    } else if attr.is(LOCKED_ATTR) && slide.locked.is_none() {
                        slide.locked = Some(attr.range.clone());
                    } else if attr.is(TIME_ATTR) && slide.time.is_none() {
                        slide.time = valued();
                    } else if attr.is(DURATION_ATTR) && slide.duration.is_none() {
                        slide.duration = valued();
                    } else if attr.is(NARRATION_START_ATTR) && slide.narration_start.is_none() {
                        slide.narration_start = valued();
                    }
                }
                markers_in_open = sections.as_deref().map_or(0, |s| s.len());
                open = Some((slide, 0));
            }
            _ => {}
        }
    }
    slides
}

/// The section marker `tag` at `at` opens, after `before` slides; None when it is no marker.
fn section_span(html: &str, at: usize, tag: &Tag, before: usize) -> Option<SectionSpan> {
    if tag.closing || !tag.is("div") || !has_class(tag, SECTION_CLASS) {
        return None;
    }
    let title = tag.attr(SECTION_TITLE_ATTR);
    let rest = &html[tag.end..];
    let after_ws = rest.trim_start();
    let closer = after_ws
        .get(..5)
        .filter(|c| c.eq_ignore_ascii_case("</div"))
        .and_then(|_| after_ws.find('>'))
        .map(|e| tag.end + (rest.len() - after_ws.len()) + e + 1);
    Some(SectionSpan {
        range: at..closer.unwrap_or(tag.end),
        title: title
            .as_ref()
            .map(|a| decode_entities(a.value).trim().to_string())
            .unwrap_or_default(),
        title_value: title.map(|a| a.value_range),
        tag_name_end: tag.name_end,
        before,
        empty: closer.is_some(),
    })
}

/// Whether the page has the deck's slide container, `<main class="deck">`.
pub(crate) fn has_deck_container(html: &str) -> bool {
    let mut from = 0;
    while let Some(at) = find_ci(html, from, "<main") {
        if parse_tag(html, at).is_some_and(|t| t.is("main") && has_class(&t, "deck")) {
            return true;
        }
        from = at + 1;
    }
    false
}

pub fn content_hash(text: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

/// Hash of everything except the slides, section markers, review marks and comments: shared
/// styles, fonts, runtime. The leading whitespace of each of those goes with it, so adding or
/// removing one leaves the hash alone.
pub fn shell_hash(html: &str, slides: &[SlideSpan], sections: &[SectionSpan]) -> String {
    let mut cut: Vec<Range<usize>> = slides.iter().map(|s| with_indent(html, &s.range)).collect();
    cut.extend(sections.iter().map(|s| with_indent(html, &s.range)));
    cut.extend(crate::review::block_range(html).map(|r| with_indent(html, &r)));
    cut.extend(crate::comments::block_range(html).map(|r| with_indent(html, &r)));
    cut.sort_by_key(|r| r.start);
    let mut shell = String::with_capacity(html.len());
    let mut at = 0;
    for range in cut {
        if range.start >= at {
            shell.push_str(&html[at..range.start]);
        }
        at = at.max(range.end);
    }
    shell.push_str(&html[at..]);
    content_hash(&shell)
}

/// The slide `id` of `slides`.
pub(super) fn span_of<'a>(slides: &'a [SlideSpan], id: &str) -> Option<&'a SlideSpan> {
    slides.iter().find(|s| s.id.as_deref() == Some(id))
}

/// The slide `id` of `slides`, or the error that it is not there.
pub(super) fn slide_span<'a>(slides: &'a [SlideSpan], id: &str) -> Result<&'a SlideSpan, String> {
    span_of(slides, id).ok_or_else(|| format!("Slide not found: {id}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::html::fixtures::*;
    use crate::html::*;

    /// Cases shared with the frontend's copy of the slide finder (src/lib/slideSpans.ts),
    /// so the two cannot drift apart.
    #[test]
    fn matches_shared_slide_fixtures() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/slide-spans.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let html = case["html"].as_str().unwrap();
            let actual: Vec<(String, &str)> = find_slides(html)
                .iter()
                .enumerate()
                .map(|(i, s)| {
                    let id = s.id.clone().unwrap_or_else(|| format!("#{}", i + 1));
                    (id, &html[s.range.clone()])
                })
                .collect();
            let expected: Vec<(String, &str)> = case["slides"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| {
                    (
                        s["id"].as_str().unwrap().to_string(),
                        s["source"].as_str().unwrap(),
                    )
                })
                .collect();
            assert_eq!(actual, expected, "fixture: {name}");
        }
    }

    /// The section markers as two passes find them: the slides first, then every marker that
    /// is in none of them.
    fn sections_in_two_passes(html: &str) -> Vec<(std::ops::Range<usize>, String, usize, bool)> {
        let slides = find_slides(html);
        tags(html)
            .filter(|(at, _)| !slides.iter().any(|s| s.range.contains(at)))
            .filter_map(|(at, tag)| {
                let before = slides.iter().filter(|s| s.range.end <= at).count();
                section_span(html, at, &tag, before)
            })
            .map(|s| (s.range, s.title, s.before, s.empty))
            .collect()
    }

    #[test]
    fn one_pass_finds_the_slides_and_sections_two_passes_do() {
        let marker = "<div class=\"deck-section\" data-title=\"M\"></div>";
        let slide = |inner: &str| format!("<section class=\"slide\" id=\"s\">{inner}</section>");
        let documents = [
            DECK.to_string(),
            SECTIONED.to_string(),
            STYLED.to_string(),
            big_deck(45),
            // Markers before, in, between and after slides, and in a nested section.
            format!(
                "{marker}{}{marker}{}{marker}",
                slide(marker),
                slide(&format!("<section>{marker}</section>{marker}"))
            ),
            // A slide never closed is no slide: the markers in it are between slides.
            format!(
                "{}{marker}<section class=\"slide\" id=\"open\">{marker}<section>{marker}",
                slide("x")
            ),
            format!("<section class=\"slide\" id=\"open\">{marker}"),
            // A section that is no slide, around and in slides.
            format!(
                "<section class=\"part\">{marker}{}{marker}</section>{marker}",
                slide(marker)
            ),
            format!(
                "<DIV CLASS=\"deck-section\">{}<div class=\"deck-section\"><p>x</p></div>",
                slide("y")
            ),
            String::new(),
        ];
        for html in &documents {
            let before = scans();
            let (slides, sections) = find_spans(html);
            assert_eq!(scans() - before, 1);
            let ranges = |spans: &[SlideSpan]| -> Vec<_> {
                spans
                    .iter()
                    .map(|s| (s.range.clone(), s.id.clone()))
                    .collect()
            };
            assert_eq!(ranges(&slides), ranges(&find_slides(html)), "{html}");
            let found: Vec<_> = sections
                .into_iter()
                .map(|s| (s.range, s.title, s.before, s.empty))
                .collect();
            assert_eq!(found, sections_in_two_passes(html), "{html}");
        }
    }

    #[test]
    fn the_first_of_a_slides_attributes_counts() {
        let html = r#"<section class="slide" id="one" ID="two" data-time="5" DATA-TIME="9" data-hidden data-hidden="x"></section>"#;
        let slide = &find_slides(html)[0];
        assert_eq!(slide.id.as_deref(), Some("one"));
        assert_eq!(&html[slide.id_value.clone().unwrap()], "one");
        assert_eq!(slide.time.as_ref().unwrap().1, "5");
        assert_eq!(&html[slide.hidden.clone().unwrap()], "data-hidden");
    }

    #[test]
    fn finds_top_level_slides_only() {
        assert_eq!(ids(DECK), ["intro", "plan", ""]);
        let first = &find_slides(DECK)[0];
        assert!(DECK[first.range.clone()].ends_with("x</section></section>"));
    }

    #[test]
    fn detects_hidden_slides() {
        let html = r#"<main class="deck">
<section class="slide" id="a" data-hidden></section>
<section data-hidden="" class="slide" id="b"><section data-hidden>nested</section></section>
<section class="slide" id="c" data-hidden-not="x"></section>
</main>"#;
        assert_eq!(hidden(html), [true, true, false]);
        assert_eq!(ids(html), ["a", "b", "c"]);
    }

    #[test]
    fn records_id_value_ranges_and_tag_name_end() {
        let html = r#"<SECTION CLASS="slide" ID="Up"></SECTION><section class="slide"></section>"#;
        let slides = find_slides(html);
        assert_eq!(slides.len(), 2);
        assert_eq!(slides[0].id.as_deref(), Some("Up"));
        assert_eq!(&html[slides[0].id_value.clone().unwrap()], "Up");
        assert_eq!(
            &html[slides[0].range.start..slides[0].tag_name_end],
            "<SECTION"
        );
        assert!(slides[1].id_value.is_none());
        assert_eq!(
            &html[slides[1].range.clone()],
            r#"<section class="slide"></section>"#
        );
    }

    #[test]
    fn empty_id_attribute_counts_as_missing_but_keeps_its_range() {
        let html = r#"<section class="slide" id=""></section>"#;
        let slide = &find_slides(html)[0];
        assert_eq!(slide.id, None);
        let range = slide.id_value.clone().unwrap();
        assert!(range.is_empty());
        assert_eq!(&html[..range.start], r#"<section class="slide" id=""#);
    }

    #[test]
    fn unterminated_raw_text_and_tags_end_the_scan() {
        assert_eq!(
            ids(
                r#"<section class="slide" id="a"></section><textarea><section class="slide" id="b"></section>"#
            ),
            ["a"]
        );
        assert_eq!(
            ids(r#"<section class="slide" id="a"></section><section class="slide" id="b""#),
            ["a"]
        );
        assert!(find_slides("<").is_empty());
        assert!(find_slides("<<<>>>").is_empty());
    }

    #[test]
    fn handles_multibyte_text_around_slides() {
        let html = "<p>héllo 👋</p><section class=\"slide\" id=\"ü\">日本</section>";
        let slide = &find_slides(html)[0];
        assert_eq!(slide.id.as_deref(), Some("ü"));
        assert_eq!(
            &html[slide.range.clone()],
            "<section class=\"slide\" id=\"ü\">日本</section>"
        );
    }

    #[test]
    fn content_hash_is_stable_and_sensitive() {
        assert_eq!(content_hash("abc"), content_hash("abc"));
        assert_ne!(content_hash("abc"), content_hash("abd"));
        assert!(content_hash("").chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn shell_hash_ignores_slide_edits_but_not_shell_edits() {
        let deck = normalize_ids(DECK).unwrap();
        let hash = |html: &str| shell_hash(html, &find_slides(html), &find_sections(html));
        let slide_edit = deck.replace("<p>Plan</p>", "<p>New plan</p>");
        assert_eq!(hash(&deck), hash(&slide_edit));
        let style_edit = deck.replace("color: red", "color: blue");
        assert_ne!(hash(&deck), hash(&style_edit));
        let reordered = reorder(
            &deck,
            &[
                "plan".to_string(),
                "intro".to_string(),
                "slide-3".to_string(),
            ],
        )
        .unwrap();
        assert_eq!(hash(&deck), hash(&reordered));
    }

    #[test]
    fn finds_section_markers_between_slides_only() {
        assert_eq!(
            section_titles(SECTIONED),
            [
                ("Intro & \"goals\"".to_string(), 1),
                ("Wrap up".to_string(), 3)
            ]
        );
        assert_eq!(ids(SECTIONED), ["a", "b", "c", "d"]);
        assert!(find_sections("<main class=\"deck\"></main>").is_empty());
    }

    #[test]
    fn section_markers_are_not_slides_and_cover_their_end_tag() {
        let sections = find_sections(SECTIONED);
        assert!(SECTIONED[sections[0].range.clone()].ends_with("></div>"));
        assert!(sections.iter().all(|s| s.empty));
        let open = "<div class=\"deck-section\" data-title=\"x\"><p>hi</p></div>";
        let found = find_sections(open);
        assert!(!found[0].empty);
        assert_eq!(
            &open[found[0].range.clone()],
            &open[..open.find('>').unwrap() + 1]
        );
        let upper = "<DIV CLASS=\"deck-section\" DATA-TITLE=\"Up\"> </DIV>";
        let found = find_sections(upper);
        assert_eq!(found[0].title, "Up");
        assert_eq!(found[0].range, 0..upper.len());
        assert!(found[0].empty);
    }

    #[test]
    fn section_without_a_title_has_an_empty_one() {
        let found = find_sections("<div class=\"deck-section\"></div>");
        assert_eq!(found[0].title, "");
        assert!(found[0].title_value.is_none());
        let found =
            find_sections("<div class=\"other deck-section\" data-title=\"  Padded  \"></div>");
        assert_eq!(found[0].title, "Padded");
    }

    #[test]
    fn section_markers_in_scripts_and_styles_are_ignored() {
        let html = "<script>x = '<div class=\"deck-section\" data-title=\"js\"></div>'</script>\
            <div class=\"deck-section\" data-title=\"real\"></div>";
        assert_eq!(section_titles(html), [("real".to_string(), 0)]);
    }

    #[test]
    fn shell_hash_ignores_review_marks() {
        let hash = |html: &str| shell_hash(html, &find_slides(html), &find_sections(html));
        let deck = ensure_runtime(
            "<html><head></head><body><main class=\"deck\"><section class=\"slide\" id=\"a\"></section></main></body></html>",
        );
        let stroke = crate::review::Stroke {
            tool: crate::review::InkTool::Pen,
            color: "#000".into(),
            points: vec![[0.5, 0.5]],
        };
        let marked = crate::review::write(&deck, &[("a".to_string(), vec![stroke])].into());
        assert_ne!(marked, deck);
        assert_eq!(hash(&marked), hash(&deck));
    }

    #[test]
    fn shell_hash_ignores_section_markers() {
        let hash = |html: &str| shell_hash(html, &find_slides(html), &find_sections(html));
        let base = hash(SECTIONED);
        assert_eq!(base, hash(&rename_section(SECTIONED, 0, "Other").unwrap()));
        assert_eq!(base, hash(&delete_section(SECTIONED, 1).unwrap()));
        assert_eq!(
            base,
            hash(&add_section(SECTIONED, Some("d"), "More").unwrap())
        );
        assert_ne!(
            base,
            hash(&SECTIONED.replace("<main", "<header></header><main"))
        );
    }
}
