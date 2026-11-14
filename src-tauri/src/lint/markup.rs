//! The walk over every tag of the deck: balance, stray end tags, duplicate attributes, and
//! what sits where (in the deck container, in slides).

use crate::html::{
    has_class, parse_tag, Attr, Tag, ADDED_ATTR, ADJUST_ATTR, AUTOFIT_ATTR,
    DELETE_PLACEHOLDER_ATTR, DROPPED_ATTR, EDITOR_ATTRS, HEAD_ATTR, HEAD_KINDS, MOVED_ATTR,
    NARRATION_CLASS, RESIZE_PLACEHOLDER_ATTR, ROUTES, ROUTE_ATTR, SECTION_CLASS, SHAPE_ATTR,
    SHAPE_KINDS, TEXT_BODY_ATTR, VOID_ELEMENTS,
};

use super::{truncate, Linter, Severity};

/// Elements whose end tag HTML lets you leave out.
const OPTIONAL_END: &[&str] = &[
    "html", "head", "body", "p", "li", "dt", "dd", "option", "optgroup", "tr", "td", "th", "thead",
    "tbody", "tfoot", "colgroup", "caption", "rb", "rt", "rtc", "rp",
];
/// Elements whose content is raw text, not markup.
const RAW_TEXT: &[&str] = &["script", "style", "textarea", "title"];
/// Foreign content (SVG, MathML) allows self-closing tags such as `<path/>`.
const FOREIGN: &[&str] = &["svg", "math"];

struct Open<'a> {
    /// The element's name as the document writes it; compared ignoring case.
    name: &'a str,
    at: usize,
    /// How many elements it holds so far.
    children: usize,
    /// Where the text body ([`TEXT_BODY_ATTR`]) it holds starts, until that one is reported.
    body: Option<usize>,
}

impl<'a> Open<'a> {
    fn new(tag: &Tag<'a>, at: usize) -> Self {
        Self {
            name: tag.raw_name(),
            at,
            children: 0,
            body: None,
        }
    }
}

/// A start tag with its attributes read once: the checks ask a dozen questions of every tag.
struct Element<'t, 'a> {
    tag: &'t Tag<'a>,
    attrs: &'t [Attr<'a>],
}

impl<'a> Element<'_, 'a> {
    /// The value of the first attribute `name`.
    fn value(&self, name: &str) -> Option<&'a str> {
        self.attrs.iter().find(|a| a.is(name)).map(|a| a.value)
    }

    fn has(&self, name: &str) -> bool {
        self.attrs.iter().any(|a| a.is(name))
    }

    fn has_class(&self, class: &str) -> bool {
        self.attrs
            .iter()
            .any(|a| a.is("class") && a.value.split_ascii_whitespace().any(|c| c == class))
    }
}

/// Where the walk is: the elements open there.
#[derive(Default)]
struct Walk<'a> {
    stack: Vec<Open<'a>>,
    /// Stack depth of `<main class="deck">`, while it is open.
    deck_depth: Option<usize>,
}

impl Walk<'_> {
    /// Whether what comes next is directly in `<main class="deck">`.
    fn at_deck_level(&self) -> bool {
        self.deck_depth == Some(self.stack.len())
    }
}

/// Walks every tag: balance, stray end tags, duplicate attributes, and what sits where.
pub(super) fn check_markup(l: &mut Linter) {
    let html = l.html;
    let bytes = html.as_bytes();
    let mut walk = Walk::default();
    // One list for every tag's attributes, filled anew for each.
    let mut attrs = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i = check_text(l, &walk, i);
            continue;
        }
        if html[i..].starts_with("<!--") {
            i = skip_comment(l, i);
            continue;
        }
        let Some(tag) = parse_tag(html, i) else {
            check_unterminated_tag(l, i);
            i += 1;
            continue;
        };
        if !tag.closing {
            attrs.clear();
            attrs.extend(tag.attrs());
            let element = Element {
                tag: &tag,
                attrs: &attrs,
            };
            check_opening_tag(l, &mut walk, &element, i);
        }
        i = step(l, &mut walk, &tag, i);
    }
    for open in walk.stack.into_iter().rev() {
        if !named(open.name, OPTIONAL_END) {
            l.report(
                "unclosed-tag",
                Severity::Error,
                open.at,
                format!("<{}> is never closed.", open.name.to_ascii_lowercase()),
            );
        }
    }
}

/// Text at `i`, outside any tag: reports text directly in the deck container. Returns where
/// the walk goes on.
fn check_text(l: &mut Linter, walk: &Walk, i: usize) -> usize {
    let html = l.html;
    if walk.at_deck_level() && !html.as_bytes()[i].is_ascii_whitespace() {
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
        return end;
    }
    i + 1
}

/// The comment at `i`: where it ends, or the end of the deck when it never does.
fn skip_comment(l: &mut Linter, i: usize) -> usize {
    match l.html[i..].find("-->") {
        Some(e) => i + e + 3,
        None => {
            l.report(
                "unclosed-comment",
                Severity::Error,
                i,
                "This comment is never closed with -->; everything after it is hidden.".into(),
            );
            l.html.len()
        }
    }
}

/// A `<` at `i` that starts no tag the scanner could read.
fn check_unterminated_tag(l: &mut Linter, i: usize) {
    let next = l.html.as_bytes().get(i + 1).copied().unwrap_or(b' ');
    if next.is_ascii_alphabetic() || next == b'/' {
        l.report(
            "unterminated-tag",
            Severity::Error,
            i,
            "This tag is never closed with > (or has an unterminated quote).".into(),
        );
    }
}

/// Everything about an opening tag at `i` but its place in the element tree.
fn check_opening_tag(l: &mut Linter, walk: &mut Walk, element: &Element, i: usize) {
    check_duplicate_attributes(l, element, i);
    check_placement(l, walk, element, i);
    if l.slide_span_at(i).is_some() {
        check_slide_content(l, element, i);
        check_text_body(l, walk, element, i);
        check_figure(l, element, i);
        check_added(l, element, i);
    }
}

fn check_duplicate_attributes(l: &mut Linter, element: &Element, i: usize) {
    let Element { tag, attrs } = element;
    // A tag has a handful of attributes: looking back over them needs no set.
    for (index, attr) in attrs.iter().enumerate() {
        if attrs[..index]
            .iter()
            .any(|earlier| earlier.is(attr.raw_name()))
        {
            l.report(
                "duplicate-attribute",
                Severity::Error,
                i,
                format!(
                    "<{}> has the attribute `{}` more than once.",
                    tag.name(),
                    attr.name()
                ),
            );
        }
    }
}

/// Slides and section markers directly in the deck container, and nothing else there;
/// narration directly in its slide.
fn check_placement(l: &mut Linter, walk: &Walk, element: &Element, i: usize) {
    let tag = element.tag;
    let is_slide = tag.is("section") && element.has_class("slide");
    let is_marker = tag.is("div") && element.has_class(SECTION_CLASS);
    let deck_level = walk.at_deck_level();
    if deck_level && !is_slide && !is_marker && !tag.is_any(&["script", "template"]) {
        l.report(
            "deck-stray-content",
            Severity::Warning,
            i,
            format!(
                "<{}> sits directly in <main class=\"deck\">; only <section class=\"slide\"> belongs there.",
                tag.name()
            ),
        );
    }
    if is_marker && !deck_level {
        l.report(
            "section-marker-misplaced",
            Severity::Warning,
            i,
            "Section markers must be direct children of <main class=\"deck\">, between slides."
                .into(),
        );
    }
    if is_slide && !deck_level {
        // Nested slides are content of their parent slide, not slides of their own.
        let nested = l.slide_span_at(i).is_some_and(|s| s.range.start < i);
        if !nested {
            l.report(
                "slide-outside-deck",
                Severity::Error,
                i,
                "Slides must be direct children of <main class=\"deck\">.".into(),
            );
        }
    }
    if element.has_class(NARRATION_CLASS) {
        // Directly inside a slide: the innermost open element is the slide itself.
        let in_slide = walk.stack.last().is_some_and(|open| {
            l.slide_span_at(open.at)
                .is_some_and(|s| s.range.start == open.at)
        });
        if !tag.is("aside") || !in_slide {
            l.report(
                "narration-misplaced",
                Severity::Warning,
                i,
                "A slide's narration is one <aside class=\"narration\"> placed directly inside its <section class=\"slide\">; move it there.".into(),
            );
        }
    }
}

/// What a slide should not hold, and what the editor left on its elements for the agent to
/// tidy: styles, scripts, editing leftovers, hand moves and drops, placeholders, autofit.
fn check_slide_content(l: &mut Linter, element: &Element, i: usize) {
    let tag = element.tag;
    let has = |attr: &str| element.has(attr);
    if tag.is("style") {
        l.report(
            "style-in-slide",
            Severity::Warning,
            i,
            "Move this <style> into the single <style> in <head>, scoped by a reusable layout class, never the slide id.".into(),
        );
    }
    if tag.is("script") {
        l.report(
            "script-in-slide",
            Severity::Warning,
            i,
            "Slides should not contain <script>; use CSS for slide visuals.".into(),
        );
    }
    if let Some(leftover) = element
        .attrs
        .iter()
        .find(|a| EDITOR_ATTRS.iter().any(|name| a.is(name)))
    {
        l.report(
            "editor-leftover",
            Severity::Warning,
            i,
            format!(
                "<{}> has `{}`, left over from editing in the app; remove it.",
                tag.name(),
                leftover.name()
            ),
        );
    }
    if has(DROPPED_ATTR) {
        l.report(
            "dropped-image",
            Severity::Warning,
            i,
            format!(
                "<{}> was dropped onto the slide by hand ({DROPPED_ATTR}, placed on top with inline `position: absolute`, `left`, `top`, `width` and `translate`). Give it a place in the slide's layout where it appears now, sized with the slide's styles, and a fitting alt text, then remove {DROPPED_ATTR}, {MOVED_ATTR} and the inline styles.",
                tag.name()
            ),
        );
    } else if has(MOVED_ATTR) {
        l.report(
            "moved-element",
            Severity::Warning,
            i,
            format!(
                "<{}> was moved, rotated, tilted or scaled by hand ({MOVED_ATTR} with an inline `translate`, `rotate`, `scale` or tilt `transform`). Rework the slide's layout so it sits where it appears now without the offset, turn a scale into real sizes, keep an intended rotation or tilt in the slide's styles, then remove the attribute and the inline transforms.",
                tag.name()
            ),
        );
    }
    if has(RESIZE_PLACEHOLDER_ATTR) {
        l.report(
            "resize-placeholder",
            Severity::Warning,
            i,
            "This invisible, inert placeholder reserves the original layout space of an element the user resized (the one immediately before it) or moved into a group they made (a `data-group` box). Keep the visible element's text, dimensions and position when tidying, fit it into the slide's layout, then remove this entire placeholder and its hidden contents.".into(),
        );
    }
    if has(DELETE_PLACEHOLDER_ATTR) {
        l.report(
            "delete-placeholder",
            Severity::Warning,
            i,
            "The user deleted an element here; this invisible, inert copy only holds its empty slot so the rest of the layout did not shift. Do not bring the deleted content back. When tidying, remove this entire placeholder and its hidden contents and rework the surrounding layout so the gap closes cleanly.".into(),
        );
    }
    if let Some(value) = element.value(AUTOFIT_ATTR) {
        if !matches!(value, "shrink" | "grow") {
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
}

/// A text body is all its box holds: an element next to it is an item of the box's flex
/// column, apart from the text the editor selects and edits as one.
fn check_text_body(l: &mut Linter, walk: &mut Walk, element: &Element, i: usize) {
    let tag = element.tag;
    let is_body = element.has(TEXT_BODY_ATTR);
    let beside_body = walk.stack.last_mut().and_then(|parent| {
        parent.children += 1;
        if is_body && parent.body.is_none() && parent.children == 1 {
            parent.body = Some(i);
            return None;
        }
        if is_body {
            return Some(i);
        }
        parent.body.take()
    });
    if is_body && !tag.is("div") {
        l.report(
            "text-body",
            Severity::Warning,
            i,
            format!(
                "`{TEXT_BODY_ATTR}` belongs on the `<div>` that holds all the text of a text box or shape, not on <{}>; remove it here.",
                tag.name()
            ),
        );
    } else if let Some(at) = beside_body {
        l.report(
            "text-body",
            Severity::Warning,
            at,
            format!(
                "This `{TEXT_BODY_ATTR}` block has elements next to it. It holds all the text of its text box or shape, as the box's only child, so the editor selects and edits it as one text: move what sits beside it into it."
            ),
        );
    }
}

/// The attributes of the figures and lines the editor draws: values it can read.
fn check_figure(l: &mut Linter, element: &Element, i: usize) {
    if let Some(value) = element.value(SHAPE_ATTR) {
        if !SHAPE_KINDS.contains(&value) {
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
    if let Some(value) = element.value(ADJUST_ATTR) {
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
    if let Some(value) = element.value(HEAD_ATTR) {
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
    if let Some(value) = element.value(ROUTE_ATTR) {
        if !ROUTES.contains(&value) {
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
}

/// An element the user added in the editor, for the agent to give a place in the layout.
fn check_added(l: &mut Linter, element: &Element, i: usize) {
    let Some(value) = element.value(ADDED_ATTR) else {
        return;
    };
    let what = match value {
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

/// Whether the element name `name`, in whatever case, is one of `names` (lowercase).
fn named(name: &str, names: &[&str]) -> bool {
    names.iter().any(|n| name.eq_ignore_ascii_case(n))
}

/// Takes the tag at `i` into the open elements: an end tag closes, a start tag opens (and
/// may end one whose end tag is optional). Returns where the walk goes on, past the content of
/// a raw-text element.
fn step<'a>(l: &mut Linter<'a>, walk: &mut Walk<'a>, tag: &Tag<'a>, i: usize) -> usize {
    let html = l.html;
    let self_closing = html[..tag.end].ends_with("/>");
    let in_foreign = walk.stack.iter().any(|o| named(o.name, FOREIGN));
    if tag.closing {
        close(l, &mut walk.stack, tag.raw_name(), i);
        if walk.deck_depth.is_some_and(|d| walk.stack.len() < d) {
            walk.deck_depth = None;
        }
    } else if tag.is_any(VOID_ELEMENTS) {
        // No content, no end tag.
    } else if self_closing {
        if !in_foreign && !tag.is_any(FOREIGN) {
            l.report(
                "self-closing-tag",
                Severity::Error,
                i,
                format!(
                    "<{0}/> does not close the element in HTML; write <{0}></{0}>.",
                    tag.name()
                ),
            );
            // Browsers ignore the slash, so the element stays open.
            walk.stack.push(Open::new(tag, i));
        }
    } else {
        // Opening a <p> or <li> implicitly ends a previous one.
        if tag.is_any(OPTIONAL_END) && walk.stack.last().is_some_and(|o| tag.is(o.name)) {
            walk.stack.pop();
        }
        if tag.is("main") && has_class(tag, "deck") && walk.deck_depth.is_none() {
            walk.deck_depth = Some(walk.stack.len() + 1);
        }
        walk.stack.push(Open::new(tag, i));
        if tag.is_any(RAW_TEXT) {
            return tag.end_tag().unwrap_or(html.len());
        }
    }
    tag.end
}

fn close(l: &mut Linter, stack: &mut Vec<Open>, name: &str, at: usize) {
    let Some(pos) = stack
        .iter()
        .rposition(|o| o.name.eq_ignore_ascii_case(name))
    else {
        if !named(name, VOID_ELEMENTS) {
            let name = name.to_ascii_lowercase();
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
        if !named(open.name, OPTIONAL_END) {
            let message = format!(
                "<{}> is never closed (</{}> on line {} ends it implicitly).",
                open.name.to_ascii_lowercase(),
                name.to_ascii_lowercase(),
                l.line(at)
            );
            l.report("unclosed-tag", Severity::Error, open.at, message);
        }
    }
}
