//! The document's `<title>`, and the app's settings in `<meta name="slopslide-…">` tags.

use crate::size::{self, SlideSize};

use super::edit::{insert_after_head, remove};
use super::entities::{decode_entities, escape, escape_attr};
use super::scan::{find_ci, tags, Tag};

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

/// Name of the `<meta>` naming the template a deck's design comes from:
/// `<meta name="slopslide-template" content="<template id>">`.
pub const TEMPLATE_META: &str = "slopslide-template";

/// The first `<meta name="<name>">` tag (an app setting such as [`TEMPLATE_META`]): where it
/// starts and its parsed tag.
fn app_meta(html: &str, name: &str) -> Option<(usize, Tag)> {
    tags(html).find(|(_, tag)| {
        !tag.closing
            && tag.name == "meta"
            && tag
                .attrs
                .iter()
                .any(|(n, v, _, _)| n == "name" && v.trim().eq_ignore_ascii_case(name))
    })
}

/// The decoded, trimmed `content` of the app setting `<meta name="<name>">`; None when it is
/// missing or empty.
pub(crate) fn app_meta_content(html: &str, name: &str) -> Option<String> {
    let (_, tag) = app_meta(html, name)?;
    let content = tag.attrs.iter().find(|(n, _, _, _)| n == "content")?;
    let value = decode_entities(content.1.trim());
    (!value.is_empty()).then_some(value)
}

/// Sets the app setting `<meta name="<name>">` (new ones go right after `<title>`), or removes
/// it for None.
fn set_app_meta(html: &str, name: &str, content: Option<&str>) -> String {
    let tag =
        content.map(|value| format!("<meta name=\"{name}\" content=\"{}\">", escape_attr(value)));
    match (app_meta(html, name), tag) {
        (Some((at, old)), Some(tag)) => format!("{}{tag}{}", &html[..at], &html[old.end..]),
        (Some((at, old)), None) => remove(html, &(at..old.end)),
        (None, Some(tag)) => match find_ci(html, 0, "</title") {
            Some(end) => {
                let at = html[end..].find('>').map_or(html.len(), |e| end + e + 1);
                format!("{}\n  {tag}{}", &html[..at], &html[at..])
            }
            None => insert_after_head(html, &format!("\n  {tag}")),
        },
        (None, None) => html.to_string(),
    }
}

/// Id of the template the deck's design comes from (see [`TEMPLATE_META`]).
pub fn template(html: &str) -> Option<String> {
    app_meta_content(html, TEMPLATE_META)
}

/// Names the deck's template in its `<meta>` (right after `<title>`), or removes it for None.
pub fn set_template(html: &str, template: Option<&str>) -> String {
    set_app_meta(html, TEMPLATE_META, template)
}

/// The deck's slide size (see [`size::SIZE_META`]); the default 1920×1080 px without one.
pub fn slide_size(html: &str) -> SlideSize {
    app_meta_content(html, size::SIZE_META)
        .and_then(|content| SlideSize::parse(&content))
        .unwrap_or_default()
}

/// Sets the deck's slide size in its `<meta>`; the default size removes the tag. The player
/// runtime has to be refreshed after (see [`ensure_runtime`]) for the stage to take it.
pub fn set_slide_size(html: &str, size: SlideSize) -> String {
    let content = (size != SlideSize::default()).then(|| size.to_string());
    set_app_meta(html, size::SIZE_META, content.as_deref())
}

/// The app setting naming the voice the deck's narration is said in (see
/// [`crate::narration::Provider::accepts_voice`]).
pub const NARRATION_VOICE_META: &str = "slopslide-narration-voice";
/// The app setting naming the language the deck's narration is in (see
/// [`crate::narration::LANGUAGES`]).
pub const NARRATION_LANGUAGE_META: &str = "slopslide-narration-language";

/// The app setting naming who says the deck's narration (see
/// [`crate::narration::cloud::PROVIDERS`]); [`crate::narration::DEFAULT_PROVIDER`] without one.
pub const NARRATION_PROVIDER_META: &str = "slopslide-narration-provider";

/// The provider the deck's `<meta>` names for its narration, if any.
pub fn narration_provider(html: &str) -> Option<String> {
    app_meta_content(html, NARRATION_PROVIDER_META)
}

/// Names the narration's provider in the deck's `<meta>` (right after `<title>`), or removes
/// it for None.
pub fn set_narration_provider(html: &str, provider: Option<&str>) -> String {
    set_app_meta(html, NARRATION_PROVIDER_META, provider)
}

/// The voice the deck's `<meta>` names for its narration, if any.
pub fn narration_voice(html: &str) -> Option<String> {
    app_meta_content(html, NARRATION_VOICE_META)
}

/// Names the narration's voice in the deck's `<meta>` (right after `<title>`).
pub fn set_narration_voice(html: &str, voice: &str) -> String {
    set_app_meta(html, NARRATION_VOICE_META, Some(voice))
}

/// The language the deck's `<meta>` names for its narration, if any.
pub fn narration_language(html: &str) -> Option<String> {
    app_meta_content(html, NARRATION_LANGUAGE_META)
}

/// Names the narration's language in the deck's `<meta>` (right after `<title>`).
pub fn set_narration_language(html: &str, language: &str) -> String {
    set_app_meta(html, NARRATION_LANGUAGE_META, Some(language))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::html::fixtures::*;

    #[test]
    fn reads_and_writes_titles() {
        assert_eq!(title(DECK).as_deref(), Some("Q3 & more"));
        let renamed = set_title(DECK, "A <b> deck");
        assert_eq!(title(&renamed).as_deref(), Some("A <b> deck"));
        assert!(renamed.contains("<title>A &lt;b&gt; deck</title>"));
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
    fn reads_and_writes_the_template_meta() {
        assert_eq!(template(STYLED), None);
        let named = set_template(STYLED, Some("swiss"));
        assert!(
            named.contains(
                "<title>Talk</title>\n  <meta name=\"slopslide-template\" content=\"swiss\">"
            ),
            "{named}"
        );
        assert_eq!(template(&named).as_deref(), Some("swiss"));
        let renamed = set_template(&named, Some("a\"b"));
        assert_eq!(renamed.matches(TEMPLATE_META).count(), 1);
        assert_eq!(template(&renamed).as_deref(), Some("a\"b"));
        assert_eq!(set_template(&named, None), STYLED, "removing undoes adding");
        assert_eq!(set_template(STYLED, None), STYLED);
        assert_eq!(
            template("<head><META NAME=\"SlopSlide-Template\" content=\" bento-grid \"></head>")
                .as_deref(),
            Some("bento-grid")
        );
        assert_eq!(
            template("<meta name=\"slopslide-template\" content=\"\">"),
            None
        );
        let untitled = set_template("<html><head></head></html>", Some("x"));
        assert_eq!(
            untitled,
            "<html><head>\n  <meta name=\"slopslide-template\" content=\"x\"></head></html>"
        );
    }

    #[test]
    fn reads_and_writes_the_slide_size_meta() {
        use crate::size::Unit;
        assert_eq!(slide_size(STYLED), SlideSize::default());
        let named = set_template(STYLED, Some("swiss"));
        let a4 = SlideSize {
            width: 21.0,
            height: 29.7,
            unit: Unit::Cm,
        };
        let sized = set_slide_size(&named, a4);
        assert!(
            sized.contains("<title>Talk</title>\n  <meta name=\"slopslide-size\" content=\"21x29.7cm\">\n  <meta name=\"slopslide-template\""),
            "{sized}"
        );
        assert_eq!(slide_size(&sized), a4);
        assert_eq!(
            template(&sized).as_deref(),
            Some("swiss"),
            "other metas stay"
        );
        let square = SlideSize::parse("1080x1080").unwrap();
        let resized = set_slide_size(&sized, square);
        assert_eq!(resized.matches(crate::size::SIZE_META).count(), 1);
        assert_eq!(slide_size(&resized), square);
        assert_eq!(
            set_slide_size(&sized, SlideSize::default()),
            named,
            "the default size removes the meta"
        );
        // Unusable sizes fall back to the default.
        let bad = sized.replace("21x29.7cm", "huge");
        assert_eq!(slide_size(&bad), SlideSize::default());
    }
}
