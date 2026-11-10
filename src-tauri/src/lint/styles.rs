//! The checks of the deck's styles: its `<style>` blocks, and inline styles. What they look
//! for in the CSS is in [`super::css`].

use std::collections::HashSet;
use std::ops::Range;

use crate::html::{find_ci, parse_tag, MOVED_ATTR};

use super::css::{
    animates_reveal, css_id_references, easing_vars, steep_tilts, transform_keyframes,
    untimed_delays, STEEPEST_TILT,
};
use super::{in_markup, truncate, Issue, Linter, Severity};

/// The content of each `<style>` block in the deck's markup (not in a comment or script).
fn style_blocks(l: &Linter) -> Vec<Range<usize>> {
    let html = l.html;
    let mut blocks = Vec::new();
    let mut from = 0;
    while let Some(open) = find_ci(html, from, "<style") {
        let Some(start) = html[open..].find('>').map(|i| open + i + 1) else {
            break;
        };
        let end = find_ci(html, start, "</style").unwrap_or(html.len());
        from = end;
        if in_markup(l, open) {
            blocks.push(start..end);
        }
    }
    blocks
}

/// Slide ids are identity, not styling hooks: copies get new ids but retain classes.
pub(super) fn check_slide_id_styles(l: &mut Linter) {
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

/// Entrance keyframes (those a `.reveal` rule animates with) must not animate `transform`:
/// held by `both` fill, it would replace each element's own transform and tilt.
pub(super) fn check_entrances(l: &mut Linter) {
    for Range { start, end } in style_blocks(l) {
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

/// Animations delayed to time them (by [`TIMED_DELAY`] or more, or by a `var()` or `calc()`) in
/// rules not under `.active`: such an animation starts when the page loads, so in the show and
/// in video exports its delay counts from then rather than from when its slide shows, and what
/// it is timed to has long passed. A loop that runs whatever slide shows has no such delay.
pub(super) fn check_untimed_delays(l: &mut Linter) {
    let html = l.html;
    let easings = easing_vars(html);
    for Range { start, end } in style_blocks(l) {
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

/// 3D tilts steeper than [`STEEPEST_TILT`] in the deck's styles: WebKit draws a page off screen
/// (video and image exports, PDFs, `render_slide`) with perspective flattened, so a steep tilt
/// comes out sheared and squashed, or as a thin line, though the editor shows it right. The
/// user's own tilts (on `data-moved` elements) are theirs.
pub(super) fn check_tilts(l: &mut Linter) {
    let html = l.html;
    let mut found = Vec::new();
    for Range { start, end } in style_blocks(l) {
        found.extend(
            steep_tilts(&html[start..end])
                .into_iter()
                .map(|(at, deg)| (start + at, deg)),
        );
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
