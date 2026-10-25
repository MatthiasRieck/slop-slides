//! Find and replace across a deck: the text on its slides (and in their speaker notes) as
//! people read it, never markup, attribute values, styles or scripts. Character references
//! count as the characters they stand for, and a run of whitespace as one space, so a phrase
//! the source wraps over two lines is still found. A match stays within one run of text: a
//! phrase with a tag inside it (`Hello <em>there</em>`) is not found as a whole.
//!
//! Locked slides are found but never changed. The invisible copies the slide editor leaves
//! behind (`data-resize-placeholder`, `data-delete-placeholder`) are skipped.

use std::ops::Range;

use serde::{Deserialize, Serialize};

use crate::html::{self, find_ci, parse_tag};

/// How the query matches.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub match_case: bool,
    /// Only where the query is not part of a longer word.
    pub whole_word: bool,
}

/// One place the query is found, with some of the text around it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Match {
    pub slide: String,
    /// The slide's position in the deck, from 0.
    pub index: usize,
    pub locked: bool,
    pub before: String,
    pub text: String,
    pub after: String,
}

/// What a replace changed.
#[derive(Debug, Clone, PartialEq)]
pub struct Replaced {
    pub html: String,
    pub count: usize,
    /// Slides it changed, in deck order.
    pub slides: Vec<String>,
    /// Locked slides with matches it left alone.
    pub skipped: Vec<String>,
}

/// Characters of context on each side of a match.
const CONTEXT: usize = 40;

/// Elements whose content is not text on the slide.
const RAW_TEXT: &[&str] = &["script", "style", "textarea", "title", "template"];
const VOID: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];
const PLACEHOLDERS: &[&str] = &["data-resize-placeholder", "data-delete-placeholder"];

/// The slide's text as characters, each with the source bytes it came from.
type Chars = Vec<(char, Range<usize>)>;

/// Every match of `query` in the deck's slides, in deck order.
pub fn find(source: &str, query: &str, options: Options) -> Vec<Match> {
    let needle = normalize_query(query, options);
    if needle.is_empty() {
        return Vec::new();
    }
    let mut found = Vec::new();
    for (index, slide) in html::find_slides(source).iter().enumerate() {
        let Some(id) = slide.id.clone() else { continue };
        let locked = slide.locked.is_some();
        for run in text_runs(source, slide.range.clone()) {
            let chars = decode(source, run);
            for at in matches(&chars, &needle, options) {
                let text = |r: Range<usize>| chars[r].iter().map(|(c, _)| *c).collect::<String>();
                found.push(Match {
                    slide: id.clone(),
                    index,
                    locked,
                    before: text(at.start.saturating_sub(CONTEXT)..at.start)
                        .trim_start()
                        .to_string(),
                    text: text(at.clone()),
                    after: text(at.end..(at.end + CONTEXT).min(chars.len()))
                        .trim_end()
                        .to_string(),
                });
            }
        }
    }
    found
}

/// Replaces every match of `query` with `replacement` (plain text) in the deck's slides, or
/// with `only`, in those slides. Locked slides are left alone.
pub fn replace(
    source: &str,
    query: &str,
    replacement: &str,
    options: Options,
    only: Option<&[String]>,
) -> Replaced {
    let needle = normalize_query(query, options);
    let mut edits: Vec<(Range<usize>, String)> = Vec::new();
    let mut slides = Vec::new();
    let mut skipped = Vec::new();
    let escaped = escape_text(replacement);
    if !needle.is_empty() {
        for slide in html::find_slides(source) {
            let Some(id) = slide.id.clone() else { continue };
            if only.is_some_and(|ids| !ids.contains(&id)) {
                continue;
            }
            let mut hits = Vec::new();
            for run in text_runs(source, slide.range.clone()) {
                let chars = decode(source, run);
                for at in matches(&chars, &needle, options) {
                    hits.push(chars[at.start].1.start..chars[at.end - 1].1.end);
                }
            }
            if hits.is_empty() {
                continue;
            }
            if slide.locked.is_some() {
                skipped.push(id);
                continue;
            }
            slides.push(id);
            edits.extend(hits.into_iter().map(|r| (r, escaped.clone())));
        }
    }
    let count = edits.len();
    let mut html = source.to_string();
    for (range, text) in edits.into_iter().rev() {
        html.replace_range(range, &text);
    }
    Replaced {
        html,
        count,
        slides,
        skipped,
    }
}

/// Byte ranges of the text between tags in `range` (one slide), outside comments, raw-text
/// elements and the editor's placeholders.
fn text_runs(source: &str, range: Range<usize>) -> Vec<Range<usize>> {
    let bytes = source.as_bytes();
    let mut runs = Vec::new();
    let mut i = range.start;
    // Depth inside a placeholder, while skipping one.
    let mut skipping = 0usize;
    while i < range.end {
        if source[i..].starts_with("<!--") {
            i = source[i..].find("-->").map_or(range.end, |e| i + e + 3);
            continue;
        }
        if bytes[i] == b'<' {
            if let Some(tag) = parse_tag(source, i) {
                let void = VOID.contains(&tag.name.as_str()) || source[..tag.end].ends_with("/>");
                if !tag.closing && RAW_TEXT.contains(&tag.name.as_str()) {
                    let close = find_ci(source, tag.end, &format!("</{}", tag.name));
                    i = close
                        .and_then(|c| source[c..].find('>').map(|e| c + e + 1))
                        .unwrap_or(range.end);
                    continue;
                }
                if skipping > 0 {
                    if tag.closing {
                        skipping -= 1;
                    } else if !void {
                        skipping += 1;
                    }
                } else if !tag.closing
                    && !void
                    && tag
                        .attrs
                        .iter()
                        .any(|(n, ..)| PLACEHOLDERS.contains(&n.as_str()))
                {
                    skipping = 1;
                }
                i = tag.end;
                continue;
            }
        }
        // Past the character here (a `<` that starts no tag is text too).
        let next = i + source[i..].chars().next().map_or(1, char::len_utf8);
        let end = source[next..range.end]
            .find('<')
            .map_or(range.end, |e| next + e);
        if skipping == 0 {
            runs.push(i..end);
        }
        i = end;
    }
    runs
}

/// The text of `run` as read: character references decoded, whitespace runs as one space.
fn decode(source: &str, run: Range<usize>) -> Chars {
    let text = &source[run.clone()];
    let mut chars: Chars = Vec::new();
    let mut iter = text.char_indices().peekable();
    while let Some((at, c)) = iter.next() {
        let start = run.start + at;
        if c == '&' {
            if let Some((decoded, len)) = entity(&text[at..]) {
                for _ in 1..len {
                    iter.next();
                }
                chars.push((decoded, start..start + len));
                continue;
            }
        }
        let end = start + c.len_utf8();
        if c.is_ascii_whitespace() {
            if let Some((' ', last)) = chars
                .last_mut()
                .filter(|(_, r)| source[r.clone()].chars().all(|ch| ch.is_ascii_whitespace()))
            {
                last.end = end;
                continue;
            }
            chars.push((' ', start..end));
            continue;
        }
        chars.push((c, start..end));
    }
    chars
}

/// The character a reference at the start of `text` stands for, and its length in bytes.
fn entity(text: &str) -> Option<(char, usize)> {
    let end = text.get(..text.len().min(12))?.find(';')?;
    let name = &text[1..end];
    let c = match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => '\u{a0}',
        "mdash" => '—',
        "ndash" => '–',
        "hellip" => '…',
        "lsquo" => '‘',
        "rsquo" => '’',
        "ldquo" => '“',
        "rdquo" => '”',
        "laquo" => '«',
        "raquo" => '»',
        "middot" => '·',
        "bull" => '•',
        "times" => '×',
        "copy" => '©',
        "reg" => '®',
        "trade" => '™',
        "euro" => '€',
        _ => {
            let number = name.strip_prefix('#')?;
            let code = match number.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => number.parse().ok()?,
            };
            char::from_u32(code)?
        }
    };
    Some((c, end + 1))
}

/// The query as it is compared: whitespace runs as one space, and folded without `match_case`.
fn normalize_query(query: &str, options: Options) -> Vec<char> {
    let mut out: Vec<char> = Vec::new();
    for c in query.chars() {
        if c.is_ascii_whitespace() {
            if out.last() != Some(&' ') {
                out.push(' ');
            }
        } else {
            out.push(fold(c, options));
        }
    }
    out
}

fn fold(c: char, options: Options) -> char {
    if options.match_case {
        return c;
    }
    let mut lower = c.to_lowercase();
    match (lower.next(), lower.next()) {
        (Some(l), None) => l,
        _ => c,
    }
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Where `needle` is in `chars`, as character ranges, without overlaps.
fn matches(chars: &Chars, needle: &[char], options: Options) -> Vec<Range<usize>> {
    let mut found = Vec::new();
    if needle.is_empty() || chars.len() < needle.len() {
        return found;
    }
    let mut i = 0;
    while i + needle.len() <= chars.len() {
        let hit = needle
            .iter()
            .enumerate()
            .all(|(k, n)| fold(chars[i + k].0, options) == *n);
        let end = i + needle.len();
        let bounded = !options.whole_word
            || ((i == 0 || !is_word(chars[i - 1].0))
                && (end == chars.len() || !is_word(chars[end].0)));
        if hit && bounded {
            found.push(i..end);
            i = end;
        } else {
            i += 1;
        }
    }
    found
}

/// Plain text as HTML text.
fn escape_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deck(body: &str) -> String {
        format!(
            "<!DOCTYPE html>\n<html>\n<head><title>Plan</title><style>.plan {{}}</style></head>\n<body>\n<main class=\"deck\">\n{body}\n</main>\n</body>\n</html>\n"
        )
    }

    const CASE: Options = Options {
        match_case: false,
        whole_word: false,
    };

    fn texts(found: &[Match]) -> Vec<(&str, &str)> {
        found
            .iter()
            .map(|m| (m.slide.as_str(), m.text.as_str()))
            .collect()
    }

    #[test]
    fn finds_text_on_slides_and_in_notes_but_not_markup() {
        let source = deck(
            r#"<section class="slide" id="intro"><h1 class="plan" title="plan">The Plan</h1>
<aside class="notes">Explain the plan.</aside><style>.plan{}</style><script>plan()</script><!-- plan --></section>
<section class="slide" id="next"><p>Planning ahead</p></section>"#,
        );
        let found = find(&source, "plan", CASE);
        assert_eq!(
            texts(&found),
            [("intro", "Plan"), ("intro", "plan"), ("next", "Plan")]
        );
        assert_eq!(found[1].before, "Explain the ");
        assert_eq!(found[1].after, ".");
        assert_eq!(found[2].index, 1);
        assert!(find(&source, "", CASE).is_empty());
    }

    #[test]
    fn matches_case_and_whole_words_when_asked() {
        let source = deck(r#"<section class="slide" id="a"><p>Plan plan planning</p></section>"#);
        let exact = Options {
            match_case: true,
            whole_word: false,
        };
        let word = Options {
            match_case: false,
            whole_word: true,
        };
        assert_eq!(find(&source, "plan", exact).len(), 2);
        assert_eq!(find(&source, "plan", word).len(), 2);
        assert_eq!(
            find(
                &source,
                "plan",
                Options {
                    match_case: true,
                    whole_word: true
                }
            )
            .len(),
            1
        );
    }

    #[test]
    fn reads_character_references_and_wrapped_lines_as_text() {
        let source = deck(
            "<section class=\"slide\" id=\"a\"><p>R&amp;D &mdash; next\n      quarter&#39;s goals</p></section>",
        );
        assert_eq!(
            texts(&find(&source, "R&D — next quarter's", CASE)),
            [("a", "R&D — next quarter's")]
        );
        let replaced = replace(&source, "next quarter", "Q3 <soon>", CASE, None);
        assert_eq!(replaced.count, 1);
        assert!(replaced
            .html
            .contains("<p>R&amp;D &mdash; Q3 &lt;soon&gt;&#39;s goals</p>"));
    }

    #[test]
    fn replaces_everywhere_or_on_chosen_slides_and_leaves_locked_slides_alone() {
        let source = deck(
            r#"<section class="slide" id="a"><h1>Acme</h1><p>Acme and acme</p></section>
<section class="slide" id="b" data-locked><p>Acme</p></section>
<section class="slide" id="c"><p>Acme</p></section>"#,
        );
        let all = replace(&source, "acme", "Initech", CASE, None);
        assert_eq!(all.count, 4);
        assert_eq!(all.slides, ["a", "c"]);
        assert_eq!(all.skipped, ["b"]);
        assert!(all
            .html
            .contains(r#"<h1>Initech</h1><p>Initech and Initech</p>"#));
        assert!(all.html.contains(r#"data-locked><p>Acme</p>"#));
        assert!(find(&source, "acme", CASE)[3].locked);

        let one = replace(&source, "acme", "Initech", CASE, Some(&["c".to_string()]));
        assert_eq!((one.count, one.slides.clone()), (1, vec!["c".to_string()]));
        assert!(one.html.contains(r#"<h1>Acme</h1>"#));

        let none = replace(&source, "nowhere", "x", CASE, None);
        assert_eq!((none.count, none.html), (0, source));
    }

    #[test]
    fn skips_the_editors_invisible_placeholders() {
        let source = deck(
            r#"<section class="slide" id="a"><p data-delete-placeholder aria-hidden="true"><b>Gone</b> text</p><p>Gone</p></section>"#,
        );
        assert_eq!(texts(&find(&source, "gone", CASE)), [("a", "Gone")]);
        let replaced = replace(&source, "gone", "Here", CASE, None);
        assert!(replaced.html.contains("<b>Gone</b> text</p><p>Here</p>"));
    }

    #[test]
    fn does_not_match_across_tags() {
        let source = deck(r#"<section class="slide" id="a"><p>Hello <em>there</em></p></section>"#);
        assert!(find(&source, "hello there", CASE).is_empty());
        assert_eq!(find(&source, "there", CASE).len(), 1);
    }
}
