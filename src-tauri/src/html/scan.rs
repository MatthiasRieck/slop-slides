//! The tag scanner: tags and their attributes, without a full HTML parser.

use std::ops::Range;

/// Elements that never have content or an end tag.
pub(crate) const VOID_ELEMENTS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

pub(crate) struct Tag {
    pub name: String,
    pub closing: bool,
    /// (name, value, value range, whole attribute range)
    pub attrs: Vec<(String, String, Range<usize>, Range<usize>)>,
    pub name_end: usize,
    pub end: usize,
}

/// Every tag outside comments and raw-text elements (`<script>`, `<style>`, …), with the
/// byte offset it starts at.
pub(super) fn tags(html: &str) -> impl Iterator<Item = (usize, Tag)> + '_ {
    let mut i = 0;
    std::iter::from_fn(move || loop {
        let Some(found) = html.get(i..).and_then(|rest| rest.find('<')) else {
            i = html.len();
            return None;
        };
        i += found;
        if html[i..].starts_with("<!--") {
            i = html[i..].find("-->").map_or(html.len(), |e| i + e + 3);
            continue;
        }
        let Some(tag) = parse_tag(html, i) else {
            i += 1;
            continue;
        };
        if !tag.closing && matches!(tag.name.as_str(), "script" | "style" | "textarea" | "title") {
            let close = format!("</{}", tag.name);
            i = find_ci(html, tag.end, &close).unwrap_or(html.len());
            continue;
        }
        let start = i;
        i = tag.end;
        return Some((start, tag));
    })
}

pub(crate) fn has_class(tag: &Tag, class: &str) -> bool {
    tag.attrs
        .iter()
        .any(|(n, v, _, _)| n == "class" && v.split_ascii_whitespace().any(|c| c == class))
}

pub(crate) fn find_ci(html: &str, from: usize, needle: &str) -> Option<usize> {
    html.get(from..)?
        .to_ascii_lowercase()
        .find(&needle.to_ascii_lowercase())
        .map(|p| from + p)
}

pub(crate) fn parse_tag(html: &str, start: usize) -> Option<Tag> {
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
