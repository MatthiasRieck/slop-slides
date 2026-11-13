//! One change to many slides at once. Changing them one after the other scans the whole
//! document and builds it anew for each: resetting the timing of sixty slides took half a
//! second. Here the changes are worked out against one scan and put in together; the result is
//! byte for byte what changing the slides one after the other gives.

use std::collections::HashSet;

use super::attrs::{DURATION_ATTR, HIDDEN_ATTR, LOCKED_ATTR, NARRATION_START_ATTR};
use super::edit::{indent_before, with_indent};
use super::slide_attrs::{
    check_duration, check_narration_start, flag_edit, set_locked, value_edit, Edit,
};
use super::slides::{slugify, unique_id, with_id_placeholder, ID_PLACEHOLDER};
use super::spans::{find_slides, span_of, SlideSpan};

/// One of the slides [`edit_slides`] changes, as the scan found it. Its methods are the single
/// changes of [`super::slide_attrs`] and [`super::slides`], noted down instead of made.
pub struct SlideEdit<'a> {
    html: &'a str,
    id: &'a str,
    span: Option<&'a SlideSpan>,
    edits: &'a mut Vec<Edit>,
    taken: &'a mut HashSet<String>,
}

impl<'a> SlideEdit<'a> {
    fn span(&self) -> Result<&'a SlideSpan, String> {
        self.span
            .ok_or_else(|| format!("Slide not found: {}", self.id))
    }

    /// Whether the slide exists and is locked (see [`super::is_locked`]).
    pub fn is_locked(&self) -> bool {
        self.span.is_some_and(|s| s.locked.is_some())
    }

    /// See [`super::set_hidden`].
    pub fn set_hidden(&mut self, hidden: bool) -> Result<(), String> {
        let span = self.span()?;
        let edit = flag_edit(self.html, span, HIDDEN_ATTR, span.hidden.clone(), hidden);
        self.edits.extend(edit);
        Ok(())
    }

    /// See [`super::set_locked`].
    pub fn set_locked(&mut self, locked: bool) -> Result<(), String> {
        let span = self.span()?;
        let edit = flag_edit(self.html, span, LOCKED_ATTR, span.locked.clone(), locked);
        self.edits.extend(edit);
        Ok(())
    }

    /// See [`super::set_duration`].
    pub fn set_duration(&mut self, seconds: Option<f64>) -> Result<(), String> {
        let value = check_duration(seconds)?;
        let span = self.span()?;
        let current = span.duration.as_ref().map(|(range, _)| range.clone());
        let edit = value_edit(self.html, span, DURATION_ATTR, current, value);
        self.edits.extend(edit);
        Ok(())
    }

    /// See [`super::set_narration_start`].
    pub fn set_narration_start(&mut self, seconds: Option<f64>) -> Result<(), String> {
        let value = check_narration_start(seconds)?;
        let span = self.span()?;
        let current = span
            .narration_start
            .as_ref()
            .map(|(range, _)| range.clone());
        let edit = value_edit(self.html, span, NARRATION_START_ATTR, current, value);
        self.edits.extend(edit);
        Ok(())
    }

    /// See [`super::delete`].
    pub fn delete(&mut self) -> Result<(), String> {
        let cut = with_indent(self.html, &self.span()?.range);
        self.edits.push((cut, String::new()));
        Ok(())
    }

    /// See [`super::duplicate`]; returns the copy's id.
    pub fn duplicate(&mut self) -> Result<String, String> {
        let span = self.span()?;
        let id = unique_id(self.taken, &slugify(&format!("{}-copy", self.id)));
        let copy = with_id_placeholder(self.html, span).replace(ID_PLACEHOLDER, &id);
        // The copy is not locked, so it can be changed.
        let copy = set_locked(copy.trim(), &id, false)?;
        let indent = indent_before(self.html, span.range.start);
        let at = span.range.end;
        self.edits.push((at..at, format!("\n{indent}{copy}")));
        self.taken.insert(id.clone());
        Ok(id)
    }
}

/// Changes the slides `ids` name, in order, as `change` says for each (given its place in
/// `ids`), with one scan of the document for all of them. A slide named a second time, or one
/// an earlier change in the list only just made, is looked up in the document as changed so
/// far, as it would be when the changes are made one after the other.
pub fn edit_slides<'i>(
    html: &str,
    ids: impl IntoIterator<Item = &'i str>,
    mut change: impl FnMut(usize, &mut SlideEdit) -> Result<(), String>,
) -> Result<String, String> {
    let ids: Vec<&str> = ids.into_iter().collect();
    let mut out = html.to_string();
    let mut done = 0;
    while done < ids.len() {
        let slides = find_slides(&out);
        let mut taken: HashSet<String> = slides.iter().filter_map(|s| s.id.clone()).collect();
        let mut edits = Vec::new();
        let mut seen = HashSet::new();
        let started = done;
        for (index, id) in ids.iter().enumerate().skip(started) {
            let span = span_of(&slides, id);
            // Changed already in this pass, or maybe made by it: look again after it.
            let changed = !seen.insert(*id) || (span.is_none() && !edits.is_empty());
            if changed && done > started {
                break;
            }
            let mut slide = SlideEdit {
                html: &out,
                id,
                span,
                edits: &mut edits,
                taken: &mut taken,
            };
            change(index, &mut slide)?;
            done += 1;
        }
        out = apply(&out, edits);
    }
    Ok(out)
}

/// `html` with `edits`, each worked out against `html` itself. Where several start at one
/// place, text put in comes before what replaces the text there, and of the texts put in at
/// one place the one noted last comes first: as when they are made one after the other.
fn apply(html: &str, mut edits: Vec<Edit>) -> String {
    if edits.is_empty() {
        return html.to_string();
    }
    let mut order: Vec<usize> = (0..edits.len()).collect();
    order.sort_by_key(|&i| {
        let range = &edits[i].0;
        (range.start, !range.is_empty(), std::cmp::Reverse(i))
    });
    let mut out =
        String::with_capacity(html.len() + edits.iter().map(|e| e.1.len()).sum::<usize>());
    let mut at = 0;
    for i in order {
        let (range, text) = std::mem::take(&mut edits[i]);
        debug_assert!(range.start >= at, "edits of one pass do not overlap");
        out.push_str(&html[at..range.start]);
        out.push_str(&text);
        at = range.end;
    }
    out.push_str(&html[at..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::html::fixtures::big_deck;
    use crate::html::*;

    const DECK: &str = "<main class=\"deck\">\n    <section class=\"slide\" id=\"a\">A</section>\n    <section data-duration=\"4\" class=\"slide\" id=\"b\" data-narration-start=\"1\">B</section>\n    <section class=\"slide\" data-hidden id=\"c\" data-locked>C</section>\n    <section   data-narration-start=\"-2\"   data-duration=\"9\" class=\"slide\" id=\"d\">D</section><section class=\"slide\" id=\"e\" data-duration=\"7\">E</section>\n  </main>";

    type Timing = (&'static str, Option<f64>, Option<f64>);

    fn timed(html: &str, timing: &[Timing]) -> Result<String, String> {
        edit_slides(html, timing.iter().map(|t| t.0), |index, slide| {
            slide.set_duration(timing[index].1)?;
            slide.set_narration_start(timing[index].2)
        })
    }

    fn timed_one_by_one(html: &str, timing: &[Timing]) -> Result<String, String> {
        let mut out = html.to_string();
        for (id, duration, start) in timing {
            out = set_duration(&out, id, *duration)?;
            out = set_narration_start(&out, id, *start)?;
        }
        Ok(out)
    }

    #[test]
    fn timing_many_slides_at_once_equals_timing_them_one_by_one() {
        let cases: &[&[Timing]] = &[
            // Reset everything.
            &[
                ("a", None, None),
                ("b", None, None),
                ("c", None, None),
                ("d", None, None),
                ("e", None, None),
            ],
            // Set everything, in another order than the document's.
            &[
                ("e", Some(1.5), Some(0.25)),
                ("a", Some(12.0), Some(-3.0)),
                ("d", Some(2.0), Some(1.0)),
                ("b", Some(8.0), Some(0.5)),
            ],
            // One of the two each way: added, changed, removed, left out.
            &[
                ("a", Some(3.0), None),
                ("b", None, Some(2.0)),
                ("d", Some(5.0), None),
                ("e", None, Some(4.0)),
            ],
            // A slide named twice, which the second time is not what the scan saw.
            &[
                ("b", None, None),
                ("a", Some(3.0), None),
                ("b", Some(6.0), Some(1.0)),
                ("a", None, Some(2.0)),
                ("a", Some(9.0), None),
            ],
            &[],
        ];
        for timing in cases {
            assert_eq!(
                timed(DECK, timing).unwrap(),
                timed_one_by_one(DECK, timing).unwrap(),
                "{timing:?}"
            );
        }
        let big = big_deck(12);
        let all: Vec<Timing> = find_slides(&big)
            .iter()
            .map(|s| {
                let id: &'static str = Box::leak(s.id.clone().unwrap().into_boxed_str());
                (id, Some(7.5), Some(0.5))
            })
            .collect();
        let set = timed(&big, &all).unwrap();
        assert_eq!(set, timed_one_by_one(&big, &all).unwrap());
        let reset: Vec<Timing> = all.iter().map(|t| (t.0, None, None)).collect();
        assert_eq!(timed(&set, &reset).unwrap(), big);
    }

    #[test]
    fn a_refused_change_fails_like_the_single_one() {
        for timing in [
            vec![("a", Some(3.0), None), ("missing", Some(3.0), None)],
            vec![("a", Some(0.1), None)],
            vec![("missing", Some(0.1), None)],
            vec![("a", Some(3.0), Some(f64::INFINITY))],
        ] {
            assert_eq!(
                timed(DECK, &timing).unwrap_err(),
                timed_one_by_one(DECK, &timing).unwrap_err()
            );
        }
    }

    #[test]
    fn flagging_many_slides_at_once_equals_flagging_them_one_by_one() {
        let lists: &[&[&str]] = &[
            &["a", "b", "c", "d", "e"],
            &["e", "c", "a"],
            &["c", "c"],
            &[],
        ];
        for ids in lists {
            for on in [true, false] {
                let mut hidden = DECK.to_string();
                let mut locked = DECK.to_string();
                for id in *ids {
                    hidden = set_hidden(&hidden, id, on).unwrap();
                    locked = set_locked(&locked, id, on).unwrap();
                }
                let ids = || ids.iter().copied();
                assert_eq!(
                    edit_slides(DECK, ids(), |_, s| s.set_hidden(on)).unwrap(),
                    hidden
                );
                assert_eq!(
                    edit_slides(DECK, ids(), |_, s| s.set_locked(on)).unwrap(),
                    locked
                );
            }
        }
        assert!(edit_slides(DECK, ["a", "nope"], |_, s| s.set_hidden(true)).is_err());
    }

    #[test]
    fn deleting_many_slides_at_once_equals_deleting_them_one_by_one() {
        let lists: &[&[&str]] = &[
            &["a", "b", "c", "d", "e"],
            &["d", "e"],
            &["e", "b", "a"],
            &["c"],
        ];
        for ids in lists {
            let mut expected = DECK.to_string();
            for id in *ids {
                expected = delete(&expected, id).unwrap();
            }
            assert_eq!(
                edit_slides(DECK, ids.iter().copied(), |_, s| s.delete()).unwrap(),
                expected,
                "{ids:?}"
            );
        }
        // Deleting a slide twice fails the second time, as it does one by one.
        assert_eq!(
            edit_slides(DECK, ["a", "a"], |_, s| s.delete()).unwrap_err(),
            delete(&delete(DECK, "a").unwrap(), "a").unwrap_err()
        );
    }

    #[test]
    fn duplicating_many_slides_at_once_equals_duplicating_them_one_by_one() {
        let lists: &[&[&str]] = &[
            &["a", "b", "c", "d", "e"],
            &["e", "c", "a"],
            // Twice the same slide, and the copy an earlier duplicate made.
            &["c", "c", "a"],
            &["a", "a-copy", "a"],
        ];
        for ids in lists {
            let mut expected = DECK.to_string();
            let mut expected_ids = Vec::new();
            for id in *ids {
                let (next, new) = duplicate(&expected, id).unwrap();
                expected = next;
                expected_ids.push(new);
            }
            let mut created = Vec::new();
            let out = edit_slides(DECK, ids.iter().copied(), |_, s| {
                created.push(s.duplicate()?);
                Ok(())
            })
            .unwrap();
            assert_eq!((out, created), (expected, expected_ids), "{ids:?}");
        }
        assert!(edit_slides(DECK, ["nope"], |_, s| s.duplicate().map(drop)).is_err());
    }

    #[test]
    fn many_slides_are_changed_with_one_scan() {
        let big = big_deck(60);
        let ids: Vec<String> = find_slides(&big).into_iter().filter_map(|s| s.id).collect();
        let before = scans();
        let out = edit_slides(&big, ids.iter().map(String::as_str), |_, s| {
            s.set_duration(Some(5.0))?;
            s.set_narration_start(Some(1.0))
        })
        .unwrap();
        assert_eq!(scans() - before, 1);
        assert_eq!(out.matches("data-duration=\"5\"").count(), 60);
        assert_eq!(out.matches("data-narration-start=\"1\"").count(), 60);
    }
}
