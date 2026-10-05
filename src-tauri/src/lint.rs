//! Lints deck.html: checks that the markup is well formed (every element closed, no stray
//! end tags) and that it follows the deck format the app and player rely on (see
//! `prompts/system.md`). Keep these rules in sync whenever the deck structure changes.

use std::collections::HashSet;

use serde::Serialize;

use crate::html::{self, find_ci, has_class, parse_tag, HIDDEN_ATTR};

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
    /// 1-based line in deck.html.
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

/// Lints a deck. `asset_exists` answers whether a deck-relative `assets/…` path exists.
/// Issues come back sorted by line.
pub fn lint(source: &str, asset_exists: impl Fn(&str) -> bool) -> Vec<Issue> {
    let mut l = Linter::new(source);
    check_markup(&mut l);
    check_document(&mut l);
    check_slides(&mut l);
    check_assets(&mut l, asset_exists);
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
                if !is_slide && !matches!(tag.name.as_str(), "script" | "template") {
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
            if l.slides.iter().any(|s| s.range.contains(&i)) {
                if tag.name == "style" {
                    l.report(
                        "style-in-slide",
                        Severity::Warning,
                        i,
                        "Move this <style> into the single <style> in <head>, scoped by the slide id.".into(),
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
            "deck.html should start with <!DOCTYPE html>.".into(),
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
    if !has_deck_container(html) {
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

fn has_deck_container(html: &str) -> bool {
    let mut from = 0;
    while let Some(at) = find_ci(html, from, "<main") {
        if parse_tag(html, at).is_some_and(|t| t.name == "main" && has_class(&t, "deck")) {
            return true;
        }
        from = at + 1;
    }
    false
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
        if let Some(attr) = &slide.hidden {
            let attr = &l.html[attr.clone()];
            if attr.contains('=') && !attr.ends_with("\"\"") && !attr.ends_with("''") {
                l.report(
                    "hidden-value",
                    Severity::Warning,
                    at,
                    format!(
                        "Write `{HIDDEN_ATTR}` without a value; any value still hides the slide."
                    ),
                );
            }
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
                format!("`{path}` does not exist in the deck's assets folder."),
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
        return "deck.html passes lint: no issues.".into();
    }
    let errors = issues
        .iter()
        .filter(|i| i.severity == Severity::Error)
        .count();
    let warnings = issues.len() - errors;
    let mut out = format!("deck.html has {errors} error(s) and {warnings} warning(s):\n");
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
        lint(html, |p| p == "assets/logo.png")
            .into_iter()
            .map(|i| i.rule)
            .collect()
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
        assert_eq!(lint(&html, |p| p == "assets/logo.png"), vec![]);
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
    fn reports_unclosed_and_stray_tags_with_lines() {
        let html =
            deck("<section class=\"slide\" id=\"a\">\n<div><span>x</div>\n</section>\n</em>");
        let issues = lint(&html, |_| true);
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
    fn flags_content_outside_slides_in_the_deck() {
        let found = rules(&deck("<div>loose</div>\nloose text\n<section class=\"slide\" id=\"a\"><div>fine</div></section>"));
        assert_eq!(found, ["deck-stray-content", "deck-stray-content"]);
        assert_eq!(rules(&deck("<section class=\"slide\" id=\"a\"><section class=\"slide\">nested</section></section>")), Vec::<&str>::new());
    }

    #[test]
    fn flags_styles_and_scripts_inside_slides() {
        let found = rules(&deck(
            "<section class=\"slide\" id=\"a\"><style>p{}</style><script>1</script></section>",
        ));
        assert_eq!(found, ["style-in-slide", "script-in-slide"]);
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
        let issues = lint(&html, |_| true);
        assert!(issues.windows(2).all(|w| w[0].line <= w[1].line));
        let report = format_report(&issues);
        assert!(
            report.starts_with("deck.html has 1 error(s) and 1 warning(s):"),
            "{report}"
        );
        assert!(
            report.contains("line 10 error [unclosed-tag] (slide `Bad`): <span> is never closed")
        );
        assert_eq!(format_report(&[]), "deck.html passes lint: no issues.");
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
}
