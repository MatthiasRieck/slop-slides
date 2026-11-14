//! What an export holds of a deck: which of its slides ([`Scope`]), and, for the web page, which
//! of what the author keeps to themselves ([`WebPage`]): speaker notes, narration scripts, review
//! marks and comments. All of it is worked out on a copy of the deck's HTML; the deck file is
//! only ever read.
//!
//! The exports that render the deck in a hidden window (PDF, PowerPoint, video, images) get
//! that copy served to the window ([`serve`], which protocol.rs asks through [`page_for`]), so
//! the player and the page helpers only ever see the slides the export is of.

use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::assets::mime_for;
use crate::error::{Error, Result};
use crate::{comments, deck, html, review};

/// The slides an export is of. Left as it is, that is every slide the show shows.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Scope {
    /// The slides to export, by id; every slide when left out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slides: Option<Vec<String>>,
    /// Hidden slides come along; otherwise they are left out, as the show skips them.
    pub include_hidden: bool,
}

impl Scope {
    /// Every slide of the deck, the hidden ones too.
    #[cfg(test)]
    pub fn everything() -> Scope {
        Scope {
            slides: None,
            include_hidden: true,
        }
    }

    /// Whether the slide `id` is exported.
    pub fn holds(&self, id: &str, hidden: bool) -> bool {
        (self.include_hidden || !hidden)
            && self
                .slides
                .as_ref()
                .map_or(true, |ids| ids.iter().any(|i| i == id))
    }

    /// The slides of `deck` that are exported, in the deck's order.
    pub fn of<'a>(&self, deck: &'a deck::Deck) -> Vec<&'a deck::Slide> {
        deck.slides
            .iter()
            .filter(|s| self.holds(&s.id, s.hidden))
            .collect()
    }
}

/// What becomes of a hidden slide that is exported.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hidden {
    /// It stays hidden: in a web page the show goes on skipping it.
    Stay,
    /// It is shown like any other: a page of the PDF, a slide of the PowerPoint file.
    Show,
}

/// A range of `html` with the whitespace before it, to take out without leaving a blank line.
fn cut(html: &str, range: &Range<usize>) -> Range<usize> {
    html::with_indent(html, range)
}

/// `html` without `cuts`, which may come in any order and may hold one another.
fn without(html: &str, mut cuts: Vec<Range<usize>>) -> String {
    cuts.sort_by_key(|range| range.start);
    let mut out = String::with_capacity(html.len());
    let mut at = 0;
    for range in cuts {
        if range.start > at {
            out.push_str(&html[at..range.start]);
        }
        at = at.max(range.end);
    }
    out.push_str(&html[at..]);
    out
}

/// The deck `html` with only the slides of `scope`. A section left with no slide goes too,
/// its name with it. Review marks and comments of the slides that went are dropped.
pub fn select(html: &str, scope: &Scope, hidden: Hidden) -> String {
    let (slides, sections) = html::find_spans(html);
    let kept: Vec<bool> = slides
        .iter()
        .map(|s| scope.holds(s.id.as_deref().unwrap_or(""), s.hidden.is_some()))
        .collect();
    let mut cuts = Vec::new();
    for (slide, keep) in slides.iter().zip(&kept) {
        match (keep, &slide.hidden) {
            (false, _) => cuts.push(cut(html, &slide.range)),
            (true, Some(attr)) if hidden == Hidden::Show => cuts.push(cut(html, attr)),
            _ => {}
        }
    }
    for (index, section) in sections.iter().enumerate() {
        let end = sections.get(index + 1).map_or(slides.len(), |s| s.before);
        let any = kept
            .get(section.before..end)
            .is_some_and(|k| k.contains(&true));
        if !any {
            cuts.push(cut(html, &section.range));
        }
    }
    if cuts.is_empty() {
        return html.to_string();
    }
    let out = without(html, cuts);
    let ids: HashSet<&str> = slides
        .iter()
        .zip(&kept)
        .filter(|(_, keep)| **keep)
        .filter_map(|(s, _)| s.id.as_deref())
        .collect();
    let out = review::prune(&out, &ids).unwrap_or(out);
    comments::prune(&out, &ids).unwrap_or(out)
}

/// What of the author's own material a web page keeps. Nothing, unless asked for.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Keep {
    /// Speaker notes: the presenter's words, in each slide's markup.
    pub notes: bool,
    /// Narration scripts: what is said over each slide.
    pub narration: bool,
    /// Review marks and comments, which a key in the show brings up.
    pub review: bool,
}

impl Keep {
    /// All of it: the deck as it is.
    #[cfg(test)]
    pub const ALL: Keep = Keep {
        notes: true,
        narration: true,
        review: true,
    };
}

/// The deck `html` without what `keep` does not name: the notes and the narration of every
/// slide, and the blocks of review marks and comments.
pub fn without_private(html: &str, keep: Keep) -> String {
    let mut cuts = Vec::new();
    for slide in html::find_slides(html) {
        let markup = &html[slide.range.clone()];
        let mut asides = Vec::new();
        if !keep.notes {
            asides.extend(html::notes_spans(markup));
        }
        if !keep.narration {
            asides.extend(html::narration_spans(markup));
        }
        for aside in asides {
            let start = slide.range.start;
            let range = start + aside.range.start..start + aside.range.end;
            cuts.push(cut(html, &range));
        }
    }
    if !keep.review {
        let blocks = [review::block_range(html), comments::block_range(html)];
        for block in blocks.into_iter().flatten() {
            cuts.push(cut(html, &block));
        }
    }
    without(html, cuts)
}

/// How the web page export is made.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WebPage {
    #[serde(flatten)]
    pub scope: Scope,
    #[serde(flatten)]
    pub keep: Keep,
}

/// The deck `source` as the web page of `options`: its slides, and what it keeps.
pub fn web_page_source(source: &str, options: &WebPage) -> Result<String> {
    let chosen = select(source, &options.scope, Hidden::Stay);
    let shown = html::find_slides(&chosen)
        .iter()
        .any(|s| s.hidden.is_none());
    if !shown {
        return Err(Error::msg("the deck has no shown slides to export"));
    }
    Ok(without_private(&chosen, options.keep))
}

/// Writes the deck `file` to `dest` as one web page that stands on its own: the player in it
/// current, the files it uses embedded as data URIs. The deck file is only read.
pub fn web_page(file: &Path, dest: &Path, options: &WebPage) -> Result<()> {
    let source = web_page_source(&deck::read_html(file)?, options)?;
    let standalone = html::inline_assets(&html::ensure_runtime(&source), |rel| {
        let path = deck::resolve_in_deck(deck::folder(file), rel).ok()?;
        Some((mime_for(rel).to_string(), std::fs::read(path).ok()?))
    });
    std::fs::write(dest, standalone)?;
    Ok(())
}

/// The name of the query parameter that names a served scope.
const PARAM: &str = "scope";

/// The scopes the hidden export windows are shown, by the token in their address.
static SERVED: Mutex<Option<HashMap<String, Scope>>> = Mutex::new(None);

fn served() -> MutexGuard<'static, Option<HashMap<String, Scope>>> {
    SERVED.lock().unwrap_or_else(|e| e.into_inner())
}

/// A scope a hidden window is shown, for as long as this lives.
pub struct Served(String);

impl Served {
    /// What the window's address carries, after the deck's state: `scope=<token>`.
    pub fn query(&self) -> String {
        format!("{PARAM}={}", self.0)
    }
}

impl Drop for Served {
    fn drop(&mut self) {
        if let Some(scopes) = served().as_mut() {
            scopes.remove(&self.0);
        }
    }
}

/// Has the window whose address carries the returned [`Served::query`] shown only the slides
/// of `scope`, each of them shown, the hidden ones too.
pub fn serve(scope: &Scope) -> Served {
    let token = uuid::Uuid::new_v4().simple().to_string();
    served()
        .get_or_insert_with(HashMap::new)
        .insert(token.clone(), scope.clone());
    Served(token)
}

/// The deck `page` as the window asking with `query` is shown it; None when the query names
/// no scope, and the page goes out as it is.
pub fn page_for(query: Option<&str>, page: &str) -> Option<String> {
    let token = query?
        .split('&')
        .find_map(|pair| pair.strip_prefix(PARAM)?.strip_prefix('='))?;
    let scope = served().as_ref()?.get(token)?.clone();
    Some(select(page, &scope, Hidden::Show))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    const DECK: &str = r##"<!DOCTYPE html>
<html>
<head><title>Talk</title></head>
<body>
  <main class="deck">
    <section class="slide" id="intro">
      <h1>Hello</h1>
      <aside class="notes">Greet the room &amp; smile</aside>
      <aside class="narration">Welcome, everyone.</aside>
    </section>
    <div class="deck-section" data-title="Backup"></div>
    <section class="slide" id="secret" data-hidden>
      <h1>Numbers we do not show</h1>
      <aside class="notes">Only if asked</aside>
    </section>
    <div class="deck-section" data-title="Close"></div>
    <section class="slide" id="end">
      <img src="assets/logo.png" alt="">
      <aside class="narration">Thank you.</aside>
    </section>
  </main>
  <!-- slopslide:review (managed by SlopSlide, do not edit) -->
  <script type="application/json" id="slopslide-review">{"intro":[{"tool":"pen","color":"#ff0000","points":[[0.1,0.2],[0.3,0.4]]}],"secret":[{"tool":"pen","color":"#00ff00","points":[[0.1,0.2]]}]}</script>
  <!-- /slopslide:review -->
  <!-- slopslide:comments (managed by SlopSlide, do not edit) -->
  <script type="application/json" id="slopslide-comments">{"end":[{"id":"c1","text":"Is this logo current?","x":0.5,"y":0.5}]}</script>
  <!-- /slopslide:comments -->
</body>
</html>
"##;

    fn ids(html: &str) -> Vec<String> {
        html::find_slides(html)
            .into_iter()
            .filter_map(|s| s.id)
            .collect()
    }

    fn only(slides: &[&str], include_hidden: bool) -> Scope {
        Scope {
            slides: Some(slides.iter().map(|s| s.to_string()).collect()),
            include_hidden,
        }
    }

    #[test]
    fn a_scope_left_alone_is_what_the_show_shows() {
        let scope = Scope::default();
        assert!(scope.holds("intro", false));
        assert!(!scope.holds("secret", true));
        assert!(Scope::everything().holds("secret", true));
        let some = only(&["secret", "end"], false);
        assert!(!some.holds("intro", false));
        assert!(!some.holds("secret", true), "hidden, and not asked for");
        assert!(some.holds("end", false));
    }

    #[test]
    fn reads_what_the_frontend_sends() {
        let scope: Scope =
            serde_json::from_str(r#"{"slides":["a","b"],"includeHidden":true}"#).unwrap();
        assert_eq!(scope, only(&["a", "b"], true));
        assert_eq!(
            serde_json::from_str::<Scope>("{}").unwrap(),
            Scope::default()
        );
        let page: WebPage =
            serde_json::from_str(r#"{"includeHidden":true,"notes":true,"review":false}"#).unwrap();
        assert!(page.scope.include_hidden && page.keep.notes);
        assert!(!page.keep.narration && !page.keep.review);
    }

    #[test]
    fn hidden_slides_are_left_out_with_their_section_and_their_marks() {
        let out = select(DECK, &Scope::default(), Hidden::Show);
        assert_eq!(ids(&out), ["intro", "end"]);
        assert!(!out.contains("Numbers we do not show"));
        assert!(!out.contains("Backup"), "its section went with it");
        assert!(out.contains("data-title=\"Close\""));
        let marks = review::read(&out);
        assert!(marks.contains_key("intro") && !marks.contains_key("secret"));
        assert!(!out.contains("\n\n\n"), "no hole is left where it was");
    }

    #[test]
    fn a_hidden_slide_that_comes_along_is_shown_or_stays_hidden() {
        let shown = select(DECK, &Scope::everything(), Hidden::Show);
        assert_eq!(ids(&shown), ["intro", "secret", "end"]);
        assert!(html::find_slides(&shown).iter().all(|s| s.hidden.is_none()));
        assert!(shown.contains("<section class=\"slide\" id=\"secret\">"));
        let stays = select(DECK, &Scope::everything(), Hidden::Stay);
        assert_eq!(stays, DECK, "nothing to take out");
    }

    #[test]
    fn only_the_slides_asked_for_are_kept_in_the_decks_order() {
        let out = select(DECK, &only(&["end", "intro"], true), Hidden::Show);
        assert_eq!(ids(&out), ["intro", "end"]);
        let one = select(DECK, &only(&["secret"], true), Hidden::Show);
        assert_eq!(ids(&one), ["secret"]);
        assert!(one.contains("Backup") && !one.contains("data-title=\"Close\""));
        assert!(html::find_slides(&select(DECK, &only(&[], true), Hidden::Show)).is_empty());
    }

    #[test]
    fn private_material_goes_unless_kept() {
        let out = without_private(DECK, Keep::default());
        assert!(!out.contains("<aside"), "{out}");
        for private in [
            "Greet the room",
            "Only if asked",
            "Welcome, everyone",
            "Thank you",
        ] {
            assert!(!out.contains(private), "{private} is still there");
        }
        assert!(!out.contains("slopslide-review") && !out.contains("slopslide:review"));
        assert!(!out.contains("slopslide-comments") && !out.contains("Is this logo current"));
        assert_eq!(ids(&out), ["intro", "secret", "end"]);
        assert!(out.contains("<h1>Hello</h1>") && out.contains("assets/logo.png"));
        assert_eq!(without_private(DECK, Keep::ALL), DECK);
    }

    #[test]
    fn each_kind_of_private_material_is_kept_on_its_own() {
        let notes = without_private(
            DECK,
            Keep {
                notes: true,
                ..Keep::default()
            },
        );
        assert!(notes.contains("Greet the room") && !notes.contains("Welcome, everyone"));
        assert!(!notes.contains("slopslide-review"));
        let narration = without_private(
            DECK,
            Keep {
                narration: true,
                ..Keep::default()
            },
        );
        assert!(narration.contains("Thank you.") && !narration.contains("Greet the room"));
        let marks = without_private(
            DECK,
            Keep {
                review: true,
                ..Keep::default()
            },
        );
        assert!(marks.contains("slopslide-review") && marks.contains("Is this logo current"));
        assert!(!marks.contains("<aside"));
    }

    #[test]
    fn an_aside_that_is_never_closed_takes_nothing_else_with_it() {
        let deck = "<main class=\"deck\">\n  <section class=\"slide\" id=\"a\">\n    <p>Shown</p>\n    <aside class=\"notes\">Private\n  </section>\n  <section class=\"slide\" id=\"b\"><p>Next</p></section>\n</main>";
        let out = without_private(deck, Keep::default());
        assert!(!out.contains("Private"));
        assert!(out.contains("<p>Shown</p>") && out.contains("<p>Next</p>"));
        assert_eq!(ids(&out), ["a", "b"]);
    }

    #[test]
    fn the_web_page_has_none_of_the_private_parts_and_the_deck_is_untouched() {
        let dir = TempDir::new("export-scope");
        let file = dir.write("talk/deck.html", DECK);
        dir.write("talk/assets/logo.png", [1u8, 2, 3]);
        let dest = dir.join("out.html");
        web_page(&file, &dest, &WebPage::default()).unwrap();
        let out = std::fs::read_to_string(&dest).unwrap();
        assert_eq!(ids(&out), ["intro", "end"]);
        for private in [
            "Greet the room",
            "Only if asked",
            "Welcome, everyone",
            "Thank you.",
            "Numbers we do not show",
            "Backup",
            // The player names the blocks it reads; the blocks themselves are gone.
            "id=\"slopslide-review\"",
            "id=\"slopslide-comments\"",
            "<!-- slopslide:review",
            "<!-- slopslide:comments",
            "Is this logo current",
            "<aside",
        ] {
            assert!(!out.contains(private), "{private} is in the export");
        }
        assert!(out.contains("<h1>Hello</h1>"));
        assert!(
            out.contains("data:image/png;base64,AQID"),
            "assets are embedded"
        );
        assert!(out.contains(html::JS_START), "the player is in it");
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            DECK,
            "the deck file is as it was"
        );
    }

    #[test]
    fn the_web_page_keeps_what_is_asked_for() {
        let dir = TempDir::new("export-scope");
        let file = dir.write("deck.html", DECK);
        let dest = dir.join("out.html");
        let options = WebPage {
            scope: Scope::everything(),
            keep: Keep::ALL,
        };
        web_page(&file, &dest, &options).unwrap();
        let out = std::fs::read_to_string(&dest).unwrap();
        assert_eq!(ids(&out), ["intro", "secret", "end"]);
        let hidden: Vec<bool> = html::find_slides(&out)
            .iter()
            .map(|s| s.hidden.is_some())
            .collect();
        assert_eq!(hidden, [false, true, false], "the show still skips it");
        assert!(out.contains("Greet the room") && out.contains("Thank you."));
        assert!(out.contains("slopslide-review") && out.contains("slopslide-comments"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), DECK);
    }

    #[test]
    fn a_web_page_needs_a_slide_to_show() {
        let dir = TempDir::new("export-scope");
        let file = dir.write("deck.html", DECK);
        let dest = dir.join("out.html");
        let options = WebPage {
            scope: only(&["secret"], true),
            keep: Keep::default(),
        };
        let error = web_page(&file, &dest, &options).unwrap_err().to_string();
        assert_eq!(error, "the deck has no shown slides to export");
        assert!(!dest.exists(), "nothing is written");
    }

    #[test]
    fn a_window_is_served_its_scope_until_it_is_done() {
        let scope = only(&["secret", "end"], true);
        let token = serve(&scope);
        let query = format!("static&print&{}", token.query());
        let page = page_for(Some(&query), DECK).unwrap();
        assert_eq!(ids(&page), ["secret", "end"]);
        assert!(!page.contains("data-hidden"), "what is exported is shown");
        assert!(page_for(Some("static&print"), DECK).is_none());
        assert!(page_for(None, DECK).is_none());
        assert!(page_for(Some("scope=nobody"), DECK).is_none());
        drop(token);
        assert!(page_for(Some(&query), DECK).is_none());
    }
}
