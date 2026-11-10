//! Placeholder (lorem ipsum) text in place of a deck's own, for templates.

use super::scan::{find_ci, parse_tag};
use super::spans::find_slides;

/// Replaces every word of the slides' text with placeholder (lorem ipsum) words of about
/// the same length and case, and every digit with another digit, keeping all markup,
/// styles, and entities. Turns a deck into a template without its content.
pub fn with_placeholder_text(html: &str) -> String {
    let mut words = PlaceholderWords::default();
    let mut out = String::with_capacity(html.len());
    let mut at = 0;
    for slide in find_slides(html) {
        out.push_str(&html[at..slide.range.start]);
        let s = &html[slide.range.clone()];
        let mut i = 0;
        while i < s.len() {
            let next = s[i..].find('<').map_or(s.len(), |e| i + e);
            out.push_str(&words.replace(&s[i..next]));
            if next == s.len() {
                break;
            }
            let end = if s[next..].starts_with("<!--") {
                s[next..].find("-->").map_or(s.len(), |e| next + e + 3)
            } else {
                match parse_tag(s, next) {
                    Some(tag)
                        if !tag.closing
                            && matches!(tag.name.as_str(), "script" | "style" | "textarea") =>
                    {
                        find_ci(s, tag.end, &format!("</{}", tag.name)).unwrap_or(s.len())
                    }
                    Some(tag) => tag.end,
                    None => next + 1,
                }
            };
            out.push_str(&s[next..end]);
            i = end;
        }
        at = slide.range.end;
    }
    out.push_str(&html[at..]);
    out
}

const LOREM: &[&str] = &[
    "a",
    "ad",
    "et",
    "in",
    "ut",
    "id",
    "non",
    "sed",
    "est",
    "sit",
    "amet",
    "elit",
    "enim",
    "quis",
    "nisi",
    "lorem",
    "ipsum",
    "dolor",
    "magna",
    "minim",
    "culpa",
    "labore",
    "dolore",
    "veniam",
    "fugiat",
    "tempor",
    "aliqua",
    "nostrud",
    "officia",
    "laboris",
    "commodo",
    "pariatur",
    "voluptate",
    "adipiscing",
    "incididunt",
    "consectetur",
    "exercitation",
    "reprehenderit",
];
const DIGITS: &[u8] = b"4827365190";

#[derive(Default)]
struct PlaceholderWords {
    next: usize,
}

impl PlaceholderWords {
    fn replace(&mut self, text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        let mut chars = text.char_indices().peekable();
        while let Some((i, c)) = chars.next() {
            if c == '&' {
                // Keep entities such as `&amp;` or `&#8212;` as they are.
                let entity = text[i..].find(';').filter(|&e| {
                    e > 1
                        && e <= 10
                        && text[i + 1..i + e]
                            .chars()
                            .all(|c| c.is_alphanumeric() || c == '#')
                });
                if let Some(e) = entity {
                    out.push_str(&text[i..=i + e]);
                    while chars.peek().is_some_and(|&(j, _)| j <= i + e) {
                        chars.next();
                    }
                    continue;
                }
            }
            if c.is_alphabetic() {
                let mut word = String::from(c);
                while let Some(&(_, next)) = chars.peek().filter(|(_, n)| n.is_alphabetic()) {
                    word.push(next);
                    chars.next();
                }
                out.push_str(&self.word(&word));
            } else if c.is_ascii_digit() {
                out.push(DIGITS[self.next % DIGITS.len()] as char);
                self.next += 1;
            } else {
                out.push(c);
            }
        }
        out
    }

    /// A placeholder word as long as `original` as the list allows, in the same case.
    fn word(&mut self, original: &str) -> String {
        let len = original.chars().count();
        let distance = |w: &&str| w.len().abs_diff(len);
        let best = LOREM.iter().map(distance).min().unwrap_or(0);
        let fits: Vec<&str> = LOREM
            .iter()
            .filter(|w| distance(w) == best)
            .copied()
            .collect();
        let word = fits[self.next % fits.len()];
        self.next += 1;
        let mut letters = original.chars();
        let first_upper = letters.next().is_some_and(char::is_uppercase);
        if first_upper && len > 1 && original.chars().all(char::is_uppercase) {
            word.to_uppercase()
        } else if first_upper {
            let mut w = word.chars();
            w.next()
                .map(|f| f.to_uppercase().chain(w).collect())
                .unwrap_or_default()
        } else {
            word.to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::html::fixtures::*;

    #[test]
    fn replaces_slide_text_with_placeholder_words() {
        let out = with_placeholder_text(STYLED);
        // Everything outside the slides, and all markup, styles and comments stay.
        assert!(out.starts_with("<!DOCTYPE html><html><head>\n  <title>Talk</title>"));
        assert!(out.contains("data-title=\"Part\""));
        assert!(out.contains("<style>.y { content: \"keep\" }</style><!-- note -->"));
        assert!(out.contains("<section class=\"slide\" id=\"a\"><h1>"));
        assert!(out.contains(" &amp; "), "entities stay: {out}");
        for word in ["Big", "bold", "Revenue", "grew", "NASA", "hello", "42"] {
            assert!(!out.contains(word), "{word} left in {out}");
        }
        assert_eq!(find_slides(&out).len(), 2);
        // Case and punctuation follow the original.
        let slides = find_slides(&out);
        let b = &out[slides[1].range.clone()];
        let text = b.split("<p>").nth(1).unwrap().split("</p>").next().unwrap();
        let words: Vec<&str> = text.split(' ').collect();
        assert_eq!(words.len(), 3, "{text}");
        assert!(
            words[0].len() > 1 && words[0].chars().all(char::is_uppercase),
            "{text}"
        );
        assert!(words[1].ends_with(':'), "{text}");
        assert!(words[2].chars().all(char::is_lowercase), "{text}");
        let a = &out[slides[0].range.clone()];
        assert!(a.contains("% "), "digits and symbols keep their shape: {a}");
        assert_eq!(
            with_placeholder_text(&out).len(),
            out.len(),
            "same shape again"
        );
    }
}
