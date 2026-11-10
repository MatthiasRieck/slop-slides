//! Lints a deck file: checks that the markup is well formed (every element closed, no stray
//! end tags) and that it follows the deck format the app and player rely on (see
//! `prompts/system.md`). Keep these rules in sync whenever the deck structure changes.

use std::collections::HashSet;

use serde::Serialize;

use crate::comments;
use crate::html::{
    self, find_ci, has_class, parse_tag, ADDED_ATTR, AUTOFIT_ATTR, DROPPED_ATTR, DURATION_ATTR,
    EDITOR_ATTRS, HIDDEN_ATTR, LOCKED_ATTR, MOVED_ATTR, NARRATION_CLASS, NARRATION_START_ATTR,
    SECTION_CLASS, SECTION_TITLE_ATTR, SHAPE_ATTR, SHAPE_KINDS, TIME_ATTR,
};
use crate::html::{ADJUST_ATTR, HEAD_ATTR, HEAD_KINDS, ROUTES, ROUTE_ATTR};
use crate::narration;
use crate::palette::{self, Place};
use crate::review;
use crate::size::{self, SlideSize};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub rule: &'static str,
    pub severity: Severity,
    pub message: String,
    /// 1-based line in the deck file.
    pub line: usize,
    /// Id of the slide the issue is in, if any.
    pub slide: Option<String>,
}

/// Elements that never have content or an end tag.
const VOID: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];
/// Elements whose end tag HTML lets you leave out.
const OPTIONAL_END: &[&str] = &[
    "html", "head", "body", "p", "li", "dt", "dd", "option", "optgroup", "tr", "td", "th", "thead",
    "tbody", "tfoot", "colgroup", "caption", "rb", "rt", "rtc", "rp",
];
/// Elements whose content is raw text, not markup.
const RAW_TEXT: &[&str] = &["script", "style", "textarea", "title"];
/// Foreign content (SVG, MathML) allows self-closing tags such as `<path/>`.
const FOREIGN: &[&str] = &["svg", "math"];

struct Open {
    name: String,
    at: usize,
}

struct Linter<'a> {
    html: &'a str,
    line_starts: Vec<usize>,
    slides: Vec<html::SlideSpan>,
    issues: Vec<Issue>,
}

impl<'a> Linter<'a> {
    fn new(html: &'a str) -> Self {
        let line_starts = std::iter::once(0)
            .chain(html.match_indices('\n').map(|(i, _)| i + 1))
            .collect();
        Self {
            html,
            line_starts,
            slides: html::find_slides(html),
            issues: Vec::new(),
        }
    }

    fn line(&self, at: usize) -> usize {
        self.line_starts.partition_point(|&s| s <= at)
    }

    fn slide_at(&self, at: usize) -> Option<String> {
        self.slides
            .iter()
            .find(|s| s.range.contains(&at))
            .and_then(|s| s.id.clone())
    }

    fn report(&mut self, rule: &'static str, severity: Severity, at: usize, message: String) {
        self.issues.push(Issue {
            rule,
            severity,
            message,
            line: self.line(at),
            slide: self.slide_at(at),
        });
    }
}

/// Lints a deck. `asset_exists` answers whether a deck-relative `assets/…` path exists;
/// `locked` lists the locked slides as an agent turn started (empty outside a turn), and every
/// one the deck changed or removed is reported. Issues come back sorted by line.
pub fn lint(
    source: &str,
    asset_exists: impl Fn(&str) -> bool,
    locked: &[html::LockedSlide],
) -> Vec<Issue> {
    let mut l = Linter::new(source);
    check_markup(&mut l);
    check_document(&mut l);
    check_slides(&mut l);
    check_narration(&mut l);
    check_slide_id_styles(&mut l);
    check_sections(&mut l);
    check_review(&mut l);
    check_comments(&mut l);
    check_template(&mut l);
    check_slide_size(&mut l);
    check_narration_settings(&mut l);
    check_entrances(&mut l);
    check_tilts(&mut l);
    check_untimed_delays(&mut l);
    check_morphs(&mut l);
    check_stuck_lines(&mut l);
    check_assets(&mut l, asset_exists);
    check_links(&mut l);
    check_palette(&mut l);
    check_locked(&mut l, locked);
    l.issues.sort_by_key(|i| (i.line, i.severity));
    l.issues
}

/// Walks every tag: balance, stray end tags, duplicate attributes, and what sits where.
fn check_markup(l: &mut Linter) {
    let html = l.html;
    let bytes = html.as_bytes();
    let mut stack: Vec<Open> = Vec::new();
    let mut deck_depth: Option<usize> = None; // stack depth of <main class="deck">
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            if let Some(depth) = deck_depth {
                if stack.len() == depth && !bytes[i].is_ascii_whitespace() {
                    let end = html[i..].find('<').map_or(html.len(), |e| i + e);
                    l.report(
                        "deck-stray-content",
                        Severity::Warning,
                        i,
                        format!(
                            "Text \"{}\" sits directly in <main class=\"deck\">; put it inside a slide.",
                            truncate(html[i..end].trim(), 40)
                        ),
                    );
                    i = end;
                    continue;
                }
            }
            i += 1;
            continue;
        }
        if html[i..].starts_with("<!--") {
            match html[i..].find("-->") {
                Some(e) => i += e + 3,
                None => {
                    l.report(
                        "unclosed-comment",
                        Severity::Error,
                        i,
                        "This comment is never closed with -->; everything after it is hidden."
                            .into(),
                    );
                    i = bytes.len();
                }
            }
            continue;
        }
        let next = bytes.get(i + 1).copied().unwrap_or(b' ');
        let looks_like_tag = next.is_ascii_alphabetic() || next == b'/';
        let Some(tag) = parse_tag(html, i) else {
            if looks_like_tag {
                l.report(
                    "unterminated-tag",
                    Severity::Error,
                    i,
                    "This tag is never closed with > (or has an unterminated quote).".into(),
                );
            }
            i += 1;
            continue;
        };
        let self_closing = html[..tag.end].ends_with("/>");

        if !tag.closing {
            let mut seen = HashSet::new();
            for (name, ..) in &tag.attrs {
                if !seen.insert(name.as_str()) {
                    l.report(
                        "duplicate-attribute",
                        Severity::Error,
                        i,
                        format!("<{}> has the attribute `{name}` more than once.", tag.name),
                    );
                }
            }
            if deck_depth == Some(stack.len()) {
                let is_slide = tag.name == "section" && has_class(&tag, "slide");
                let is_marker = tag.name == "div" && has_class(&tag, SECTION_CLASS);
                if !is_slide && !is_marker && !matches!(tag.name.as_str(), "script" | "template") {
                    l.report(
                        "deck-stray-content",
                        Severity::Warning,
                        i,
                        format!(
                            "<{}> sits directly in <main class=\"deck\">; only <section class=\"slide\"> belongs there.",
                            tag.name
                        ),
                    );
                }
            }
            if tag.name == "div"
                && has_class(&tag, SECTION_CLASS)
                && deck_depth != Some(stack.len())
            {
                l.report(
                    "section-marker-misplaced",
                    Severity::Warning,
                    i,
                    "Section markers must be direct children of <main class=\"deck\">, between slides."
                        .into(),
                );
            }
            if tag.name == "section" && has_class(&tag, "slide") && deck_depth != Some(stack.len())
            {
                // Nested slides are content of their parent slide, not slides of their own.
                let nested = l
                    .slides
                    .iter()
                    .any(|s| s.range.start < i && i < s.range.end);
                if !nested {
                    l.report(
                        "slide-outside-deck",
                        Severity::Error,
                        i,
                        "Slides must be direct children of <main class=\"deck\">.".into(),
                    );
                }
            }
            if has_class(&tag, NARRATION_CLASS) {
                // Directly inside a slide: the innermost open element is the slide itself.
                let in_slide = stack
                    .last()
                    .is_some_and(|open| l.slides.iter().any(|s| s.range.start == open.at));
                if tag.name != "aside" || !in_slide {
                    l.report(
                        "narration-misplaced",
                        Severity::Warning,
                        i,
                        "A slide's narration is one <aside class=\"narration\"> placed directly inside its <section class=\"slide\">; move it there.".into(),
                    );
                }
            }
            if l.slides.iter().any(|s| s.range.contains(&i)) {
                if tag.name == "style" {
                    l.report(
                        "style-in-slide",
                        Severity::Warning,
                        i,
                        "Move this <style> into the single <style> in <head>, scoped by a reusable layout class, never the slide id.".into(),
                    );
                }
                if tag.name == "script" {
                    l.report(
                        "script-in-slide",
                        Severity::Warning,
                        i,
                        "Slides should not contain <script>; use CSS for slide visuals.".into(),
                    );
                }
                if let Some((name, ..)) = tag
                    .attrs
                    .iter()
                    .find(|(n, ..)| EDITOR_ATTRS.contains(&n.as_str()))
                {
                    l.report(
                        "editor-leftover",
                        Severity::Warning,
                        i,
                        format!(
                            "<{}> has `{name}`, left over from editing in the app; remove it.",
                            tag.name
                        ),
                    );
                }
                if tag.attrs.iter().any(|(n, ..)| n == DROPPED_ATTR) {
                    l.report(
                        "dropped-image",
                        Severity::Warning,
                        i,
                        format!(
                            "<{}> was dropped onto the slide by hand ({DROPPED_ATTR}, placed on top with inline `position: absolute`, `left`, `top`, `width` and `translate`). Give it a place in the slide's layout where it appears now, sized with the slide's styles, and a fitting alt text, then remove {DROPPED_ATTR}, {MOVED_ATTR} and the inline styles.",
                            tag.name
                        ),
                    );
                } else if tag.attrs.iter().any(|(n, ..)| n == MOVED_ATTR) {
                    l.report(
                        "moved-element",
                        Severity::Warning,
                        i,
                        format!(
                            "<{}> was moved, rotated, tilted or scaled by hand ({MOVED_ATTR} with an inline `translate`, `rotate`, `scale` or tilt `transform`). Rework the slide's layout so it sits where it appears now without the offset, turn a scale into real sizes, keep an intended rotation or tilt in the slide's styles, then remove the attribute and the inline transforms.",
                            tag.name
                        ),
                    );
                }
                if tag
                    .attrs
                    .iter()
                    .any(|(n, ..)| n == "data-resize-placeholder")
                {
                    l.report(
                        "resize-placeholder",
                        Severity::Warning,
                        i,
                        "This invisible, inert placeholder reserves the original layout space of an element the user resized (the one immediately before it) or moved into a group they made (a `data-group` box). Keep the visible element's text, dimensions and position when tidying, fit it into the slide's layout, then remove this entire placeholder and its hidden contents.".into(),
                    );
                }
                if tag
                    .attrs
                    .iter()
                    .any(|(n, ..)| n == "data-delete-placeholder")
                {
                    l.report(
                        "delete-placeholder",
                        Severity::Warning,
                        i,
                        "The user deleted an element here; this invisible, inert copy only holds its empty slot so the rest of the layout did not shift. Do not bring the deleted content back. When tidying, remove this entire placeholder and its hidden contents and rework the surrounding layout so the gap closes cleanly.".into(),
                    );
                }
                if let Some((_, value, ..)) = tag.attrs.iter().find(|(n, ..)| n == AUTOFIT_ATTR) {
                    if !matches!(value.as_str(), "shrink" | "grow") {
                        l.report(
                            "autofit-value",
                            Severity::Warning,
                            i,
                            format!(
                                "`{AUTOFIT_ATTR}=\"{value}\"` means nothing; use \"shrink\" (the text shrinks to fit its box) or \"grow\" (the box grows with its text), or remove it."
                            ),
                        );
                    }
                }
                if let Some((_, value, ..)) = tag.attrs.iter().find(|(n, ..)| n == SHAPE_ATTR) {
                    if !SHAPE_KINDS.contains(&value.as_str()) {
                        l.report(
                            "shape-kind",
                            Severity::Warning,
                            i,
                            format!(
                                "`{SHAPE_ATTR}=\"{value}\"` is not a shape the editor draws ({}), so it cannot restyle, flip or fit this one. Use one of those kinds, or remove the attribute and draw the shape some other way.",
                                SHAPE_KINDS.join(", ")
                            ),
                        );
                    }
                }
                if let Some((_, value, ..)) = tag.attrs.iter().find(|(n, ..)| n == ADJUST_ATTR) {
                    if value.trim().parse::<f64>().map_or(true, |n| !n.is_finite()) {
                        l.report(
                            "shape-adjust",
                            Severity::Warning,
                            i,
                            format!(
                                "`{ADJUST_ATTR}=\"{value}\"` is not a number, so the figure is drawn with its usual proportions. Keep the number the editor wrote, or remove the attribute."
                            ),
                        );
                    }
                }
                if let Some((_, value, ..)) = tag.attrs.iter().find(|(n, ..)| n == HEAD_ATTR) {
                    let words: Vec<_> = value.split_whitespace().collect();
                    let head = matches!(words.as_slice(), [end, kind] if (*end == "start" || *end == "end") && HEAD_KINDS.contains(kind));
                    if !head {
                        l.report(
                            "line-head",
                            Severity::Warning,
                            i,
                            format!(
                                "`{HEAD_ATTR}=\"{value}\"` says nothing the editor can use: it takes the end (`start` or `end`) and the kind of head ({}), like \"end arrow\".",
                                HEAD_KINDS.join(", ")
                            ),
                        );
                    }
                }
                if let Some((_, value, ..)) = tag.attrs.iter().find(|(n, ..)| n == ROUTE_ATTR) {
                    if !ROUTES.contains(&value.as_str()) {
                        l.report(
                            "line-route",
                            Severity::Warning,
                            i,
                            format!(
                                "`{ROUTE_ATTR}=\"{value}\"` is not a route the editor draws ({}); remove it for a line that is straight or curved through its points.",
                                ROUTES.join(", ")
                            ),
                        );
                    }
                }
                if let Some((_, value, ..)) = tag.attrs.iter().find(|(n, ..)| n == ADDED_ATTR) {
                    let what = match value.as_str() {
                        "text" => "text box",
                        "shape" => "shape",
                        "drawing" => "drawing",
                        _ => "element",
                    };
                    l.report(
                        "added-element",
                        Severity::Warning,
                        i,
                        format!(
                            "This {what} was added by hand ({ADDED_ATTR}, absolutely positioned with inline styles). Keep it where it appears now, but give it a class and move its styles into the slide's rules (fitting it into the layout where that is cleaner), then remove the attribute."
                        ),
                    );
                }
            }
        }

        let in_foreign = stack.iter().any(|o| FOREIGN.contains(&o.name.as_str()));
        if tag.closing {
            close(l, &mut stack, &tag.name, i);
            if deck_depth.is_some_and(|d| stack.len() < d) {
                deck_depth = None;
            }
        } else if VOID.contains(&tag.name.as_str()) {
            // No content, no end tag.
        } else if self_closing {
            if !in_foreign && !FOREIGN.contains(&tag.name.as_str()) {
                l.report(
                    "self-closing-tag",
                    Severity::Error,
                    i,
                    format!(
                        "<{0}/> does not close the element in HTML; write <{0}></{0}>.",
                        tag.name
                    ),
                );
                // Browsers ignore the slash, so the element stays open.
                stack.push(Open {
                    name: tag.name.clone(),
                    at: i,
                });
            }
        } else {
            // Opening a <p> or <li> implicitly ends a previous one.
            if OPTIONAL_END.contains(&tag.name.as_str())
                && stack.last().is_some_and(|o| o.name == tag.name)
            {
                stack.pop();
            }
            if tag.name == "main" && has_class(&tag, "deck") && deck_depth.is_none() {
                deck_depth = Some(stack.len() + 1);
            }
            stack.push(Open {
                name: tag.name.clone(),
                at: i,
            });
            if RAW_TEXT.contains(&tag.name.as_str()) {
                i = find_ci(html, tag.end, &format!("</{}", tag.name)).unwrap_or(bytes.len());
                continue;
            }
        }
        i = tag.end;
    }
    for open in stack.into_iter().rev() {
        if !OPTIONAL_END.contains(&open.name.as_str()) {
            l.report(
                "unclosed-tag",
                Severity::Error,
                open.at,
                format!("<{}> is never closed.", open.name),
            );
        }
    }
}

fn close(l: &mut Linter, stack: &mut Vec<Open>, name: &str, at: usize) {
    let Some(pos) = stack.iter().rposition(|o| o.name == name) else {
        if !VOID.contains(&name) {
            l.report(
                "stray-end-tag",
                Severity::Error,
                at,
                format!("</{name}> has no matching <{name}>."),
            );
        }
        return;
    };
    let closed: Vec<Open> = stack.drain(pos..).collect();
    for open in closed.into_iter().skip(1).rev() {
        if !OPTIONAL_END.contains(&open.name.as_str()) {
            let message = format!(
                "<{}> is never closed (</{name}> on line {} ends it implicitly).",
                open.name,
                l.line(at)
            );
            l.report("unclosed-tag", Severity::Error, open.at, message);
        }
    }
}

/// Document-level structure: doctype, title, deck container, runtime blocks.
fn check_document(l: &mut Linter) {
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
fn check_morphs(l: &mut Linter) {
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
fn check_stuck_lines(l: &mut Linter) {
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
fn check_slides(l: &mut Linter) {
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

/// The slides whose narration has to wait for an earlier slide's, still playing over them (see
/// [`crate::narration::timeline::overlaps`]), as issues of `source`.
pub fn narration_overlaps(
    source: &str,
    overlaps: &[crate::narration::timeline::Overlap],
) -> Vec<Issue> {
    let mut l = Linter::new(source);
    let slides = l.slides.clone();
    for overlap in overlaps {
        let Some(span) = slides
            .iter()
            .find(|s| s.id.as_deref() == Some(&overlap.slide))
        else {
            continue;
        };
        let (slide, under, waits) = (&overlap.slide, &overlap.under, overlap.waits);
        let late = if overlap.after_end {
            ", after the slide stopped showing"
        } else {
            ""
        };
        l.report(
            "narration-overlap",
            Severity::Warning,
            span.range.start,
            format!(
                "The narration audio of slide `{under}` still plays when slide `{slide}`'s own narration is to start, so that waits {waits:.1} s{late}. Audio that plays on over later slides leaves them without narration of their own: remove theirs (script and audio), or end `{under}`'s audio sooner."
            ),
        );
    }
    l.issues
}

/// Narration: one `<aside class="narration">` of Markdown text per slide, no HTML in it.
fn check_narration(l: &mut Linter) {
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
fn check_locked(l: &mut Linter, locked: &[html::LockedSlide]) {
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
fn check_sections(l: &mut Linter) {
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
fn check_review(l: &mut Linter) {
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
fn check_comments(l: &mut Linter) {
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
fn check_template(l: &mut Linter) {
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
fn check_slide_size(l: &mut Linter) {
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
fn check_narration_settings(l: &mut Linter) {
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

fn is_kebab_case(id: &str) -> bool {
    !id.is_empty()
        && id.split('-').all(|p| {
            !p.is_empty()
                && p.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

/// Images and media: attached files exist, nothing is hotlinked, images have alt text.
fn check_assets(l: &mut Linter, asset_exists: impl Fn(&str) -> bool) {
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
fn check_links(l: &mut Linter) {
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

/// Slide ids are identity, not styling hooks: copies get new ids but retain classes.
fn check_slide_id_styles(l: &mut Linter) {
    let ids: HashSet<_> = l.slides.iter().filter_map(|s| s.id.as_deref()).collect();
    let mut references = Vec::new();
    let mut from = 0;
    while let Some(open) = find_ci(l.html, from, "<style") {
        let Some(tag) = parse_tag(l.html, open) else {
            break;
        };
        let end = find_ci(l.html, tag.end, "</style").unwrap_or(l.html.len());
        from = end;
        if tag.name != "style" || !in_markup(l, open) {
            continue;
        }
        let mut input = cssparser::ParserInput::new(&l.html[tag.end..end]);
        let mut parser = cssparser::Parser::new(&mut input);
        let mut found = Vec::new();
        css_id_references(&mut parser, &mut found);
        references.extend(
            found
                .into_iter()
                .filter(|(_, id)| ids.contains(id.as_str()))
                .map(|(at, id)| (tag.end + at, id)),
        );
    }
    for (at, id) in references {
        l.issues.push(Issue {
            rule: "slide-id-style",
            severity: Severity::Error,
            message: format!("CSS targets slide id `{id}`; copying the slide changes its id and breaks these styles. Add a reusable layout class to the slide and replace its id-based selectors with that class, preserving its appearance and keeping its id for tracking."),
            line: l.line(at),
            slide: Some(id),
        });
    }
}

/// Every color comes from the palette (`:root` custom properties), so changing the palette
/// recolors the whole deck. One issue per line, listing the colors written out on it.
fn check_palette(l: &mut Linter) {
    let colors = palette::palette(l.html);
    for color in &colors {
        if palette::is_placeholder_name(&color.name) {
            let name = &color.name;
            l.report(
                "palette-name",
                Severity::Warning,
                color.range.start,
                format!("Palette color `--{name}` was added in the editor for a color picked by hand. Rename it for what it is used for (such as `--highlight` or `--chart-2`, or reuse a palette color that fits) and update every `var(--{name})`."),
            );
        }
    }
    let mut groups: Vec<(usize, Place, Vec<String>)> = Vec::new();
    for literal in palette::literals(l.html) {
        let text = l.html[literal.range.clone()].to_string();
        let line = l.line(literal.range.start);
        match groups.last_mut() {
            Some((at, place, texts)) if l.line(*at) == line && *place == literal.place => {
                if !texts.contains(&text) {
                    texts.push(text)
                }
            }
            _ => groups.push((literal.range.start, literal.place, vec![text])),
        }
    }
    for (at, place, texts) in groups {
        let listed = texts
            .iter()
            .map(|t| format!("`{}`", truncate(t, 40)))
            .collect::<Vec<_>>()
            .join(", ");
        let matches: Vec<String> = texts
            .iter()
            .filter_map(|t| {
                let n = palette::normalize(t);
                colors
                    .iter()
                    .find(|c| palette::normalize(&c.value) == n)
                    .map(|c| format!("`{t}` is `var(--{})`", c.name))
            })
            .collect();
        let hint = if matches.is_empty() {
            String::new()
        } else {
            format!(" In the palette: {}.", matches.join(", "))
        };
        let how = match place {
            Place::Attribute(attr) => format!(" Presentation attributes do not take `var()`: set it as `style=\"{attr}: var(--name)\"` instead, or use `currentColor`."),
            _ => String::new(),
        };
        l.report(
            "palette-color",
            Severity::Warning,
            at,
            format!("{} {listed} {} written out instead of coming from the deck's palette, so changing the palette will not reach it.{hint}{how} Refer to a palette color with `var(--name)`, add a new one to `:root` under a name that says what it is for, and mix see-through or lighter shades from the palette: `color-mix(in srgb, var(--accent) 30%, transparent)`.",
                if texts.len() == 1 { "Color" } else { "Colors" },
                if texts.len() == 1 { "is" } else { "are" }),
        );
    }
}

/// Tokenize rather than search text: comments, strings, URL fragments and declaration
/// colors must not count as selectors. Pending references become selectors only when
/// followed by a rule block; recurse into grouping rules and CSS nesting as well.
fn css_id_references<'i>(
    parser: &mut cssparser::Parser<'i, '_>,
    found: &mut Vec<(usize, String)>,
) -> Vec<(usize, String)> {
    use cssparser::Token;
    let mut pending = Vec::new();
    let mut at_rule = false;
    loop {
        let at = parser.position().byte_index();
        let Ok(token) = parser.next_including_whitespace_and_comments().cloned() else {
            break;
        };
        match token {
            Token::AtKeyword(name) => at_rule = !name.eq_ignore_ascii_case("scope"),
            Token::IDHash(id) => pending.push((at, id.to_string())),
            Token::Semicolon => {
                pending.clear();
                at_rule = false;
            }
            Token::CurlyBracketBlock => {
                if at_rule {
                    pending.clear();
                }
                at_rule = false;
                found.append(&mut pending);
                let _: Result<_, cssparser::ParseError<'i, ()>> = parser.parse_nested_block(|p| {
                    css_id_references(p, found);
                    Ok(())
                });
            }
            Token::Function(_) | Token::ParenthesisBlock => {
                let _: Result<_, cssparser::ParseError<'i, ()>> = parser.parse_nested_block(|p| {
                    pending.extend(css_id_references(p, found));
                    Ok(())
                });
            }
            Token::SquareBracketBlock => {
                let _: Result<_, cssparser::ParseError<'i, ()>> = parser.parse_nested_block(|p| {
                    // [id="title"] is just as dependent on identity as #title.
                    if p.expect_ident_matching("id").is_ok() && p.expect_delim('=').is_ok() {
                        if let Ok(Token::Ident(id) | Token::QuotedString(id)) = p.next() {
                            pending.push((at, id.to_string()));
                        }
                    }
                    // Consume flags / other attribute selectors without treating their
                    // values as CSS id selectors.
                    while p.next().is_ok() {}
                    Ok(())
                });
            }
            _ => {}
        }
    }
    pending
}

/// Entrance keyframes (those a `.reveal` rule animates with) must not animate `transform`:
/// held by `both` fill, it would replace each element's own transform and tilt.
fn check_entrances(l: &mut Linter) {
    let mut from = 0;
    while let Some(open) = find_ci(l.html, from, "<style") {
        let Some(start) = l.html[open..].find('>').map(|i| open + i + 1) else {
            break;
        };
        let end = find_ci(l.html, start, "</style").unwrap_or(l.html.len());
        from = end;
        if !in_markup(l, open) {
            continue;
        }
        let css = &l.html[start..end];
        for (at, name) in transform_keyframes(css) {
            if animates_reveal(css, name) {
                l.report(
                    "entrance-transform",
                    Severity::Warning,
                    start + at,
                    format!(
                        "@keyframes {name} animates `transform` for a `.reveal` entrance, which overrides the elements' own transforms and hand edits. Animate `translate`, `scale`, or `rotate` instead and leave them out of the last frame."
                    ),
                );
            }
        }
    }
}

/// The steepest a 3D tilt (rotateX/rotateY) draws about right in exports, PDFs and renders.
const STEEPEST_TILT: f64 = 45.0;

/// The shortest animation delay taken to time something to its slide, in seconds.
const TIMED_DELAY: f64 = 1.0;

/// Animations delayed to time them (by [`TIMED_DELAY`] or more, or by a `var()` or `calc()`) in
/// rules not under `.active`: such an animation starts when the page loads, so in the show and
/// in video exports its delay counts from then rather than from when its slide shows, and what
/// it is timed to has long passed. A loop that runs whatever slide shows has no such delay.
fn check_untimed_delays(l: &mut Linter) {
    let html = l.html;
    let easings = easing_vars(html);
    let mut from = 0;
    while let Some(open) = find_ci(html, from, "<style") {
        let Some(start) = html[open..].find('>').map(|i| open + i + 1) else {
            break;
        };
        let end = find_ci(html, start, "</style").unwrap_or(html.len());
        from = end;
        if !in_markup(l, open) {
            continue;
        }
        for (at, selector) in untimed_delays(&html[start..end], &easings) {
            l.report(
                "untimed-animation-delay",
                Severity::Warning,
                start + at,
                format!(
                    "`{}` delays an animation to time it, but the rule is not under `.active`: the animation starts when the deck loads, so in the show and video exports its delay counts from then, not from when its slide shows. Put it under `.slide.active` (as `.slide.active .word {{ animation: … var(--at) both; }}`), so it starts as the slide shows.",
                    truncate(selector.trim(), 80)
                ),
            );
        }
    }
}

/// The rules of `css` (outside `@keyframes`) that delay an animation to time it without being
/// under `.active`: where each starts, and its selector. `easings` are custom properties that
/// hold an easing, not a time.
fn untimed_delays<'a>(css: &'a str, easings: &HashSet<&str>) -> Vec<(usize, &'a str)> {
    let mut found = Vec::new();
    let bytes = css.as_bytes();
    // Where the text since the last rule (a selector or an at-rule's prelude) starts.
    let mut head = 0;
    // A rule's declarations are skipped whole, so the scan only ever is between rules here.
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i = css[i + 2..]
                    .find("*/")
                    .map_or(bytes.len(), |e| i + 2 + e + 2);
                head = i;
                continue;
            }
            // A statement at-rule (`@import url(…);`) ends before the next rule.
            b';' => head = i + 1,
            b'{' => {
                let prelude = css[head..i].trim();
                if prelude.starts_with("@keyframes") || prelude.starts_with("@-webkit-keyframes") {
                    // Skip the whole block: its "rules" are keyframes.
                    let mut depth = 0;
                    while i < bytes.len() {
                        match bytes[i] {
                            b'{' => depth += 1,
                            b'}' => {
                                depth -= 1;
                                if depth == 0 {
                                    break;
                                }
                            }
                            _ => {}
                        }
                        i += 1;
                    }
                    head = i + 1;
                } else if prelude.starts_with('@') {
                    head = i + 1;
                } else {
                    let body_end = css[i..].find('}').map_or(css.len(), |e| i + e);
                    let body = &css[i + 1..body_end];
                    let selector = &css[head..i];
                    let ungated = selector.split(',').any(|part| !part.contains(".active"));
                    if ungated && delays_to_time(body, easings) {
                        let lead = selector.len() - selector.trim_start().len();
                        found.push((head + lead, selector));
                    }
                    i = body_end;
                    head = i + 1;
                }
            }
            b'}' => head = i + 1,
            _ => {}
        }
        i += 1;
    }
    found
}

/// Whether `declarations` delay an animation by [`TIMED_DELAY`] or more, or by a `var()` or
/// `calc()` (as times set per element are): in `animation-delay`, or as the second time of the
/// `animation` shorthand, where a `var()` of one of the `easings` is the easing, not a time.
fn delays_to_time(declarations: &str, easings: &HashSet<&str>) -> bool {
    let easing = |word: &str| {
        word.strip_prefix("var(")
            .and_then(|rest| rest.split([',', ')']).next())
            .is_some_and(|name| easings.contains(name.trim()))
    };
    let timed = |value: &str| {
        let value = value.trim();
        value.starts_with("var(")
            || value.starts_with("calc(")
            || seconds(value).is_some_and(|s| s >= TIMED_DELAY)
    };
    declarations.split(';').any(|declaration| {
        let Some((name, value)) = declaration.split_once(':') else {
            return false;
        };
        let value = value.trim().trim_end_matches("!important").trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "animation-delay" => value.split(',').any(timed),
            "animation" => value.split(',').any(|one| {
                // The first time is the duration, the second the delay.
                let times: Vec<&str> = css_words(one)
                    .into_iter()
                    .filter(|w| {
                        seconds(w).is_some()
                            || (w.starts_with("var(") && !easing(w))
                            || w.starts_with("calc(")
                    })
                    .collect();
                times.get(1).is_some_and(|delay| timed(delay))
            }),
            _ => false,
        }
    })
}

/// Custom properties `html` sets to an easing (`--spring: cubic-bezier(…)`), in its styles or
/// inline: in the `animation` shorthand such a `var()` sits where a delay may, but is none.
fn easing_vars(html: &str) -> HashSet<&str> {
    let mut found = HashSet::new();
    for (at, _) in html.match_indices("--") {
        let rest = &html[at..];
        let name_end = rest[2..]
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
            .map_or(rest.len(), |e| e + 2);
        let Some(value) = rest[name_end..].trim_start().strip_prefix(':') else {
            continue;
        };
        let value = value.trim_start().to_ascii_lowercase();
        let easing = [
            "cubic-bezier(",
            "steps(",
            "linear(",
            "ease",
            "step-start",
            "step-end",
        ]
        .iter()
        .any(|start| value.starts_with(start));
        if easing && name_end > 2 {
            found.insert(&rest[..name_end]);
        }
    }
    found
}

/// The words of a CSS value, a function call with its arguments being one.
fn css_words(value: &str) -> Vec<&str> {
    let mut words = Vec::new();
    let (mut depth, mut start) = (0, None);
    for (i, c) in value.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            c if c.is_whitespace() && depth == 0 => {
                if let Some(s) = start.take() {
                    words.push(&value[s..i]);
                }
                continue;
            }
            _ => {}
        }
        start.get_or_insert(i);
    }
    if let Some(s) = start {
        words.push(&value[s..]);
    }
    words
}

/// A CSS time in seconds: `s` or `ms`; None for anything else.
fn seconds(time: &str) -> Option<f64> {
    let time = time.trim().to_ascii_lowercase();
    if let Some(ms) = time.strip_suffix("ms") {
        return ms.parse::<f64>().ok().map(|ms| ms / 1000.0);
    }
    time.strip_suffix('s')?.parse().ok()
}

/// 3D tilts steeper than [`STEEPEST_TILT`] in the deck's styles: WebKit draws a page off screen
/// (video and image exports, PDFs, `render_slide`) with perspective flattened, so a steep tilt
/// comes out sheared and squashed, or as a thin line, though the editor shows it right. The
/// user's own tilts (on `data-moved` elements) are theirs.
fn check_tilts(l: &mut Linter) {
    let html = l.html;
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(open) = find_ci(html, from, "<style") {
        let Some(start) = html[open..].find('>').map(|i| open + i + 1) else {
            break;
        };
        let end = find_ci(html, start, "</style").unwrap_or(html.len());
        from = end;
        if in_markup(l, open) {
            found.extend(
                steep_tilts(&html[start..end])
                    .into_iter()
                    .map(|(at, deg)| (start + at, deg)),
            );
        }
    }
    for (at, _) in html.match_indices("style=\"") {
        let value_end = html[at + 7..].find('"').map_or(html.len(), |e| at + 7 + e);
        // Nearly no style tilts, so the costlier checks below run only for one that does.
        let tilts = steep_tilts(&html[at + 7..value_end]);
        if tilts.is_empty() {
            continue;
        }
        // The whole tag: the editor writes `data-moved` after the style it sets.
        let tag_start = html[..at].rfind('<').unwrap_or(at);
        let tag_end = html[value_end..]
            .find('>')
            .map_or(html.len(), |e| value_end + e);
        let moved = html[tag_start..tag_end]
            .split(|c: char| c.is_whitespace() || c == '=' || c == '"')
            .any(|word| word == MOVED_ATTR);
        if moved || !in_markup(l, at) {
            continue;
        }
        found.extend(tilts.into_iter().map(|(i, deg)| (at + 7 + i, deg)));
    }
    for (at, degrees) in found {
        l.report(
            "steep-3d-tilt",
            Severity::Warning,
            at,
            format!(
                "A 3D tilt of {degrees:.0}° shows right in the editor, but video and image exports, PDFs and render_slide draw perspective flattened: past about {STEEPEST_TILT:.0}° it comes out sheared and squashed, or as a thin line. Draw depth in 2D instead (a trapezoid with clip-path, rows that widen toward the viewer, scale), or keep the tilt within {STEEPEST_TILT:.0}°."
            ),
        );
    }
}

/// Where `css` tilts something in 3D by more than [`STEEPEST_TILT`], and by how much, in degrees.
fn steep_tilts(css: &str) -> Vec<(usize, f64)> {
    let lower = css.to_ascii_lowercase();
    let mut found = Vec::new();
    for function in ["rotatex(", "rotatey(", "rotate3d("] {
        for (at, _) in lower.match_indices(function) {
            let args = &lower[at + function.len()..];
            let Some(close) = args.find(')') else {
                continue;
            };
            // rotate3d(x, y, z, angle) tilts in 3D unless it turns about z alone.
            let args = &args[..close];
            let angle = if function == "rotate3d(" {
                let parts: Vec<&str> = args.split(',').map(str::trim).collect();
                let flat =
                    parts.len() == 4 && parts[..2].iter().all(|p| p.parse::<f64>() == Ok(0.0));
                if parts.len() != 4 || flat {
                    continue;
                }
                parts[3]
            } else {
                args.trim()
            };
            if let Some(degrees) = degrees(angle).filter(|d| {
                d.abs() % 180.0 > STEEPEST_TILT && d.abs() % 180.0 < 180.0 - STEEPEST_TILT
            }) {
                found.push((at, degrees.abs()));
            }
        }
    }
    found.sort_by_key(|(at, _)| *at);
    found
}

/// A CSS angle in degrees: `deg`, `rad`, `grad` or `turn`; None for anything else (a `var()`).
fn degrees(angle: &str) -> Option<f64> {
    let angle = angle.trim();
    let split = angle.find(|c: char| c.is_ascii_alphabetic())?;
    let value: f64 = angle[..split].trim().parse().ok()?;
    Some(match &angle[split..] {
        "deg" => value,
        "rad" => value.to_degrees(),
        "grad" => value * 0.9,
        "turn" => value * 360.0,
        _ => return None,
    })
}

/// `@keyframes` blocks in `css` that set `transform`: where each starts, and its name.
fn transform_keyframes(css: &str) -> Vec<(usize, &str)> {
    let mut found = Vec::new();
    for (at, _) in css.match_indices("@keyframes") {
        let rest = &css[at + "@keyframes".len()..];
        let Some(brace) = rest.find('{') else {
            continue;
        };
        let name = rest[..brace].trim();
        let mut depth = 0;
        let body_end = rest[brace..]
            .char_indices()
            .find_map(|(i, c)| {
                match c {
                    '{' => depth += 1,
                    '}' => depth -= 1,
                    _ => {}
                }
                (depth == 0).then_some(brace + i)
            })
            .unwrap_or(rest.len());
        if !name.is_empty() && sets_property(&rest[brace..body_end], "transform") {
            found.push((at, name));
        }
    }
    found
}

/// Whether `css` declares `property` itself (not, say, `text-transform` or `transform-origin`).
fn sets_property(css: &str, property: &str) -> bool {
    css.match_indices(property).any(|(i, _)| {
        let before = css[..i].chars().next_back();
        let after = css[i + property.len()..].trim_start();
        !before.is_some_and(|c| c.is_ascii_alphanumeric() || c == '-') && after.starts_with(':')
    })
}

/// Whether a rule whose selector mentions `.reveal` uses the keyframes `name`.
fn animates_reveal(css: &str, name: &str) -> bool {
    css.match_indices(name).any(|(i, _)| {
        let word =
            |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if word(css[..i].chars().next_back()) || word(css[i + name.len()..].chars().next()) {
            return false;
        }
        let Some(open) = css[..i].rfind('{') else {
            return false;
        };
        let selector_start = css[..open].rfind('}').map_or(0, |b| b + 1);
        let selector = &css[selector_start..open];
        !selector.contains("@keyframes")
            && selector.contains(".reveal")
            && css[open..i].find('}').is_none()
    })
}

/// Whether `at` is in markup rather than inside a comment, script, or style.
fn in_markup(l: &Linter, at: usize) -> bool {
    let before = &l.html[..at];
    let lower = before.to_ascii_lowercase();
    let open_comment = before
        .rfind("<!--")
        .is_some_and(|c| before[c..].find("-->").is_none());
    let raw = ["script", "style"].iter().any(|t| {
        lower
            .rfind(&format!("<{t}"))
            .is_some_and(|o| lower[o..].find(&format!("</{t}")).is_none())
    });
    !open_comment && !raw
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    format!("{}…", text.chars().take(max).collect::<String>())
}

/// Plain-text report for the agent's lint tool.
pub fn format_report(issues: &[Issue]) -> String {
    if issues.is_empty() {
        return "The deck passes lint: no issues.".into();
    }
    let errors = issues
        .iter()
        .filter(|i| i.severity == Severity::Error)
        .count();
    let warnings = issues.len() - errors;
    let mut out = format!("The deck has {errors} error(s) and {warnings} warning(s):\n");
    for issue in issues {
        let severity = match issue.severity {
            Severity::Error => "error",
            Severity::Warning => "warning",
        };
        let slide = issue
            .slide
            .as_ref()
            .map(|s| format!(" (slide `{s}`)"))
            .unwrap_or_default();
        out.push_str(&format!(
            "- line {} {severity} [{}]{slide}: {}\n",
            issue.line, issue.rule, issue.message
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUNTIME: &str = "<!-- slopslide:runtime-css (managed by SlopSlide, do not edit) -->\
        <!-- slopslide:runtime-js (managed by SlopSlide, do not edit) -->";

    fn deck(body: &str) -> String {
        format!(
            "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<title>Talk</title>\n{RUNTIME}\n<style>.slide {{}}</style>\n</head>\n<body>\n<main class=\"deck\">\n{body}\n</main>\n</body>\n</html>\n"
        )
    }

    fn rules(html: &str) -> Vec<&'static str> {
        lint(html, |p| p == "assets/logo.png", &[])
            .into_iter()
            .map(|i| i.rule)
            .collect()
    }

    #[test]
    fn stuck_lines_name_an_element_on_their_slide_and_a_spot_on_it() {
        let line = |attrs: &str| {
            format!(r#"<svg {attrs} viewBox="0 0 10 10"><path d="M0 0 L10 10"/></svg>"#)
        };
        let clean = deck(&format!(
            r#"<section class="slide" id="a"><div id="box"></div><div id="other"></div>{}</section>"#,
            line(
                r#"data-from="box" data-from-at="50% 100%" data-to="other" data-to-at="0% 25.5% edge""#
            )
        ));
        let issues = lint(&clean, |_| true, &[]);
        assert!(
            !issues.iter().any(|i| i.rule.starts_with("stuck-line")),
            "{issues:?}"
        );

        let broken = deck(&format!(
            r#"<section class="slide" id="a"><div id="box"></div>{}{}{}{}{}</section><section class="slide" id="b"><div id="far"></div></section>"#,
            line(r#"data-to="far" data-to-at="50% 100%""#),
            line(r#"data-from-at="50% 50%""#),
            line(r#"data-to="here" data-to-at="center""#),
            line(r#"data-to="box" data-to-at="50% 100% border""#),
            line(r#"data-to="box" data-to-at="edge 50% 100%""#),
        ));
        let issues = lint(&broken, |_| true, &[]);
        let count = |rule| issues.iter().filter(|i| i.rule == rule).count();
        // `far` is on another slide, and `here` on none.
        assert_eq!(count("stuck-line-target"), 2);
        // `data-from-at` alone, `center` is no spot, and only `edge` may follow one, after it.
        assert_eq!(count("stuck-line-anchor"), 4);
        assert!(issues
            .iter()
            .filter(|i| i.rule.starts_with("stuck-line"))
            .all(|i| i.slide.as_deref() == Some("a")));
    }

    #[test]
    fn morph_names_are_valid_and_unique_per_slide() {
        let source = deck(
            r#"<section class="slide" id="a"><img data-morph="hero" alt=""><div data-morph="hero"></div><p data-morph="Bad name">X</p></section><section class="slide" id="b"><img data-morph="hero" alt=""></section>"#,
        );
        let issues = lint(&source, |_| true, &[]);
        assert_eq!(
            issues
                .iter()
                .filter(|i| i.rule == "morph-duplicate")
                .count(),
            1
        );
        assert_eq!(issues.iter().filter(|i| i.rule == "morph-name").count(), 1);
    }

    #[test]
    fn the_hero_morph_example_in_the_design_reference_is_clean() {
        let reference = include_str!("../prompts/design-reference.md");
        let section = &reference[reference.find("## Hero Morphs").unwrap()..];
        let start = section.find("```html\n").unwrap() + "```html\n".len();
        let example = &section[start..start + section[start..].find("```").unwrap()];
        let (style, slides) = example.split_at(example.find("<section").unwrap());
        let html = deck(slides).replace("<style>.slide {}</style>", style.trim());
        assert_eq!(
            lint(&html, |_| true, &[])
                .into_iter()
                .map(|i| i.rule)
                .collect::<Vec<_>>(),
            Vec::<&str>::new()
        );
        assert_eq!(example.matches(r#"data-morph="orbit""#).count(), 3);
    }

    #[test]
    fn a_clean_deck_passes() {
        let html = deck(
            r#"<section class="slide" id="intro">
  <h1 class="reveal">Hi</h1>
  <p>Unclosed paragraphs are fine<p>and so is this
  <ul><li>one<li>two</ul>
  <img src="assets/logo.png" alt="Logo"><br>
  <svg viewBox="0 0 10 10"><path d="M0 0"/><circle r="1" /></svg>
  <aside class="notes">Say hi</aside>
</section>
<!-- <div> commented out -->
<section class="slide" id="plan-2025" data-hidden><p>Plan</p></section>"#,
        );
        assert_eq!(lint(&html, |p| p == "assets/logo.png", &[]), vec![]);
    }

    fn stroke() -> review::Stroke {
        review::Stroke {
            tool: review::InkTool::Pen,
            color: "#ef4444".into(),
            points: vec![[0.5, 0.5]],
        }
    }

    fn commented() -> String {
        let comment = comments::Comment {
            id: "first".into(),
            text: "Bigger".into(),
            x: 0.5,
            y: 0.5,
            target: None,
            area: None,
        };
        let on_area = comments::Comment {
            id: "second".into(),
            text: "Too crowded".into(),
            area: Some(comments::Area {
                shape: comments::Shape::Lasso,
                points: vec![[0.1, 0.1], [0.5, 0.1], [0.3, 0.4]],
            }),
            ..comment.clone()
        };
        comments::write(
            &deck(r#"<section class="slide" id="intro"><p>Hi</p></section>"#),
            &[("intro".to_string(), vec![comment, on_area])].into(),
        )
    }

    #[test]
    fn accepts_comments() {
        let html = commented();
        assert!(html.contains(comments::START));
        assert_eq!(rules(&html), Vec::<&str>::new());
    }

    #[test]
    fn flags_damaged_or_misplaced_comments() {
        let html = commented();
        assert_eq!(
            rules(&html.replace("\"Bigger\"", "\"\"")),
            ["comments-invalid"]
        );
        assert_eq!(
            rules(&html.replace(comments::END, "")),
            ["comments-invalid"]
        );
        assert_eq!(
            rules(&html.replace("\"lasso\"", "\"blob\"")),
            ["comments-invalid"]
        );
        let block = &html[comments::block_range(&html).unwrap()];
        let inside = deck(&format!(
            r#"<section class="slide" id="intro"><p>Hi</p>{block}</section>"#
        ));
        let found = rules(&inside);
        assert!(found.contains(&"comments-misplaced"), "{found:?}");
    }

    #[test]
    fn accepts_review_marks() {
        let marks = [("intro".to_string(), vec![stroke()])].into();
        let html = review::write(
            &deck(r#"<section class="slide" id="intro"><p>Hi</p></section>"#),
            &marks,
        );
        assert!(html.contains(review::START));
        assert_eq!(rules(&html), Vec::<&str>::new());
    }

    #[test]
    fn flags_damaged_or_misplaced_review_marks() {
        let marks = [("intro".to_string(), vec![stroke()])].into();
        let html = review::write(
            &deck(r#"<section class="slide" id="intro"><p>Hi</p></section>"#),
            &marks,
        );
        assert_eq!(rules(&html.replace("#ef4444", "red")), ["review-invalid"]);
        assert_eq!(rules(&html.replace(review::END, "")), ["review-invalid"]);
        let block = &html[review::block_range(&html).unwrap()];
        let inside = deck(&format!(
            r#"<section class="slide" id="intro"><p>Hi</p>{block}</section>"#
        ));
        let found = rules(&inside);
        assert!(found.contains(&"review-misplaced"), "{found:?}");
        let issue = lint(&html.replace("[[", "["), |_| true, &[]).remove(0);
        assert_eq!(
            issue.line,
            html[..html.find(review::START).unwrap()].lines().count()
        );
    }

    #[test]
    fn the_app_templates_pass() {
        let template = include_str!("../assets/deck-template.html").replace("{{TITLE}}", "Talk");
        let blank = include_str!("../assets/blank-slide.html").replace("{{ID}}", "untitled");
        let with_slide = template.replace(
            "<main class=\"deck\">",
            &format!("<main class=\"deck\">\n    {blank}"),
        );
        let html = html::ensure_runtime(&with_slide);
        assert_eq!(rules(&html), Vec::<&str>::new());
    }

    #[test]
    fn accepts_the_player_flag_script_in_the_runtime_css_block() {
        let html = html::ensure_runtime(&deck(
            r#"<section class="slide" id="intro"><p>Hi</p></section>"#,
        ));
        let head = &html[..html.find("</head>").unwrap()];
        assert!(
            head.contains(html::PLAYER_FLAG),
            "flag script sits in <head>"
        );
        assert_eq!(rules(&html), Vec::<&str>::new());
    }

    #[test]
    fn reports_unclosed_and_stray_tags_with_lines() {
        let html =
            deck("<section class=\"slide\" id=\"a\">\n<div><span>x</div>\n</section>\n</em>");
        let issues = lint(&html, |_| true, &[]);
        let unclosed = issues.iter().find(|i| i.rule == "unclosed-tag").unwrap();
        assert!(unclosed.message.contains("<span>"));
        assert_eq!(unclosed.line, 11);
        assert_eq!(unclosed.slide.as_deref(), Some("a"));
        let stray = issues.iter().find(|i| i.rule == "stray-end-tag").unwrap();
        assert!(stray.message.contains("</em>"));
        assert_eq!(stray.line, 13);
    }

    #[test]
    fn reports_elements_left_open_at_the_end() {
        let html = deck("<section class=\"slide\" id=\"a\"><div>never closed</section>");
        assert!(rules(&html).contains(&"unclosed-tag"));
        let html = "<!DOCTYPE html><html><head><title>T</title></head><body><main class=\"deck\"><section class=\"slide\" id=\"a\">";
        let found = rules(html);
        assert_eq!(
            found.iter().filter(|r| **r == "unclosed-tag").count(),
            2,
            "{found:?}"
        );
    }

    #[test]
    fn reports_unterminated_tags_and_comments() {
        assert!(rules(&deck(
            "<section class=\"slide\" id=\"a\"><img src=\"x></section>"
        ))
        .contains(&"unterminated-tag"));
        assert!(rules(&deck(
            "<!-- open forever <section class=\"slide\" id=\"a\"></section>"
        ))
        .contains(&"unclosed-comment"));
        // A lone `<` in text is not a tag.
        assert_eq!(
            rules(&deck(
                "<section class=\"slide\" id=\"a\"><p>1 < 2</p></section>"
            )),
            Vec::<&str>::new()
        );
    }

    #[test]
    fn rejects_self_closing_html_elements_outside_svg() {
        let found = rules(&deck("<section class=\"slide\" id=\"a\"><div/></section>"));
        assert!(found.contains(&"self-closing-tag"));
        assert_eq!(rules(&deck("<section class=\"slide\" id=\"a\"><br/><img src=\"assets/logo.png\" alt=\"\"/></section>")), Vec::<&str>::new());
    }

    #[test]
    fn ignores_markup_inside_scripts_styles_and_comments() {
        let html = deck("<section class=\"slide\" id=\"a\"></section>\n<script>const s = '<div><img src=x>';</script>")
            .replace(".slide {}", ".slide {} /* <div> <img src=x> */");
        assert_eq!(rules(&html), Vec::<&str>::new());
    }

    #[test]
    fn reports_duplicate_attributes() {
        assert!(rules(&deck(
            "<section class=\"slide\" id=\"a\"><p class=\"x\" class=\"y\">x</p></section>"
        ))
        .contains(&"duplicate-attribute"));
    }

    #[test]
    fn checks_document_structure() {
        let found = rules(
            "<html><head></head><body><section class=\"slide\" id=\"a\"></section></body></html>",
        );
        for rule in [
            "doctype",
            "title",
            "deck-container",
            "runtime-missing",
            "slide-outside-deck",
        ] {
            assert!(found.contains(&rule), "{rule} missing from {found:?}");
        }
    }

    #[test]
    fn checks_slide_ids() {
        let found = rules(&deck(
            r#"<section class="slide"></section>
<section class="slide" id="a"></section>
<section class="slide" id="a"></section>
<section class="slide" id="Big_Title"></section>"#,
        ));
        assert_eq!(
            found,
            ["slide-id-missing", "slide-id-duplicate", "slide-id-format"]
        );
        assert!(is_kebab_case("q3-plan-2"));
        assert!(!is_kebab_case("-a") && !is_kebab_case("a--b") && !is_kebab_case("A"));
    }

    #[test]
    fn rejects_slide_id_styles_including_nested_and_escaped_selectors() {
        let styled = |css: &str| {
            deck(
                r#"<section class="slide layout-title" id="title"></section>
<section class="slide" id="title-copy"></section>"#,
            )
            .replace(
                "<style>.slide {}</style>",
                &format!("<style>\n{css}\n</style>"),
            )
        };
        for selector in [
            "#title",
            "section#title .card",
            "#title:hover",
            ".other, #title > h1",
            ":is(#title, .other)",
            ":where(#title)",
            "[id=title] .card",
            "[id=\"title\"]",
            r"#\74 itle",
            "#title-copy",
        ] {
            for css in [
                format!("{selector} {{ color: var(--red); }}"),
                format!("@media print {{ {selector} {{ color: var(--red); }} }}"),
                format!(".deck {{ color: var(--black); & {selector} {{ color: var(--red); }} }}"),
            ] {
                let issues = lint(&styled(&css), |_| true, &[]);
                assert_eq!(issues.len(), 1, "{css}: {issues:?}");
                assert_eq!(issues[0].rule, "slide-id-style");
                assert_eq!(issues[0].severity, Severity::Error);
                assert_eq!(issues[0].line, 7);
                assert_eq!(
                    issues[0].slide.as_deref(),
                    Some(if selector == "#title-copy" {
                        "title-copy"
                    } else {
                        "title"
                    })
                );
                assert!(format_report(&issues).contains("reusable layout class"));
            }
        }
        let fixed =
            styled(".layout-title { color: var(--red); } .layout-title .card { padding: 20px; }");
        assert!(lint(&fixed, |_| true, &[]).is_empty());
    }

    #[test]
    fn slide_id_styles_ignore_declarations_comments_strings_and_other_ids() {
        let source =
            deck(r##"<section class="slide" id="abc"><svg><path id="icon"/></svg></section>"##)
                .replace(
                    "<style>.slide {}</style>",
                    r##"<style>
/* #abc { color: var(--red); } */
#icon { fill: var(--red); }
#abc-longer { color: var(--red); }
.layout { color: #abc; --color: #abc; content: "#abc { }"; background: url(#abc); }
[data-label="#abc"] { color: var(--blue); }
@supports (color: #abc) { .layout { color: #abc; } }
</style>"##,
                );
        // `#abc` is a color here, which the palette rule flags; it is no slide id.
        let id_styles = |html: &str| {
            lint(html, |_| true, &[])
                .into_iter()
                .filter(|i| i.rule != "palette-color")
                .collect::<Vec<_>>()
        };
        assert!(id_styles(&source).is_empty());
        let fake = format!("{}<!-- <style>#abc {{}}</style> --><script>const s = '<style>#abc {{}}</style>';</script>", source);
        assert!(id_styles(&fake).is_empty());
    }

    #[test]
    fn slide_id_styles_report_each_selector_at_its_line_in_any_style_block() {
        let source = deck(r#"<section class="slide" id="title"></section>"#)
            .replace("<style>.slide {}</style>", "<style>\n#title { color: var(--red); }\n@media print {\n#title h1 { color: var(--black); }\n}\n</style>\n<style>#title { padding: 1px; }</style>");
        let issues = lint(&source, |_| true, &[]);
        assert_eq!(
            issues
                .iter()
                .map(|i| (i.rule, i.line, i.slide.as_deref()))
                .collect::<Vec<_>>(),
            vec![
                ("slide-id-style", 7, Some("title")),
                ("slide-id-style", 9, Some("title")),
                ("slide-id-style", 12, Some("title")),
            ]
        );
    }

    #[test]
    fn copying_a_slide_does_not_silence_id_style_errors_or_rewrite_css() {
        let css = "#title { padding: 52px 60px; }\n#title .hero-image { width: 700px; }";
        let source = deck(
            r#"<section class="slide" id="title"><img class="hero-image" src="assets/logo.png" alt="Logo"></section>"#,
        )
        .replace(".slide {}", css);
        let before = lint(&source, |_| true, &[]);
        let (copied, copy_id) = html::duplicate(&source, "title").unwrap();

        assert_eq!(copy_id, "title-copy");
        assert_eq!(html::find_slides(&copied).len(), 2);
        assert!(copied.contains(&format!("<style>{css}</style>")));
        assert_eq!(lint(&copied, |_| true, &[]), before);
        assert_eq!(before.len(), 2);
        assert!(before.iter().all(|issue| issue.rule == "slide-id-style"
            && issue.severity == Severity::Error
            && issue.slide.as_deref() == Some("title")));
    }

    #[test]
    fn class_based_repair_passes_lint_and_survives_repeated_copying() {
        let source = deck(r#"<section class="slide" id="title"><h1>AI-KIT</h1></section>"#)
            .replace(
                ".slide {}",
                "#title { padding: 52px 60px; } #title h1 { font-size: 100px; }",
            );
        assert_eq!(rules(&source), ["slide-id-style", "slide-id-style"]);

        // The agent's repair changes styling hooks, retaining the slide identity/content.
        let repaired = source
            .replace("class=\"slide\"", "class=\"slide layout-title\"")
            .replace("#title", ".layout-title");
        let (once, first_id) = html::duplicate(&repaired, "title").unwrap();
        let (twice, second_id) = html::duplicate(&once, &first_id).unwrap();
        assert_ne!(first_id, second_id);
        for version in [&repaired, &once, &twice] {
            assert!(lint(version, |_| true, &[]).is_empty());
            assert!(version.contains(".layout-title { padding: 52px 60px; }"));
            assert!(version.contains(".layout-title h1 { font-size: 100px; }"));
            for slide in html::find_slides(version) {
                let markup = &version[slide.range];
                assert!(markup.contains("class=\"slide layout-title\""));
                assert!(markup.contains("<h1>AI-KIT</h1>"));
            }
        }
    }

    #[test]
    fn slide_id_styles_reject_grouping_rules_and_copy_id_workarounds() {
        let source = deck(
            r#"<section class="slide" id="title"></section>
<section class="slide" id="title-copy" data-hidden></section>"#,
        );
        for css in [
            "@layer layouts { @supports (display: grid) { #title .card { display: grid; } } }",
            "@container (width > 100px) { #title { color: var(--red); } }",
            "@scope (#title) { .card { color: var(--red); } }",
            ":is(#title, #title-copy) .card { color: var(--red); }",
            "#title, #title-copy { color: var(--red); }",
        ] {
            let styled = source.replace(".slide {}", css);
            let issues = lint(&styled, |_| true, &[]);
            let slides: Vec<_> = issues.iter().map(|i| i.slide.as_deref()).collect();
            assert_eq!(
                slides,
                if css.contains("#title-copy") {
                    vec![Some("title"), Some("title-copy")]
                } else {
                    vec![Some("title")]
                },
                "{css}: {issues:?}"
            );
            assert!(issues
                .iter()
                .all(|i| i.rule == "slide-id-style" && i.severity == Severity::Error));
        }
    }

    #[test]
    fn flags_timing_the_app_cannot_read() {
        assert_eq!(
            rules(&deck(
                "<section class=\"slide\" id=\"a\" data-duration=\"12.5\" data-narration-start=\"-1.5\"></section>"
            )),
            Vec::<&str>::new()
        );
        for value in ["soon", "0.1", "-3", ""] {
            assert_eq!(
                rules(&deck(&format!(
                    "<section class=\"slide\" id=\"a\" data-duration=\"{value}\"></section>"
                ))),
                ["duration-value"]
            );
        }
        assert_eq!(
            rules(&deck(
                "<section class=\"slide\" id=\"a\" data-narration-start=\"later\"></section>"
            )),
            ["narration-start-value"]
        );
    }

    #[test]
    fn flags_narration_that_starts_after_its_slide_ends() {
        let slide = |attrs: &str| {
            rules(&deck(&format!(
                "<section class=\"slide\" id=\"a\" {attrs}></section>"
            )))
        };
        assert_eq!(
            slide("data-duration=\"4\" data-narration-start=\"5\""),
            ["narration-start-after-end"]
        );
        assert_eq!(
            slide("data-duration=\"4\" data-narration-start=\"4\""),
            ["narration-start-after-end"]
        );
        for fine in [
            "data-duration=\"4\" data-narration-start=\"3.9\"",
            "data-duration=\"4\" data-narration-start=\"-2\"",
            // Without a pinned length the slide lasts its narration out.
            "data-narration-start=\"30\"",
            "data-duration=\"4\"",
        ] {
            assert!(slide(fine).is_empty(), "{fine}");
        }
        // A value the app cannot read is reported as that alone.
        assert_eq!(
            slide("data-duration=\"soon\" data-narration-start=\"5\""),
            ["duration-value"]
        );
    }

    #[test]
    fn reports_narration_that_waits_for_audio_still_playing() {
        use crate::narration::timeline::Overlap;
        let source = deck(
            "<section class=\"slide\" id=\"song\"></section>\n<section class=\"slide\" id=\"talk\"></section>",
        );
        let overlap = |slide: &str, after_end| Overlap {
            slide: slide.into(),
            under: "song".into(),
            waits: 2.54,
            after_end,
        };
        let issues = narration_overlaps(&source, &[overlap("talk", true), overlap("gone", false)]);
        assert_eq!(issues.len(), 1, "slides no longer there are skipped");
        let issue = &issues[0];
        assert_eq!(
            (issue.rule, issue.severity),
            ("narration-overlap", Severity::Warning)
        );
        assert_eq!(issue.slide.as_deref(), Some("talk"));
        assert!(
            issue.message.contains("slide `song` still plays")
                && issue
                    .message
                    .contains("waits 2.5 s, after the slide stopped showing"),
            "{}",
            issue.message
        );
        assert!(narration_overlaps(&source, &[]).is_empty());
    }

    #[test]
    fn flags_3d_tilts_exports_draw_flattened() {
        let with = |css: &str, slide: &str| {
            let html =
                deck(slide).replace("<style>.slide {}</style>", &format!("<style>{css}</style>"));
            rules(&html)
        };
        let plain = "<section class=\"slide\" id=\"a\"></section>";
        assert_eq!(
            with(
                ".floor { transform: perspective(900px) rotateX(58deg); }",
                plain
            ),
            ["steep-3d-tilt"]
        );
        for steep in [
            "rotateY(-50deg)",
            "rotateX(1rad)",
            "rotate3d(1, 0, 0, 0.2turn)",
            "ROTATEX(60DEG)",
        ] {
            assert_eq!(
                with(&format!(".a {{ transform: {steep}; }}"), plain),
                ["steep-3d-tilt"],
                "{steep}"
            );
        }
        for fine in [
            "rotateX(20deg)",
            "rotateY(-44deg)",
            "rotateX(45deg)",
            "rotateX(180deg)",
            "rotate(90deg)",
            "rotate3d(0, 0, 1, 90deg)",
            "rotateX(var(--tilt))",
        ] {
            assert!(
                with(&format!(".a {{ transform: {fine}; }}"), plain).is_empty(),
                "{fine}"
            );
        }
        // In an inline style too, but not on what the user tilted by hand.
        let inline = "<section class=\"slide\" id=\"a\"><div style=\"transform: rotateX(60deg)\">x</div></section>";
        assert_eq!(with(".slide {}", inline), ["steep-3d-tilt"]);
        let moved = inline.replace("<div style", "<div data-moved style");
        assert!(!with(".slide {}", &moved).contains(&"steep-3d-tilt"));
        // The editor writes the style first and marks the element after it.
        let moved = inline.replace("60deg)\"", "60deg)\" data-moved=\"\"");
        assert!(
            !with(".slide {}", &moved).contains(&"steep-3d-tilt"),
            "{moved}"
        );
        // Only the attribute itself counts, not a word in another one.
        let named = inline.replace("<div style", "<div class=\"not-data-moved\" style");
        assert_eq!(with(".slide {}", &named), ["steep-3d-tilt"]);
    }

    #[test]
    fn tilt_lint_stays_fast_on_decks_with_many_inline_styles() {
        // A big deck: thousands of inline styles, none tilted (lint runs on every change).
        let body: String = (0..4000)
            .map(|i| format!("<p style=\"translate: {i}px 0; color: #123\">Word {i}</p>\n"))
            .collect();
        let html = deck(&format!(
            "<section class=\"slide\" id=\"a\">{body}</section>"
        ));
        let started = std::time::Instant::now();
        let found = rules(&html);
        assert!(!found.contains(&"steep-3d-tilt"), "{found:?}");
        // Quadratic in the deck's size this took seconds in debug builds.
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn flags_animations_timed_to_a_slide_that_start_with_the_deck() {
        let with = |css: &str| {
            rules(
                &deck("<section class=\"slide\" id=\"a\"></section>")
                    .replace("<style>.slide {}</style>", &format!("<style>{css}</style>")),
            )
        };
        for untimed in [
            ".word { animation: pop 0.4s ease-out 3.2s both; }",
            ".word { animation: pop .4s var(--at) both; }",
            ".scene .tile { animation-delay: calc(var(--b0) + 0.5s); }",
            ".a, .slide.active .b { animation: pop 1s 2s; }",
            "@media (min-width: 1px) { .word { animation-delay: 1500ms; } }",
            ".a { opacity: 0; } .word { animation: spin 2s linear infinite, pop 1s 4s both; }",
            // A font import before the rule does not hide it.
            "@import url(https://fonts.googleapis.com/css2?family=Inter); .word { animation-delay: 2s; }",
        ] {
            assert_eq!(with(untimed), ["untimed-animation-delay"], "{untimed}");
        }
        for fine in [
            ".slide.active .word { animation: pop 0.4s ease-out var(--at, 0s) both; }",
            ".logo { animation: spin 8s linear infinite; }",
            ".dot { animation: pulse 1s ease 0.2s infinite; }",
            ".slide.active .a, .slide.active .b { animation-delay: 2s; }",
            "@keyframes pop { 0% { opacity: 0; } 100% { opacity: 1; } } .x { color: var(--red); }",
            "/* .word { animation-delay: 3s; } */ .x { color: var(--red); }",
            ".x { transition: opacity 0.3s 2s; }",
            // A var() holding an easing is no delay, set in the styles or inline.
            ":root { --spring: cubic-bezier(.3, 1.4, .5, 1); } .badge { animation: pop .4s var(--spring) both; }",
            ":root { --ease: ease-in-out; } .logo { animation: float 3s var(--ease) infinite; }",
        ] {
            assert!(with(fine).is_empty(), "{fine}: {:?}", with(fine));
        }
        // A var() holding a time still delays, beside an easing one.
        let both = ":root { --spring: cubic-bezier(.3, 1.4, .5, 1); --at: 2s; } .w { animation: pop .4s var(--spring) var(--at) both; }";
        assert_eq!(with(both), ["untimed-animation-delay"], "{both}");
    }

    #[test]
    fn flags_valued_hidden_attributes() {
        assert_eq!(
            rules(&deck(
                "<section class=\"slide\" id=\"a\" data-hidden=\"\"></section>"
            )),
            Vec::<&str>::new()
        );
        assert_eq!(
            rules(&deck(
                "<section class=\"slide\" id=\"a\" data-hidden=\"false\"></section>"
            )),
            ["hidden-value"]
        );
    }

    #[test]
    fn flags_time_attributes_that_are_no_whole_seconds() {
        assert_eq!(
            rules(&deck(
                "<section class=\"slide\" id=\"a\" data-time=\"90\"></section>"
            )),
            Vec::<&str>::new()
        );
        for value in ["1:30", "soon", "0", "-5", "1.5", ""] {
            assert_eq!(
                rules(&deck(&format!(
                    "<section class=\"slide\" id=\"a\" data-time=\"{value}\"></section>"
                ))),
                ["time-value"],
                "{value}"
            );
        }
    }

    #[test]
    fn flags_valued_locked_attributes() {
        assert_eq!(
            rules(&deck(
                "<section class=\"slide\" id=\"a\" data-locked></section>"
            )),
            Vec::<&str>::new()
        );
        assert_eq!(
            rules(&deck(
                "<section class=\"slide\" id=\"a\" data-locked=\"false\"></section>"
            )),
            ["locked-value"]
        );
    }

    #[test]
    fn flags_locked_slides_changed_during_a_turn() {
        let before = deck(
            "<section class=\"slide\" id=\"a\" data-locked>A</section>\n<section class=\"slide\" id=\"b\" data-locked>B</section>\n<section class=\"slide\" id=\"c\">C</section>",
        );
        let locked = html::locked_slides(&before);
        assert_eq!(lint(&before, |_| true, &locked), vec![]);
        let edited = before.replace(">C<", ">C!<");
        assert_eq!(
            lint(&edited, |_| true, &locked),
            vec![],
            "other slides are free"
        );

        let changed = html::delete(&before.replace(">A<", ">A!<"), "b").unwrap();
        let issues = lint(&changed, |_| true, &locked);
        let found: Vec<_> = issues
            .iter()
            .map(|i| (i.rule, i.severity, i.slide.as_deref(), i.line))
            .collect();
        assert_eq!(
            found,
            [
                ("locked-slide-changed", Severity::Error, None, 1),
                ("locked-slide-changed", Severity::Error, Some("a"), 10),
            ]
        );
        assert!(issues[0].message.contains("`b` was removed"));
        assert!(issues[1].message.contains("`a` is locked"));
    }

    #[test]
    fn flags_content_outside_slides_in_the_deck() {
        let found = rules(&deck("<div>loose</div>\nloose text\n<section class=\"slide\" id=\"a\"><div>fine</div></section>"));
        assert_eq!(found, ["deck-stray-content", "deck-stray-content"]);
        assert_eq!(rules(&deck("<section class=\"slide\" id=\"a\"><section class=\"slide\">nested</section></section>")), Vec::<&str>::new());
    }

    #[test]
    fn accepts_one_plain_narration_per_slide() {
        let found = rules(&deck(
            "<section class=\"slide\" id=\"a\"><h1>A</h1>\n<aside class=\"narration\">Say &amp; this.<br>\n\nThen that.</aside></section>",
        ));
        assert_eq!(found, Vec::<&str>::new());
    }

    #[test]
    fn accepts_markdown_in_narration() {
        let found = rules(&deck(
            "<section class=\"slide\" id=\"a\"><h1>A</h1>\n<aside class=\"narration\"># Say **this**\n\n- `one` &lt; two\n  - [three](https://a.b)</aside></section>",
        ));
        assert_eq!(found, Vec::<&str>::new());
    }

    #[test]
    fn flags_misplaced_duplicate_or_marked_up_narration() {
        let found = rules(&deck(
            "<section class=\"slide\" id=\"a\"><div><aside class=\"narration\">Nested</aside></div><p class=\"narration\">Wrong tag</p></section>",
        ));
        assert_eq!(found, ["narration-misplaced", "narration-misplaced"]);
        let found = rules(&deck(
            "<section class=\"slide\" id=\"a\"><aside class=\"narration\">One</aside><aside class=\"narration\">Two</aside></section>",
        ));
        assert_eq!(found, ["narration-duplicate"]);
        let found = rules(&deck(
            "<section class=\"slide\" id=\"a\"><aside class=\"narration\"><p>Say <b>this</b></p></aside></section>",
        ));
        assert_eq!(found, ["narration-markup"]);
    }

    #[test]
    fn flags_styles_and_scripts_inside_slides() {
        let found = rules(&deck(
            "<section class=\"slide\" id=\"a\"><style>p{}</style><script>1</script></section>",
        ));
        assert_eq!(found, ["style-in-slide", "script-in-slide"]);
    }

    #[test]
    fn colors_come_from_the_palette() {
        let source = deck("<section class=\"slide\" id=\"a\"><p style=\"color: #E30613\">x</p><svg><path fill=\"#fff\" stroke=\"#000\"/></svg></section>")
            .replace(
                "<style>.slide {}</style>",
                "<style>\n:root { --accent: #e30613; --line: 2px solid var(--accent); }\n.slide { color: var(--accent); background: color-mix(in srgb, var(--accent) 20%, transparent); }\n.card { box-shadow: 0 0 8px rgba(0, 0, 0, 0.3); border: 1px solid #ccc; }\n</style>",
            );
        let issues: Vec<_> = lint(&source, |_| true, &[])
            .into_iter()
            .filter(|i| i.rule == "palette-color")
            .collect();
        // One issue per line and place: both of `.card`'s colors, the inline color, each SVG attribute's.
        assert_eq!(issues.len(), 4, "{issues:?}");
        assert!(
            issues[0].message.contains("`rgba(0, 0, 0, 0.3)`, `#ccc`"),
            "{}",
            issues[0].message
        );
        assert_eq!(issues[0].slide, None);
        assert!(
            issues[1].message.contains("`#E30613` is `var(--accent)`"),
            "{}",
            issues[1].message
        );
        assert_eq!(issues[1].slide.as_deref(), Some("a"));
        assert!(issues[0].message.starts_with("Colors "));
        assert!(issues[1].message.starts_with("Color `#E30613` is written"));
        assert!(issues[2].message.contains("style=\"fill: var(--name)\""));
        assert!(issues[3].message.contains("style=\"stroke: var(--name)\""));
        assert!(issues.iter().all(|i| i.severity == Severity::Warning));
    }

    #[test]
    fn a_deck_whose_colors_all_come_from_the_palette_passes() {
        let source = deck("<section class=\"slide\" id=\"a\"><p style=\"color: var(--accent)\">x</p><svg><path style=\"fill: var(--accent)\" stroke=\"currentColor\"/></svg></section>")
            .replace(
                "<style>.slide {}</style>",
                "<style>:root { --accent: oklch(0.6 0.2 25); --ink: black; } .slide { color: var(--ink); border-color: transparent; }</style>",
            );
        assert_eq!(rules(&source), Vec::<&str>::new());
    }

    #[test]
    fn colors_picked_by_hand_get_a_real_name() {
        let source = deck(
            "<section class=\"slide\" id=\"a\"><p style=\"color: var(--custom-1)\">x</p></section>",
        )
        .replace(
            "<style>.slide {}</style>",
            "<style>:root { --custom-1: #123456; --custom-blue: #0000ff; }</style>",
        );
        let issues = lint(&source, |_| true, &[]);
        assert_eq!(issues.len(), 1, "{issues:?}");
        assert_eq!(issues[0].rule, "palette-name");
        assert!(issues[0].message.contains("`--custom-1`"));
    }

    #[test]
    fn hand_styling_needs_no_rules_of_its_own() {
        // Cut-out shapes and arrows are added elements like any other, and the look the toolbar
        // sets (opacity, shadow, radius, image fit and flips, a slide's background) is inline style.
        let found = lint(
            &deck(
                "<section class=\"slide\" id=\"a\" style=\"background-color: var(--accent); background-image: none\">\n<div data-added=\"shape\" style=\"position: absolute; clip-path: polygon(50% 0%, 100% 100%, 0% 100%)\">Hi</div>\n<svg data-added=\"drawing\" viewBox=\"0 0 30 30\" style=\"position: absolute; filter: drop-shadow(0px 4px 12px var(--shadow))\"><path d=\"M3 15 L27 15 M15 3 L27 15 L15 27\" style=\"stroke: var(--ink)\"/></svg>\n<img src=\"https://example.test/a.png\" alt=\"A cat\" style=\"opacity: 0.5; box-shadow: 0px 8px 24px var(--shadow); border-radius: 16px; object-fit: cover; object-position: 50% 0%; transform: scaleX(-1) !important\">\n</section>",
            ),
            |_| true,
            &[],
        );
        let rules: Vec<_> = found.iter().map(|i| i.rule).collect();
        assert_eq!(rules, ["added-element", "added-element", "remote-image"]);
    }

    #[test]
    fn figures_need_no_rules_of_their_own() {
        // A figure is a box an SVG in its background draws, with the shape's kind in `data-shape`;
        // brackets and braces are drawings with one stroke.
        let found = lint(
            &deck(
                "<section class=\"slide\" id=\"a\">\n<div data-added=\"shape\" data-shape=\"block-arrow\" style=\"position: absolute; left: 0px; top: 0px; width: 320px; height: 200px; padding: 54px 96px 54px 13px; background-image: url(&quot;data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' preserveAspectRatio='none'%3E%3Cg transform='matrix(-1 0 0 1 100 0)'%3E%3Cpath d='M0 25 L65 25 L65 0 L100 50 L65 100 L65 75 L0 75 Z' fill='%233b82f6'/%3E%3C/g%3E%3C/svg%3E&quot;); background-size: 100% 100%; background-repeat: no-repeat; filter: drop-shadow(0px 8px 24px var(--shadow))\">Next</div>\n<svg data-added=\"drawing\" data-outline=\"brace\" viewBox=\"0 0 60 200\" style=\"position: absolute; left: 400px; top: 0px; width: 60px; height: 200px\"><path d=\"M57 3 Q30 3 30 57 L30 46 Q30 100 3 100\" style=\"stroke: var(--ink)\" stroke-width=\"6\" fill=\"none\"/></svg>\n</section>",
            ),
            |_| true,
            &[],
        );
        let rules: Vec<_> = found.iter().map(|i| i.rule).collect();
        assert_eq!(rules, ["added-element", "added-element"]);
    }

    #[test]
    fn connectors_groups_and_locks_need_no_rules_of_their_own() {
        // A connector's heads are paths of their own; a group holds what it groups; a lock is a flag.
        let found = lint(
            &deck(
                "<section class=\"slide\" id=\"a\">\n<div id=\"box\" data-lock=\"\" style=\"position: absolute\">A</div>\n<div data-group=\"\" style=\"position: absolute; left: 0px; top: 0px; width: 500px; height: 300px\"><div data-shape=\"star\" data-adjust=\"7\" style=\"position: absolute\">Hi</div><div data-shape=\"cylinder\" data-adjust=\"12.5\">Db</div></div>\n<svg data-route=\"elbow\" data-from=\"box\" data-from-at=\"50% 100%\" viewBox=\"0 0 10 10\"><path d=\"M3 3 L3 103 L453 103\" style=\"stroke: var(--ink)\" stroke-dasharray=\"12 18\" fill=\"none\"/><path data-head=\"start dot\" d=\"M0 3 A3 3 0 1 0 6 3 A3 3 0 1 0 0 3 Z\"/><path data-head=\"end triangle\" d=\"M0 0 L5 5 L0 10 Z\"/></svg>\n</section>",
            ),
            |_| true,
            &[],
        );
        assert_eq!(found, vec![]);
    }

    #[test]
    fn flags_figure_proportions_heads_and_routes_the_editor_cannot_read() {
        let found = lint(
            &deck(
                "<section class=\"slide\" id=\"a\">\n<div data-shape=\"star\" data-adjust=\"lots\">Hi</div>\n<svg data-route=\"zigzag\" viewBox=\"0 0 10 10\">\n<path data-head=\"middle arrow\" d=\"M0 0 L1 1\"/>\n<path data-head=\"end star\" d=\"M0 0 L1 1\"/>\n<path data-head=\"end\" d=\"M0 0 L1 1\"/>\n</svg>\n</section>",
            ),
            |_| true,
            &[],
        );
        let found: Vec<_> = found.iter().map(|i| (i.rule, i.line)).collect();
        assert_eq!(
            found,
            [
                ("shape-adjust", 11),
                ("line-route", 12),
                ("line-head", 13),
                ("line-head", 14),
                ("line-head", 15),
            ]
        );
    }

    #[test]
    fn flags_shapes_the_editor_cannot_draw() {
        let found = lint(
            &deck(
                "<section class=\"slide\" id=\"a\">\n<div data-shape=\"cloud\">Hi</div>\n<div data-shape=\"hexagon\">Ok</div>\n</section>",
            ),
            |_| true,
            &[],
        );
        let found: Vec<_> = found.iter().map(|i| (i.rule, i.line)).collect();
        assert_eq!(found, [("shape-kind", 11)]);
    }

    #[test]
    fn curved_lines_need_no_rules_of_their_own() {
        // A line the user bent is a drawing like a straight one: one path, the arrow's head in it.
        let found = lint(
            &deck(
                "<section class=\"slide\" id=\"a\">\n<svg data-added=\"drawing\" viewBox=\"0 0 206 106\" style=\"position: absolute; left: 97px; top: 97px; width: 206px; height: 106px; overflow: visible\"><path d=\"M3 3 C36.3 3 69.7 103 103 103 C136.3 103 169.7 3 203 3 M182 15 L203 3 L182 -9\" style=\"stroke: var(--ink)\" stroke-width=\"6\" fill=\"none\"/></svg>\n</section>",
            ),
            |_| true,
            &[],
        );
        let rules: Vec<_> = found.iter().map(|i| i.rule).collect();
        assert_eq!(rules, ["added-element"]);
    }

    #[test]
    fn flags_elements_added_by_hand() {
        let found = lint(
            &deck(
                "<section class=\"slide\" id=\"a\">\n<div data-added=\"text\" style=\"position: absolute; left: 10px; top: 20px\">Hi</div>\n<div data-added=\"shape\" style=\"position: absolute; left: 0px; top: 0px; width: 320px; height: 200px\"></div>\n<svg data-added=\"drawing\" viewBox=\"0 0 10 10\" style=\"position: absolute\"><path d=\"M0 0 L10 10\" style=\"stroke: var(--ink)\"/></svg>\n</section>",
            ),
            |_| true,
            &[],
        );
        let found: Vec<_> = found.iter().map(|i| (i.rule, i.line)).collect();
        assert_eq!(
            found,
            [
                ("added-element", 11),
                ("added-element", 12),
                ("added-element", 13)
            ]
        );
        let messages: Vec<_> = lint(
            &deck("<section class=\"slide\" id=\"a\"><div data-added=\"shape\"></div><svg data-added=\"drawing\"></svg></section>"),
            |_| true,
            &[],
        )
        .into_iter()
        .map(|i| i.message)
        .collect();
        assert!(messages[0].starts_with("This shape was added by hand"));
        assert!(messages[1].starts_with("This drawing was added by hand"));
        // As text it means nothing to the editor.
        assert_eq!(
            rules(&deck(
                "<section class=\"slide\" id=\"a\"><p>data-added</p></section>"
            )),
            Vec::<&str>::new()
        );
    }

    #[test]
    fn flags_links_to_missing_slides_and_scripts() {
        let source = deck(
            "<section class=\"slide\" id=\"intro\">\n<a href=\"#pricing\">Pricing</a>\n<a href=\"#2\">Two</a>\n<a href=\"#outro\">Out</a>\n<a href=\"#\">Nowhere</a>\n<a href=\"#9\">Nine</a>\n<a href=\"javascript:go()\">Go</a>\n<a href=\"https://example.com\" target=\"_blank\" rel=\"noopener\">Web</a>\n<a href=\"mailto:a@b.c\">Mail</a>\n</section>\n<section class=\"slide\" id=\"outro\"><a>no href</a></section>",
        );
        let found: Vec<_> = lint(&source, |_| true, &[])
            .into_iter()
            .map(|i| (i.rule, i.line, i.slide))
            .collect();
        let intro = Some("intro".to_string());
        assert_eq!(
            found,
            [
                ("broken-slide-link", 11, intro.clone()),
                ("broken-slide-link", 14, intro.clone()),
                ("broken-slide-link", 15, intro.clone()),
                ("script-link", 16, intro),
            ]
        );
        let messages: Vec<_> = lint(&source, |_| true, &[])
            .into_iter()
            .map(|i| i.message)
            .collect();
        assert!(messages[0].contains("`pricing`"));
        assert!(messages[1].contains("goes nowhere"));
        // Links outside slides (in the head, say) and link-like text are not checked.
        assert_eq!(
            rules(&deck(
                "<section class=\"slide\" id=\"a\"><p>&lt;a href=\"#x\"&gt;</p></section>"
            )),
            Vec::<&str>::new()
        );
    }

    #[test]
    fn flags_unknown_autofit_values() {
        assert_eq!(
            rules(&deck(
                "<section class=\"slide\" id=\"a\"><div data-autofit=\"shrink\">A</div><div data-autofit=\"grow\">B</div><div data-autofit=\"squeeze\">C</div></section>"
            )),
            ["autofit-value"]
        );
    }

    #[test]
    fn flags_resize_placeholders_awaiting_cleanup() {
        assert_eq!(
            rules(&deck(
                "<section class=\"slide\" id=\"a\"><p style=\"position: absolute; width: 300px\">Edited</p><p data-resize-placeholder aria-hidden=\"true\" inert style=\"visibility: hidden\">Original</p></section>"
            )),
            ["resize-placeholder"]
        );
        assert!(rules(&deck(
            "<section class=\"slide\" id=\"a\"><p>data-resize-placeholder</p></section>"
        ))
        .is_empty());
        assert!(rules(&format!(
            "{}<div data-resize-placeholder></div>",
            deck("<section class=\"slide\" id=\"a\"></section>")
        ))
        .is_empty());
    }

    #[test]
    fn flags_delete_placeholders_awaiting_cleanup() {
        let found = lint(
            &deck(
                "<section class=\"slide\" id=\"a\"><p data-delete-placeholder aria-hidden=\"true\" inert style=\"visibility: hidden\">Gone</p><p>Kept</p></section>",
            ),
            |_| true,
            &[],
        );
        assert_eq!(
            found.iter().map(|f| f.rule).collect::<Vec<_>>(),
            ["delete-placeholder"]
        );
        assert!(found[0]
            .message
            .contains("Do not bring the deleted content back"));
        assert!(rules(&deck(
            "<section class=\"slide\" id=\"a\"><p>data-delete-placeholder</p></section>"
        ))
        .is_empty());
        assert!(rules(&format!(
            "{}<div data-delete-placeholder></div>",
            deck("<section class=\"slide\" id=\"a\"></section>")
        ))
        .is_empty());
    }

    #[test]
    fn flags_hand_edits_awaiting_cleanup() {
        let found = lint(
            &deck(
                "<section class=\"slide\" id=\"a\">\n<h2 data-moved style=\"translate: 40px -12px\">Moved</h2>\n<img data-moved style=\"translate: 0px 12px; rotate: 15deg; scale: 1.5 0.8\" src=\"a.png\" alt=\"\">\n<div data-moved style=\"transform: perspective(1000px) rotateX(10deg) rotateY(30deg) !important\">Tilted</div>\n<p contenteditable=\"true\" data-slop-selected>Left over</p>\n</section>",
            ),
            |_| true,
            &[],
        );
        let found: Vec<_> = found.iter().map(|i| (i.rule, i.slide.as_deref())).collect();
        assert_eq!(
            found,
            [
                ("moved-element", Some("a")),
                ("moved-element", Some("a")),
                ("moved-element", Some("a")),
                ("editor-leftover", Some("a"))
            ]
        );
        assert_eq!(
            rules(&deck(
                "<section class=\"slide\" id=\"a\" data-slop-typing><p>Hi</p></section>"
            )),
            ["editor-leftover"]
        );
        assert_eq!(
            rules(&deck(
                "<section class=\"slide\" id=\"a\"><p spellcheck=\"true\">Hi</p></section>"
            )),
            ["editor-leftover"]
        );
        // Outside slides (or as text) the attributes mean nothing to the editor.
        assert_eq!(
            rules(&deck(
                "<section class=\"slide\" id=\"a\"><p>data-moved</p></section>"
            )),
            Vec::<&str>::new()
        );
        assert_eq!(
            rules(&format!(
                "{}<div data-moved contenteditable></div>",
                deck("<section class=\"slide\" id=\"a\"></section>")
            )),
            Vec::<&str>::new()
        );
    }

    #[test]
    fn flags_dropped_images_awaiting_a_place() {
        let found = rules(&deck(
            "<section class=\"slide\" id=\"a\">\n<img src=\"assets/logo.png\" alt=\"\" data-dropped data-moved style=\"position: absolute; left: 0px; top: 0px; width: 640px; translate: 640px 300px\">\n</section>",
        ));
        // One warning covers both markers.
        assert_eq!(found, ["dropped-image"]);
        let issues = lint(
            &deck("<section class=\"slide\" id=\"a\"><img src=\"assets/logo.png\" alt=\"\" data-dropped></section>"),
            |_| true,
            &[],
        );
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].slide.as_deref(), Some("a"));
        assert_eq!(issues[0].severity, Severity::Warning);
        // Outside slides the attribute means nothing to the editor.
        assert_eq!(
            rules(&format!(
                "{}<img src=\"assets/logo.png\" alt=\"\" data-dropped>",
                deck("<section class=\"slide\" id=\"a\"></section>")
            )),
            Vec::<&str>::new()
        );
    }

    #[test]
    fn rejects_image_references_outside_the_deck_folder() {
        let html = deck("<section class=\"slide\" id=\"a\"><img src=\"../shared/x.png\" alt=\"X\"><img src=\"%2e%2e/shared/x.png\" alt=\"X\"></section>");
        assert_eq!(
            lint(&html, |_| true, &[])
                .iter()
                .filter(|i| i.rule == "asset-outside-deck")
                .count(),
            2
        );
    }

    #[test]
    fn checks_images_and_assets() {
        let found = rules(&deck(
            r#"<section class="slide" id="a">
<img src="assets/missing.png" alt="">
<img src="https://example.com/x.png" alt="x">
<img src="assets/logo.png">
<div style="background: url(./assets/logo.png)"></div>
</section>"#,
        ));
        assert_eq!(found, ["missing-asset", "remote-image", "img-alt"]);
    }

    #[test]
    fn sorts_by_line_and_formats_a_report() {
        let html = deck("<section class=\"slide\" id=\"Bad\"><span></section>");
        let issues = lint(&html, |_| true, &[]);
        assert!(issues.windows(2).all(|w| w[0].line <= w[1].line));
        let report = format_report(&issues);
        assert!(
            report.starts_with("The deck has 1 error(s) and 1 warning(s):"),
            "{report}"
        );
        assert!(
            report.contains("line 10 error [unclosed-tag] (slide `Bad`): <span> is never closed")
        );
        assert_eq!(format_report(&[]), "The deck passes lint: no issues.");
    }

    #[test]
    fn serializes_for_the_frontend() {
        let issue = Issue {
            rule: "title",
            severity: Severity::Warning,
            message: "m".into(),
            line: 1,
            slide: None,
        };
        assert_eq!(
            serde_json::to_value(&issue).unwrap(),
            serde_json::json!({"rule":"title","severity":"warning","message":"m","line":1,"slide":null})
        );
    }

    #[test]
    fn accepts_section_markers_between_slides() {
        let html = deck(
            r#"<section class="slide" id="a">A</section>
<div class="deck-section" data-title="Part two"></div>
<section class="slide" id="b">B</section>"#,
        );
        assert_eq!(rules(&html), Vec::<&str>::new());
    }

    #[test]
    fn flags_section_markers_without_title_or_with_content() {
        let found = rules(&deck(
            r#"<div class="deck-section"></div>
<div class="deck-section" data-title="  "></div>
<section class="slide" id="a">A</section>
<div class="deck-section" data-title="Ok"><p>x</p></div>"#,
        ));
        assert_eq!(
            found,
            [
                "section-title-missing",
                "section-title-missing",
                "section-marker-content"
            ]
        );
        let issues = lint(
            &deck(
                "<div class=\"deck-section\"></div>\n<section class=\"slide\" id=\"a\">A</section>",
            ),
            |_| true,
            &[],
        );
        assert_eq!(issues[0].line, 10);
        assert!(issues[0].message.contains("Section 1"));
    }

    #[test]
    fn flags_section_markers_outside_the_deck_level() {
        let inside = rules(&deck(
            r#"<section class="slide" id="a"><div class="deck-section" data-title="X"></div></section>"#,
        ));
        assert_eq!(inside, ["section-marker-misplaced"]);
        let wrapped = rules(&deck(
            r#"<div class="wrap"><div class="deck-section" data-title="X"></div></div>
<section class="slide" id="a">A</section>"#,
        ));
        assert!(wrapped.contains(&"section-marker-misplaced"));
        assert!(wrapped.contains(&"deck-stray-content"));
    }

    #[test]
    fn warns_about_entrances_that_animate_transform() {
        let styled = |css: &str| {
            deck(r#"<section class="slide" id="a"><h1 class="reveal">Hi</h1></section>"#)
                .replace("<style>.slide {}</style>", &format!("<style>{css}</style>"))
        };
        let own =
            "@keyframes rise { from { opacity: 0; translate: 0 20px; } to { opacity: 1; } }\n\
            .slide.active .reveal { animation: rise 0.6s ease both; }";
        assert_eq!(rules(&styled(own)), Vec::<&str>::new());
        let transform = "@keyframes rise { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: none; } }\n\
            .slide.active .reveal { animation: rise 0.6s ease both; }";
        assert_eq!(rules(&styled(transform)), ["entrance-transform"]);
        let issue = &lint(&styled(transform), |_| false, &[])[0];
        assert_eq!(issue.line, 6, "reported at the keyframes");
        assert!(issue.message.contains("@keyframes rise"));
        let in_media = "@keyframes rise { from { transform: scale(0.9); } }\n\
            @media (min-width: 1px) { .slide.active .reveal { animation-name: rise; } }";
        assert_eq!(rules(&styled(in_media)), ["entrance-transform"]);
        let not_an_entrance = "@keyframes spin { to { transform: rotate(1turn); } }\n\
            .slide .logo { animation: spin 4s linear infinite; }\n\
            .slide.active .reveal { animation: spinner 1s both; }";
        assert_eq!(rules(&styled(not_an_entrance)), Vec::<&str>::new());
        let lookalikes =
            "@keyframes rise { from { text-transform: none; transform-origin: 0 0; } }\n\
            .slide.active .reveal { animation: rise 1s both; }";
        assert_eq!(rules(&styled(lookalikes)), Vec::<&str>::new());
        let commented = deck(&format!(
            "<!-- <style>{transform}</style> -->\n<section class=\"slide\" id=\"a\"></section>"
        ));
        assert_eq!(rules(&commented), Vec::<&str>::new());
    }

    #[test]
    fn checks_the_template_meta() {
        let named = html::set_template(
            &deck(r#"<section class="slide" id="a"></section>"#),
            Some("swiss"),
        );
        assert_eq!(rules(&named), Vec::<&str>::new());
        let empty = named.replace("content=\"swiss\"", "content=\" \"");
        assert_eq!(rules(&empty), ["template-meta-empty"]);
        let no_content = named.replace(" content=\"swiss\"", "");
        assert_eq!(rules(&no_content), ["template-meta-empty"]);
        let twice = named.replace(
            "<title>Talk</title>",
            "<title>Talk</title><meta name=\"slopslide-template\" content=\"bohemian\">",
        );
        assert_eq!(rules(&twice), ["template-meta-duplicate"]);
        let in_body = deck(
            r#"<section class="slide" id="a"><meta name="slopslide-template" content="x"></section>"#,
        );
        assert_eq!(rules(&in_body), ["template-meta-misplaced"]);
        let commented = deck(r#"<!-- <meta name="slopslide-template" content=""> -->"#);
        assert_eq!(rules(&commented), Vec::<&str>::new());
        let other = deck("").replace("<title>", "<meta name=\"description\" content=\"\"><title>");
        assert_eq!(rules(&other), Vec::<&str>::new());
    }

    #[test]
    fn checks_the_narration_voice_and_language_metas() {
        let set = html::set_narration_language(
            &html::set_narration_voice(
                &deck(r#"<section class="slide" id="a"></section>"#),
                "coral",
            ),
            "de",
        );
        assert_eq!(rules(&set), Vec::<&str>::new());
        assert_eq!(rules(&html::ensure_runtime(&set)), Vec::<&str>::new());
        for bad in ["", "Coral", "bob"] {
            let html = set.replace("content=\"coral\"", &format!("content=\"{bad}\""));
            assert_eq!(rules(&html), ["narration-voice-invalid"], "{bad}");
        }
        for bad in ["", "german", "xx"] {
            let html = set.replace("content=\"de\"", &format!("content=\"{bad}\""));
            assert_eq!(rules(&html), ["narration-language-invalid"], "{bad}");
        }
        let message = &lint(&set.replace("coral", "bob"), |_| true, &[])[0].message;
        assert!(message.contains("marin, cedar"), "{message}");
        let twice = set.replace(
            "<title>Talk</title>",
            "<title>Talk</title><meta name=\"slopslide-narration-voice\" content=\"marin\">",
        );
        assert_eq!(rules(&twice), ["narration-voice-duplicate"]);
        let in_body = deck(
            r#"<section class="slide" id="a"><meta name="slopslide-narration-language" content="en"></section>"#,
        );
        assert_eq!(rules(&in_body), ["narration-language-misplaced"]);
    }

    #[test]
    fn checks_the_narration_provider_and_its_voices() {
        let base = deck(r#"<section class="slide" id="a"></section>"#);
        let with = |provider: &str, voice: &str| {
            html::set_narration_voice(&html::set_narration_provider(&base, Some(provider)), voice)
        };
        for (provider, voice) in [
            ("openai", "coral"),
            ("elevenlabs", "JBFqnCBsd6RMkjVDRZzb"),
            ("elevenlabs", "abcdefghij1234567890"),
        ] {
            let html = with(provider, voice);
            assert_eq!(rules(&html), Vec::<&str>::new(), "{provider} {voice}");
            assert_eq!(rules(&html::ensure_runtime(&html)), Vec::<&str>::new());
        }
        // A voice of another provider.
        assert_eq!(
            rules(&with("openai", "JBFqnCBsd6RMkjVDRZzb")),
            ["narration-voice-invalid"]
        );
        assert_eq!(
            rules(&with("elevenlabs", "coral")),
            ["narration-voice-invalid"]
        );
        let message = &lint(&with("openai", "ryan"), |_| true, &[])[0].message;
        assert!(
            message.contains("OpenAI") && message.contains("marin, cedar"),
            "{message}"
        );
        let message = &lint(&with("elevenlabs", "x"), |_| true, &[])[0].message;
        assert!(message.contains("ElevenLabs voice id"), "{message}");
        // An unknown provider (the removed local model too): the voice is checked as the
        // default's.
        for bad in ["", "ElevenLabs", "google", "local"] {
            let html = with("openai", "coral")
                .replace("content=\"openai\"", &format!("content=\"{bad}\""));
            assert_eq!(rules(&html), ["narration-provider-invalid"], "{bad}");
        }
        let message = &lint(&with("acme", "coral"), |_| true, &[])[0].message;
        assert!(
            message.contains("openai, elevenlabs") && message.contains("default, openai"),
            "{message}"
        );
        let twice = with("openai", "coral").replace(
            "<title>Talk</title>",
            "<title>Talk</title><meta name=\"slopslide-narration-provider\" content=\"openai\">",
        );
        assert_eq!(rules(&twice), ["narration-provider-duplicate"]);
        let in_body = deck(
            r#"<section class="slide" id="a"><meta name="slopslide-narration-provider" content="openai"></section>"#,
        );
        assert_eq!(rules(&in_body), ["narration-provider-misplaced"]);
    }

    #[test]
    fn checks_the_slide_size_meta() {
        let sized = html::set_slide_size(
            &deck(r#"<section class="slide" id="a"></section>"#),
            SlideSize::parse("8.5x11in").unwrap(),
        );
        assert_eq!(rules(&sized), Vec::<&str>::new());
        assert_eq!(rules(&html::ensure_runtime(&sized)), Vec::<&str>::new());
        for bad in ["", " ", "portrait", "1920", "50x50", "1920x1080mm"] {
            let html = sized.replace("8.5x11in", bad);
            assert_eq!(rules(&html), ["slide-size-invalid"], "{bad}");
        }
        let no_content = sized.replace(" content=\"8.5x11in\"", "");
        assert_eq!(rules(&no_content), ["slide-size-invalid"]);
        let message = &lint(&sized.replace("8.5x11in", "big"), |_| true, &[])[0].message;
        assert!(
            message.contains("\"big\" is not a usable size"),
            "{message}"
        );
        let twice = sized.replace(
            "<title>Talk</title>",
            "<title>Talk</title><meta name=\"slopslide-size\" content=\"1080x1080\">",
        );
        assert_eq!(rules(&twice), ["slide-size-duplicate"]);
        let in_body = deck(
            r#"<section class="slide" id="a"><meta name="slopslide-size" content="1080x1080"></section>"#,
        );
        assert_eq!(rules(&in_body), ["slide-size-misplaced"]);
        let commented = deck(r#"<!-- <meta name="slopslide-size" content="nope"> -->"#);
        assert_eq!(rules(&commented), Vec::<&str>::new());
    }
}
