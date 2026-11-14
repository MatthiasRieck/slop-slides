//! Locked slides: what they were like when the agent's turn started, and putting them back.

use super::edit::{end_of_deck, indent_before};
use super::spans::{find_slides, span_of, SlideSpan};

/// A locked slide as it was when a guard was set up: what it must stay like.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct LockedSlide {
    pub id: String,
    pub markup: String,
    /// Id of the slide before it, where it goes back if it is removed; None when it was first.
    pub after: Option<String>,
}

/// Every locked slide of `html`, in order.
pub fn locked_slides(html: &str) -> Vec<LockedSlide> {
    let slides = find_slides(html);
    slides
        .iter()
        .enumerate()
        .filter(|(_, s)| s.locked.is_some())
        .filter_map(|(i, s)| {
            Some(LockedSlide {
                id: s.id.clone()?,
                markup: html[s.range.clone()].to_string(),
                after: i.checked_sub(1).and_then(|p| slides[p].id.clone()),
            })
        })
        .collect()
}

/// Ids of the `locked` slides that `html` changed or removed. Moving one is not a change.
pub fn changed_locked(html: &str, locked: &[LockedSlide]) -> Vec<String> {
    changed_locked_in(html, &find_slides(html), locked)
}

/// [`changed_locked`] with `slides`, the slides of `html` already found.
pub fn changed_locked_in(html: &str, slides: &[SlideSpan], locked: &[LockedSlide]) -> Vec<String> {
    locked
        .iter()
        .filter(|l| {
            span_of(slides, &l.id).map(|s| &html[s.range.clone()]) != Some(l.markup.as_str())
        })
        .map(|l| l.id.clone())
        .collect()
}

/// `html` with every `locked` slide as it was: changed ones get their markup back, removed
/// ones go back after the slide they followed (or first). Returns the ids it put back.
pub fn restore_locked(html: &str, locked: &[LockedSlide]) -> (String, Vec<String>) {
    let mut out = html.to_string();
    let mut restored = Vec::new();
    // Found again only after a slide was put back: most turns leave the locked slides alone.
    let mut found: Option<Vec<SlideSpan>> = None;
    for slide in locked {
        let slides = found.take().unwrap_or_else(|| find_slides(&out));
        match span_of(&slides, &slide.id) {
            Some(span) if out[span.range.clone()] == slide.markup => {
                found = Some(slides);
                continue;
            }
            Some(span) => out.replace_range(span.range.clone(), &slide.markup),
            None => {
                let anchor = match &slide.after {
                    Some(after) => span_of(&slides, after).or(slides.last()),
                    None => None,
                };
                let first = slides.first().filter(|_| anchor.is_none());
                let (at, indent, before) = match (anchor, first) {
                    (Some(a), _) => (a.range.end, indent_before(&out, a.range.start), false),
                    (None, Some(f)) => (f.range.start, indent_before(&out, f.range.start), true),
                    (None, None) => match end_of_deck(&out) {
                        Ok(at) => (at, "    ", false),
                        Err(_) => continue,
                    },
                };
                let insert = if before {
                    format!("{}\n{indent}", slide.markup)
                } else {
                    format!("\n{indent}{}", slide.markup)
                };
                out.insert_str(at, &insert);
            }
        }
        restored.push(slide.id.clone());
    }
    (out, restored)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::html::fixtures::*;
    use crate::html::*;

    const LOCKED_DECK: &str = "<main class=\"deck\">\n    <section class=\"slide\" id=\"a\">A</section>\n    <section class=\"slide\" id=\"b\" data-locked>B</section>\n    <section class=\"slide\" id=\"c\">C</section>\n    <section class=\"slide\" id=\"d\" data-locked>D</section>\n  </main>";

    #[test]
    fn lists_locked_slides_with_their_predecessor() {
        let locked = locked_slides(LOCKED_DECK);
        assert_eq!(
            locked,
            [
                LockedSlide {
                    id: "b".into(),
                    markup: "<section class=\"slide\" id=\"b\" data-locked>B</section>".into(),
                    after: Some("a".into()),
                },
                LockedSlide {
                    id: "d".into(),
                    markup: "<section class=\"slide\" id=\"d\" data-locked>D</section>".into(),
                    after: Some("c".into()),
                },
            ]
        );
        let first = LOCKED_DECK.replace("id=\"a\">", "id=\"a\" data-locked>");
        assert_eq!(locked_slides(&first)[0].after, None);
        assert!(locked_slides(DECK).is_empty());
    }

    #[test]
    fn detects_changed_locked_slides() {
        let locked = locked_slides(LOCKED_DECK);
        assert!(changed_locked(LOCKED_DECK, &locked).is_empty());
        let edited_others = LOCKED_DECK.replace(">A<", ">A!<").replace(">C<", ">C!<");
        assert!(changed_locked(&edited_others, &locked).is_empty());
        let moved = reorder(LOCKED_DECK, &["d", "c", "b", "a"].map(String::from)).unwrap();
        assert!(
            changed_locked(&moved, &locked).is_empty(),
            "moving is no change"
        );

        assert_eq!(
            changed_locked(&LOCKED_DECK.replace(">B<", ">B!<"), &locked),
            ["b"]
        );
        assert_eq!(
            changed_locked(
                &LOCKED_DECK.replace(" id=\"d\" data-locked", " id=\"d\""),
                &locked
            ),
            ["d"],
            "unlocking is a change"
        );
        assert_eq!(
            changed_locked(&delete(LOCKED_DECK, "b").unwrap(), &locked),
            ["b"]
        );
    }

    #[test]
    fn locked_slides_left_alone_are_checked_with_one_scan() {
        let locked = locked_slides(LOCKED_DECK);
        assert_eq!(locked.len(), 2);
        let before = scans();
        let (same, restored) = restore_locked(LOCKED_DECK, &locked);
        assert_eq!((same.as_str(), restored.len()), (LOCKED_DECK, 0));
        assert_eq!(scans() - before, 1);
        // One changed: found again after it is put back, for the one after it.
        let edited = LOCKED_DECK.replace(">B<", ">B!<");
        let before = scans();
        assert_eq!(restore_locked(&edited, &locked).0, LOCKED_DECK);
        assert_eq!(scans() - before, 2);
    }

    #[test]
    fn restores_changed_and_removed_locked_slides() {
        let locked = locked_slides(LOCKED_DECK);
        let (same, restored) = restore_locked(LOCKED_DECK, &locked);
        assert_eq!((same.as_str(), restored.len()), (LOCKED_DECK, 0));

        let edited = LOCKED_DECK
            .replace(">A<", ">A!<")
            .replace(">B<", ">B!<")
            .replace(" id=\"d\" data-locked", " id=\"d\"");
        let (out, restored) = restore_locked(&edited, &locked);
        assert_eq!(restored, ["b", "d"]);
        assert_eq!(out, LOCKED_DECK.replace(">A<", ">A!<"), "other edits stay");

        let removed = delete(&delete(LOCKED_DECK, "b").unwrap(), "d").unwrap();
        let (out, restored) = restore_locked(&removed, &locked);
        assert_eq!(restored, ["b", "d"]);
        assert_eq!(
            out, LOCKED_DECK,
            "back in place, indented like its neighbors"
        );

        // Its predecessor is gone too: it goes to the end.
        let gone = delete(&delete(LOCKED_DECK, "a").unwrap(), "b").unwrap();
        let (out, _) = restore_locked(&gone, &locked);
        assert_eq!(ids(&out), ["c", "d", "b"]);

        // A locked first slide goes back first.
        let first = LOCKED_DECK.replace("id=\"a\">", "id=\"a\" data-locked>");
        let locked = locked_slides(&first);
        let (out, _) = restore_locked(&delete(&first, "a").unwrap(), &locked);
        assert_eq!(out, first);

        // Into a deck the agent emptied.
        let empty = "<main class=\"deck\">\n  </main>";
        let (out, restored) = restore_locked(empty, &locked);
        assert_eq!(restored, ["a", "b", "d"]);
        assert_eq!(ids(&out), ["a", "b", "d"]);
    }
}
