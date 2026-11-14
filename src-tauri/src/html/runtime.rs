//! The player runtime: the app-managed blocks of CSS and JavaScript every deck embeds.

use super::edit::{insert_after_head, remove};
use super::meta::slide_size;
use super::scan::rfind_ci;

const RUNTIME_CSS: &str = include_str!("../../assets/runtime.css");
const RUNTIME_JS: &str = include_str!("../../assets/runtime.js");
pub(crate) const CSS_START: &str =
    "<!-- slopslide:runtime-css (managed by SlopSlide, do not edit) -->";
const CSS_END: &str = "<!-- /slopslide:runtime-css -->";
pub(crate) const JS_START: &str =
    "<!-- slopslide:runtime-js (managed by SlopSlide, do not edit) -->";
const JS_END: &str = "<!-- /slopslide:runtime-js -->";
/// Runs in `<head>` so the player's stylesheet applies before the first paint. Viewers without
/// JavaScript skip it and get the stylesheet's fallback: every slide, top to bottom.
pub(crate) const PLAYER_FLAG: &str =
    "<script>document.documentElement.setAttribute(\"data-slop-player\", \"\");</script>";

/// Installs (or refreshes) the player runtime: base CSS first in `<head>` so deck styles
/// override it, and the script at the end of `<body>`.
/// The stage takes the size named in the deck's `slopslide-size` meta, so refresh the runtime
/// whenever that changes.
pub fn ensure_runtime(html: &str) -> String {
    let stage = slide_size(html).runtime_css();
    let css = format!(
        "{CSS_START}\n  <style>\n{RUNTIME_CSS}{stage}  </style>\n  {PLAYER_FLAG}\n  {CSS_END}"
    );
    let js = format!("{JS_START}\n  <script>\n{RUNTIME_JS}  </script>\n  {JS_END}");
    let html = match replace_block(html, CSS_START, CSS_END, &css) {
        Some(updated) => updated,
        None => insert_after_head(html, &format!("\n  {css}")),
    };
    match replace_block(&html, JS_START, JS_END, &js) {
        Some(updated) => updated,
        None => {
            let at = rfind_ci(&html, "</body").unwrap_or(html.len());
            format!("{}  {js}\n{}", &html[..at], &html[at..])
        }
    }
}

fn replace_block(html: &str, start: &str, end: &str, block: &str) -> Option<String> {
    let s = html.find(start)?;
    let e = html[s..].find(end)? + s + end.len();
    Some(format!("{}{}{}", &html[..s], block, &html[e..]))
}

/// `html` without the player runtime blocks, e.g. for the agent to read a template.
pub fn without_runtime(html: &str) -> String {
    let mut out = html.to_string();
    for (start, end) in [(CSS_START, CSS_END), (JS_START, JS_END)] {
        if let Some(s) = out.find(start) {
            if let Some(e) = out[s..].find(end) {
                out = remove(&out, &(s..s + e + end.len()));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::html::fixtures::*;
    use crate::html::*;
    use crate::size::SlideSize;

    #[test]
    fn runtime_is_installed_once_and_refreshed() {
        let once = ensure_runtime(DECK);
        assert!(once.contains(RUNTIME_CSS) && once.contains(RUNTIME_JS));
        let twice = ensure_runtime(&once);
        assert_eq!(once, twice);
        assert_eq!(once.matches(CSS_START).count(), 1);
        assert!(once.find(CSS_START).unwrap() < once.find("<title>").unwrap());
        assert!(once.find(JS_START).unwrap() > once.find("</main>").unwrap());
        assert_eq!(ids(&once), ["intro", "plan", ""]);
    }

    #[test]
    fn ensure_runtime_works_without_head_or_body() {
        let out = ensure_runtime(r#"<section class="slide" id="a"></section>"#);
        assert!(out.starts_with("\n  ") && out.contains(CSS_START));
        assert!(out.contains(JS_END));
        assert!(out.find(CSS_END).unwrap() < out.find("<section").unwrap());
        assert!(out.find(JS_START).unwrap() > out.find("</section>").unwrap());
        assert_eq!(
            ids(&out),
            ["a"],
            "runtime script is not mistaken for slides"
        );
    }

    #[test]
    fn ensure_runtime_replaces_a_stale_or_edited_runtime() {
        let stale = DECK
            .replace(
                "</head>",
                &format!("{CSS_START}<style>old</style>{CSS_END}</head>"),
            )
            .replace(
                "</body>",
                &format!("{JS_START}<script>tampered()</script>{JS_END}</body>"),
            );
        let out = ensure_runtime(&stale);
        assert!(!out.contains("old</style>"));
        assert!(!out.contains("tampered()"));
        assert_eq!(out.matches(JS_START).count(), 1);
        assert!(out.contains(RUNTIME_JS));
        // Refreshed in place: the block stays after the deck's own <style>.
        assert!(out.find(CSS_START).unwrap() > out.find(".slide { color: red }").unwrap());
        assert_eq!(out, ensure_runtime(&out));
    }

    #[test]
    fn ensure_runtime_flags_the_player_inside_the_css_block() {
        let out = ensure_runtime(DECK);
        let flag = out.find(PLAYER_FLAG).expect("player flag installed");
        assert!(out.find(CSS_START).unwrap() < flag && flag < out.find(CSS_END).unwrap());
        assert!(
            flag < out.find("<body").unwrap(),
            "runs before the body renders"
        );
        assert_eq!(out.matches(PLAYER_FLAG).count(), 1);
        // Decks saved before the flag existed get it on refresh.
        let old = DECK.replace(
            "</head>",
            &format!("{CSS_START}<style>{RUNTIME_CSS}</style>{CSS_END}</head>"),
        );
        assert_eq!(ensure_runtime(&old).matches(PLAYER_FLAG).count(), 1);
    }

    #[test]
    fn the_runtime_entrance_keeps_transforms_and_its_stagger() {
        let start = RUNTIME_CSS.find("@keyframes slop-reveal").unwrap();
        let keyframes = &RUNTIME_CSS[start..start + RUNTIME_CSS[start..].find("\n}").unwrap()];
        assert!(
            !keyframes.contains("transform"),
            "an entrance leaves the elements' own transforms alone"
        );
        for n in 1..=4 {
            // Outranks a deck's `.slide.active .reveal { animation: … }`, which resets the delay.
            assert!(
                RUNTIME_CSS.contains(&format!(
                    ".slide.active .reveal.reveal-delay-{n} {{ animation-delay:"
                )),
                "reveal-delay-{n}"
            );
        }
    }

    /// Example decks open straight in a browser with their embedded runtime, so it must be the
    /// current one (a deck saved by an older build loses newer player features, like morphs).
    /// Run with SLOP_UPDATE_EXAMPLES=1 to refresh them.
    #[test]
    fn example_decks_embed_the_current_runtime() {
        let examples = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples");
        for entry in std::fs::read_dir(&examples).unwrap() {
            let path = entry.unwrap().path().join("deck.html");
            let Ok(html) = std::fs::read_to_string(&path) else {
                continue;
            };
            let current = ensure_runtime(&html);
            if std::env::var_os("SLOP_UPDATE_EXAMPLES").is_some() {
                std::fs::write(&path, &current).unwrap();
            } else {
                assert!(
                    html == current,
                    "{} embeds a stale runtime; rerun with SLOP_UPDATE_EXAMPLES=1",
                    path.display()
                );
            }
        }
    }

    #[test]
    fn ensure_runtime_sizes_the_stage_from_the_meta() {
        let landscape = ensure_runtime(DECK);
        assert!(landscape.contains("--slop-w: 1920px;") && landscape.contains("--slop-h: 1080px;"));
        let portrait = ensure_runtime(&set_slide_size(
            &landscape,
            SlideSize::parse("1080x1920").unwrap(),
        ));
        assert!(portrait.contains("--slop-w: 1080px;") && portrait.contains("--slop-h: 1920px;"));
        assert!(portrait.contains("size: 1080px 1920px;"));
        assert!(
            !portrait.contains("--slop-w: 1920px;"),
            "refreshed, not added twice"
        );
        assert_eq!(portrait.matches(CSS_START).count(), 1);
        assert_eq!(portrait, ensure_runtime(&portrait));
        let start = portrait.find(CSS_START).unwrap();
        let end = portrait.find(CSS_END).unwrap();
        assert!((start..end).contains(&portrait.find("--slop-w: 1080px;").unwrap()));
    }

    #[test]
    fn removes_the_runtime_blocks() {
        let with = ensure_runtime(STYLED);
        assert!(with.contains(CSS_START) && with.contains(JS_START));
        let without = without_runtime(&with);
        assert!(!without.contains("slopslide:runtime"));
        assert_eq!(without_runtime(STYLED), STYLED);
        assert_eq!(find_slides(&without).len(), 2);
    }
}
