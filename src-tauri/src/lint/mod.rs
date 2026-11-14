//! Lints a deck file: checks that the markup is well formed (every element closed, no stray
//! end tags) and that it follows the deck format the app and player rely on (see
//! `prompts/system.md`). Keep these rules in sync whenever the deck structure changes.
//!
//! The checks, by what they read: [`markup`] walks the tags, [`deck`] checks the deck format,
//! and [`styles`] the deck's CSS, with what it looks for in CSS in [`css`].

mod css;
mod deck;
mod markup;
mod styles;

use serde::Serialize;

use crate::html;

use deck::{
    check_assets, check_comments, check_document, check_links, check_locked, check_morphs,
    check_narration, check_narration_settings, check_review, check_sections, check_slide_size,
    check_slides, check_stuck_lines, check_template,
};
use markup::check_markup;
use styles::{check_entrances, check_slide_id_styles, check_tilts, check_untimed_delays};

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

struct Linter<'a> {
    html: &'a str,
    line_starts: Vec<usize>,
    /// The deck's slides, in document order (see [`html::find_slides`]).
    slides: &'a [html::SlideSpan],
    /// The section markers between them (see [`html::find_sections`]).
    sections: &'a [html::SectionSpan],
    /// Where the texts the checks start from are written.
    marks: Marks,
    issues: Vec<Issue>,
}

/// Where the texts the checks start from are in the document, in whatever case they are
/// written, found in one pass over it: each check searching the whole deck for its own was a
/// dozen passes.
struct Marks {
    /// Where comments, scripts and styles open and close (see [`in_markup`]).
    comments: RawText,
    scripts: RawText,
    styles: RawText,
    /// Where `<meta`, `<img` and `<a` are written, in document order.
    metas: Vec<usize>,
    images: Vec<usize>,
    links: Vec<usize>,
    /// Where `<body` is first written.
    body: Option<usize>,
}

impl Marks {
    fn find(html: &str) -> Self {
        let mut marks = Self {
            comments: RawText::of("<!--", "-->"),
            scripts: RawText::of("<script", "</script"),
            styles: RawText::of("<style", "</style"),
            metas: Vec::new(),
            images: Vec::new(),
            links: Vec::new(),
            body: None,
        };
        let bytes = html.as_bytes();
        for (at, _) in html.match_indices('<') {
            let rest = &bytes[at + 1..];
            let starts = |word: &str| {
                rest.get(..word.len())
                    .is_some_and(|start| start.eq_ignore_ascii_case(word.as_bytes()))
            };
            // What follows the `<` tells them apart by its first letter.
            match rest.first().map(u8::to_ascii_lowercase) {
                Some(b'!') if starts("!--") => marks.comments.opens.push(at),
                Some(b's') if starts("script") => marks.scripts.opens.push(at),
                Some(b's') if starts("style") => marks.styles.opens.push(at),
                Some(b'/') if starts("/script") => marks.scripts.closes.push(at),
                Some(b'/') if starts("/style") => marks.styles.closes.push(at),
                Some(b'm') if starts("meta") => marks.metas.push(at),
                Some(b'i') if starts("img") => marks.images.push(at),
                Some(b'a') => marks.links.push(at),
                Some(b'b') if marks.body.is_none() && starts("body") => marks.body = Some(at),
                _ => {}
            }
        }
        marks.comments.closes = html.match_indices("-->").map(|(at, _)| at).collect();
        marks
    }
}

/// Where one kind of text that is not markup (a comment, a script, a style) opens and closes
/// in the document, found once per lint run.
struct RawText {
    /// Where each opening marker starts, in document order, and how long the marker is.
    opens: Vec<usize>,
    open_len: usize,
    /// The same for the closing marker.
    closes: Vec<usize>,
    close_len: usize,
}

impl RawText {
    /// The kind `open` and `close` mark, its places yet to be found (see [`Marks::find`]).
    fn of(open: &str, close: &str) -> Self {
        Self {
            opens: Vec::new(),
            open_len: open.len(),
            closes: Vec::new(),
            close_len: close.len(),
        }
    }

    /// Where the first opening marker at or after `from` starts.
    fn next_open(&self, from: usize) -> Option<usize> {
        next_at(&self.opens, from)
    }

    /// Where the first closing marker at or after `from` starts.
    fn next_close(&self, from: usize) -> Option<usize> {
        next_at(&self.closes, from)
    }

    /// Whether the text before `at` ends inside this kind: its last opening marker there has
    /// no closing marker after it.
    fn open_at(&self, at: usize) -> bool {
        let before = |starts: &[usize], len: usize| starts.partition_point(|&s| s + len <= at);
        let Some(&open) = before(&self.opens, self.open_len)
            .checked_sub(1)
            .and_then(|last| self.opens.get(last))
        else {
            return false;
        };
        let closed = self.closes[..before(&self.closes, self.close_len)]
            .last()
            .is_some_and(|&close| close >= open);
        !closed
    }
}

/// The first of `places`, which are in document order, at or after `from`.
fn next_at(places: &[usize], from: usize) -> Option<usize> {
    places.get(places.partition_point(|&at| at < from)).copied()
}

impl<'a> Linter<'a> {
    fn new(
        html: &'a str,
        slides: &'a [html::SlideSpan],
        sections: &'a [html::SectionSpan],
    ) -> Self {
        let line_starts = std::iter::once(0)
            .chain(html.match_indices('\n').map(|(i, _)| i + 1))
            .collect();
        Self {
            html,
            line_starts,
            slides,
            sections,
            marks: Marks::find(html),
            issues: Vec::new(),
        }
    }

    fn line(&self, at: usize) -> usize {
        self.line_starts.partition_point(|&s| s <= at)
    }

    /// The slide `at` is in. The slides are in document order and apart from each other, so
    /// the one that could hold `at` is the last that starts at or before it.
    fn slide_span_at(&self, at: usize) -> Option<&'a html::SlideSpan> {
        let slides = self.slides;
        slides[..slides.partition_point(|s| s.range.start <= at)]
            .last()
            .filter(|s| s.range.contains(&at))
    }

    fn slide_at(&self, at: usize) -> Option<String> {
        self.slide_span_at(at).and_then(|s| s.id.clone())
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

/// [`lint_parsed`] of a deck given as its source alone, for tests.
#[cfg(test)]
pub fn lint(
    source: &str,
    asset_exists: impl Fn(&str) -> bool,
    locked: &[html::LockedSlide],
) -> Vec<Issue> {
    let (slides, sections) = html::find_spans(source);
    lint_parsed(source, &slides, &sections, asset_exists, locked)
}

/// Lints the deck `source`, whose `slides` and `sections` are those [`html::find_spans`]
/// finds. `asset_exists` answers whether a deck-relative `assets/…` path exists; `locked` lists
/// the locked slides as an agent turn started (empty outside a turn), and every one the deck
/// changed or removed is reported. Issues come back sorted by line.
pub fn lint_parsed(
    source: &str,
    slides: &[html::SlideSpan],
    sections: &[html::SectionSpan],
    asset_exists: impl Fn(&str) -> bool,
    locked: &[html::LockedSlide],
) -> Vec<Issue> {
    let mut l = Linter::new(source, slides, sections);
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
    check_locked(&mut l, locked);
    l.issues.sort_by_key(|i| (i.line, i.severity));
    l.issues
}

/// The slides whose narration has to wait for an earlier slide's, still playing over them (see
/// [`crate::narration::timeline::overlaps`]), as issues of `source`, whose slides are `slides`.
pub fn narration_overlaps(
    source: &str,
    slides: &[html::SlideSpan],
    overlaps: &[crate::narration::timeline::Overlap],
) -> Vec<Issue> {
    let mut issues = Vec::new();
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
        issues.push(Issue {
            rule: "narration-overlap",
            severity: Severity::Warning,
            message: format!(
                "The narration audio of slide `{under}` still plays when slide `{slide}`'s own narration is to start, so that waits {waits:.1} s{late}. Audio that plays on over later slides leaves them without narration of their own: remove theirs (script and audio), or end `{under}`'s audio sooner."
            ),
            // Few slides overlap, so their lines are counted rather than indexed.
            line: source[..span.range.start].matches('\n').count() + 1,
            slide: span.id.clone(),
        });
    }
    issues
}

/// Whether `at` is in markup rather than inside a comment, script, or style.
fn in_markup(l: &Linter, at: usize) -> bool {
    let marks = &l.marks;
    ![&marks.comments, &marks.scripts, &marks.styles]
        .iter()
        .any(|raw| raw.open_at(at))
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
mod tests;
