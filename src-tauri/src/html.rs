//! Single-file deck format. A deck is one HTML document whose top-level
//! `<section class="slide" id="…">` elements are the slides, in order. This module finds
//! those sections without a full HTML parser (it skips comments, `<script>`, `<style>`
//! and quoted attributes) and rewrites the document for slide-level operations.

use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::ops::Range;

const RUNTIME_CSS: &str = include_str!("../assets/runtime.css");
const RUNTIME_JS: &str = include_str!("../assets/runtime.js");
const CSS_START: &str = "<!-- slopslide:runtime-css (managed by SlopSlide, do not edit) -->";
const CSS_END: &str = "<!-- /slopslide:runtime-css -->";
const JS_START: &str = "<!-- slopslide:runtime-js (managed by SlopSlide, do not edit) -->";
const JS_END: &str = "<!-- /slopslide:runtime-js -->";

#[derive(Debug, Clone)]
pub struct SlideSpan {
    /// The whole `<section …>…</section>`.
    pub range: Range<usize>,
    pub id: Option<String>,
    /// Byte range of the id attribute's value, when present.
    pub id_value: Option<Range<usize>>,
    /// Byte offset just after `<section`.
    pub tag_name_end: usize,
}

struct Tag {
    name: String,
    closing: bool,
    attrs: Vec<(String, String, Range<usize>)>,
    name_end: usize,
    end: usize,
}

/// Top-level slide sections in document order.
pub fn find_slides(html: &str) -> Vec<SlideSpan> {
    let bytes = html.as_bytes();
    let mut slides = Vec::new();
    let mut open: Option<(SlideSpan, usize)> = None; // (slide, nested <section> depth)
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        if html[i..].starts_with("<!--") {
            i = html[i..].find("-->").map_or(bytes.len(), |e| i + e + 3);
            continue;
        }
        let Some(tag) = parse_tag(html, i) else {
            i += 1;
            continue;
        };
        if !tag.closing && matches!(tag.name.as_str(), "script" | "style" | "textarea" | "title") {
            let close = format!("</{}", tag.name);
            i = find_ci(html, tag.end, &close).unwrap_or(bytes.len());
            continue;
        }
        if tag.name == "section" {
            match (&mut open, tag.closing) {
                (Some((_, depth)), false) => *depth += 1,
                (Some((_, depth)), true) if *depth > 0 => *depth -= 1,
                (Some(_), true) => {
                    let (mut slide, _) = open.take().unwrap();
                    slide.range.end = tag.end;
                    slides.push(slide);
                }
                (None, false) if has_class(&tag, "slide") => {
                    let id = tag.attrs.iter().find(|(n, _, _)| n == "id");
                    open = Some((
                        SlideSpan {
                            range: i..i,
                            id: id.map(|(_, v, _)| v.clone()).filter(|v| !v.is_empty()),
                            id_value: id.map(|(_, _, r)| r.clone()),
                            tag_name_end: tag.name_end,
                        },
                        0,
                    ));
                }
                _ => {}
            }
        }
        i = tag.end;
    }
    slides
}

fn has_class(tag: &Tag, class: &str) -> bool {
    tag.attrs
        .iter()
        .any(|(n, v, _)| n == "class" && v.split_ascii_whitespace().any(|c| c == class))
}

fn find_ci(html: &str, from: usize, needle: &str) -> Option<usize> {
    html.get(from..)?
        .to_ascii_lowercase()
        .find(&needle.to_ascii_lowercase())
        .map(|p| from + p)
}

fn parse_tag(html: &str, start: usize) -> Option<Tag> {
    let bytes = html.as_bytes();
    let mut i = start + 1;
    let closing = bytes.get(i) == Some(&b'/');
    if closing {
        i += 1;
    }
    let name_start = i;
    while i < bytes.len() && bytes[i].is_ascii_alphanumeric() {
        i += 1;
    }
    if i == name_start {
        return None;
    }
    let name = html[name_start..i].to_ascii_lowercase();
    let name_end = i;
    let mut attrs = Vec::new();
    loop {
        while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b'/') {
            i += 1;
        }
        match bytes.get(i) {
            None => return None,
            Some(b'>') => break,
            _ => {}
        }
        let attr_start = i;
        while i < bytes.len()
            && !matches!(bytes[i], b'=' | b'>' | b'/')
            && !bytes[i].is_ascii_whitespace()
        {
            i += 1;
        }
        let attr = html[attr_start..i].to_ascii_lowercase();
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if bytes.get(i) != Some(&b'=') {
            attrs.push((attr, String::new(), i..i));
            continue;
        }
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let value = match bytes.get(i) {
            Some(&q @ (b'"' | b'\'')) => {
                let end = html[i + 1..].find(q as char)? + i + 1;
                let range = i + 1..end;
                i = end + 1;
                range
            }
            _ => {
                let s = i;
                while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'>' {
                    i += 1;
                }
                s..i
            }
        };
        attrs.push((attr, html[value.clone()].to_string(), value));
    }
    Some(Tag {
        name,
        closing,
        attrs,
        name_end,
        end: i + 1,
    })
}

pub fn content_hash(text: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

/// Hash of everything except the slides: shared styles, fonts, runtime.
pub fn shell_hash(html: &str, slides: &[SlideSpan]) -> String {
    let mut shell = String::with_capacity(html.len());
    let mut at = 0;
    for slide in slides {
        shell.push_str(&html[at..slide.range.start]);
        at = slide.range.end;
    }
    shell.push_str(&html[at..]);
    content_hash(&shell)
}

pub fn title(html: &str) -> Option<String> {
    let start = find_ci(html, 0, "<title")?;
    let open_end = html[start..].find('>')? + start + 1;
    let end = find_ci(html, open_end, "</title")?;
    let raw = html[open_end..end].trim();
    (!raw.is_empty()).then(|| decode_entities(raw))
}

pub fn set_title(html: &str, title: &str) -> String {
    let escaped = escape(title);
    if let Some(start) = find_ci(html, 0, "<title") {
        if let (Some(open), Some(end)) = (html[start..].find('>'), find_ci(html, start, "</title"))
        {
            return format!("{}{}{}", &html[..start + open + 1], escaped, &html[end..]);
        }
    }
    insert_after_head(html, &format!("\n  <title>{escaped}</title>"))
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn decode_entities(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

fn insert_after_head(html: &str, snippet: &str) -> String {
    let at = find_ci(html, 0, "<head")
        .and_then(|s| html[s..].find('>').map(|e| s + e + 1))
        .unwrap_or(0);
    format!("{}{}{}", &html[..at], snippet, &html[at..])
}

/// Installs (or refreshes) the player runtime: base CSS first in `<head>` so deck styles
/// override it, and the script at the end of `<body>`.
pub fn ensure_runtime(html: &str) -> String {
    let css = format!("{CSS_START}\n  <style>\n{RUNTIME_CSS}  </style>\n  {CSS_END}");
    let js = format!("{JS_START}\n  <script>\n{RUNTIME_JS}  </script>\n  {JS_END}");
    let html = match replace_block(html, CSS_START, CSS_END, &css) {
        Some(updated) => updated,
        None => insert_after_head(html, &format!("\n  {css}")),
    };
    match replace_block(&html, JS_START, JS_END, &js) {
        Some(updated) => updated,
        None => {
            let at = html
                .to_ascii_lowercase()
                .rfind("</body")
                .unwrap_or(html.len());
            format!("{}  {js}\n{}", &html[..at], &html[at..])
        }
    }
}

fn replace_block(html: &str, start: &str, end: &str, block: &str) -> Option<String> {
    let s = html.find(start)?;
    let e = html[s..].find(end)? + s + end.len();
    Some(format!("{}{}{}", &html[..s], block, &html[e..]))
}

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

fn unique_id(taken: &HashSet<String>, base: &str) -> String {
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

fn span_of<'a>(slides: &'a [SlideSpan], id: &str) -> Option<&'a SlideSpan> {
    slides.iter().find(|s| s.id.as_deref() == Some(id))
}

/// Whitespace between the previous line break and `at`, used to indent inserted slides.
fn indent_before(html: &str, at: usize) -> &str {
    let line_start = html[..at].rfind('\n').map_or(0, |p| p + 1);
    let indent = &html[line_start..at];
    if indent.trim().is_empty() {
        indent
    } else {
        "    "
    }
}

pub fn reorder(html: &str, order: &[String]) -> Result<String, String> {
    let slides = find_slides(html);
    let mut current: Vec<_> = slides.iter().filter_map(|s| s.id.clone()).collect();
    let mut proposed = order.to_vec();
    current.sort();
    proposed.sort();
    if current != proposed || current.len() != slides.len() {
        return Err("The slides changed while reordering; try again.".into());
    }
    let mut out = String::with_capacity(html.len());
    let mut at = 0;
    for (slot, id) in slides.iter().zip(order) {
        out.push_str(&html[at..slot.range.start]);
        out.push_str(&html[span_of(&slides, id).unwrap().range.clone()]);
        at = slot.range.end;
    }
    out.push_str(&html[at..]);
    Ok(out)
}

pub fn delete(html: &str, id: &str) -> Result<String, String> {
    let slides = find_slides(html);
    let span = span_of(&slides, id).ok_or_else(|| format!("Slide not found: {id}"))?;
    let start = html[..span.range.start].trim_end().len();
    Ok(format!("{}{}", &html[..start], &html[span.range.end..]))
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
    let section = section.replace("{{ID}}", &id);
    let anchor = after.and_then(|a| span_of(&slides, a)).or(slides.last());
    let (at, indent) = match anchor {
        Some(span) => (
            span.range.end,
            indent_before(html, span.range.start).to_string(),
        ),
        None => {
            let lower = html.to_ascii_lowercase();
            let at = lower
                .rfind("</main")
                .or_else(|| lower.rfind("</body"))
                .ok_or("The deck has no <main class=\"deck\"> container.")?;
            let at = html[..at].trim_end().len();
            (at, "    ".to_string())
        }
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

pub fn duplicate(html: &str, id: &str) -> Result<(String, String), String> {
    let slides = find_slides(html);
    let span = span_of(&slides, id).ok_or_else(|| format!("Slide not found: {id}"))?;
    let range = span
        .id_value
        .clone()
        .expect("slides with ids have id ranges");
    let copy = format!(
        "{}{{{{ID}}}}{}",
        &html[span.range.start..range.start],
        &html[range.end..span.range.end]
    );
    insert(html, Some(id), &copy, &format!("{id}-copy"))
}

/// Replaces deck-relative `assets/…` references with data URIs so the file stands alone.
pub fn inline_assets(
    html: &str,
    mut load: impl FnMut(&str) -> Option<(String, Vec<u8>)>,
) -> String {
    use base64::Engine;
    let mut out = String::with_capacity(html.len());
    let mut at = 0;
    for (pos, _) in html.match_indices("assets/") {
        if pos < at {
            continue;
        }
        let mut start = pos;
        if html[..pos].ends_with("./") {
            start -= 2;
        }
        let quoted = html[..start].ends_with(['"', '\'', '(']);
        if !quoted {
            continue;
        }
        let end = html[pos..]
            .find(|c: char| matches!(c, '"' | '\'' | ')' | '?' | '#') || c.is_whitespace())
            .map_or(html.len(), |e| pos + e);
        let path = &html[pos..end];
        let Some((mime, bytes)) = load(path) else {
            continue;
        };
        out.push_str(&html[at..start]);
        out.push_str(&format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ));
        at = end;
    }
    out.push_str(&html[at..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const DECK: &str = r#"<!DOCTYPE html><html><head><title>Q3 &amp; more</title>
<style>.slide { color: red } /* <section class="slide"> */</style></head>
<body>
  <main class="deck">
    <section class="slide intro" id="intro"><h1>Hi</h1><section class="inner">x</section></section>
    <!-- <section class="slide" id="ghost"></section> -->
    <section class='slide' id=plan><p>Plan</p></section>
    <section class="slide"><p>No id</p></section>
  </main>
  <script>const s = '<section class="slide" id="fake">';</script>
</body></html>"#;

    /// Cases shared with the frontend's copy of the slide finder (src/lib/slideSpans.ts),
    /// so the two cannot drift apart.
    #[test]
    fn matches_shared_slide_fixtures() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/slide-spans.json")).unwrap();
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

    fn ids(html: &str) -> Vec<String> {
        find_slides(html)
            .into_iter()
            .map(|s| s.id.unwrap_or_default())
            .collect()
    }

    #[test]
    fn finds_top_level_slides_only() {
        assert_eq!(ids(DECK), ["intro", "plan", ""]);
        let first = &find_slides(DECK)[0];
        assert!(DECK[first.range.clone()].ends_with("x</section></section>"));
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
    fn inserts_into_empty_deck() {
        let empty = "<html><body>\n  <main class=\"deck\">\n  </main>\n</body></html>";
        let (out, id) = insert(
            empty,
            None,
            r#"<section class="slide" id="{{ID}}"></section>"#,
            "Title",
        )
        .unwrap();
        assert_eq!(id, "title");
        assert_eq!(ids(&out), ["title"]);
        assert!(out.find("id=\"title\"").unwrap() < out.find("</main>").unwrap());
    }

    #[test]
    fn reads_and_writes_titles() {
        assert_eq!(title(DECK).as_deref(), Some("Q3 & more"));
        let renamed = set_title(DECK, "A <b> deck");
        assert_eq!(title(&renamed).as_deref(), Some("A <b> deck"));
        assert!(renamed.contains("<title>A &lt;b&gt; deck</title>"));
    }

    #[test]
    fn runtime_is_installed_once_and_refreshed() {
        let once = ensure_runtime(DECK);
        let twice = ensure_runtime(&once);
        assert_eq!(once, twice);
        assert_eq!(once.matches(CSS_START).count(), 1);
        assert!(once.find(CSS_START).unwrap() < once.find("<title>").unwrap());
        assert!(once.find(JS_START).unwrap() > once.find("</main>").unwrap());
        assert_eq!(ids(&once), ["intro", "plan", ""]);
    }

    #[test]
    fn inlines_referenced_assets() {
        let html = r#"<img src="assets/a.png"><div style="background:url('./assets/b.jpg')"></div> see assets/a.png"#;
        let out = inline_assets(html, |p| Some(("image/png".into(), p.as_bytes().to_vec())));
        assert!(out.contains(r#"src="data:image/png;base64,"#));
        assert!(out.contains("url('data:image/png;base64,"));
        assert!(
            out.ends_with("see assets/a.png"),
            "bare text is not a reference"
        );
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
        let hash = |html: &str| shell_hash(html, &find_slides(html));
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
    fn title_edge_cases() {
        assert_eq!(title("<html><head></head></html>"), None);
        assert_eq!(title("<title>   </title>"), None);
        assert_eq!(
            title("<TITLE lang=en> Spaced </TITLE>").as_deref(),
            Some("Spaced")
        );
        assert_eq!(
            title("<title>&lt;a&gt; &quot;b&quot; &#39;c&#39; &amp;amp;</title>").as_deref(),
            Some("<a> \"b\" 'c' &amp;"),
            "&amp; is decoded last so it cannot create new entities"
        );
    }

    #[test]
    fn set_title_inserts_a_title_when_missing() {
        let html = "<html><head><meta charset=\"utf-8\"></head><body></body></html>";
        let out = set_title(html, "Fresh & new");
        assert_eq!(title(&out).as_deref(), Some("Fresh & new"));
        assert!(out.find("<title>").unwrap() > out.find("<head>").unwrap());
        assert!(out.find("<title>").unwrap() < out.find("</head>").unwrap());
        // No <head> at all: the title goes first.
        assert!(set_title("<p>x</p>", "T").starts_with("\n  <title>T</title>"));
    }

    #[test]
    fn set_title_round_trips_special_characters() {
        for name in [
            "Q3 & Q4",
            "a < b > c",
            "  trimmed?  ",
            "émoji 🎉",
            "&amp; literal",
        ] {
            let out = set_title(DECK, name);
            assert_eq!(title(&out).as_deref(), Some(name.trim()), "{name}");
            assert_eq!(ids(&out), ids(DECK), "slides untouched for {name}");
        }
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
            shell_hash(&swapped, &find_slides(&swapped)),
            shell_hash(&deck, &find_slides(&deck))
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
    fn insert_into_empty_deck_falls_back_to_body_or_fails() {
        let section = r#"<section class="slide" id="{{ID}}"></section>"#;
        let (out, id) = insert("<html><BODY>\n</BODY></html>", None, section, "").unwrap();
        assert_eq!(id, "slide");
        assert!(out.find(&format!("id=\"{id}\"")).unwrap() < out.find("</BODY>").unwrap());
        assert!(insert("<p>no container</p>", None, section, "x").is_err());
    }

    #[test]
    fn ensure_runtime_works_without_head_or_body() {
        let out = ensure_runtime(r#"<section class="slide" id="a"></section>"#);
        assert!(out.starts_with("\n  ") && out.contains(CSS_START));
        assert!(out.contains(JS_END));
        assert!(out.find(CSS_END).unwrap() < out.find("<section").unwrap());
        assert!(out.find(JS_START).unwrap() > out.find("</section>").unwrap());
        assert_eq!(
            ids(&out),
            ["a"],
            "runtime script is not mistaken for slides"
        );
    }

    #[test]
    fn ensure_runtime_replaces_a_stale_or_edited_runtime() {
        let stale = DECK
            .replace(
                "</head>",
                &format!("{CSS_START}<style>old</style>{CSS_END}</head>"),
            )
            .replace(
                "</body>",
                &format!("{JS_START}<script>tampered()</script>{JS_END}</body>"),
            );
        let out = ensure_runtime(&stale);
        assert!(!out.contains("old</style>"));
        assert!(!out.contains("tampered()"));
        assert_eq!(out.matches(JS_START).count(), 1);
        assert!(out.contains(RUNTIME_JS));
        // Refreshed in place: the block stays after the deck's own <style>.
        assert!(out.find(CSS_START).unwrap() > out.find(".slide { color: red }").unwrap());
        assert_eq!(out, ensure_runtime(&out));
    }

    #[test]
    fn ensure_runtime_embeds_the_current_assets() {
        let out = ensure_runtime(DECK);
        assert!(out.contains(RUNTIME_CSS));
        assert!(out.contains(RUNTIME_JS));
    }

    #[test]
    fn inline_assets_stops_at_query_and_fragment() {
        let html = r##"<img src="assets/a.png?v=2"><use href="assets/icons.svg#star"/>"##;
        let mut seen = Vec::new();
        let out = inline_assets(html, |p| {
            seen.push(p.to_string());
            Some(("x/y".into(), vec![1, 2, 3]))
        });
        assert_eq!(seen, ["assets/a.png", "assets/icons.svg"]);
        assert_eq!(
            out,
            r##"<img src="data:x/y;base64,AQID?v=2"><use href="data:x/y;base64,AQID#star"/>"##
        );
    }

    #[test]
    fn inline_assets_leaves_unloadable_and_unquoted_references() {
        let html =
            r#"<img src="assets/missing.png"><a href=assets/x.png>x</a><img src='assets/ok.png'>"#;
        let out = inline_assets(html, |p| {
            (p == "assets/ok.png").then(|| ("image/png".into(), b"ok".to_vec()))
        });
        assert_eq!(
            out,
            r#"<img src="assets/missing.png"><a href=assets/x.png>x</a><img src='data:image/png;base64,b2s='>"#
        );
    }

    #[test]
    fn inline_assets_ignores_lookalike_paths() {
        let html =
            r#"<img src="myassets/a.png"><img src="/assets/a.png"><img src="../assets/a.png">"#;
        let out = inline_assets(html, |_| Some(("image/png".into(), vec![0])));
        assert_eq!(
            out, html,
            "only deck-relative assets/ references are inlined"
        );
    }
}
