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
    check_locked(&mut l, locked);
    l.issues.sort_by_key(|i| (i.line, i.severity));
    l.issues
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
mod tests;
