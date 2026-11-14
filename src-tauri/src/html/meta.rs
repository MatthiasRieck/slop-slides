//! The document's `<title>`, and the app's settings in `<meta name="slopslide-…">` tags.

use crate::size::{self, SlideSize};

use super::edit::{insert_after_head, remove};
use super::entities::{decode_entities, escape, escape_attr};
use super::scan::{find_ci, rfind_ci, tags, Tag};

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
fn app_meta<'a>(html: &'a str, name: &str) -> Option<(usize, Tag<'a>)> {
    metas(html).find(|(_, tag)| names(tag, name))
}

/// Every `<meta>` tag of the document, with where it starts. A document's metas sit in its
/// head, so the scan stops at the last place `<meta` is written instead of reading every slide
/// after it; nothing further on can be one.
fn metas(html: &str) -> impl Iterator<Item = (usize, Tag<'_>)> {
    let last = rfind_ci(html, "<meta");
    tags(html)
        .take_while(move |(at, _)| last.is_some_and(|last| *at <= last))
        .filter(|(_, tag)| !tag.closing && tag.is("meta"))
}

/// Whether the meta `tag` is the app setting `name`.
fn names(tag: &Tag, name: &str) -> bool {
    tag.attrs()
        .any(|a| a.is("name") && a.value.trim().eq_ignore_ascii_case(name))
}

/// The decoded, trimmed `content` of the meta `tag`; None when it is missing or empty.
fn content(tag: &Tag) -> Option<String> {
    let value = decode_entities(tag.attr("content")?.value.trim());
    (!value.is_empty()).then_some(value)
}

/// The decoded, trimmed `content` of the app setting `<meta name="<name>">`; None when it is
/// missing or empty.
pub(crate) fn app_meta_content(html: &str, name: &str) -> Option<String> {
    content(&app_meta(html, name)?.1)
}

/// Every app setting a document names, read in one pass over its metas: loading a deck asks
/// for all of them, and most decks name none, which each lookup of its own only finds out at
/// the end of the document.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AppMetas {
    /// See [`template`].
    pub template: Option<String>,
    /// The content of the [`size::SIZE_META`] tag (see [`AppMetas::slide_size`]).
    pub size: Option<String>,
    /// See [`narration_provider`].
    pub narration_provider: Option<String>,
    /// See [`narration_voice`].
    pub narration_voice: Option<String>,
    /// See [`narration_language`].
    pub narration_language: Option<String>,
}

impl AppMetas {
    pub fn read(html: &str) -> Self {
        // The first tag of each setting counts, whatever its content, as in `app_meta`.
        let mut found: [Option<Option<String>>; 5] = Default::default();
        const NAMES: [&str; 5] = [
            TEMPLATE_META,
            size::SIZE_META,
            NARRATION_PROVIDER_META,
            NARRATION_VOICE_META,
            NARRATION_LANGUAGE_META,
        ];
        for (_, tag) in metas(html) {
            for (slot, name) in found.iter_mut().zip(NAMES) {
                if slot.is_none() && names(&tag, name) {
                    *slot = Some(content(&tag));
                }
            }
            if found.iter().all(Option::is_some) {
                break;
            }
        }
        let [template, size, narration_provider, narration_voice, narration_language] =
            found.map(Option::flatten);
        Self {
            template,
            size,
            narration_provider,
            narration_voice,
            narration_language,
        }
    }

    /// The deck's slide size (see [`slide_size`]).
    pub fn slide_size(&self) -> SlideSize {
        self.size
            .as_deref()
            .and_then(SlideSize::parse)
            .unwrap_or_default()
    }
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

/// Id of the template the deck's design comes from (see [`TEMPLATE_META`]). The app reads it
/// with the deck's other settings (see [`AppMetas`]); this is the lookup by itself, for tests.
#[cfg(test)]
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

/// The language the deck's `<meta>` names for its narration, if any. The app reads it with
/// the deck's other settings (see [`AppMetas`]); this is the lookup by itself, for tests.
#[cfg(test)]
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

    /// The settings as five lookups of their own read them.
    fn separately(html: &str) -> AppMetas {
        AppMetas {
            template: template(html),
            size: app_meta_content(html, crate::size::SIZE_META),
            narration_provider: narration_provider(html),
            narration_voice: narration_voice(html),
            narration_language: narration_language(html),
        }
    }

    #[test]
    fn one_pass_reads_every_setting_like_the_lookups_of_their_own() {
        assert_eq!(AppMetas::read(STYLED), AppMetas::default());
        let all = set_narration_language(
            &set_narration_voice(
                &set_narration_provider(
                    &set_slide_size(
                        &set_template(STYLED, Some("swiss")),
                        SlideSize::parse("1080x1080").unwrap(),
                    ),
                    Some("elevenlabs"),
                ),
                "nova",
            ),
            "de",
        );
        let metas = AppMetas::read(&all);
        assert_eq!(metas, separately(&all));
        assert_eq!(metas.template.as_deref(), Some("swiss"));
        assert_eq!(metas.narration_language.as_deref(), Some("de"));
        assert_eq!(metas.slide_size(), slide_size(&all));
        for html in [
            // The first tag of a setting counts, even an empty one.
            "<meta name=\"slopslide-template\" content=\"\"><meta name=\"slopslide-template\" content=\"late\">",
            "<META NAME=\" SlopSlide-Template \" CONTENT=\" a &amp; b \"><meta name=slopslide-size content=huge>",
            // Not in markup: a comment, a script.
            "<!-- <meta name=\"slopslide-template\" content=\"ghost\"> --><script>'<meta name=\"slopslide-size\" content=\"1x1\">'</script>",
            "<meta name=\"slopslide-template\">",
            "",
        ] {
            assert_eq!(AppMetas::read(html), separately(html), "{html}");
        }
    }

    #[test]
    fn settings_in_the_body_are_read_too() {
        // Lint reports a meta outside <head> as misplaced, but the app has always read it.
        let html = "<html><head><title>T</title></head><body><main class=\"deck\">\n<section class=\"slide\" id=\"a\">A</section>\n</main>\n<meta name=\"slopslide-template\" content=\"swiss\">\n<meta name=\"slopslide-narration-language\" content=\"fr\"></body></html>";
        assert_eq!(template(html).as_deref(), Some("swiss"));
        let metas = AppMetas::read(html);
        assert_eq!(metas, separately(html));
        assert_eq!(metas.narration_language.as_deref(), Some("fr"));
        // Also one inside a slide.
        let inside = "<section class=\"slide\" id=\"a\"><meta name=\"slopslide-size\" content=\"1080x1080\"></section>";
        assert_eq!(AppMetas::read(inside).slide_size(), slide_size(inside));
        assert_ne!(slide_size(inside), SlideSize::default());
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
