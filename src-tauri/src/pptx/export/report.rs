//! What an exported PowerPoint file does not keep of the deck, for the user to check: the
//! elements that became pictures, the fonts the file only names, the animations and the
//! narration audio that stay behind. Each with the slides it is about, numbered as the file has
//! them.

use std::collections::BTreeSet;

use super::{Item, Scene, SceneSlide};
use crate::deck;
use crate::html;
use crate::pptx::Change;

/// Fonts that are on every computer PowerPoint runs on, and the names CSS has for whatever the
/// system uses: text in them looks the same there. Compared in lower case.
const COMMON_FONTS: &[&str] = &[
    "arial",
    "arial black",
    "calibri",
    "cambria",
    "comic sans ms",
    "consolas",
    "courier new",
    "georgia",
    "helvetica",
    "helvetica neue",
    "impact",
    "segoe ui",
    "tahoma",
    "times",
    "times new roman",
    "trebuchet ms",
    "verdana",
    "sans-serif",
    "serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-sans-serif",
    "ui-serif",
    "ui-monospace",
    "ui-rounded",
    "-apple-system",
    "blinkmacsystemfont",
];

/// How many pictures stand in for what PowerPoint cannot draw among `items`.
fn pictures(items: &[Item]) -> usize {
    items
        .iter()
        .map(|item| match item {
            Item::Shot(_) => 1,
            Item::Group(group) => pictures(&group.items),
            _ => 0,
        })
        .sum()
}

/// The fonts the text among `items` is set in, into `fonts`.
fn fonts(items: &[Item], fonts: &mut BTreeSet<String>) {
    for item in items {
        match item {
            Item::Text(text) => {
                for run in text.paragraphs.iter().flat_map(|p| &p.runs) {
                    let font = run.font.trim();
                    if !run.text.trim().is_empty() && !font.is_empty() {
                        fonts.insert(font.to_string());
                    }
                }
            }
            Item::Group(group) => self::fonts(&group.items, fonts),
            _ => {}
        }
    }
}

/// Whether the slide `markup` moves: an entrance (`reveal`) or an element that morphs between
/// slides (`data-morph`).
fn animated(markup: &str) -> bool {
    if markup.contains("data-morph") {
        return true;
    }
    let mut rest = markup;
    while let Some(at) = rest.find("class=") {
        rest = &rest[at + "class=".len()..];
        let quote = rest.chars().next().filter(|c| *c == '"' || *c == '\'');
        let value = match quote {
            Some(quote) => rest[1..].split(quote).next().unwrap_or(""),
            None => rest.split([' ', '>']).next().unwrap_or(""),
        };
        if value.split_whitespace().any(|class| class == "reveal") {
            return true;
        }
    }
    false
}

/// The numbers, from 1, of the slides of `scene` that `matches`.
fn numbers(scene: &Scene, matches: impl Fn(&SceneSlide) -> bool) -> Vec<usize> {
    scene
        .slides
        .iter()
        .enumerate()
        .filter(|(_, slide)| matches(slide))
        .map(|(index, _)| index + 1)
        .collect()
}

/// What the PowerPoint file made from `scene` does not keep of the deck `loaded`, whose source
/// is `source`. Empty when the file has all of it.
pub(in crate::pptx) fn changes(scene: &Scene, loaded: &deck::Deck, source: &str) -> Vec<Change> {
    let mut changes = Vec::new();
    let pictured = numbers(scene, |slide| {
        slide.background.shot.is_some() || pictures(&slide.items) > 0
    });
    if !pictured.is_empty() {
        changes.push(Change {
            what: "Parts that PowerPoint cannot draw became pictures: they look the same, but cannot be edited".into(),
            slides: pictured,
        });
    }

    let mut used = BTreeSet::new();
    for slide in &scene.slides {
        fonts(&slide.items, &mut used);
    }
    let named: Vec<String> = used
        .into_iter()
        .filter(|font| !COMMON_FONTS.contains(&font.to_lowercase().as_str()))
        .collect();
    if !named.is_empty() {
        let with_font = numbers(scene, |slide| {
            let mut on_slide = BTreeSet::new();
            fonts(&slide.items, &mut on_slide);
            on_slide.iter().any(|font| named.contains(font))
        });
        changes.push(Change {
            what: format!(
                "{} not stored in the file: {}. A computer without {} shows another font",
                if named.len() == 1 {
                    "A font is"
                } else {
                    "Fonts are"
                },
                named.join(", "),
                if named.len() == 1 { "it" } else { "them" },
            ),
            slides: with_font,
        });
    }

    let spans = html::find_slides(source);
    let markup_of = |id: &str| {
        spans
            .iter()
            .find(|span| span.id.as_deref() == Some(id))
            .map(|span| &source[span.range.clone()])
    };
    let moving = numbers(scene, |slide| markup_of(&slide.id).is_some_and(animated));
    if !moving.is_empty() {
        changes.push(Change {
            what: "Animations are left out: each slide shows as it ends".into(),
            slides: moving,
        });
    }

    let narrated = numbers(scene, |slide| {
        loaded
            .slides
            .iter()
            .any(|s| s.id == slide.id && !s.narration.trim().is_empty())
    });
    if !narrated.is_empty() {
        changes.push(Change {
            what: "Narration audio is left out. Its text is in the notes of slides that have no notes of their own".into(),
            slides: narrated,
        });
    }
    changes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    const DECK: &str = r#"<!DOCTYPE html><html><head><title>T</title></head><body><main class="deck">
<section class="slide" id="one"><h1 class="reveal">Hi</h1></section>
<section class="slide" id="two"><p>Plain</p><aside class="narration">Said aloud.</aside></section>
<section class="slide" id="three" data-morph-group="x"><p data-morph="logo">Logo</p></section>
</main></body></html>"#;

    fn scene(json: serde_json::Value) -> Scene {
        serde_json::from_value(json).unwrap()
    }

    fn text(font: &str, words: &str) -> serde_json::Value {
        serde_json::json!({
            "kind": "text", "x": 0, "y": 0, "w": 100, "h": 20,
            "paragraphs": [{ "runs": [{ "text": words, "font": font }] }],
        })
    }

    fn changes_of(scene: &Scene) -> Vec<Change> {
        let dir = TempDir::new("pptx-report");
        let file = dir.write("deck.html", DECK);
        changes(scene, &deck::load(&file).unwrap(), DECK)
    }

    #[test]
    fn says_what_the_file_does_not_keep_by_slide() {
        let scene = scene(serde_json::json!({
            "slides": [
                { "id": "one", "items": [
                    text("Inter", "Hello"),
                    { "kind": "group", "x": 0, "y": 0, "w": 9, "h": 9, "items": [
                        { "kind": "shot", "shot": 0, "x": 0, "y": 0, "w": 9, "h": 9 },
                    ] },
                ] },
                { "id": "two", "items": [text("Arial", "Plain"), text("Inter", " ")] },
                { "id": "three", "background": { "shot": 1 }, "items": [text("Brand Sans", "Logo")] },
            ],
        }));
        let found = changes_of(&scene);
        let by = |start: &str| {
            found
                .iter()
                .find(|c| c.what.starts_with(start))
                .unwrap_or_else(|| panic!("no {start} in {found:?}"))
                .slides
                .clone()
        };
        assert_eq!(by("Parts that PowerPoint cannot draw"), [1, 3]);
        let fonts = found
            .iter()
            .find(|c| c.what.starts_with("Fonts are"))
            .unwrap();
        assert!(fonts.what.contains("Brand Sans, Inter"), "{}", fonts.what);
        assert!(!fonts.what.contains("Arial"), "a font every computer has");
        assert_eq!(fonts.slides, [1, 3], "a blank run in a font does not count");
        assert_eq!(by("Animations are left out"), [1, 3]);
        assert_eq!(by("Narration audio is left out"), [2]);
    }

    #[test]
    fn a_file_that_keeps_everything_says_nothing() {
        let scene = scene(serde_json::json!({
            "slides": [{ "id": "two", "items": [text("Helvetica Neue", "Plain")] }],
        }));
        let dir = TempDir::new("pptx-report");
        let plain = DECK.replace("<aside class=\"narration\">Said aloud.</aside>", "");
        let file = dir.write("deck.html", &plain);
        assert_eq!(changes(&scene, &deck::load(&file).unwrap(), &plain), []);
    }

    #[test]
    fn one_font_is_named_as_one() {
        let scene = scene(serde_json::json!({
            "slides": [{ "id": "two", "items": [text("Inter", "Plain")] }],
        }));
        let fonts = changes_of(&scene)
            .into_iter()
            .find(|c| c.what.starts_with("A font is"))
            .unwrap();
        assert_eq!(
            fonts.what,
            "A font is not stored in the file: Inter. A computer without it shows another font"
        );
    }

    #[test]
    fn reveal_is_a_whole_class_name() {
        assert!(animated(r#"<p class="big reveal">"#));
        assert!(animated("<p class=reveal>"));
        assert!(!animated(r#"<p class="revealed">"#));
        assert!(animated(r#"<img data-morph="x">"#));
    }
}
