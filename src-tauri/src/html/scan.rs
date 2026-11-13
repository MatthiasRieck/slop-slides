//! The tag scanner: tags and their attributes, without a full HTML parser.

use std::ops::Range;

/// Elements that never have content or an end tag.
pub(crate) const VOID_ELEMENTS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

/// One tag as it is written in the document. Nothing of it is copied: its name and attributes
/// are slices of the document, read with [`Tag::is`] and [`Tag::attr`], which ignore case the
/// way HTML does.
pub(crate) struct Tag<'a> {
    html: &'a str,
    name: &'a str,
    pub closing: bool,
    /// Byte offset just after the tag's name.
    pub name_end: usize,
    /// Byte offset just after the tag's `>`.
    pub end: usize,
}

/// One attribute of a tag, as it is written in the document.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Attr<'a> {
    name: &'a str,
    /// The value without its quotes; empty for an attribute without one.
    pub value: &'a str,
    /// Byte range of the value in the document.
    pub value_range: Range<usize>,
    /// Byte range of the whole attribute, name to closing quote.
    pub range: Range<usize>,
}

impl<'a> Attr<'a> {
    /// Whether this is the attribute `name` (lowercase), in whatever case it is written.
    pub fn is(&self, name: &str) -> bool {
        self.name.eq_ignore_ascii_case(name)
    }

    /// The name as it is written in the document; compare it with [`Attr::is`].
    pub fn raw_name(&self) -> &'a str {
        self.name
    }

    /// The name in lowercase, for messages.
    pub fn name(&self) -> String {
        self.name.to_ascii_lowercase()
    }
}

impl<'a> Tag<'a> {
    /// Whether this is a `name` (lowercase) tag, in whatever case it is written.
    pub fn is(&self, name: &str) -> bool {
        self.name.eq_ignore_ascii_case(name)
    }

    /// Whether the tag is one of `names` (lowercase).
    pub fn is_any(&self, names: &[&str]) -> bool {
        names.iter().any(|name| self.is(name))
    }

    /// The name as it is written in the document; compare it with [`Tag::is`], or ignoring
    /// case.
    pub fn raw_name(&self) -> &'a str {
        self.name
    }

    /// The name in lowercase, for messages.
    pub fn name(&self) -> String {
        self.name.to_ascii_lowercase()
    }

    /// The tag's attributes, in order. They are read from the document as the iterator goes,
    /// so a tag nobody asks about its attributes costs nothing more.
    pub fn attrs(&self) -> Attrs<'a> {
        Attrs {
            html: self.html,
            at: self.name_end,
        }
    }

    /// The first attribute `name` (lowercase).
    pub fn attr(&self, name: &str) -> Option<Attr<'a>> {
        self.attrs().find(|a| a.is(name))
    }

    /// Where the first end tag of this tag's element (`</name`) starts after it. What a
    /// raw-text element such as `<script>` holds runs up to there.
    pub fn end_tag(&self) -> Option<usize> {
        let bytes = self.html.as_bytes();
        let mut from = self.end;
        loop {
            let at = find_ci(self.html, from, "</")?;
            let name = bytes.get(at + 2..at + 2 + self.name.len())?;
            if name.eq_ignore_ascii_case(self.name.as_bytes()) {
                return Some(at);
            }
            from = at + 2;
        }
    }
}

/// The attributes of one tag (see [`Tag::attrs`]).
pub(crate) struct Attrs<'a> {
    html: &'a str,
    at: usize,
}

impl<'a> Iterator for Attrs<'a> {
    type Item = Attr<'a>;

    fn next(&mut self) -> Option<Attr<'a>> {
        match next_attr(self.html, &mut self.at) {
            Step::Attr(attr) => Some(attr),
            Step::End | Step::Broken => None,
        }
    }
}

/// What comes next inside a tag.
enum Step<'a> {
    Attr(Attr<'a>),
    /// The tag's `>`.
    End,
    /// The document ends, or a quote never closes, before the tag does.
    Broken,
}

/// Reads what comes at `*i` inside a tag and moves `*i` past it (onto the `>` at the end).
fn next_attr<'a>(html: &'a str, i: &mut usize) -> Step<'a> {
    let bytes = html.as_bytes();
    while *i < bytes.len() && (bytes[*i].is_ascii_whitespace() || bytes[*i] == b'/') {
        *i += 1;
    }
    match bytes.get(*i) {
        None => return Step::Broken,
        Some(b'>') => return Step::End,
        _ => {}
    }
    let start = *i;
    while *i < bytes.len()
        && !matches!(bytes[*i], b'=' | b'>' | b'/')
        && !bytes[*i].is_ascii_whitespace()
    {
        *i += 1;
    }
    let name_end = *i;
    let name = &html[start..name_end];
    while *i < bytes.len() && bytes[*i].is_ascii_whitespace() {
        *i += 1;
    }
    if bytes.get(*i) != Some(&b'=') {
        return Step::Attr(Attr {
            name,
            value: "",
            value_range: *i..*i,
            range: start..name_end,
        });
    }
    *i += 1;
    while *i < bytes.len() && bytes[*i].is_ascii_whitespace() {
        *i += 1;
    }
    let value = match bytes.get(*i) {
        Some(&quote @ (b'"' | b'\'')) => {
            let Some(len) = html[*i + 1..].find(quote as char) else {
                return Step::Broken;
            };
            let range = *i + 1..*i + 1 + len;
            *i = range.end + 1;
            range
        }
        _ => {
            let from = *i;
            while *i < bytes.len() && !bytes[*i].is_ascii_whitespace() && bytes[*i] != b'>' {
                *i += 1;
            }
            from..*i
        }
    };
    Step::Attr(Attr {
        name,
        value: &html[value.clone()],
        value_range: value,
        range: start..*i,
    })
}

/// Elements whose content is text, not markup.
const RAW_TEXT: &[&str] = &["script", "style", "textarea", "title"];

/// Every tag outside comments and raw-text elements (`<script>`, `<style>`, …), with the
/// byte offset it starts at.
pub(super) fn tags(html: &str) -> impl Iterator<Item = (usize, Tag<'_>)> + '_ {
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
        if !tag.closing && tag.is_any(RAW_TEXT) {
            i = tag.end_tag().unwrap_or(html.len());
            continue;
        }
        let start = i;
        i = tag.end;
        return Some((start, tag));
    })
}

pub(crate) fn has_class(tag: &Tag, class: &str) -> bool {
    tag.attrs()
        .any(|a| a.is("class") && a.value.split_ascii_whitespace().any(|c| c == class))
}

/// Where `needle` first is in `html` at or after `from`, whatever the case of its ASCII letters.
/// Nothing is copied: the document is compared in place.
pub(crate) fn find_ci(html: &str, from: usize, needle: &str) -> Option<usize> {
    let hay = html.get(from..)?.as_bytes();
    let needle = needle.as_bytes();
    let Some((&first, rest)) = needle.split_first() else {
        return Some(from);
    };
    let last_start = hay.len().checked_sub(needle.len())?;
    let mut at = 0;
    while at <= last_start {
        at += hay[at..=last_start]
            .iter()
            .position(|b| b.eq_ignore_ascii_case(&first))?;
        if hay[at + 1..at + needle.len()].eq_ignore_ascii_case(rest) {
            return Some(from + at);
        }
        at += 1;
    }
    None
}

/// Where `needle` last is in `html`, whatever the case of its ASCII letters (see [`find_ci`]).
pub(crate) fn rfind_ci(html: &str, needle: &str) -> Option<usize> {
    let hay = html.as_bytes();
    let needle = needle.as_bytes();
    let Some((&first, rest)) = needle.split_first() else {
        return Some(hay.len());
    };
    let mut end = hay.len().checked_sub(needle.len())? + 1;
    while end > 0 {
        let at = hay[..end]
            .iter()
            .rposition(|b| b.eq_ignore_ascii_case(&first))?;
        if hay[at + 1..at + needle.len()].eq_ignore_ascii_case(rest) {
            return Some(at);
        }
        end = at;
    }
    None
}

pub(crate) fn parse_tag(html: &str, start: usize) -> Option<Tag<'_>> {
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
    let name_end = i;
    loop {
        match next_attr(html, &mut i) {
            Step::Attr(_) => {}
            Step::End => break,
            Step::Broken => return None,
        }
    }
    Some(Tag {
        html,
        name: &html[name_start..name_end],
        closing,
        name_end,
        end: i + 1,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::html::find_slides;
    use crate::html::fixtures::big_deck;

    /// What `find_ci` did before it compared in place: both texts lowercased, then searched.
    fn find_lowercased(html: &str, from: usize, needle: &str) -> Option<usize> {
        html.get(from..)?
            .to_ascii_lowercase()
            .find(&needle.to_ascii_lowercase())
            .map(|p| from + p)
    }

    fn rfind_lowercased(html: &str, needle: &str) -> Option<usize> {
        html.to_ascii_lowercase()
            .rfind(&needle.to_ascii_lowercase())
    }

    #[test]
    fn finds_text_in_any_case_where_a_lowercased_search_does() {
        let texts = [
            "<HTML><Body><MAIN class=\"deck\"></main><SCRIPT>x</ScRiPt></BODY></html>",
            "<<Section</SECTION></section><</sectio</SeCtIoN",
            "no tags at all",
            "ÄÖ <títle>é</TÍTLE> 日本 </main> 👋 </MAIN",
            "<a<A<a href=x></A></a>",
            "</",
            "",
        ];
        let needles = [
            "<main",
            "</main",
            "</section",
            "<script",
            "</script",
            "<a",
            "</",
            "<títle",
            "</títle",
            "é",
            "x",
            "<<",
            "",
        ];
        for text in texts {
            for needle in needles {
                assert_eq!(
                    rfind_ci(text, needle),
                    rfind_lowercased(text, needle),
                    "last {needle:?} in {text:?}"
                );
                for from in 0..=text.len() + 1 {
                    assert_eq!(
                        find_ci(text, from, needle),
                        find_lowercased(text, from, needle),
                        "{needle:?} in {text:?} from {from}"
                    );
                }
            }
        }
    }

    #[test]
    fn reads_tags_and_attributes_in_place_whatever_their_case() {
        let html = "<DIV Class=\"a  b\" ID=main data-x='1 > 2' hidden DATA-Y = \"q\" />text";
        let tag = parse_tag(html, 0).unwrap();
        assert!(tag.is("div") && !tag.is("di") && !tag.closing);
        assert!(tag.is_any(&["p", "div"]));
        assert_eq!((tag.raw_name(), tag.name().as_str()), ("DIV", "div"));
        assert_eq!(&html[..tag.name_end], "<DIV");
        assert_eq!(&html[tag.end..], "text");
        let attrs: Vec<_> = tag.attrs().collect();
        let read: Vec<_> = attrs
            .iter()
            .map(|a| (a.name(), a.value, &html[a.range.clone()]))
            .collect();
        assert_eq!(
            read,
            [
                ("class".to_string(), "a  b", "Class=\"a  b\""),
                ("id".to_string(), "main", "ID=main"),
                ("data-x".to_string(), "1 > 2", "data-x='1 > 2'"),
                ("hidden".to_string(), "", "hidden"),
                ("data-y".to_string(), "q", "DATA-Y = \"q\""),
            ]
        );
        for attr in &attrs {
            assert_eq!(&html[attr.value_range.clone()], attr.value);
        }
        assert_eq!(tag.attr("id").unwrap().value, "main");
        assert_eq!(tag.attr("DATA-Y").unwrap().value, "q");
        assert!(tag.attr("hidden").is_some() && tag.attr("data").is_none());
        assert!(has_class(&tag, "b") && !has_class(&tag, "B"));

        let closing = parse_tag("</Section >", 0).unwrap();
        assert!(closing.closing && closing.is("section"));
        assert_eq!(closing.attrs().count(), 0);
        // Never closed, or a quote never closed: no tag.
        for broken in [
            "<div class=\"a",
            "<div class='a\">",
            "<div",
            "<",
            "< div>",
            "<>",
        ] {
            assert!(parse_tag(broken, 0).is_none(), "{broken}");
        }
    }

    #[test]
    fn a_raw_text_element_runs_to_its_own_end_tag() {
        let html = "<Script>a </scrip> b </style> c</SCRIPT><p>x</p>";
        let tag = parse_tag(html, 0).unwrap();
        assert_eq!(tag.end_tag(), html.find("</SCRIPT"));
        assert_eq!(parse_tag("<style>never closed", 0).unwrap().end_tag(), None);
        let names: Vec<_> = tags(html).map(|(_, t)| (t.name(), t.closing)).collect();
        assert_eq!(
            names,
            [
                ("script".to_string(), true),
                ("p".to_string(), false),
                ("p".to_string(), true)
            ]
        );
    }

    /// How long one scan of a deck of 60 heavy slides takes. Run it with
    /// `cargo test scans_a_big_deck -- --ignored --nocapture`.
    #[test]
    #[ignore = "a timing, not a check"]
    fn scans_a_big_deck_fast() {
        let deck = big_deck(60);
        let runs = 50;
        let time = |what: &str, run: &dyn Fn()| {
            let started = std::time::Instant::now();
            for _ in 0..runs {
                run();
            }
            println!("{what}: {:?}", started.elapsed() / runs);
        };
        println!("{} KB deck", deck.len() / 1024);
        time("every tag", &|| assert!(tags(&deck).count() > 1000));
        time("one scan for the slides", &|| {
            assert_eq!(find_slides(&deck).len(), 60)
        });
        time("the slides and sections", &|| {
            assert_eq!(crate::html::find_spans(&deck).0.len(), 60)
        });
        time("a deck parsed whole", &|| {
            assert_eq!(crate::deck::Parsed::of(&deck).slides.len(), 60)
        });
    }
}
