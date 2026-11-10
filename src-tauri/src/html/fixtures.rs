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
