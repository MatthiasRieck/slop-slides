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
    /// Byte range of the whole `data-hidden` attribute, when the slide is hidden.
    pub hidden: Option<Range<usize>>,
}

/// Marks a slide the player skips. The editor still shows it, muted.
pub const HIDDEN_ATTR: &str = "data-hidden";

struct Tag {
    name: String,
    closing: bool,
    /// (name, value, value range, whole attribute range)
    attrs: Vec<(String, String, Range<usize>, Range<usize>)>,
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
                    let id = tag.attrs.iter().find(|(n, _, _, _)| n == "id");
                    let hidden = tag.attrs.iter().find(|(n, _, _, _)| n == HIDDEN_ATTR);
                    open = Some((
                        SlideSpan {
                            range: i..i,
                            id: id.map(|(_, v, _, _)| v.clone()).filter(|v| !v.is_empty()),
                            id_value: id.map(|(_, _, r, _)| r.clone()),
                            tag_name_end: tag.name_end,
                            hidden: hidden.map(|(_, _, _, r)| r.clone()),
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
        .any(|(n, v, _, _)| n == "class" && v.split_ascii_whitespace().any(|c| c == class))
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
            let name_end = attr_start + attr.len();
            attrs.push((attr, String::new(), i..i, attr_start..name_end));
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
        attrs.push((
            attr,
            html[value.clone()].to_string(),
            value.clone(),
            attr_start..i,
        ));
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

/// Adds or removes the slide's `data-hidden` attribute. Leaves the markup untouched when
/// the slide is already in the requested state.
pub fn set_hidden(html: &str, id: &str, hidden: bool) -> Result<String, String> {
    let slides = find_slides(html);
    let span = span_of(&slides, id).ok_or_else(|| format!("Slide not found: {id}"))?;
    Ok(match (&span.hidden, hidden) {
        (None, true) => format!(
            "{} {HIDDEN_ATTR}{}",
            &html[..span.tag_name_end],
            &html[span.tag_name_end..]
        ),
        (Some(attr), false) => {
            let start = html[..attr.start].trim_end().len();
            format!("{}{}", &html[..start], &html[attr.end..])
        }
        _ => html.to_string(),
    })
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

    fn hidden(html: &str) -> Vec<bool> {
        find_slides(html)
            .into_iter()
            .map(|s| s.hidden.is_some())
            .collect()
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
    fn hides_and_unhides_slides() {
        let deck = normalize_ids(DECK).unwrap();
        let hid = set_hidden(&deck, "plan", true).unwrap();
        assert_eq!(hidden(&hid), [false, true, false]);
        assert!(hid.contains("<section data-hidden class='slide' id=plan>"));
        assert_eq!(set_hidden(&hid, "plan", true).unwrap(), hid, "idempotent");

        let shown = set_hidden(&hid, "plan", false).unwrap();
        assert_eq!(shown, deck, "unhiding restores the original markup");
        assert_eq!(set_hidden(&shown, "plan", false).unwrap(), deck);

        let valued = deck.replace("id=plan>", r#"id=plan data-hidden="true">"#);
        assert_eq!(set_hidden(&valued, "plan", false).unwrap(), deck);

        assert!(set_hidden(&deck, "missing", true).is_err());
    }

    #[test]
    fn duplicating_a_hidden_slide_keeps_it_hidden() {
        let deck = set_hidden(&normalize_ids(DECK).unwrap(), "intro", true).unwrap();
        let (copied, _) = duplicate(&deck, "intro").unwrap();
        assert_eq!(hidden(&copied), [true, true, false, false]);
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
}
