//! Two versions of a deck compared slide by slide: slides are matched by id, and then by
//! content. Pure text work, no git.

use std::collections::HashMap;

use crate::html;

use super::{SlideChange, SlideStatus};

/// Whether `a` and `b` have the same slides in the same order, whatever is between them.
pub(super) fn same_slides(a: &str, b: &str) -> bool {
    let key = |source: &str| -> Vec<(String, String)> {
        snapshots(source)
            .into_iter()
            .map(|slide| (slide.id, slide.hash))
            .collect()
    };
    key(a) == key(b)
}

/// The markup of the slide `id`, or nothing when `source` does not have it.
pub(super) fn slide_of<'a>(source: &'a str, id: &str) -> &'a str {
    let slides = html::find_slides(source);
    let at = snapshots(source).iter().position(|slide| slide.id == id);
    at.map_or("", |at| &source[slides[at].range.clone()])
}

/// The slide of `base` that is the slide `id` of `version`.
pub(super) fn locate(base: &str, version: &str, id: &str) -> Option<usize> {
    let slides = snapshots(version);
    let at = slides.iter().position(|slide| slide.id == id)?;
    match_slides(&snapshots(base), &slides)[at]
}

/// Says of each row of `list`, the deck against the commit, whether the index has that change
/// already: when the deck against the index, in `against_index`, no longer shows it.
pub(super) fn mark_staged(
    list: &mut [SlideChange],
    against_index: &[SlideChange],
    index: &str,
    committed: &str,
) {
    for row in list.iter_mut() {
        let Some(id) = &row.id else {
            let old_id = row.old_id.as_deref().unwrap_or("");
            row.staged = locate(index, committed, old_id).is_none();
            continue;
        };
        let now = against_index.iter().find(|r| r.id.as_ref() == Some(id));
        let same =
            now.is_some_and(|r| matches!(r.status, SlideStatus::Unchanged | SlideStatus::Moved));
        row.staged = same && matches!(row.status, SlideStatus::Added | SlideStatus::Modified);
        row.move_staged = row.moved && now.is_some_and(|r| !r.moved);
    }
}

/// `source` without its slides.
/// Unlike [`html::strip_slides`], it keeps the section markers and the whitespace around the slides.
pub(super) fn strip_slides(source: &str) -> String {
    let mut rest = String::with_capacity(source.len());
    let mut at = 0;
    for slide in html::find_slides(source) {
        rest.push_str(&source[at..slide.range.start]);
        at = slide.range.end;
    }
    rest.push_str(&source[at..]);
    rest
}

/// Hash of what the slides share. The player runtime does not count: the app brings it up to date
/// by itself, and that should not show as a change to every slide.
pub(super) fn shell(source: &str) -> String {
    let source = html::ensure_runtime(source);
    let spans = html::find_slides(&source);
    html::shell_hash(&source, &spans, &html::find_sections(&source))
}

/// One slide of one version of a deck.
pub(super) struct Snapshot {
    pub(super) id: String,
    /// Hash of its markup but for its id, which the app may have given it since.
    hash: String,
    pub(super) markup: String,
    /// The parts that do not show on the slide, under the name [`SlideChange::details`] gives them.
    parts: [(&'static str, String); 5],
}

pub(super) fn snapshots(source: &str) -> Vec<Snapshot> {
    html::find_slides(source)
        .iter()
        .enumerate()
        .map(|(index, span)| {
            let markup = &source[span.range.clone()];
            let unnamed = without_id(source, span);
            let attr = |attr: &Option<(std::ops::Range<usize>, String)>| {
                attr.as_ref()
                    .map(|(_, value)| value.clone())
                    .unwrap_or_default()
            };
            Snapshot {
                id: span.id.clone().unwrap_or_else(|| format!("#{}", index + 1)),
                hash: html::content_hash(&unnamed),
                markup: markup.to_string(),
                parts: [
                    ("speaker notes", html::notes(markup)),
                    ("narration", html::narration(markup)),
                    ("hidden", span.hidden.is_some().to_string()),
                    ("locked", span.locked.is_some().to_string()),
                    (
                        "timing",
                        [&span.time, &span.duration, &span.narration_start]
                            .map(attr)
                            .join(","),
                    ),
                ],
            }
        })
        .collect()
}

/// A slide's markup without its `id` attribute, however that is written.
fn without_id(source: &str, span: &html::SlideSpan) -> String {
    let markup = &source[span.range.clone()];
    let Some(id) = &span.id_value else {
        return markup.to_string();
    };
    let before = source[span.range.start..id.start].trim_end_matches(['"', '\'']);
    let name = before.trim_end().strip_suffix('=').unwrap_or(before);
    let tag = name.trim_end();
    let tag = tag[..tag.len().saturating_sub("id".len())].trim_end();
    let after = &source[id.end..span.range.end];
    format!("{tag}{}", after.trim_start_matches(['"', '\'']))
}

/// For each slide in `new`, the slide in `old` it is: by id, and failing that by content.
pub(super) fn match_slides(old: &[Snapshot], new: &[Snapshot]) -> Vec<Option<usize>> {
    let mut by_id: HashMap<&str, usize> = HashMap::new();
    let mut by_hash: HashMap<&str, Vec<usize>> = HashMap::new();
    for (index, slide) in old.iter().enumerate().rev() {
        // `#2` only says where a slide without an id is; another slide may be there now.
        if !slide.id.starts_with('#') {
            by_id.insert(&slide.id, index);
        }
    }
    let mut matches: Vec<Option<usize>> = new.iter().map(|s| by_id.remove(s.id.as_str())).collect();
    for (index, slide) in old.iter().enumerate().rev() {
        if !matches.contains(&Some(index)) {
            by_hash.entry(&slide.hash).or_default().push(index);
        }
    }
    for (found, slide) in matches.iter_mut().zip(new) {
        if found.is_none() {
            *found = by_hash.get_mut(slide.hash.as_str()).and_then(Vec::pop);
        }
    }
    matches
}

/// The slides that stayed in order: the most `matches` that rise, so that moving one slide far
/// marks that slide and not all those it passed.
fn in_order(matches: &[Option<usize>]) -> Vec<bool> {
    let mut best: Vec<(usize, Option<usize>)> = Vec::with_capacity(matches.len());
    let mut last = None;
    for (i, old) in matches.iter().enumerate() {
        let before = (0..i)
            .filter(|&j| matches[j].is_some() && matches[j] < *old)
            .max_by_key(|&j| best[j].0);
        best.push((1 + before.map_or(0, |j| best[j].0), before));
        if old.is_some() && last.map_or(true, |l: usize| best[l].0 < best[i].0) {
            last = Some(i);
        }
    }
    let mut kept = vec![false; matches.len()];
    while let Some(i) = last {
        kept[i] = true;
        last = best[i].1;
    }
    kept
}

/// Every slide of `new` and `old` in deck order, each removed one after the slide it followed.
/// `assets` are the files around the deck that changed, as slides refer to them.
pub(super) fn compare(old: &[Snapshot], new: &[Snapshot], assets: &[String]) -> Vec<SlideChange> {
    let matches = match_slides(old, new);
    let kept = in_order(&matches);
    let new_index: HashMap<usize, usize> = matches
        .iter()
        .enumerate()
        .filter_map(|(new, old)| old.map(|old| (old, new)))
        .collect();

    // Keyed by where each removed slide goes back in: after that slide of `new`, or at the start.
    let mut removed: HashMap<Option<usize>, Vec<SlideChange>> = HashMap::new();
    let mut after = None;
    for (index, slide) in old.iter().enumerate() {
        if let Some(&new) = new_index.get(&index) {
            after = Some(new);
            continue;
        }
        removed.entry(after).or_default().push(SlideChange {
            key: format!("removed:{index}"),
            status: SlideStatus::Removed,
            id: None,
            old_id: Some(slide.id.clone()),
            details: Vec::new(),
            moved: false,
            old_number: Some(index + 1),
            staged: false,
            move_staged: false,
        });
    }

    let mut list = removed.remove(&None).unwrap_or_default();
    for (index, slide) in new.iter().enumerate() {
        let was = matches[index].map(|i| (i, &old[i]));
        list.push(change(slide, was, kept[index], assets));
        list.extend(removed.remove(&Some(index)).unwrap_or_default());
    }
    list
}

fn change(
    slide: &Snapshot,
    old: Option<(usize, &Snapshot)>,
    in_place: bool,
    assets: &[String],
) -> SlideChange {
    let row = |status, old_id, details, moved, old_number| SlideChange {
        key: slide.id.clone(),
        status,
        id: Some(slide.id.clone()),
        old_id,
        details,
        moved,
        old_number,
        staged: false,
        move_staged: false,
    };
    let Some((index, old)) = old else {
        return row(SlideStatus::Added, None, Vec::new(), false, None);
    };
    let parts = slide.parts.iter().zip(&old.parts);
    let details: Vec<String> = parts
        .filter(|(new, old)| new.1 != old.1)
        .map(|(new, _)| new.0.to_string())
        .chain(assets.iter().filter(|a| slide.markup.contains(*a)).cloned())
        .collect();
    let status = if slide.hash != old.hash || !details.is_empty() {
        SlideStatus::Modified
    } else if in_place {
        SlideStatus::Unchanged
    } else {
        SlideStatus::Moved
    };
    row(
        status,
        Some(old.id.clone()),
        details,
        !in_place,
        Some(index + 1),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::fixtures::*;
    use SlideStatus::{Added, Modified, Moved, Removed, Unchanged};

    /// `(status, id, old id)` of each row.
    fn rows(old: &str, new: &str) -> Vec<(SlideStatus, Option<String>, Option<String>)> {
        compare(&snapshots(old), &snapshots(new), &[])
            .into_iter()
            .map(|row| (row.status, row.id, row.old_id))
            .collect()
    }

    fn statuses(old: &str, new: &str) -> Vec<(SlideStatus, String)> {
        rows(old, new)
            .into_iter()
            .map(|(status, id, old_id)| (status, id.or(old_id).unwrap()))
            .collect()
    }

    fn expect(rows: &[(SlideStatus, &str)]) -> Vec<(SlideStatus, String)> {
        rows.iter().map(|(s, id)| (*s, id.to_string())).collect()
    }

    #[test]
    fn tells_added_removed_and_modified_slides_apart() {
        let old = deck(&["a=A", "b=B", "c=C"]);
        let new = deck(&["a=A", "b=Bee", "d=D"]);
        assert_eq!(
            statuses(&old, &new),
            expect(&[
                (Unchanged, "a"),
                (Modified, "b"),
                (Removed, "c"),
                (Added, "d")
            ])
        );
    }

    #[test]
    fn removed_slides_stay_where_they_were() {
        let old = deck(&["a=A", "b=B", "c=C", "d=D"]);
        assert_eq!(
            statuses(&old, &deck(&["c=C", "d=D"])),
            expect(&[
                (Removed, "a"),
                (Removed, "b"),
                (Unchanged, "c"),
                (Unchanged, "d")
            ])
        );
        assert_eq!(
            statuses(&old, &deck(&["a=A", "d=D"])),
            expect(&[
                (Unchanged, "a"),
                (Removed, "b"),
                (Removed, "c"),
                (Unchanged, "d")
            ])
        );
    }

    #[test]
    fn a_slide_moved_far_is_the_one_marked() {
        let old = deck(&["a=A", "b=B", "c=C", "d=D"]);
        let new = deck(&["d=D", "a=A", "b=B", "c=C"]);
        assert_eq!(
            statuses(&old, &new),
            expect(&[
                (Moved, "d"),
                (Unchanged, "a"),
                (Unchanged, "b"),
                (Unchanged, "c")
            ])
        );
    }

    #[test]
    fn a_changed_slide_that_moved_is_both() {
        let old = deck(&["a=A", "b=B", "c=C"]);
        let new = deck(&["c=Cee", "a=A", "b=B"]);
        let list = compare(&snapshots(&old), &snapshots(&new), &[]);
        assert_eq!(list[0].status, Modified);
        assert!(list[0].moved, "the edit must not hide the move");
        assert_eq!(list[0].old_number, Some(3));
        assert!(!list[1].moved);
    }

    #[test]
    fn a_slide_that_got_its_id_later_is_still_the_same_slide() {
        let old = deck(&["A", "B"]);
        let new = deck(&["intro=A", "plan=B"]);
        assert_eq!(
            rows(&old, &new),
            vec![
                (Unchanged, Some("intro".into()), Some("#1".into())),
                (Unchanged, Some("plan".into()), Some("#2".into())),
            ]
        );
    }

    #[test]
    fn ignores_the_id_however_it_is_written() {
        let hash = |tag: &str| {
            snapshots(&format!("<main class=\"deck\">{tag}A</section></main>"))[0]
                .hash
                .clone()
        };
        let plain = hash("<section class=\"slide\">");
        assert_eq!(hash("<section id=\"a\" class=\"slide\">"), plain);
        assert_eq!(hash("<section class=\"slide\" id='a'>"), plain);
        assert_eq!(hash("<section class=\"slide\" id = \"a\">"), plain);
        assert_eq!(hash("<section class=\"slide\" id=a>"), plain);
    }

    #[test]
    fn a_position_is_not_an_identity() {
        // The second slide of each deck is another slide, though both go by `#2`.
        let old = deck(&["A", "B"]);
        let new = deck(&["A", "C"]);
        assert_eq!(
            statuses(&old, &new),
            expect(&[(Unchanged, "#1"), (Removed, "#2"), (Added, "#2")])
        );
    }

    #[test]
    fn equal_slides_pair_up_once_each() {
        let old = deck(&["same", "same"]);
        let new = deck(&["x=same", "y=same", "z=same"]);
        assert_eq!(
            statuses(&old, &new),
            expect(&[(Unchanged, "x"), (Unchanged, "y"), (Added, "z")])
        );
    }

    #[test]
    fn names_what_the_picture_does_not_show() {
        let old = deck(&["a=A", "b=B"]);
        let new = old
            .replace(
                "<h1>A</h1>",
                "<h1>A</h1><aside class=\"notes\">Say hello</aside>",
            )
            .replace("id=\"b\"", "id=\"b\" data-hidden");
        let list = compare(&snapshots(&old), &snapshots(&new), &[]);
        assert_eq!(list[0].status, Modified);
        assert_eq!(list[0].details, ["speaker notes"]);
        assert_eq!(list[1].details, ["hidden"]);
    }

    #[test]
    fn a_slide_showing_a_changed_asset_is_modified() {
        let old = deck(&["a=<img src='assets/a.png'>", "b=B"]);
        let assets = ["assets/a.png".to_string()];
        let list = compare(&snapshots(&old), &snapshots(&old), &assets);
        assert_eq!(list[0].status, Modified);
        assert_eq!(list[0].details, assets);
        assert_eq!(list[1].status, Unchanged);
    }

    #[test]
    fn the_runtime_is_not_a_change_but_the_styles_are() {
        let plain = deck(&["a=A"]);
        assert_eq!(shell(&plain), shell(&html::ensure_runtime(&plain)));
        assert_ne!(shell(&plain), shell(&deck_styled("blue", &["a=A"])));
        assert_eq!(
            shell(&plain),
            shell(&deck(&["a=A", "b=B"])),
            "slides are not styles"
        );
    }
}
