//! The checks of the deck format the app and player rely on: the document, slides, their
//! attributes and narration, section markers, the app-managed blocks and settings, assets and
//! links.

use std::collections::HashSet;

use crate::comments;
use crate::html::{
    self, find_ci, parse_tag, DURATION_ATTR, HIDDEN_ATTR, LOCKED_ATTR, NARRATION_START_ATTR,
    SECTION_TITLE_ATTR, TIME_ATTR,
};
use crate::narration;
use crate::review;
use crate::size::{self, SlideSize};

use super::{in_markup, truncate, Linter, Severity};

/// Document-level structure: doctype, title, deck container, runtime blocks.
pub(super) fn check_document(l: &mut Linter) {
    let html = l.html;
    if !html
        .trim_start()
        .to_ascii_lowercase()
        .starts_with("<!doctype html")
    {
        l.report(
            "doctype",
            Severity::Warning,
            0,
            "The deck should start with <!DOCTYPE html>.".into(),
        );
    }
    if html::title(html).is_none() {
        l.report(
            "title",
            Severity::Warning,
            0,
            "The deck needs a non-empty <title> in <head>.".into(),
        );
    }
    if !html::has_deck_container(html) {
        l.report(
            "deck-container",
            Severity::Error,
            0,
            "There is no <main class=\"deck\"> element holding the slides.".into(),
        );
    }
    if !html.contains(html::CSS_START) || !html.contains(html::JS_START) {
        l.report(
            "runtime-missing",
            Severity::Warning,
            0,
            "The slopslide:runtime-css / runtime-js blocks are missing; keep them intact.".into(),
        );
    }
}

/// Shared-element names are unique within each click state, reusable across slides.
pub(super) fn check_morphs(l: &mut Linter) {
    for slide in l.slides.clone() {
        let mut seen = HashSet::new();
        let mut at = slide.range.start;
        while at < slide.range.end {
            if let Some(tag) = parse_tag(l.html, at) {
                if !tag.closing {
                    if let Some((_, name, ..)) = tag.attrs.iter().find(|(n, ..)| n == "data-morph")
                    {
                        if name.is_empty()
                            || !name.as_bytes()[0].is_ascii_lowercase()
                            || !name
                                .bytes()
                                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                        {
                            l.report(
                                "morph-name",
                                Severity::Warning,
                                at,
                                "data-morph needs a lowercase name such as product-hero.".into(),
                            );
                        } else if !seen.insert(name.clone()) {
                            l.report("morph-duplicate", Severity::Warning, at,
                                format!("data-morph=\"{name}\" occurs twice on this slide; use each name once per slide."));
                        }
                    }
                }
                at = tag.end;
            } else {
                at += 1;
            }
        }
    }
}

/// The ends of a line the user stuck to elements in the editor: `data-from` / `data-to` name
/// an element on the same slide by id, and `data-from-at` / `data-to-at` the spot on its box
/// as two percentages (`"50% 100%"`), followed by `edge` when the end is stuck to the element's
/// outline there (`"0% 0% edge"`).
pub(super) fn check_stuck_lines(l: &mut Linter) {
    const ENDS: [(&str, &str); 2] = [("data-from", "data-from-at"), ("data-to", "data-to-at")];
    for slide in l.slides.clone() {
        let mut ids = HashSet::new();
        let mut stuck = Vec::new();
        let mut at = slide.range.start;
        while at < slide.range.end {
            let Some(tag) = parse_tag(l.html, at) else {
                at += 1;
                continue;
            };
            if !tag.closing {
                let attr = |name: &str| {
                    tag.attrs
                        .iter()
                        .find(|(n, ..)| n == name)
                        .map(|(_, v, ..)| v.trim().to_string())
                };
                if let Some(id) = attr("id") {
                    ids.insert(id);
                }
                for (end, spot) in ENDS {
                    match (attr(end), attr(spot)) {
                        (Some(id), spot) => stuck.push((at, end, id, spot)),
                        (None, Some(_)) => l.report(
                            "stuck-line-anchor",
                            Severity::Warning,
                            at,
                            format!("`{spot}` means nothing without `{end}`; remove it."),
                        ),
                        (None, None) => {}
                    }
                }
            }
            at = tag.end;
        }
        for (at, end, id, spot) in stuck {
            if !ids.contains(&id) {
                l.report(
                    "stuck-line-target",
                    Severity::Warning,
                    at,
                    format!("This line's `{end}` names `{id}`, but no element on this slide has that id. Give the element it ends on that id, or remove `{end}` and its `-at`."),
                );
            }
            if !spot.as_deref().is_some_and(is_anchor) {
                l.report(
                    "stuck-line-anchor",
                    Severity::Warning,
                    at,
                    format!("`{end}-at` needs the spot on the element's box the line ends at, as two percentages from 0% to 100% (e.g. \"50% 100%\"), and then `edge` if the end is stuck to the element's outline (\"0% 0% edge\")."),
                );
            }
        }
    }
}

/// Two percentages from 0% to 100%, such as `50% 100%`, and maybe `edge` after them.
fn is_anchor(value: &str) -> bool {
    let mut parts: Vec<_> = value.split_whitespace().collect();
    if parts.len() == 3 && parts[2] == "edge" {
        parts.pop();
    }
    parts.len() == 2
        && parts.iter().all(|p| {
            p.strip_suffix('%')
                .and_then(|n| n.parse::<f64>().ok())
                .is_some_and(|n| (0.0..=100.0).contains(&n))
        })
}

/// Slide ids: present, unique, kebab-case.
pub(super) fn check_slides(l: &mut Linter) {
    let mut seen = HashSet::new();
    let slides = l.slides.clone();
    for (index, slide) in slides.iter().enumerate() {
        let at = slide.range.start;
        match &slide.id {
            None => l.report(
                "slide-id-missing",
                Severity::Error,
                at,
                format!("Slide {} has no id.", index + 1),
            ),
            Some(id) if !seen.insert(id.clone()) => l.report(
                "slide-id-duplicate",
                Severity::Error,
                at,
                format!("The slide id `{id}` is used more than once."),
            ),
            Some(id) if !is_kebab_case(id) => l.report(
                "slide-id-format",
                Severity::Warning,
                at,
                format!("The slide id `{id}` should be kebab-case (e.g. `pricing-tiers`)."),
            ),
            Some(_) => {}
        }
        let valued = |range: &Option<std::ops::Range<usize>>| {
            range.as_ref().is_some_and(|r| {
                let attr = &l.html[r.clone()];
                attr.contains('=') && !attr.ends_with("\"\"") && !attr.ends_with("''")
            })
        };
        if valued(&slide.hidden) {
            l.report(
                "hidden-value",
                Severity::Warning,
                at,
                format!("Write `{HIDDEN_ATTR}` without a value; any value still hides the slide."),
            );
        }
        if valued(&slide.locked) {
            l.report(
                "locked-value",
                Severity::Warning,
                at,
                format!("Write `{LOCKED_ATTR}` without a value; any value still locks the slide."),
            );
        }
        if let Some((_, value)) = slide
            .time
            .as_ref()
            .filter(|(_, v)| html::parse_time(v).is_none())
        {
            l.report(
                "time-value",
                Severity::Warning,
                at,
                format!(
                    "`{TIME_ATTR}=\"{value}\"` is ignored: it takes the whole seconds expected on the slide, like `{TIME_ATTR}=\"90\"`."
                ),
            );
        }
        if let Some((_, value)) = slide
            .duration
            .as_ref()
            .filter(|(_, v)| html::parse_duration(v).is_none())
        {
            l.report(
                "duration-value",
                Severity::Warning,
                at,
                format!(
                    "`{DURATION_ATTR}=\"{value}\"` is ignored: it takes the seconds the slide is shown, {} to {}, like `{DURATION_ATTR}=\"12.5\"`. The user sets it on the narration timeline; keep it as it was.",
                    html::MIN_DURATION,
                    html::MAX_DURATION
                ),
            );
        }
        if let Some((_, value)) = slide
            .narration_start
            .as_ref()
            .filter(|(_, v)| html::parse_narration_start(v).is_none())
        {
            l.report(
                "narration-start-value",
                Severity::Warning,
                at,
                format!(
                    "`{NARRATION_START_ATTR}=\"{value}\"` is ignored: it takes the seconds from the slide's start to its narration's, negative when it starts earlier, like `{NARRATION_START_ATTR}=\"0.5\"`. The user sets it on the narration timeline; keep it as it was."
                ),
            );
        }
        let pinned = |attr: &Option<(std::ops::Range<usize>, String)>,
                      parse: fn(&str) -> Option<f64>| {
            attr.as_ref().and_then(|(_, v)| parse(v))
        };
        if let (Some(start), Some(duration)) = (
            pinned(&slide.narration_start, html::parse_narration_start),
            pinned(&slide.duration, html::parse_duration),
        ) {
            if start >= duration {
                l.report(
                    "narration-start-after-end",
                    Severity::Error,
                    at,
                    format!(
                        "The slide's narration starts {start} s in (`{NARRATION_START_ATTR}`), but the slide only shows for {duration} s (`{DURATION_ATTR}`): start it before the slide ends. Audio that is to play on over the next slides starts on a short first slide."
                    ),
                );
            }
        }
    }
}

/// Narration: one `<aside class="narration">` of Markdown text per slide, no HTML in it.
pub(super) fn check_narration(l: &mut Linter) {
    let slides = l.slides.clone();
    for slide in &slides {
        let markup = &l.html[slide.range.clone()];
        let spans = html::narration_spans(markup);
        for extra in spans.iter().skip(1) {
            l.report(
                "narration-duplicate",
                Severity::Warning,
                slide.range.start + extra.range.start,
                "This slide has more than one narration; merge them into a single <aside class=\"narration\">.".into(),
            );
        }
        for span in &spans {
            let inner = &markup[span.inner.clone()];
            let has_markup = inner
                .match_indices('<')
                .any(|(at, _)| html::parse_tag(inner, at).is_some_and(|t| t.name != "br"));
            if has_markup {
                l.report(
                    "narration-markup",
                    Severity::Warning,
                    slide.range.start + span.range.start,
                    "Narration is text read out loud, formatted in Markdown if at all; remove the HTML inside it (keep its text, separate paragraphs with a blank line).".into(),
                );
            }
        }
    }
}

/// Locked slides the agent changed or removed this turn; the app puts them back after it.
pub(super) fn check_locked(l: &mut Linter, locked: &[html::LockedSlide]) {
    for id in html::changed_locked(l.html, locked) {
        let span = l.slides.iter().find(|s| s.id.as_deref() == Some(&id));
        let (at, message) = match span {
            Some(span) => (
                span.range.start,
                format!(
                    "The slide `{id}` is locked ({LOCKED_ATTR}) but was changed. Undo every \
                     change to it: the user locked it, and the app restores it after your turn."
                ),
            ),
            None => (
                0,
                format!(
                    "The locked slide `{id}` was removed or renamed. Put it back unchanged: \
                     the user locked it, and the app restores it after your turn."
                ),
            ),
        };
        l.report("locked-slide-changed", Severity::Error, at, message);
    }
}

/// Section markers between slides: each needs a title and no content of its own.
pub(super) fn check_sections(l: &mut Linter) {
    for (index, section) in html::find_sections(l.html).iter().enumerate() {
        let at = section.range.start;
        if section.title.is_empty() {
            l.report(
                "section-title-missing",
                Severity::Warning,
                at,
                format!(
                    "Section {} needs a non-empty {SECTION_TITLE_ATTR} attribute.",
                    index + 1
                ),
            );
        }
        if !section.empty {
            l.report(
                "section-marker-content",
                Severity::Warning,
                at,
                "A section marker must be empty: <div class=\"deck-section\" data-title=\"…\"></div>."
                    .into(),
            );
        }
    }
}

/// The app-managed review block (the user's marks on slides): readable, and outside the slides.
pub(super) fn check_review(l: &mut Linter) {
    let html = l.html;
    let Some(at) = html.find(review::START) else {
        return;
    };
    if let Err(problem) = review::parse(html) {
        l.report(
            "review-invalid",
            Severity::Warning,
            at,
            format!(
                "{problem} The slopslide:review block holds the user's review marks and is managed by the app: restore it as it was, or delete the whole block (from its start comment to its end comment) if the user asked to clear the review."
            ),
        );
    }
    if l.slides.iter().any(|s| s.range.contains(&at)) {
        l.report(
            "review-misplaced",
            Severity::Warning,
            at,
            "The slopslide:review block belongs at the end of <body>, outside the slides; move it back there unchanged.".into(),
        );
    }
}

/// The app-managed comments block (what the user wrote about slides): readable, and outside the
/// slides.
pub(super) fn check_comments(l: &mut Linter) {
    let html = l.html;
    let Some(at) = html.find(comments::START) else {
        return;
    };
    if let Err(problem) = comments::parse(html) {
        l.report(
            "comments-invalid",
            Severity::Warning,
            at,
            format!(
                "{problem} The slopslide:comments block holds the user's comments and is managed by the app: restore it as it was, or delete the whole block (from its start comment to its end comment) if the user asked to clear the comments."
            ),
        );
    }
    if l.slides.iter().any(|s| s.range.contains(&at)) {
        l.report(
            "comments-misplaced",
            Severity::Warning,
            at,
            "The slopslide:comments block belongs at the end of <body>, outside the slides; move it back there unchanged.".into(),
        );
    }
}

/// The template `<meta>`: at most one, in `<head>`, naming a template.
pub(super) fn check_template(l: &mut Linter) {
    check_app_meta(
        l,
        html::TEMPLATE_META,
        [
            "template-meta-empty",
            "template-meta-duplicate",
            "template-meta-misplaced",
        ],
        |content| {
            content.is_empty().then(|| {
                format!(
                    "<meta name=\"{}\"> needs the template's id in `content`; remove the tag if the deck follows no template.",
                    html::TEMPLATE_META
                )
            })
        },
    );
}

/// The slide size meta must name a size the app can use (see [`size::SlideSize::parse`]).
pub(super) fn check_slide_size(l: &mut Linter) {
    check_app_meta(
        l,
        size::SIZE_META,
        [
            "slide-size-invalid",
            "slide-size-duplicate",
            "slide-size-misplaced",
        ],
        |content| {
            if SlideSize::parse(content).is_some() {
                return None;
            }
            let problem = if content.is_empty() {
                "is empty".to_string()
            } else {
                format!("\"{}\" is not a usable size", truncate(content, 40))
            };
            Some(format!(
                "<meta name=\"{}\"> {problem}: use WIDTHxHEIGHT in px, in or cm (e.g. 1920x1080, 8.5x11in, 21x29.7cm), {}–{} px a side. Remove it for the default 1920x1080.",
                size::SIZE_META,
                size::MIN_PX,
                size::MAX_PX
            ))
        },
    );
}

/// The narration's provider, voice and language metas must name ones the app has; the voice
/// one the provider has.
pub(super) fn check_narration_settings(l: &mut Linter) {
    let list = |ids: Vec<&str>| ids.join(", ");
    check_app_meta(
        l,
        html::NARRATION_PROVIDER_META,
        [
            "narration-provider-invalid",
            "narration-provider-duplicate",
            "narration-provider-misplaced",
        ],
        |content| {
            narration::Provider::parse(content).is_none().then(|| {
                format!(
                    "<meta name=\"{}\"> names no known narration provider (\"{}\"): use one of {}. Remove it for the default, {}.",
                    html::NARRATION_PROVIDER_META,
                    truncate(content, 40),
                    list(narration::cloud::PROVIDERS.iter().map(|p| p.id()).collect()),
                    narration::DEFAULT_PROVIDER.id(),
                )
            })
        },
    );
    // The voice is checked against the provider the deck names (the default otherwise).
    let provider = narration::provider_of(l.html);
    check_app_meta(
        l,
        html::NARRATION_VOICE_META,
        [
            "narration-voice-invalid",
            "narration-voice-duplicate",
            "narration-voice-misplaced",
        ],
        |content| {
            if provider.accepts_voice(content) {
                return None;
            }
            let choices = match provider {
                narration::Provider::ElevenLabs => format!(
                    "an ElevenLabs voice id (letters and digits, e.g. {})",
                    provider.default_voice()
                ),
                narration::Provider::OpenAi => {
                    list(provider.voices().iter().map(|v| v.id).collect())
                }
            };
            Some(format!(
                "<meta name=\"{}\"> names no voice {} has (\"{}\"): use {}{}. Remove it for the default, {}.",
                html::NARRATION_VOICE_META,
                provider.name(),
                truncate(content, 40),
                if provider == narration::Provider::ElevenLabs { "" } else { "one of " },
                choices,
                provider.default_voice()
            ))
        },
    );
    check_app_meta(
        l,
        html::NARRATION_LANGUAGE_META,
        [
            "narration-language-invalid",
            "narration-language-duplicate",
            "narration-language-misplaced",
        ],
        |content| {
            narration::language(content).is_none().then(|| {
                format!(
                    "<meta name=\"{}\"> names no language the narration can be said in (\"{}\"): use one of {}. Remove it for the default, {}.",
                    html::NARRATION_LANGUAGE_META,
                    truncate(content, 40),
                    list(narration::LANGUAGES.iter().map(|l| l.id).collect()),
                    narration::DEFAULT_LANGUAGE
                )
            })
        },
    );
}

/// An app setting in `<meta name="<name>">`: at most one, in `<head>`, with a `content`
/// that `invalid` accepts (it returns the message for one it rejects). `rules` names the
/// invalid, duplicate and misplaced issues.
fn check_app_meta(
    l: &mut Linter,
    name: &str,
    rules: [&'static str; 3],
    invalid: impl Fn(&str) -> Option<String>,
) {
    let [invalid_rule, duplicate_rule, misplaced_rule] = rules;
    let html = l.html;
    let body = find_ci(html, 0, "<body").unwrap_or(html.len());
    let mut seen = 0;
    let mut from = 0;
    while let Some(at) = find_ci(html, from, "<meta") {
        from = at + 1;
        let Some(tag) = parse_tag(html, at) else {
            continue;
        };
        let named = tag
            .attrs
            .iter()
            .any(|(n, v, _, _)| n == "name" && v.trim().eq_ignore_ascii_case(name));
        if tag.name != "meta" || !named || !in_markup(l, at) {
            continue;
        }
        seen += 1;
        let content = tag
            .attrs
            .iter()
            .find(|(n, _, _, _)| n == "content")
            .map_or("", |(_, v, _, _)| v.trim());
        if let Some(message) = invalid(content) {
            l.report(invalid_rule, Severity::Warning, at, message);
        }
        if seen > 1 {
            l.report(
                duplicate_rule,
                Severity::Warning,
                at,
                format!("Keep only one <meta name=\"{name}\">."),
            );
        }
        if at > body {
            l.report(
                misplaced_rule,
                Severity::Warning,
                at,
                format!("<meta name=\"{name}\"> belongs in <head>."),
            );
        }
    }
}

pub(super) fn is_kebab_case(id: &str) -> bool {
    !id.is_empty()
        && id.split('-').all(|p| {
            !p.is_empty()
                && p.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

/// Images and media: attached files exist, nothing is hotlinked, images have alt text.
pub(super) fn check_assets(l: &mut Linter, asset_exists: impl Fn(&str) -> bool) {
    let html = l.html;
    for (range, path) in html::asset_refs(html) {
        if !asset_exists(path) {
            l.report(
                "missing-asset",
                Severity::Error,
                range.start,
                format!("`{path}` does not exist relative to the deck file."),
            );
        }
    }
    let mut from = 0;
    while let Some(at) = find_ci(html, from, "<img") {
        from = at + 4;
        let Some(tag) = parse_tag(html, at).filter(|t| t.name == "img") else {
            continue;
        };
        if !in_markup(l, at) {
            continue;
        }
        let attr = |name: &str| {
            tag.attrs
                .iter()
                .find(|(n, ..)| n == name)
                .map(|a| a.1.as_str())
        };
        if attr("src").is_some_and(|s| s.starts_with("http://") || s.starts_with("https://")) {
            l.report(
                "remote-image",
                Severity::Warning,
                at,
                "Images should be attached files (assets/…), not hotlinked URLs.".into(),
            );
        }
        if attr("src").is_some_and(|s| {
            let decoded = percent_encoding::percent_decode_str(s).decode_utf8_lossy();
            decoded.split('/').any(|part| part == "..") || decoded.starts_with('/')
        }) {
            l.report("asset-outside-deck", Severity::Error, at,
                "Keep images in assets/ next to the deck file; references outside its folder are not supported.".into());
        }
        if attr("alt").is_none() {
            l.report(
                "img-alt",
                Severity::Warning,
                at,
                "<img> needs an alt attribute (use alt=\"\" for decoration).".into(),
            );
        }
    }
}

/// Links on slides go to web pages, email addresses, or other slides (`#slide-id`, or `#3` for
/// the third slide), which the player shows when they are clicked.
pub(super) fn check_links(l: &mut Linter) {
    let html = l.html;
    let ids: HashSet<String> = l.slides.iter().filter_map(|s| s.id.clone()).collect();
    let count = l.slides.len();
    let mut from = 0;
    while let Some(at) = find_ci(html, from, "<a") {
        from = at + 2;
        let Some(tag) = parse_tag(html, at).filter(|t| t.name == "a" && !t.closing) else {
            continue;
        };
        if !in_markup(l, at) || !l.slides.iter().any(|s| s.range.contains(&at)) {
            continue;
        }
        let Some((_, href, ..)) = tag.attrs.iter().find(|(n, ..)| n == "href") else {
            continue;
        };
        let href = href.trim();
        if href.to_ascii_lowercase().starts_with("javascript:") {
            l.report(
                "script-link",
                Severity::Warning,
                at,
                "Links on slides should go to web pages, email addresses or other slides (`#slide-id`), not run scripts.".into(),
            );
            continue;
        }
        let Some(target) = href.strip_prefix('#') else {
            continue;
        };
        let target = percent_encoding::percent_decode_str(target).decode_utf8_lossy();
        let by_number = target
            .parse::<usize>()
            .is_ok_and(|n| (1..=count).contains(&n));
        if !ids.contains(target.as_ref()) && !by_number {
            l.report(
                "broken-slide-link",
                Severity::Warning,
                at,
                if target.is_empty() {
                    "This link goes nowhere (`href=\"#\"`); point it at a slide (`#slide-id`) or remove it.".into()
                } else {
                    format!("This link goes to the slide `{target}`, but no slide has that id.")
                },
            );
        }
    }
}
