//! Documents and helpers the tests of the deck format share.

use super::*;

pub(super) const DECK: &str = r#"<!DOCTYPE html><html><head><title>Q3 &amp; more</title>
<style>.slide { color: red } /* <section class="slide"> */</style></head>
<body>
  <main class="deck">
    <section class="slide intro" id="intro"><h1>Hi</h1><section class="inner">x</section></section>
    <!-- <section class="slide" id="ghost"></section> -->
    <section class='slide' id=plan><p>Plan</p></section>
    <section class="slide"><p>No id</p></section>
  </main>
  <script>const s = '<section class="slide" id="fake">';</script>
</body></html>"#;

pub(super) fn ids(html: &str) -> Vec<String> {
    find_slides(html)
        .into_iter()
        .map(|s| s.id.unwrap_or_default())
        .collect()
}

pub(super) fn locked(html: &str) -> Vec<bool> {
    find_slides(html)
        .into_iter()
        .map(|s| s.locked.is_some())
        .collect()
}

pub(super) fn hidden(html: &str) -> Vec<bool> {
    find_slides(html)
        .into_iter()
        .map(|s| s.hidden.is_some())
        .collect()
}

pub(super) const SECTIONED: &str = r#"<main class="deck">
    <section class="slide" id="a">A</section>
    <div class="deck-section" data-title="Intro &amp; &quot;goals&quot;"></div>
    <section class="slide" id="b">B<div class="deck-section" data-title="inside"></div></section>
    <section class="slide" id="c">C</section>
    <!-- <div class="deck-section" data-title="ghost"></div> -->
    <div class="deck-section" data-title="Wrap up" ></div>
    <section class="slide" id="d">D</section>
  </main>"#;

pub(super) fn section_titles(html: &str) -> Vec<(String, usize)> {
    find_sections(html)
        .into_iter()
        .map(|s| (s.title, s.before))
        .collect()
}

pub(super) const STYLED: &str = "<!DOCTYPE html><html><head>\n  <title>Talk</title>\n  <style>.x {}</style>\n</head><body>\n  <main class=\"deck\">\n    <section class=\"slide\" id=\"a\"><h1>Big &amp; bold</h1><p>Revenue grew 42% in Q3.</p></section>\n    <div class=\"deck-section\" data-title=\"Part\"></div>\n    <section class=\"slide\" id=\"b\"><style>.y { content: \"keep\" }</style><!-- note --><p>NASA said: hello</p></section>\n  </main>\n</body></html>";

/// A deck of `count` slides about as heavy as real ones (some 8 KB each: nested boxes, inline
/// styles, an SVG, narration and notes) with the player runtime, for timing the scanner.
pub(crate) fn big_deck(count: usize) -> String {
    let mut slides = String::new();
    for n in 0..count {
        slides.push_str(&format!(
            "    <section class=\"slide layout-{}\" id=\"slide-{n}\" data-time=\"{}\">\n      <h1 class=\"title\">Slide {n} &amp; more</h1>\n",
            n % 5,
            30 + n
        ));
        for row in 0..24 {
            slides.push_str(&format!(
                "      <div class=\"card card-{row}\" style=\"left: {}px; top: {}px; width: 320px\" data-row=\"{row}\">\n        <p class=\"lead\">Revenue grew <b>{row}%</b> in <i>Q{}</i>, more than <a href=\"#slide-0\">before</a>.</p>\n        <ul><li>One <span class=\"tag\">new</span></li><li>Two<br>lines</li><li>Three</li></ul>\n      </div>\n",
                row * 40,
                row * 30,
                row % 4 + 1
            ));
        }
        slides.push_str(
            "      <svg viewBox=\"0 0 100 100\" class=\"chart\"><path d=\"M0 0 L10 40 L20 30 L30 80 L40 60 L50 90\" fill=\"none\" stroke=\"currentColor\"/><circle cx=\"50\" cy=\"50\" r=\"4\"/></svg>\n      <aside class=\"narration\">\n        What is said over this slide.\n\n        A second paragraph of it.\n      </aside>\n      <aside class=\"notes\">Mention the numbers.</aside>\n    </section>\n",
        );
        if n % 20 == 19 {
            slides.push_str(&format!(
                "    <div class=\"deck-section\" data-title=\"Part {}\"></div>\n",
                n / 20 + 2
            ));
        }
    }
    ensure_runtime(&format!(
        "<!DOCTYPE html>\n<html>\n<head>\n  <title>Big deck</title>\n  <style>.card {{ position: absolute }} /* <section class=\"slide\"> */</style>\n</head>\n<body>\n  <main class=\"deck\">\n{slides}  </main>\n</body>\n</html>\n"
    ))
}
