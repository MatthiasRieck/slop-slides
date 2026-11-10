//! One version of a deck made with a slide, or the styles, of another: what staging or
//! restoring one change writes. Pure text work, no git.

use crate::html;

use super::diff::{locate, match_slides, snapshots};

/// A deck's source changed, or why it could not be.
type Edited = std::result::Result<String, String>;

/// `source` without any of its slides, and without the whitespace before them, so that its
/// shell hashes like the shell of `source` does: what a deck not committed yet is compared with.
pub(super) fn empty_deck(source: &str) -> String {
    match slides_range(source) {
        Some(range) => format!(
            "{}{}",
            source[..range.start].trim_end(),
            &source[range.end..]
        ),
        None => source.to_string(),
    }
}

/// `base` with `markup` put in where it goes by the order of `from`, whose slide `at` it is:
/// after the closest slide before it that `base` also has. The slide `leaving` of `base` goes out.
fn place(base: &str, from: &str, at: usize, markup: &str, leaving: Option<usize>) -> Edited {
    let spans = html::find_slides(base);
    let matches = match_slides(&snapshots(base), &snapshots(from));
    let before = matches[..at]
        .iter()
        .rev()
        .flatten()
        .copied()
        .find(|&slide| Some(slide) != leaving);
    let next = spans
        .iter()
        .enumerate()
        .find(|(index, _)| Some(*index) != leaving)
        .map(|(_, span)| span);
    let (spot, piece) = match (before.map(|slide| &spans[slide]), next) {
        (Some(span), _) => {
            let indent = html::indent_before(base, span.range.start);
            (span.range.end, format!("\n{indent}{markup}"))
        }
        (None, Some(span)) => {
            let indent = html::indent_before(base, span.range.start);
            (span.range.start, format!("{markup}\n{indent}"))
        }
        (None, None) if leaving.is_some() => return Ok(base.to_string()),
        (None, None) => (html::end_of_deck(base)?, format!("\n    {markup}")),
    };
    let Some(out) = leaving.map(|slide| html::with_indent(base, &spans[slide].range)) else {
        return Ok(format!("{}{piece}{}", &base[..spot], &base[spot..]));
    };
    Ok(if spot >= out.end {
        format!(
            "{}{}{piece}{}",
            &base[..out.start],
            &base[out.end..spot],
            &base[spot..]
        )
    } else {
        format!(
            "{}{piece}{}{}",
            &base[..spot],
            &base[spot..out.start],
            &base[out.end..]
        )
    })
}

/// `base` with one slide made as it is in `from`, where it goes by `id`, or taken out when `from`
/// does not have it. `other` is that slide's version and id elsewhere, to find it in `base` by.
pub(super) fn adopt_slide(
    base: &str,
    from: &str,
    id: Option<&str>,
    other: (&str, Option<&str>),
) -> Edited {
    let spans = html::find_slides(base);
    let elsewhere = || other.1.and_then(|other_id| locate(base, other.0, other_id));
    let Some(id) = id else {
        return Ok(match elsewhere() {
            Some(slide) => html::remove(base, &spans[slide].range),
            None => base.to_string(),
        });
    };
    let slides = snapshots(from);
    let at = slides
        .iter()
        .position(|slide| slide.id == id)
        .ok_or_else(|| format!("Slide not found: {id}"))?;
    Ok(match locate(base, from, id).or_else(elsewhere) {
        Some(slide) => {
            let range = spans[slide].range.clone();
            format!(
                "{}{}{}",
                &base[..range.start],
                slides[at].markup,
                &base[range.end..]
            )
        }
        None => place(base, from, at, &slides[at].markup, None)?,
    })
}

/// `base` with the slide `id` of `from` where `from` has it, as far as `base` has the same slides.
pub(super) fn move_slide(base: &str, from: &str, id: &str) -> Edited {
    let at = snapshots(from)
        .iter()
        .position(|slide| slide.id == id)
        .ok_or_else(|| format!("Slide not found: {id}"))?;
    let Some(slide) = locate(base, from, id) else {
        return Ok(base.to_string());
    };
    let span = &html::find_slides(base)[slide];
    place(base, from, at, &base[span.range.clone()], Some(slide))
}

/// Where a deck's slides and section markers are, from the first to the last.
fn slides_range(source: &str) -> Option<std::ops::Range<usize>> {
    let slides = html::find_slides(source).into_iter().map(|s| s.range);
    let sections = html::find_sections(source).into_iter().map(|s| s.range);
    let ranges: Vec<_> = slides.chain(sections).collect();
    let start = ranges.iter().map(|r| r.start).min()?;
    let end = ranges.iter().map(|r| r.end).max()?;
    Some(start..end)
}

/// Everything of `shell` but its slides and section markers, which are those of `slides`.
pub(super) fn with_slides_of(shell: &str, slides: &str) -> String {
    let content = slides_range(slides).map_or("", |range| &slides[range]);
    match slides_range(shell) {
        Some(range) => format!("{}{content}{}", &shell[..range.start], &shell[range.end..]),
        None => match html::end_of_deck(shell) {
            Ok(at) if !content.is_empty() => {
                format!("{}\n    {content}{}", &shell[..at], &shell[at..])
            }
            _ => shell.to_string(),
        },
    }
}
