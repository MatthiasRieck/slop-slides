//! A slide's own attributes: whether it is hidden or locked, and its timing.

use std::ops::Range;

#[cfg(test)]
use super::attrs::{DURATION_ATTR, HIDDEN_ATTR, NARRATION_START_ATTR};
use super::attrs::{LOCKED_ATTR, MAX_DURATION, MIN_DURATION, TIME_ATTR};
use super::edit::with_indent;
use super::spans::{find_slides, slide_span, span_of, SlideSpan};

/// Adds or removes the slide's `data-hidden` attribute. Leaves the markup untouched when
/// the slide is already in the requested state. The app hides slides several at once (see
/// [`super::edit_slides`]); this is the change to one, which tests hold that against.
#[cfg(test)]
pub fn set_hidden(html: &str, id: &str, hidden: bool) -> Result<String, String> {
    set_flag(html, id, HIDDEN_ATTR, hidden, |s| s.hidden.clone())
}

/// Adds or removes the slide's `data-locked` attribute, like [`set_hidden`].
pub fn set_locked(html: &str, id: &str, locked: bool) -> Result<String, String> {
    set_flag(html, id, LOCKED_ATTR, locked, |s| s.locked.clone())
}

/// The seconds a `data-time` value stands for: a whole number above zero.
pub fn parse_time(value: &str) -> Option<u32> {
    value.trim().parse().ok().filter(|seconds| *seconds > 0)
}

/// Sets the slide's `data-time` to `seconds`; 0 removes it.
pub fn set_time(html: &str, id: &str, seconds: u32) -> Result<String, String> {
    let value = (seconds > 0).then(|| seconds.to_string());
    set_value(html, id, TIME_ATTR, value, |s| &s.time)
}

/// The seconds a `data-duration` value stands for: [`MIN_DURATION`] to [`MAX_DURATION`].
pub fn parse_duration(value: &str) -> Option<f64> {
    let seconds: f64 = value.trim().parse().ok()?;
    (MIN_DURATION..=MAX_DURATION)
        .contains(&seconds)
        .then_some(seconds)
}

/// The seconds a `data-narration-start` value stands for: up to [`MAX_DURATION`] either way.
pub fn parse_narration_start(value: &str) -> Option<f64> {
    let seconds: f64 = value.trim().parse().ok()?;
    (-MAX_DURATION..=MAX_DURATION)
        .contains(&seconds)
        .then_some(seconds)
}

/// Sets the slide's `data-duration` to `seconds`; None removes it. The app times slides
/// several at once (see [`super::edit_slides`]); this is the change to one, which tests hold
/// that against.
#[cfg(test)]
pub fn set_duration(html: &str, id: &str, seconds: Option<f64>) -> Result<String, String> {
    set_value(html, id, DURATION_ATTR, check_duration(seconds)?, |s| {
        &s.duration
    })
}

/// The `data-duration` value for `seconds`, refusing what [`parse_duration`] would not read.
pub(super) fn check_duration(seconds: Option<f64>) -> Result<Option<String>, String> {
    let value = seconds.map(|s| s.to_string());
    if let Some(value) = value.as_deref().filter(|v| parse_duration(v).is_none()) {
        return Err(format!("A slide cannot be shown for {value} seconds."));
    }
    Ok(value)
}

/// Sets the slide's `data-narration-start` to `seconds`; None removes it (see
/// [`set_duration`]).
#[cfg(test)]
pub fn set_narration_start(html: &str, id: &str, seconds: Option<f64>) -> Result<String, String> {
    let value = check_narration_start(seconds)?;
    set_value(html, id, NARRATION_START_ATTR, value, |s| {
        &s.narration_start
    })
}

/// The `data-narration-start` value for `seconds`, refusing what [`parse_narration_start`]
/// would not read.
pub(super) fn check_narration_start(seconds: Option<f64>) -> Result<Option<String>, String> {
    let value = seconds.map(|s| s.to_string());
    if let Some(value) = value
        .as_deref()
        .filter(|v| parse_narration_start(v).is_none())
    {
        return Err(format!("Narration cannot start at {value} seconds."));
    }
    Ok(value)
}

/// Sets the slide's attribute `name`, which `current` finds on it, to `value`; None removes it.
fn set_value(
    html: &str,
    id: &str,
    name: &str,
    value: Option<String>,
    current: impl Fn(&SlideSpan) -> &Option<(Range<usize>, String)>,
) -> Result<String, String> {
    let slides = find_slides(html);
    let span = slide_span(&slides, id)?;
    let current = current(span).as_ref().map(|(range, _)| range.clone());
    Ok(edited(html, value_edit(html, span, name, current, value)))
}

/// Text to put in place of a range of the document; an empty range puts it in there.
pub(super) type Edit = (Range<usize>, String);

/// `html` with `edit` made, if there is one.
fn edited(html: &str, edit: Option<Edit>) -> String {
    match edit {
        Some((range, text)) => format!("{}{text}{}", &html[..range.start], &html[range.end..]),
        None => html.to_string(),
    }
}

/// What sets the attribute `name` of the slide at `span`, now at `current`, to `value`: put in
/// right after the tag's name when new, taken out with the space before it for None.
pub(super) fn value_edit(
    html: &str,
    span: &SlideSpan,
    name: &str,
    current: Option<Range<usize>>,
    value: Option<String>,
) -> Option<Edit> {
    let attr = value.map(|value| format!("{name}=\"{value}\""));
    match (current, attr) {
        (Some(range), None) => Some((with_indent(html, &range), String::new())),
        (Some(range), Some(attr)) => Some((range, attr)),
        (None, None) => None,
        (None, Some(attr)) => Some((span.tag_name_end..span.tag_name_end, format!(" {attr}"))),
    }
}

/// What turns the valueless attribute `attr` of the slide at `span`, now at `current`, `on`
/// or off; None when it is that already.
pub(super) fn flag_edit(
    html: &str,
    span: &SlideSpan,
    attr: &str,
    current: Option<Range<usize>>,
    on: bool,
) -> Option<Edit> {
    match (current, on) {
        (None, true) => Some((span.tag_name_end..span.tag_name_end, format!(" {attr}"))),
        (Some(range), false) => Some((with_indent(html, &range), String::new())),
        _ => None,
    }
}

fn set_flag(
    html: &str,
    id: &str,
    attr: &str,
    on: bool,
    current: impl Fn(&SlideSpan) -> Option<Range<usize>>,
) -> Result<String, String> {
    let slides = find_slides(html);
    let span = slide_span(&slides, id)?;
    Ok(edited(html, flag_edit(html, span, attr, current(span), on)))
}

/// Whether slide `id` exists and is locked.
pub fn is_locked(html: &str, id: &str) -> bool {
    span_of(&find_slides(html), id).is_some_and(|s| s.locked.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::html::fixtures::*;
    use crate::html::*;

    #[test]
    fn locks_and_unlocks_slides() {
        let deck = normalize_ids(DECK).unwrap();
        let locked_deck = set_locked(&deck, "plan", true).unwrap();
        assert_eq!(locked(&locked_deck), [false, true, false]);
        assert!(locked_deck.contains("<section data-locked class='slide' id=plan>"));
        assert!(is_locked(&locked_deck, "plan") && !is_locked(&locked_deck, "intro"));
        assert!(!is_locked(&locked_deck, "missing"));
        assert_eq!(set_locked(&locked_deck, "plan", true).unwrap(), locked_deck);
        assert_eq!(set_locked(&locked_deck, "plan", false).unwrap(), deck);
        assert!(set_locked(&deck, "missing", true).is_err());

        let both = set_hidden(&locked_deck, "plan", true).unwrap();
        assert_eq!(
            (hidden(&both), locked(&both)),
            (vec![false, true, false], vec![false, true, false])
        );
        let unlocked = set_locked(&both, "plan", false).unwrap();
        assert_eq!(locked(&unlocked), [false, false, false]);
        assert_eq!(
            hidden(&unlocked),
            [false, true, false],
            "unlocking keeps it hidden"
        );
    }

    #[test]
    fn hides_and_unhides_slides() {
        let deck = normalize_ids(DECK).unwrap();
        let hid = set_hidden(&deck, "plan", true).unwrap();
        assert_eq!(hidden(&hid), [false, true, false]);
        assert!(hid.contains("<section data-hidden class='slide' id=plan>"));
        assert_eq!(set_hidden(&hid, "plan", true).unwrap(), hid, "idempotent");

        let shown = set_hidden(&hid, "plan", false).unwrap();
        assert_eq!(shown, deck, "unhiding restores the original markup");
        assert_eq!(set_hidden(&shown, "plan", false).unwrap(), deck);

        let valued = deck.replace("id=plan>", r#"id=plan data-hidden="true">"#);
        assert_eq!(set_hidden(&valued, "plan", false).unwrap(), deck);

        assert!(set_hidden(&deck, "missing", true).is_err());
    }

    #[test]
    fn sets_changes_and_removes_a_slides_timing() {
        let html = "<section class=\"slide\" id=\"a\"><p>A</p></section>";
        let timed = set_duration(html, "a", Some(12.5)).unwrap();
        let timed = set_narration_start(&timed, "a", Some(-0.75)).unwrap();
        let span = &find_slides(&timed)[0];
        assert_eq!(span.duration.as_ref().unwrap().1, "12.5");
        assert_eq!(span.narration_start.as_ref().unwrap().1, "-0.75");

        let changed = set_duration(&timed, "a", Some(3.0)).unwrap();
        assert_eq!(find_slides(&changed)[0].duration.as_ref().unwrap().1, "3");
        let cleared = set_duration(&changed, "a", None).unwrap();
        assert_eq!(set_narration_start(&cleared, "a", None).unwrap(), html);
        assert_eq!(set_duration(html, "a", None).unwrap(), html);

        assert!(set_duration(html, "a", Some(0.1)).is_err());
        assert!(set_duration(html, "a", Some(f64::NAN)).is_err());
        assert!(set_narration_start(html, "a", Some(f64::INFINITY)).is_err());
        assert!(set_duration(html, "missing", Some(5.0)).is_err());
    }

    #[test]
    fn timing_values_must_be_in_range() {
        assert_eq!(parse_duration(" 2.5 "), Some(2.5));
        assert_eq!(parse_duration("0.5"), Some(0.5));
        for bad in ["0.4", "-1", "soon", "", "NaN", "inf", "3601"] {
            assert_eq!(parse_duration(bad), None, "{bad}");
        }
        assert_eq!(parse_narration_start("-1.5"), Some(-1.5));
        assert_eq!(parse_narration_start("0"), Some(0.0));
        for bad in ["soon", "", "NaN", "3601", "-3601"] {
            assert_eq!(parse_narration_start(bad), None, "{bad}");
        }
    }
}
