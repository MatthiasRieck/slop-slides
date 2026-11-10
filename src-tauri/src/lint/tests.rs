use super::*;
use crate::size::SlideSize;
use crate::{comments, review};
use deck::is_kebab_case;

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
    let line =
        |attrs: &str| format!(r#"<svg {attrs} viewBox="0 0 10 10"><path d="M0 0 L10 10"/></svg>"#);
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
    let reference = include_str!("../../prompts/design-reference.md");
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
        time: None,
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
    let on_a_moment = comments::Comment {
        id: "third".into(),
        text: "Too fast".into(),
        time: Some(3.25),
        ..comment.clone()
    };
    comments::write(
        &deck(r#"<section class="slide" id="intro"><p>Hi</p></section>"#),
        &[("intro".to_string(), vec![comment, on_area, on_a_moment])].into(),
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
    // A comment's moment is seconds since its slide showed: a number, and not before that.
    assert!(html.contains("\"time\":3.25"));
    for bad in ["\"time\":-3.25", "\"time\":\"soon\""] {
        assert_eq!(
            rules(&html.replace("\"time\":3.25", bad)),
            ["comments-invalid"]
        );
    }
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
    let template = include_str!("../../assets/deck-template.html").replace("{{TITLE}}", "Talk");
    let blank = include_str!("../../assets/blank-slide.html").replace("{{ID}}", "untitled");
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
    let html = deck("<section class=\"slide\" id=\"a\">\n<div><span>x</div>\n</section>\n</em>");
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
            format!("{selector} {{ color: red; }}"),
            format!("@media print {{ {selector} {{ color: red; }} }}"),
            format!(".deck {{ color: black; & {selector} {{ color: red; }} }}"),
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
    let fixed = styled(".layout-title { color: red; } .layout-title .card { padding: 20px; }");
    assert!(lint(&fixed, |_| true, &[]).is_empty());
}

#[test]
fn slide_id_styles_ignore_declarations_comments_strings_and_other_ids() {
    let source =
        deck(r##"<section class="slide" id="abc"><svg><path id="icon"/></svg></section>"##)
            .replace(
                "<style>.slide {}</style>",
                r##"<style>
/* #abc { color: red; } */
#icon { fill: red; }
#abc-longer { color: red; }
.layout { color: #abc; --color: #abc; content: "#abc { }"; background: url(#abc); }
[data-label="#abc"] { color: blue; }
@supports (color: #abc) { .layout { color: #abc; } }
</style>"##,
            );
    assert!(lint(&source, |_| true, &[]).is_empty());
    let fake = format!(
        "{}<!-- <style>#abc {{}}</style> --><script>const s = '<style>#abc {{}}</style>';</script>",
        source
    );
    assert!(lint(&fake, |_| true, &[]).is_empty());
}

#[test]
fn slide_id_styles_report_each_selector_at_its_line_in_any_style_block() {
    let source = deck(r#"<section class="slide" id="title"></section>"#)
        .replace("<style>.slide {}</style>", "<style>\n#title { color: red; }\n@media print {\n#title h1 { color: black; }\n}\n</style>\n<style>#title { padding: 1px; }</style>");
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
    let source = deck(r#"<section class="slide" id="title"><h1>AI-KIT</h1></section>"#).replace(
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
        "@container (width > 100px) { #title { color: red; } }",
        "@scope (#title) { .card { color: red; } }",
        ":is(#title, #title-copy) .card { color: red; }",
        "#title, #title-copy { color: red; }",
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
        "@keyframes pop { 0% { opacity: 0; } 100% { opacity: 1; } } .x { color: red; }",
        "/* .word { animation-delay: 3s; } */ .x { color: red; }",
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
    let found = rules(&deck(
        "<div>loose</div>\nloose text\n<section class=\"slide\" id=\"a\"><div>fine</div></section>",
    ));
    assert_eq!(found, ["deck-stray-content", "deck-stray-content"]);
    assert_eq!(
        rules(&deck(
            "<section class=\"slide\" id=\"a\"><section class=\"slide\">nested</section></section>"
        )),
        Vec::<&str>::new()
    );
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
fn hand_styling_needs_no_rules_of_its_own() {
    // Cut-out shapes and arrows are added elements like any other, and the look the toolbar
    // sets (opacity, shadow, radius, image fit and flips, a slide's background) is inline style.
    let found = lint(
        &deck(
            "<section class=\"slide\" id=\"a\" style=\"background-color: #ff0000; background-image: none\">\n<div data-added=\"shape\" style=\"position: absolute; clip-path: polygon(50% 0%, 100% 100%, 0% 100%)\">Hi</div>\n<svg data-added=\"drawing\" viewBox=\"0 0 30 30\" style=\"position: absolute; filter: drop-shadow(0px 4px 12px rgba(0, 0, 0, 0.35))\"><path d=\"M3 15 L27 15 M15 3 L27 15 L15 27\" stroke=\"#111111\"/></svg>\n<img src=\"https://example.test/a.png\" alt=\"A cat\" style=\"opacity: 0.5; box-shadow: 0px 8px 24px black; border-radius: 16px; object-fit: cover; object-position: 50% 0%; transform: scaleX(-1) !important\">\n</section>",
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
            "<section class=\"slide\" id=\"a\">\n<div data-added=\"shape\" data-shape=\"block-arrow\" style=\"position: absolute; left: 0px; top: 0px; width: 320px; height: 200px; padding: 54px 96px 54px 13px; background-image: url(&quot;data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' preserveAspectRatio='none'%3E%3Cg transform='matrix(-1 0 0 1 100 0)'%3E%3Cpath d='M0 25 L65 25 L65 0 L100 50 L65 100 L65 75 L0 75 Z' fill='%233b82f6'/%3E%3C/g%3E%3C/svg%3E&quot;); background-size: 100% 100%; background-repeat: no-repeat; filter: drop-shadow(0px 8px 24px rgba(0, 0, 0, 0.35))\">Next</div>\n<svg data-added=\"drawing\" data-outline=\"brace\" viewBox=\"0 0 60 200\" style=\"position: absolute; left: 400px; top: 0px; width: 60px; height: 200px\"><path d=\"M57 3 Q30 3 30 57 L30 46 Q30 100 3 100\" stroke=\"#111111\" stroke-width=\"6\" fill=\"none\"/></svg>\n</section>",
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
            "<section class=\"slide\" id=\"a\">\n<div id=\"box\" data-lock=\"\" style=\"position: absolute\">A</div>\n<div data-group=\"\" style=\"position: absolute; left: 0px; top: 0px; width: 500px; height: 300px\"><div data-shape=\"star\" data-adjust=\"7\" style=\"position: absolute\">Hi</div><div data-shape=\"cylinder\" data-adjust=\"12.5\">Db</div></div>\n<svg data-route=\"elbow\" data-from=\"box\" data-from-at=\"50% 100%\" viewBox=\"0 0 10 10\"><path d=\"M3 3 L3 103 L453 103\" stroke=\"#111111\" stroke-dasharray=\"12 18\" fill=\"none\"/><path data-head=\"start dot\" d=\"M0 3 A3 3 0 1 0 6 3 A3 3 0 1 0 0 3 Z\"/><path data-head=\"end triangle\" d=\"M0 0 L5 5 L0 10 Z\"/></svg>\n</section>",
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
fn checks_the_text_body_of_text_boxes_and_shapes() {
    // The body is the box's only child and holds whatever the text is made of.
    let fine = "<section class=\"slide\" id=\"a\">\n<div class=\"note\" style=\"display: flex\"><div data-text-body=\"\">One <span style=\"font-weight: 700\">bold</span><br>Two<ul><li>Three</li></ul></div></div>\n</section>";
    assert_eq!(rules(&deck(fine)), Vec::<&str>::new());
    let found = lint(
        &deck(
            "<section class=\"slide\" id=\"a\">\n<div class=\"a\"><div data-text-body=\"\">One</div><span>Two</span><span>Three</span></div>\n<div class=\"b\"><p>One</p><div data-text-body=\"\">Two</div></div>\n<p data-text-body=\"\">Three</p>\n</section>",
        ),
        |_| true,
        &[],
    );
    let found: Vec<_> = found.iter().map(|i| (i.rule, i.line)).collect();
    assert_eq!(
        found,
        [("text-body", 11), ("text-body", 12), ("text-body", 13)]
    );
}

#[test]
fn curved_lines_need_no_rules_of_their_own() {
    // A line the user bent is a drawing like a straight one: one path, the arrow's head in it.
    let found = lint(
        &deck(
            "<section class=\"slide\" id=\"a\">\n<svg data-added=\"drawing\" viewBox=\"0 0 206 106\" style=\"position: absolute; left: 97px; top: 97px; width: 206px; height: 106px; overflow: visible\"><path d=\"M3 3 C36.3 3 69.7 103 103 103 C136.3 103 169.7 3 203 3 M182 15 L203 3 L182 -9\" stroke=\"#111111\" stroke-width=\"6\" fill=\"none\"/></svg>\n</section>",
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
            "<section class=\"slide\" id=\"a\">\n<div data-added=\"text\" style=\"position: absolute; left: 10px; top: 20px\">Hi</div>\n<div data-added=\"shape\" style=\"position: absolute; left: 0px; top: 0px; width: 320px; height: 200px\"></div>\n<svg data-added=\"drawing\" viewBox=\"0 0 10 10\" style=\"position: absolute\"><path d=\"M0 0 L10 10\" stroke=\"#111111\"/></svg>\n</section>",
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
    assert!(report.contains("line 10 error [unclosed-tag] (slide `Bad`): <span> is never closed"));
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
        &deck("<div class=\"deck-section\"></div>\n<section class=\"slide\" id=\"a\">A</section>"),
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
    let own = "@keyframes rise { from { opacity: 0; translate: 0 20px; } to { opacity: 1; } }\n\
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
    let lookalikes = "@keyframes rise { from { text-transform: none; transform-origin: 0 0; } }\n\
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
        let html =
            with("openai", "coral").replace("content=\"openai\"", &format!("content=\"{bad}\""));
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

#[test]
fn markup_is_told_from_comments_scripts_and_styles_as_a_scan_of_the_text_before_would() {
    // What `in_markup` answered before the ranges were found once per run: a scan of
    // everything before `at`.
    fn scanned(html: &str, at: usize) -> bool {
        let before = &html[..at];
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
    let documents = [
        "<p>a</p><!-- <meta> --><p>b</p><!--> c <!-- open <p>",
        "<STYLE>.a{}</Style><p>x</p><style>.b{}<style>.c{}</style><p>y</p>",
        "<script>if (a</b) '<!--'</script><p>-->x</p><ScRiPt>let s = '</style>'",
        "<style>/* <script> */</style><p>z</p></script><!---->-->",
        "",
    ];
    for html in documents {
        let l = Linter::new(html);
        for at in 0..=html.len() {
            assert_eq!(in_markup(&l, at), scanned(html, at), "{html:?} at {at}");
        }
    }
}
