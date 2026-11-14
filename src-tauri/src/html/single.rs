//! A deck cut down to one slide, for the previews that show one (the stage, the rail's
//! thumbnails, the layouts of a template). A preview given the whole deck styles and lays out
//! every slide, fetches every image and fits every text box of it, once per preview; given this,
//! it does that for its own slide only.
//!
//! Everything around the slides stays byte for byte, and so does the slide asked for. Each other
//! slide stays as its opening tag and `</section>`: an empty element in the same place, so
//! `:nth-child`, CSS counters and the player's own count of the slides, by which it finds `#3`,
//! all come out as in the whole deck. The deck file never looks like this; only a page served
//! to a preview does (see `protocol.rs`).
//!
//! The slide editor looks one thing up in the other slides: whether an id is taken, before it
//! gives an element a new one or lets a pasted copy keep its own (`freshId` and `idTaken` in
//! `assets/editor/60-sticky-ends.js`). For it the stand-ins keep the ids of what they stand for,
//! each on an empty element ([`Others::Ids`]).

use std::borrow::Cow;

use super::scan::{parse_tag, tags};
#[cfg(test)]
use super::spans::find_slides;
use super::spans::SlideSpan;

/// What stands in for the slides a preview does not show.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Others {
    /// Empty elements: all a preview that only shows its slide needs.
    Empty,
    /// Elements holding one empty `<i>` for each id in the slide, so that the page still has
    /// every id of the deck: for the slide editor.
    Ids,
}

/// The slide a preview's `slide` parameter names, as the player's `indexFor` reads it (see
/// `assets/runtime.js`): the first slide with that id, else a 1-based position (`#3`) kept within
/// the deck, else the first slide. None for a deck without slides.
fn index_for(slides: &[SlideSpan], reference: &str) -> Option<usize> {
    if slides.is_empty() {
        return None;
    }
    if reference.is_empty() {
        return Some(0);
    }
    if let Some(index) = slides
        .iter()
        .position(|slide| slide.id.as_deref() == Some(reference))
    {
        return Some(index);
    }
    let number = leading_integer(reference.strip_prefix('#').unwrap_or(reference));
    Some(number.map_or(0, |n| n.clamp(1, slides.len() as i64) as usize - 1))
}

/// What JavaScript's `parseInt(text, 10)` makes of `text`: the whole number it starts with, after
/// any white space; None where that gives `NaN`.
fn leading_integer(text: &str) -> Option<i64> {
    let text = text.trim_start();
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    if end == 0 {
        return None;
    }
    // More digits than fit is far past any deck's last slide either way.
    let number = digits[..end].parse::<i64>().unwrap_or(i64::MAX);
    Some(if negative { -number } else { number })
}

/// The opening tag of `slide` for its stand-in. A `style` attribute that loads something
/// (`url(…)`, a background image as a rule) is left out, so the stand-in fetches nothing.
fn stub_tag<'a>(html: &'a str, slide: &SlideSpan) -> Cow<'a, str> {
    let Some(tag) = parse_tag(html, slide.range.start) else {
        return Cow::Borrowed("<section class=\"slide\">");
    };
    let open = &html[slide.range.start..tag.end];
    let loading = tag
        .attr("style")
        .filter(|style| style.value.contains("url("));
    match loading {
        Some(style) => {
            let (from, to) = (
                style.range.start - slide.range.start,
                style.range.end - slide.range.start,
            );
            Cow::Owned(format!("{}{}", &open[..from], &open[to..]))
        }
        None => Cow::Borrowed(open),
    }
}

/// An empty element for each id inside `slide` (not its own), as the id is written there.
fn id_holders(html: &str, slide: &SlideSpan, out: &mut String) {
    let Some(open) = parse_tag(html, slide.range.start) else {
        return;
    };
    let inside = &html[open.end..slide.range.end];
    for (_, tag) in tags(inside) {
        if let Some(id) = tag.attr("id").filter(|id| !id.value.is_empty()) {
            out.push_str("<i ");
            out.push_str(&inside[id.range]);
            out.push_str("></i>");
        }
    }
}

/// [`single_slide_of`] of a page given as its source alone, for tests.
#[cfg(test)]
pub fn single_slide<'a>(html: &'a str, reference: &str, others: Others) -> Cow<'a, str> {
    single_slide_of(html, &find_slides(html), reference, others)
}

/// `html` with only the slide `reference` names (an id, or a position as `#3`) left whole: the
/// other slides are stand-ins, as `others` says. `html` itself when it has no slides. `slides`
/// are its slides (see [`super::find_slides`]), known already: the previews of one deck share them.
pub fn single_slide_of<'a>(
    html: &'a str,
    slides: &[SlideSpan],
    reference: &str,
    others: Others,
) -> Cow<'a, str> {
    slides_of(html, slides, &[reference], others)
}

/// [`single_slide_of`] keeping every slide `references` name whole: one page in which each of
/// them shows as it does in a preview of its own, for the thumbnails made in one go (see
/// `thumbnails.rs`).
pub fn slides_of<'a>(
    html: &'a str,
    slides: &[SlideSpan],
    references: &[&str],
    others: Others,
) -> Cow<'a, str> {
    let mut kept: Vec<usize> = references
        .iter()
        .filter_map(|reference| index_for(slides, reference))
        .collect();
    if kept.is_empty() {
        return Cow::Borrowed(html);
    }
    kept.sort_unstable();
    kept.dedup();
    let kept_len: usize = kept.iter().map(|&k| slides[k].range.len()).sum();
    let mut out = String::with_capacity(html.len() - slides_len(slides) + kept_len);
    let mut at = 0;
    for (index, slide) in slides.iter().enumerate() {
        out.push_str(&html[at..slide.range.start]);
        if kept.binary_search(&index).is_ok() {
            out.push_str(&html[slide.range.clone()]);
        } else {
            out.push_str(&stub_tag(html, slide));
            if others == Others::Ids {
                id_holders(html, slide, &mut out);
            }
            out.push_str("</section>");
        }
        at = slide.range.end;
    }
    out.push_str(&html[at..]);
    Cow::Owned(out)
}

fn slides_len(slides: &[SlideSpan]) -> usize {
    slides.iter().map(|slide| slide.range.len()).sum()
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::DECK;
    use super::*;

    /// As a preview that only shows its slide gets it.
    fn single_slide<'a>(html: &'a str, reference: &str) -> Cow<'a, str> {
        super::single_slide(html, reference, Others::Empty)
    }

    const PICTURES: &str = r#"<!DOCTYPE html><html><head><style>
.slide::after { counter-increment: n; content: counter(n); }
.cover { background: url(assets/shared.png) }
</style></head><body>
  <main class="deck">
    <section class="slide cover" id="a" style="background-image: url('assets/a-bg.png')"><img src="assets/a.png"></section>
    <div class="deck-section" data-title="Part"></div>
    <section class="slide" id="b" data-hidden><img src="assets/b.png"><section class="inner">x</section></section>
    <section class="slide" style="color: red"><video src="assets/c.mp4"></video></section>
    <section class="slide" id="d"><p>Last</p></section>
  </main>
  <script>player()</script>
</body></html>"#;

    /// The document with every slide cut out: what must not change.
    fn shell(html: &str) -> String {
        let mut out = String::new();
        let mut at = 0;
        for slide in find_slides(html) {
            out.push_str(&html[at..slide.range.start]);
            at = slide.range.end;
        }
        out.push_str(&html[at..]);
        out
    }

    fn body(html: &str, slide: &SlideSpan) -> String {
        let open = parse_tag(html, slide.range.start).unwrap().end;
        html[open..slide.range.end - "</section>".len()].to_string()
    }

    #[test]
    fn keeps_one_slide_whole_and_the_others_as_empty_stand_ins() {
        let whole = find_slides(PICTURES);
        for (kept, reference) in [(0, "a"), (1, "b"), (2, "#3"), (3, "d")] {
            let single = single_slide(PICTURES, reference);
            let slides = find_slides(&single);
            assert_eq!(slides.len(), whole.len(), "{reference}: as many slides");
            assert_eq!(shell(&single), shell(PICTURES), "{reference}: same shell");
            for (index, slide) in slides.iter().enumerate() {
                assert_eq!(slide.id, whole[index].id, "{reference}: ids in place");
                assert_eq!(slide.hidden.is_some(), whole[index].hidden.is_some());
                if index == kept {
                    assert_eq!(
                        &single[slide.range.clone()],
                        &PICTURES[whole[index].range.clone()],
                        "{reference}: the slide verbatim"
                    );
                } else {
                    assert_eq!(
                        body(&single, slide),
                        "",
                        "{reference}: slide {index} is empty"
                    );
                }
            }
        }
    }

    #[test]
    fn keeps_several_slides_whole_each_as_in_a_preview_of_its_own() {
        let whole = find_slides(PICTURES);
        let several = slides_of(PICTURES, &whole, &["d", "#1", "nope", "d"], Others::Empty);
        let slides = find_slides(&several);
        assert_eq!(shell(&several), shell(PICTURES), "same shell");
        assert_eq!(slides.len(), whole.len());
        // "nope" names no slide, so it falls back on the first, as a preview of it does.
        for (index, slide) in slides.iter().enumerate() {
            match index {
                0 | 3 => assert_eq!(
                    &several[slide.range.clone()],
                    &PICTURES[whole[index].range.clone()]
                ),
                _ => assert_eq!(body(&several, slide), "", "slide {index} is empty"),
            }
        }
        for reference in ["a", "b", "#3", "d"] {
            assert_eq!(
                slides_of(PICTURES, &whole, &[reference], Others::Empty),
                single_slide(PICTURES, reference),
                "one slide is the preview of it"
            );
        }
        assert_eq!(
            slides_of("<p>no slides</p>", &[], &["a"], Others::Empty),
            "<p>no slides</p>"
        );
    }

    #[test]
    fn leaves_no_asset_of_another_slide() {
        let single = single_slide(PICTURES, "b");
        assert!(single.contains("assets/b.png"));
        assert!(single.contains("assets/shared.png"), "the shell's own stay");
        for other in ["assets/a.png", "assets/a-bg.png", "assets/c.mp4"] {
            assert!(!single.contains(other), "{other} survived");
        }
        assert!(
            single.contains(r#"<section class="slide cover" id="a" ></section>"#),
            "a stand-in loses a style that loads something: {single}"
        );
        assert!(
            single.contains(r#"<section class="slide" style="color: red"></section>"#),
            "and keeps any other"
        );
    }

    /// The page the browser preview's own cut (`singleSlide` in dev/browserPreview.ts) and the
    /// player's tests (src/test/playerRuntime.test.ts) are held to as well.
    #[test]
    fn cuts_the_shared_example_as_the_frontend_tests_expect() {
        let deck = include_str!("../../../src/test/fixtures/single-slide/deck.html");
        let second = include_str!("../../../src/test/fixtures/single-slide/second.html");
        assert_eq!(single_slide(deck, "#2"), second);
        assert_eq!(
            single_slide(second, "#2"),
            second,
            "cutting again changes nothing"
        );
        let edited = include_str!("../../../src/test/fixtures/single-slide/second-edited.html");
        assert_eq!(super::single_slide(deck, "#2", Others::Ids), edited);
    }

    #[test]
    fn the_editors_page_still_has_every_id_of_the_deck() {
        let html = r#"<main class="deck">
<section class="slide" id="a"><p id="el-1">One</p><svg><linearGradient ID='fade'/></svg><img id=logo src="assets/a.png"><!-- <b id="ghost"></b> --><script id="code">var s = '<b id="fake">';</script><p id="">x</p></section>
<section class="slide" id="b"><p id="el-2">Two</p></section>
</main>"#;
        let page = super::single_slide(html, "b", Others::Ids);
        assert!(
            page.contains(
                r#"<section class="slide" id="a"><i id="el-1"></i><i ID='fade'></i><i id=logo></i></section>"#
            ),
            "{page}"
        );
        assert!(page.contains(r#"<section class="slide" id="b"><p id="el-2">Two</p></section>"#));
        assert!(!page.contains("assets/a.png") && !page.contains("One"));
        // Without the editor there is nothing to look ids up for.
        assert!(single_slide(html, "b").contains(r#"<section class="slide" id="a"></section>"#));
    }

    #[test]
    fn finds_the_slide_as_the_player_does() {
        let kept = |reference: &str| {
            let single = single_slide(DECK, reference).into_owned();
            let slides = find_slides(&single);
            let whole: Vec<usize> = (0..slides.len())
                .filter(|&i| !body(&single, &slides[i]).is_empty())
                .collect();
            assert_eq!(whole.len(), 1, "{reference}: one slide is whole");
            whole[0]
        };
        assert_eq!(kept("intro"), 0);
        assert_eq!(kept("plan"), 1);
        assert_eq!(kept("#3"), 2, "a slide without an id, by position");
        assert_eq!(kept("3"), 2);
        assert_eq!(kept("#99"), 2, "past the end is the last");
        assert_eq!(kept("#0"), 0);
        assert_eq!(kept("#-4"), 0);
        assert_eq!(kept("unknown"), 0);
        assert_eq!(kept(""), 0);
        assert_eq!(kept("#2nd"), 1, "parseInt reads the number it starts with");
        assert_eq!(kept("fake"), 0, "markup in a script is no slide");
    }

    #[test]
    fn an_id_wins_over_a_position() {
        let html = r#"<main class="deck"><section class="slide" id="x">X</section><section class="slide" id="1">One</section></main>"#;
        let single = single_slide(html, "1");
        assert!(single.contains(">One<") && !single.contains(">X<"));
    }

    #[test]
    fn keeps_nested_sections_and_comments_of_the_slide() {
        let single = single_slide(DECK, "intro");
        assert!(single.contains(r#"<h1>Hi</h1><section class="inner">x</section></section>"#));
        assert!(single.contains(r#"<!-- <section class="slide" id="ghost"></section> -->"#));
        assert!(single.contains("<section class='slide' id=plan></section>"));
        assert!(!single.contains("<p>Plan</p>") && !single.contains("No id"));
    }

    #[test]
    fn a_page_without_slides_is_left_alone() {
        let page = "<html><body><p>Hello</p></body></html>";
        assert!(matches!(single_slide(page, "a"), Cow::Borrowed(same) if same == page));
    }
}
