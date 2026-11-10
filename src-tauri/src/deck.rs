//! Deck storage. A deck is one self-contained HTML file anywhere in a workspace (see
//! [`crate::workspace`]), with the media it uses in an `assets/` folder next to it:
//!
//! ```text
//! <folder>/
//!   talk.html      every slide, the shared styles, and the embedded player runtime
//!   assets/        user-attached media, referenced as assets/<file>
//! ```
//!
//! Decks the app creates get a folder of their own and the name `deck.html`
//! ([`DECK_FILE`]); any other file passing [`crate::workspace::classify`] opens as a deck too.
//! Nothing of the app's goes next to the deck: chat history and the other app state about a
//! workspace live in its sessions ([`crate::sessions`]), and what every deck shares lives in the
//! app ([`crate::agent::SYSTEM_PROMPT`]) or in the user's [`crate::files::app_home`] folder
//! (user templates, the agent's MCP config, sessions). Functions taking a `session` keep the
//! locked-slide guard of a running agent turn there (see [`crate::guard`]); the media in
//! `assets/` is handled by [`crate::assets`].
//!
//! A deck opens directly in any browser as a slideshow; [`export`] inlines the assets so the
//! single file can be shared on its own.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::assets::{bring_assets, mime_for};
use crate::comments::{self, Comments};
use crate::error::{Error, Result};
use crate::files::{atomic_write, unique_dir};
use crate::find;
use crate::guard::{self, read_guard, refresh_guard};
use crate::html;
use crate::lint;
use crate::narration;
use crate::review::{self, Review};
use crate::size::{SizeInfo, SlideSize, SIZE_META};
use crate::templates;

/// The file name of decks the app creates.
pub const DECK_FILE: &str = "deck.html";
const DECK_TEMPLATE: &str = include_str!("../assets/deck-template.html");
const BLANK_SLIDE: &str = include_str!("../assets/blank-slide.html");

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Slide {
    pub id: String,
    /// Changes whenever this slide's markup changes, so only its preview reloads.
    pub hash: String,
    /// Skipped by the player (presenting, exported file); still shown in the editor.
    pub hidden: bool,
    /// Has elements the user moved by hand, waiting for the agent to tidy the layout.
    pub moved: bool,
    /// Can be changed by neither the user nor the agent until it is unlocked.
    pub locked: bool,
    /// What is said over the slide, as plain text; empty without any (see [`html::narration`]).
    pub narration: String,
    /// What the presenter reads alongside it, as plain text; empty without any (see [`html::notes`]).
    pub notes: String,
    /// The seconds the presenter expects to spend on it; 0 without any (see [`html::TIME_ATTR`]).
    pub time: u32,
    /// How long the narration timeline shows it, in seconds; automatic without any (see
    /// [`html::DURATION_ATTR`]).
    pub duration: Option<f64>,
    /// When its narration starts on the timeline, in seconds after the slide does (see
    /// [`html::NARRATION_START_ATTR`]).
    pub narration_start: Option<f64>,
}

/// What a slide's timing on the narration timeline becomes; None removes that part of it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideTiming {
    pub slide: String,
    pub duration: Option<f64>,
    pub narration_start: Option<f64>,
}

/// A named group of slides, started by a marker between slides in the deck file.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    /// Position among the deck's section markers, in document order.
    pub index: usize,
    pub title: String,
    /// Number of slides before the marker; the section starts at the slide with this index.
    pub before: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Deck {
    /// The deck file's absolute path; every command addresses the deck by it.
    pub id: String,
    pub title: String,
    /// The deck file's absolute path (the same as `id`).
    pub path: String,
    pub slides: Vec<Slide>,
    pub sections: Vec<Section>,
    /// Changes whenever anything outside the slides (styles, fonts, runtime) changes.
    pub shell_hash: String,
    /// What the user drew on slides, by slide id (see [`review`]).
    pub review: Review,
    /// What the user wrote about elements on slides, by slide id (see [`comments`]).
    pub comments: Comments,
    /// Id of the template the deck's design comes from (see [`crate::templates`]).
    pub template: Option<String>,
    /// Every slide's canvas (see [`crate::size`]).
    pub size: SizeInfo,
    /// The voice and language its narration is said in (see [`crate::narration`]).
    pub narration: narration::Settings,
}

/// The deck file a command's deck id names: the absolute path of an existing HTML file.
pub fn deck_file(id: &str) -> Result<PathBuf> {
    let file = PathBuf::from(id);
    if !file.is_absolute() || !is_html(&file) {
        return Err(Error::msg(format!("invalid deck id: {id}")));
    }
    if !file.is_file() {
        return Err(Error::msg(format!("deck not found: {id}")));
    }
    Ok(file)
}

/// Whether the file name ends in `.html` or `.htm`.
pub fn is_html(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("html") || e.eq_ignore_ascii_case("htm"))
}

/// The folder holding the deck file, which its relative references resolve against.
pub fn folder(file: &Path) -> &Path {
    file.parent().unwrap_or(Path::new("."))
}

/// Resolves a deck-relative path, refusing anything that escapes the deck folder.
pub fn resolve_in_deck(dir: &Path, rel: &str) -> Result<PathBuf> {
    let rel_path = Path::new(rel);
    let safe = rel_path
        .components()
        .all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    if !safe || rel.is_empty() {
        return Err(Error::msg(format!("invalid path: {rel}")));
    }
    Ok(dir.join(rel_path))
}

pub fn read_html(file: &Path) -> Result<String> {
    Ok(fs::read_to_string(file)?)
}

pub(crate) fn write_html(file: &Path, html: &str) -> Result<()> {
    atomic_write(file, html.as_bytes())
}

/// Writes `updated` over the deck unless it is `source`, the text it has now, so the watcher
/// stays quiet when nothing changed.
fn write_if_changed(file: &Path, source: &str, updated: &str) -> Result<()> {
    if updated != source {
        write_html(file, updated)?;
    }
    Ok(())
}

/// The deck's name when its `<title>` is missing: the folder's name for a `deck.html`, else
/// the file's.
fn fallback_title(file: &Path) -> String {
    let name = match file.file_name().and_then(|n| n.to_str()) {
        Some(DECK_FILE) => folder(file).file_name(),
        _ => file.file_stem(),
    };
    name.map(|n| n.to_string_lossy().replace(['-', '_'], " "))
        .unwrap_or_default()
}

/// Keeps the deck consistent: unique slide ids and the current player runtime. Safe to call
/// repeatedly; only writes when something changed.
pub fn normalize(file: &Path) -> Result<()> {
    let source = read_html(file)?;
    let fixed = html::normalize_ids(&source).unwrap_or_else(|| source.clone());
    let fixed = html::ensure_runtime(&fixed);
    let fixed = prune_review(&fixed).unwrap_or(fixed);
    write_if_changed(file, &source, &fixed)
}

/// `html` without review marks and comments of slides it no longer has; None when there are
/// none to drop.
fn prune_review(html: &str) -> Option<String> {
    let slides = html::find_slides(html);
    let ids = slides.iter().filter_map(|s| s.id.as_deref()).collect();
    let marks = review::prune(html, &ids);
    comments::prune(marks.as_deref().unwrap_or(html), &ids).or(marks)
}

/// A template a new deck takes its design from: its id and deck.html.
pub struct TemplateSource<'a> {
    pub id: &'a str,
    pub html: &'a str,
}

/// Creates `<root>/<slugged title>/deck.html` and opens it.
pub fn create(root: &Path, title: &str, template: Option<TemplateSource>) -> Result<Deck> {
    let title = title.trim();
    let title = if title.is_empty() {
        "Untitled deck"
    } else {
        title
    };
    let dir = unique_dir(root, &html::slugify(title));
    fs::create_dir_all(&dir)?;
    let source = match template {
        Some(t) => templates::deck_shell(t.html, t.id, title),
        None => html::set_title(DECK_TEMPLATE, title),
    };
    let file = dir.join(DECK_FILE);
    write_html(&file, &source)?;
    open(&file, None, true)
}

/// Loads a deck, normalizing it first unless the agent may be mid-edit.
pub fn open(file: &Path, session: Option<&Path>, normalize_first: bool) -> Result<Deck> {
    if normalize_first {
        normalize(file)?;
        // No turn is running: a guard left behind (say, the app quit mid-turn) is stale.
        if let Some(session) = session {
            guard::drop_stale(session);
        }
    }
    load(file)
}

pub fn load(file: &Path) -> Result<Deck> {
    let source = read_html(file)?;
    let spans = html::find_slides(&source);
    let section_spans = html::find_sections(&source);
    let slides = spans
        .iter()
        .enumerate()
        .map(|(index, span)| {
            let markup = &source[span.range.clone()];
            Slide {
                // A slide the agent has not given an id yet is addressed by position until
                // the turn ends and `normalize` assigns one.
                id: span.id.clone().unwrap_or_else(|| format!("#{}", index + 1)),
                hash: html::content_hash(markup),
                hidden: span.hidden.is_some(),
                locked: span.locked.is_some(),
                moved: html::has_moved(markup),
                narration: html::narration(markup),
                notes: html::notes(markup),
                time: span
                    .time
                    .as_ref()
                    .and_then(|(_, value)| html::parse_time(value))
                    .unwrap_or(0),
                duration: span
                    .duration
                    .as_ref()
                    .and_then(|(_, value)| html::parse_duration(value)),
                narration_start: span
                    .narration_start
                    .as_ref()
                    .and_then(|(_, value)| html::parse_narration_start(value)),
            }
        })
        .collect();
    let path = file.to_string_lossy().into_owned();
    Ok(Deck {
        id: path.clone(),
        title: html::title(&source).unwrap_or_else(|| fallback_title(file)),
        path,
        shell_hash: html::shell_hash(&source, &spans, &section_spans),
        review: review::read(&source),
        comments: comments::read(&source),
        template: html::template(&source),
        size: html::slide_size(&source).into(),
        narration: narration::Settings::of(&source),
        sections: section_spans
            .iter()
            .enumerate()
            .map(|(index, span)| Section {
                index,
                title: span.title.clone(),
                before: span.before,
            })
            .collect(),
        slides,
    })
}

type EditResult<T> = std::result::Result<T, String>;

/// Writes the deck's source as `f` changes it; returns the source before and after, and what
/// else `f` gave. `f` refuses the change with a message for the user.
fn rewrite<T>(
    file: &Path,
    f: impl FnOnce(&str) -> EditResult<(String, T)>,
) -> Result<(String, String, T)> {
    let previous = read_html(file)?;
    let (updated, value) = f(&previous).map_err(Error::Message)?;
    write_html(file, &updated)?;
    Ok((previous, updated, value))
}

/// Writes the deck's source as `f` changes it; returns the deck as it is then.
fn edit(file: &Path, f: impl FnOnce(&str) -> EditResult<String>) -> Result<Deck> {
    Ok(edit_with(file, |s| Ok((f(s)?, ())))?.0)
}

/// Like [`edit`], also returning the value `f` gives alongside the new source.
fn edit_with<T>(file: &Path, f: impl FnOnce(&str) -> EditResult<(String, T)>) -> Result<(Deck, T)> {
    let (_, _, value) = rewrite(file, f)?;
    Ok((load(file)?, value))
}

/// Stores `marks` (review marks or comments) in deck.html with `write`, dropping those of
/// slides that are gone. Leaves the file alone when nothing changed, so the watcher stays quiet.
fn save_marks<M>(file: &Path, marks: &M, write: fn(&str, &M) -> String) -> Result<()> {
    let source = read_html(file)?;
    let updated = write(&source, marks);
    let updated = prune_review(&updated).unwrap_or(updated);
    write_if_changed(file, &source, &updated)
}

/// Stores the user's review marks in deck.html (see [`save_marks`]).
pub fn save_review(file: &Path, review: &Review) -> Result<()> {
    save_marks(file, review, review::write)
}

/// Stores the user's comments in deck.html (see [`save_marks`]).
pub fn save_comments(file: &Path, comments: &Comments) -> Result<()> {
    save_marks(file, comments, comments::write)
}

pub fn rename(file: &Path, title: &str) -> Result<Deck> {
    let title = title.trim().to_string();
    edit(file, |s| Ok(html::set_title(s, &title)))
}

/// What a change from the slide rail did, with the deck's source before and after, so it can be
/// undone by saving `previous` back over `source` (see [`save_source`]).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RailEdit {
    pub deck: Deck,
    pub previous: String,
    pub source: String,
    /// Ids of the slides it added.
    pub created: Vec<String>,
}

fn rail_edit(
    file: &Path,
    f: impl FnOnce(&str) -> EditResult<(String, Vec<String>)>,
) -> Result<RailEdit> {
    let (previous, source, created) = rewrite(file, f)?;
    Ok(RailEdit {
        deck: load(file)?,
        previous,
        source,
        created,
    })
}

pub fn reorder(file: &Path, slides: Vec<String>) -> Result<RailEdit> {
    rail_edit(file, |s| Ok((html::reorder(s, &slides)?, Vec::new())))
}

pub fn add_blank(file: &Path, after: Option<String>) -> Result<(Deck, String)> {
    edit_with(file, |s| {
        html::insert(s, after.as_deref(), BLANK_SLIDE, "slide")
    })
}

/// Gives a deck without slides the template's design (styles, fonts), keeping its title.
pub fn apply_template(file: &Path, template: TemplateSource) -> Result<Deck> {
    edit(file, |s| {
        if !html::find_slides(s).is_empty() {
            return Err("Only a deck without slides takes a template's styles directly.".into());
        }
        let title = html::title(s).unwrap_or_else(|| fallback_title(file));
        let shell = templates::deck_shell(template.html, template.id, &title);
        // A size the user picked for the deck wins over the template's.
        let shell = match html::app_meta_content(s, SIZE_META) {
            Some(_) => html::ensure_runtime(&html::set_slide_size(&shell, html::slide_size(s))),
            None => shell,
        };
        Ok(shell)
    })
}

/// Inserts a copy of the template's slide `slide` after `after` (or at the end).
pub fn add_template_slide(
    file: &Path,
    after: Option<String>,
    template: &str,
    slide: &str,
) -> Result<(Deck, String)> {
    edit_with(file, |s| {
        html::copy_slide(s, after.as_deref(), template, slide)
    })
}

/// Inserts `markup`, a slide copied from deck `from` (this one or another), after `after`.
/// Its assets come along into this deck's `assets/` (see [`crate::assets::bring_assets`]).
pub fn paste_slide(
    file: &Path,
    after: Option<String>,
    from: Option<&Path>,
    markup: &str,
) -> Result<(Deck, String)> {
    let markup = match from {
        Some(from) => bring_assets(markup, from, file)?,
        None => markup.to_string(),
    };
    edit_with(file, |s| html::paste_slide(s, after.as_deref(), &markup))
}

/// Puts a copy of each of `slides` right after it, all in one write.
pub fn duplicate_slides(file: &Path, slides: &[String]) -> Result<RailEdit> {
    rail_edit(file, |s| {
        let mut out = s.to_string();
        let mut created = Vec::with_capacity(slides.len());
        for slide in slides {
            let (next, id) = html::duplicate(&out, slide)?;
            out = next;
            created.push(id);
        }
        Ok((out, created))
    })
}

/// Hides or shows `slides`, all in one write.
pub fn set_slides_hidden(
    file: &Path,
    session: Option<&Path>,
    slides: &[String],
    hidden: bool,
) -> Result<RailEdit> {
    let done = rail_edit(file, |s| {
        let mut out = s.to_string();
        for slide in slides {
            out = html::set_hidden(&out, slide, hidden)?;
        }
        Ok((out, Vec::new()))
    })?;
    for slide in slides {
        refresh_guard(file, session, slide)?;
    }
    Ok(done)
}

/// Sets what is said over a slide (see [`html::set_narration`]); empty `text` removes it.
/// A locked slide keeps its narration too.
pub fn set_slide_narration(file: &Path, slide: &str, text: &str) -> Result<Deck> {
    edit(file, |s| {
        ensure_unlocked(s, slide)?;
        html::set_narration(s, slide, text)
    })
}

/// Adds `text` to what is said over a slide (see [`html::append_narration`]). A locked slide
/// keeps its narration.
pub fn append_slide_narration(
    file: &Path,
    slide: &str,
    text: &str,
    paragraph: bool,
) -> Result<Deck> {
    edit(file, |s| {
        ensure_unlocked(s, slide)?;
        html::append_narration(s, slide, text, paragraph)
    })
}

/// Whether the slide is locked.
pub fn slide_locked(file: &Path, slide: &str) -> Result<bool> {
    Ok(html::is_locked(&read_html(file)?, slide))
}

/// Sets a slide's speaker notes (see [`html::set_notes`]); empty `text` removes them. A locked
/// slide keeps its notes too.
pub fn set_slide_notes(file: &Path, slide: &str, text: &str) -> Result<Deck> {
    edit(file, |s| {
        ensure_unlocked(s, slide)?;
        html::set_notes(s, slide, text)
    })
}

/// Sets the seconds the presenter expects to spend on a slide (see [`html::set_time`]); 0 removes
/// them. A locked slide keeps its time too.
pub fn set_slide_time(file: &Path, slide: &str, seconds: u32) -> Result<Deck> {
    edit(file, |s| {
        ensure_unlocked(s, slide)?;
        html::set_time(s, slide, seconds)
    })
}

/// Sets the timing of slides on the narration timeline, all in one write: resetting it changes
/// every slide. Locked slides keep theirs.
pub fn set_slide_timing(file: &Path, timing: &[SlideTiming]) -> Result<RailEdit> {
    rail_edit(file, |s| {
        let mut out = s.to_string();
        for t in timing {
            ensure_unlocked(&out, &t.slide)?;
            out = html::set_duration(&out, &t.slide, t.duration)?;
            out = html::set_narration_start(&out, &t.slide, t.narration_start)?;
        }
        Ok((out, Vec::new()))
    })
}

/// Gives every slide the canvas `size` and refreshes the player runtime to match. The slides'
/// content stays as it is; the agent lays it out again for the new size.
pub fn set_slide_size(file: &Path, size: SlideSize) -> Result<Deck> {
    size.check().map_err(Error::Message)?;
    edit(file, |s| {
        Ok(html::ensure_runtime(&html::set_slide_size(s, size)))
    })
}

/// Sets the voice the deck's narration is said in: one its provider has (see
/// [`narration::Provider::accepts_voice`]).
pub fn set_narration_voice(file: &Path, voice: &str) -> Result<Deck> {
    edit(file, |s| {
        if !narration::provider_of(s).accepts_voice(voice) {
            return Err(format!("unknown narration voice: {voice}"));
        }
        Ok(html::set_narration_voice(s, voice))
    })
}

/// Sets who says the deck's narration (one of [`narration::cloud::PROVIDERS`]); the default
/// provider has no meta. A voice the new provider does not have becomes its default.
pub fn set_narration_provider(file: &Path, provider: &str) -> Result<Deck> {
    let provider = narration::Provider::named(provider)?;
    edit(file, |s| {
        let named = (provider != narration::DEFAULT_PROVIDER).then(|| provider.id());
        let mut out = html::set_narration_provider(s, named);
        let voice = html::narration_voice(&out);
        if voice.is_some_and(|v| !provider.accepts_voice(&v)) {
            out = html::set_narration_voice(&out, provider.default_voice());
        }
        Ok(out)
    })
}

/// Sets the language the deck's narration is in (one of [`narration::LANGUAGES`]).
pub fn set_narration_language(file: &Path, language: &str) -> Result<Deck> {
    if narration::language(language).is_none() {
        return Err(Error::msg(format!(
            "unknown narration language: {language}"
        )));
    }
    edit(file, |s| Ok(html::set_narration_language(s, language)))
}

/// Locks or unlocks a slide. Neither the user nor the agent can change a locked slide.
pub fn set_slide_locked(
    file: &Path,
    session: Option<&Path>,
    slide: &str,
    locked: bool,
) -> Result<Deck> {
    let deck = edit(file, |s| html::set_locked(s, slide, locked))?;
    refresh_guard(file, session, slide)?;
    Ok(deck)
}

fn ensure_unlocked(source: &str, slide: &str) -> std::result::Result<(), String> {
    if html::is_locked(source, slide) {
        return Err(format!(
            "The slide `{slide}` is locked; unlock it to change it."
        ));
    }
    Ok(())
}

pub fn add_section(file: &Path, before: Option<String>, title: &str) -> Result<Deck> {
    edit(file, |s| html::add_section(s, before.as_deref(), title))
}

pub fn rename_section(file: &Path, index: usize, title: &str) -> Result<Deck> {
    edit(file, |s| html::rename_section(s, index, title))
}

pub fn delete_section(file: &Path, index: usize) -> Result<Deck> {
    edit(file, |s| html::delete_section(s, index))
}

/// Deletes `slides` along with their review marks and comments, all in one write; none if any is locked.
pub fn delete_slides(file: &Path, slides: &[String]) -> Result<RailEdit> {
    let source = read_html(file)?;
    for slide in slides {
        ensure_unlocked(&source, slide).map_err(Error::Message)?;
    }
    rail_edit(file, |s| {
        let mut out = s.to_string();
        for slide in slides {
            out = html::delete(&out, slide)?;
        }
        Ok((prune_review(&out).unwrap_or(out), Vec::new()))
    })
}

/// Writes `source` over the deck, as a change that can be undone. Locked `slides` refuse it, and
/// review marks and comments of slides that went with it are dropped.
pub fn restore(file: &Path, slide: Option<&str>, source: String) -> Result<RailEdit> {
    if let Some(slide) = slide {
        ensure_unlocked(&read_html(file)?, slide).map_err(Error::Message)?;
    }
    rail_edit(file, |_| {
        Ok((prune_review(&source).unwrap_or(source), Vec::new()))
    })
}

/// One slide's markup as it is in the deck file, with the hash a save of it must name as its base.
#[derive(Debug, Serialize)]
pub struct SlideSource {
    pub markup: String,
    pub hash: String,
}

/// Slide `slide`'s markup and hash, read from the file: what an edit made outside the stage's
/// preview (such as the SVG editor's) starts from.
pub fn slide_source(file: &Path, slide: &str) -> Result<SlideSource> {
    let source = read_html(file)?;
    let markup = html::slide_markup(&source, slide).map_err(Error::Message)?;
    Ok(SlideSource {
        markup: markup.to_string(),
        hash: html::content_hash(markup),
    })
}

/// Replaces one slide with markup edited on the stage. `base` is the slide's hash the edit
/// started from; the save is refused when the slide has changed since. Returns the slide's
/// previous markup, so the edit can be undone by saving it back.
pub fn update_slide(file: &Path, slide: &str, markup: &str, base: &str) -> Result<(Deck, String)> {
    let source = read_html(file)?;
    let current = html::find_slides(&source)
        .into_iter()
        .find(|s| s.id.as_deref() == Some(slide))
        .map(|s| html::content_hash(&source[s.range]))
        .ok_or_else(|| Error::msg(format!("Slide not found: {slide}")))?;
    ensure_unlocked(&source, slide).map_err(Error::Message)?;
    if current != base {
        return Err(Error::msg(
            "The slide changed while you were editing it; your last change was not saved.",
        ));
    }
    edit_with(file, |s| html::replace_slide(s, slide, markup))
}

/// Puts `slides` back as they are in `version`, an earlier version of the deck, all in one
/// write. Slides it does not have, or the deck no longer has, are left alone; none if any of
/// them is locked.
pub fn restore_slides(file: &Path, version: &str, slides: &[String]) -> Result<Deck> {
    let old = html::find_slides(version);
    edit(file, |source| {
        let mut out = source.to_string();
        for slide in slides {
            let Some(span) = old.iter().find(|s| s.id.as_deref() == Some(slide.as_str())) else {
                continue;
            };
            if !html::find_slides(&out)
                .iter()
                .any(|s| s.id.as_deref() == Some(slide.as_str()))
            {
                continue;
            }
            ensure_unlocked(&out, slide)?;
            out = html::replace_slide(&out, slide, &version[span.range.clone()])?.0;
        }
        Ok(out)
    })
}

/// What [`replace_text`] did, with the deck's source before and after, so it can be undone by
/// saving `previous` back over `source`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacedText {
    pub deck: Deck,
    /// How many matches were replaced.
    pub count: usize,
    /// The slides that changed.
    pub slides: Vec<String>,
    /// Locked slides with matches, left as they were.
    pub skipped: Vec<String>,
    /// The deck's source before and after, to undo the replace by saving `previous` over `source`.
    pub previous: String,
    pub source: String,
}

/// Where `query` is found on the deck's slides (see [`find::find`]).
pub fn find_text(file: &Path, query: &str, options: find::Options) -> Result<Vec<find::Match>> {
    Ok(find::find(&read_html(file)?, query, options))
}

/// Replaces `query` with `replacement` in the text of the deck's slides (or of `only`); locked
/// slides are left alone. The file is only written when something changed.
pub fn replace_text(
    file: &Path,
    query: &str,
    replacement: &str,
    options: find::Options,
    only: Option<&[String]>,
) -> Result<ReplacedText> {
    let previous = read_html(file)?;
    let replaced = find::replace(&previous, query, replacement, options, only);
    if replaced.count > 0 {
        write_html(file, &replaced.html)?;
    }
    Ok(ReplacedText {
        deck: load(file)?,
        count: replaced.count,
        slides: replaced.slides,
        skipped: replaced.skipped,
        previous,
        source: replaced.html,
    })
}

/// Replaces deck.html with hand-edited source. `base` is the text the edit started from;
/// when given and the file has changed since (say, the agent wrote to it), the save is
/// refused so neither side's work is silently lost.
pub fn save_source(
    file: &Path,
    source: &str,
    base: Option<&str>,
    normalize_after: bool,
) -> Result<Deck> {
    let current = read_html(file)?;
    if let Some(base) = base {
        if !same_text(&current, base) {
            return Err(Error::msg(
                "deck.html changed on disk since you started editing",
            ));
        }
    }
    let changed = html::changed_locked(
        &source.replace("\r\n", "\n"),
        &html::locked_slides(&current.replace("\r\n", "\n")),
    );
    if !changed.is_empty() {
        return Err(Error::msg(format!(
            "Locked slides cannot be changed: {}. Unlock them in the slide rail first.",
            changed.join(", ")
        )));
    }
    write_html(file, source)?;
    if normalize_after {
        normalize(file)?;
    }
    load(file)
}

/// Equal up to line endings (the editor normalizes them to `\n`).
fn same_text(a: &str, b: &str) -> bool {
    a.replace("\r\n", "\n") == b.replace("\r\n", "\n")
}

/// Writes a standalone copy of the deck with attached assets embedded as data URIs.
pub fn export(file: &Path, dest: &Path) -> Result<()> {
    let source = html::ensure_runtime(&read_html(file)?);
    let standalone = html::inline_assets(&source, |rel| {
        let path = resolve_in_deck(folder(file), rel).ok()?;
        Some((mime_for(rel).to_string(), fs::read(path).ok()?))
    });
    fs::write(dest, standalone)?;
    Ok(())
}

/// Lints the deck file; asset references are checked against the files next to it, and during
/// an agent turn, locked slides against how they were when it started.
pub fn lint(file: &Path, session: Option<&Path>) -> Result<Vec<lint::Issue>> {
    let source = read_html(file)?;
    let asset_exists = |rel: &str| {
        let rel = percent_encoding::percent_decode_str(rel).decode_utf8_lossy();
        resolve_in_deck(folder(file), &rel).is_ok_and(|path| path.is_file())
    };
    let mut issues = lint::lint(&source, asset_exists, &read_guard(file, session));
    if let Ok(deck) = load(file) {
        let slides = narration::timeline::layout(file, &deck, &narration::timeline::DEFAULTS);
        let overlaps = narration::timeline::overlaps(&slides);
        if !overlaps.is_empty() {
            issues.extend(lint::narration_overlaps(&source, &overlaps));
            issues.sort_by_key(|i| (i.line, i.severity));
        }
    }
    Ok(issues)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guard::guard_locked;
    use crate::test_support::TempDir;
    use std::time::SystemTime;

    #[test]
    fn resolve_rejects_escapes() {
        let dir = Path::new("/tmp/deck");
        assert!(resolve_in_deck(dir, "../secret").is_err());
        assert!(resolve_in_deck(dir, "/etc/passwd").is_err());
        assert!(resolve_in_deck(dir, "assets/../../x").is_err());
        assert!(resolve_in_deck(dir, "assets/photo.png").is_ok());
    }

    #[test]
    fn pastes_a_slide_from_another_deck_with_its_assets() {
        let lib = TempLib::new();
        let from = lib.add("from", ORIGINAL).join(DECK_FILE);
        let to = lib.add("to", ORIGINAL).join(DECK_FILE);
        fs::create_dir_all(folder(&from).join("assets")).unwrap();
        fs::write(folder(&from).join("assets/Photo.PNG"), b"photo").unwrap();
        let markup = r#"<section class="slide" id="a"><img src="assets/Photo.PNG"></section>"#;
        let (deck, id) = paste_slide(&to, Some("a".into()), Some(&from), markup).unwrap();
        assert_eq!(id, "a-2");
        assert_eq!(
            deck.slides
                .iter()
                .map(|s| s.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "a-2"]
        );
        let html = read_html(&to).unwrap();
        assert!(html.contains(r#"<section class="slide" id="a-2"><img src="assets/photo.png">"#));
        assert!(folder(&to).join("assets/photo.png").is_file());
        assert!(paste_slide(&to, None, None, "<p>x</p>").is_err());
    }

    /// A throwaway deck folder holding `html` as deck.html.
    /// A deck folder, `deck/` in a temporary folder that also holds its session.
    struct TempDeck(PathBuf, TempDir);

    impl TempDeck {
        /// The deck file, deck.html.
        fn file(&self) -> PathBuf {
            self.0.join(DECK_FILE)
        }
        fn new(html: &str) -> Self {
            let temp = TempDir::new("test");
            let dir = temp.join("deck");
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join(DECK_FILE), html).unwrap();
            TempDeck(dir, temp)
        }
        fn html(&self) -> String {
            fs::read_to_string(self.0.join(DECK_FILE)).unwrap()
        }
        /// The deck's session folder, outside the deck.
        fn session(&self) -> PathBuf {
            self.1.join("session")
        }
    }

    const ORIGINAL: &str = "<html><head><title>Talk</title></head><body><main>\n<section class=\"slide\" id=\"a\">A</section>\n</main></body></html>";
    const EDITED: &str = "<html><head><title>Talk</title></head><body><main>\n<section class=\"slide\" id=\"a\">A!</section>\n<section class=\"slide\" id=\"b\">B</section>\n</main></body></html>";

    #[test]
    fn saves_source_when_base_matches() {
        let deck = TempDeck::new(ORIGINAL);
        let saved = save_source(&deck.file(), EDITED, Some(ORIGINAL), false).unwrap();
        assert_eq!(deck.html(), EDITED);
        let ids: Vec<_> = saved.slides.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["a", "b"]);
        assert_eq!(saved.title, "Talk");
    }

    #[test]
    fn save_refuses_when_file_changed_since_base() {
        let deck = TempDeck::new(ORIGINAL);
        let agent_version = ORIGINAL.replace(">A<", ">Agent<");
        fs::write(deck.0.join(DECK_FILE), &agent_version).unwrap();
        let err = save_source(&deck.file(), EDITED, Some(ORIGINAL), false).unwrap_err();
        assert!(err.to_string().contains("changed on disk"), "{err}");
        assert_eq!(
            deck.html(),
            agent_version,
            "the agent's version must survive"
        );
    }

    #[test]
    fn save_without_base_overwrites() {
        let deck = TempDeck::new(ORIGINAL);
        fs::write(deck.0.join(DECK_FILE), "<html>agent</html>").unwrap();
        save_source(&deck.file(), EDITED, None, false).unwrap();
        assert_eq!(deck.html(), EDITED);
    }

    #[test]
    fn save_accepts_base_with_different_line_endings() {
        let deck = TempDeck::new(&ORIGINAL.replace('\n', "\r\n"));
        save_source(&deck.file(), EDITED, Some(ORIGINAL), false).unwrap();
        assert_eq!(deck.html(), EDITED);
    }

    #[test]
    fn save_normalizes_when_asked() {
        let deck = TempDeck::new(ORIGINAL);
        let no_id = EDITED.replace(" id=\"b\"", "");
        let saved = save_source(&deck.file(), &no_id, Some(ORIGINAL), true).unwrap();
        let html = deck.html();
        assert!(html.contains("slopslide:runtime-js"), "runtime installed");
        assert!(
            saved.slides.iter().all(|s| !s.id.starts_with('#')),
            "ids assigned"
        );
        assert_eq!(saved.slides.len(), 2);
    }

    #[test]
    fn save_leaves_markup_alone_without_normalizing() {
        let deck = TempDeck::new(ORIGINAL);
        let no_id = EDITED.replace(" id=\"b\"", "");
        let saved = save_source(&deck.file(), &no_id, None, false).unwrap();
        assert_eq!(deck.html(), no_id);
        assert_eq!(
            saved.slides[1].id, "#2",
            "unnamed slide addressed by position"
        );
    }

    #[test]
    fn replace_text_rewrites_slide_text_and_can_be_undone() {
        let deck = TempDeck::new(EDITED);
        let options = find::Options::default();
        let found = find_text(&deck.file(), "a!", options).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].slide, "a");

        let done = replace_text(&deck.file(), "A!", "Alpha", options, None).unwrap();
        assert_eq!(
            (done.count, done.slides.clone()),
            (1, vec!["a".to_string()])
        );
        assert_eq!(done.previous, EDITED);
        assert_eq!(deck.html(), done.source);
        assert!(deck.html().contains(">Alpha</section>"));

        // Nothing found: the file is left alone.
        let none = replace_text(&deck.file(), "zzz", "x", options, None).unwrap();
        assert_eq!(none.count, 0);

        // Undo: the previous source saved back over this one.
        save_source(&deck.file(), &done.previous, Some(&done.source), false).unwrap();
        assert_eq!(deck.html(), EDITED);
    }

    #[test]
    fn slide_source_gives_the_markup_and_the_hash_a_save_needs() {
        let deck = TempDeck::new(EDITED);
        let source = slide_source(&deck.file(), "b").unwrap();
        assert_eq!(
            source.markup,
            "<section class=\"slide\" id=\"b\">B</section>"
        );
        assert_eq!(source.hash, load(&deck.file()).unwrap().slides[1].hash);
        let markup = "<section class=\"slide\" id=\"b\">B!</section>";
        update_slide(&deck.file(), "b", markup, &source.hash).unwrap();
        assert_eq!(slide_source(&deck.file(), "b").unwrap().markup, markup);
        assert!(slide_source(&deck.file(), "zz").is_err());
    }

    #[test]
    fn update_slide_replaces_it_and_returns_the_old_markup() {
        let deck = TempDeck::new(EDITED);
        let base = load(&deck.file()).unwrap().slides[0].hash.clone();
        let markup = "<section class=\"slide\" id=\"a\"><p data-moved=\"\" style=\"translate: 10px 0px\">A!</p></section>";
        let (saved, previous) = update_slide(&deck.file(), "a", markup, &base).unwrap();
        assert_eq!(previous, "<section class=\"slide\" id=\"a\">A!</section>");
        assert_eq!(deck.html(), EDITED.replace(&previous, markup));
        let moved: Vec<_> = saved.slides.iter().map(|s| s.moved).collect();
        assert_eq!(moved, [true, false]);
        assert_ne!(saved.slides[0].hash, base);

        // Undo: save the previous markup back on top of the new version.
        let (restored, _) =
            update_slide(&deck.file(), "a", &previous, &saved.slides[0].hash).unwrap();
        assert_eq!(deck.html(), EDITED);
        assert_eq!(restored.slides[0].hash, base);
    }

    #[test]
    fn update_slide_refuses_when_the_slide_changed_since_base() {
        let deck = TempDeck::new(EDITED);
        let markup = "<section class=\"slide\" id=\"a\">mine</section>";
        let err = update_slide(&deck.file(), "a", markup, "stale").unwrap_err();
        assert!(err.to_string().contains("changed"), "{err}");
        assert_eq!(deck.html(), EDITED);

        let base = load(&deck.file()).unwrap().slides[0].hash.clone();
        assert!(update_slide(&deck.file(), "zz", markup, &base).is_err());
        let other = "<section class=\"slide\" id=\"b\">mine</section>";
        assert!(update_slide(&deck.file(), "a", other, &base).is_err());
        assert_eq!(deck.html(), EDITED);
    }

    fn timing(slide: &str, duration: Option<f64>, narration_start: Option<f64>) -> SlideTiming {
        SlideTiming {
            slide: slide.into(),
            duration,
            narration_start,
        }
    }

    #[test]
    fn timing_changes_many_slides_in_one_write_and_can_be_removed() {
        let deck = TempDeck::new(EDITED);
        let edit = set_slide_timing(
            &deck.file(),
            &[
                timing("a", Some(4.5), Some(0.5)),
                timing("b", Some(2.0), Some(-1.25)),
            ],
        )
        .unwrap();
        assert_eq!(edit.previous, EDITED);
        assert_eq!(edit.deck.slides[0].duration, Some(4.5));
        assert_eq!(edit.deck.slides[1].narration_start, Some(-1.25));

        let edit = set_slide_timing(&deck.file(), &[timing("a", None, None)]).unwrap();
        assert_eq!(edit.deck.slides[0].duration, None);
        assert_eq!(edit.deck.slides[0].narration_start, None);
        assert_eq!(edit.deck.slides[1].duration, Some(2.0));
    }

    #[test]
    fn timing_leaves_the_deck_alone_when_a_slide_cannot_take_it() {
        let html = EDITED.replacen("id=\"b\"", "id=\"b\" data-locked", 1);
        let deck = TempDeck::new(&html);
        let locked = [timing("a", Some(4.0), None), timing("b", Some(4.0), None)];
        assert!(set_slide_timing(&deck.file(), &locked).is_err());
        assert!(set_slide_timing(&deck.file(), &[timing("nope", Some(4.0), None)]).is_err());
        assert!(set_slide_timing(&deck.file(), &[timing("a", Some(0.0), None)]).is_err());
        assert_eq!(deck.html(), html);
    }

    #[test]
    fn invalid_timing_reads_as_none() {
        let html = EDITED.replacen(
            "id=\"b\"",
            "id=\"b\" data-duration=\"soon\" data-narration-start=\"later\"",
            1,
        );
        let deck = TempDeck::new(&html);
        let loaded = load(&deck.file()).unwrap();
        assert_eq!(loaded.slides[1].duration, None);
        assert_eq!(loaded.slides[1].narration_start, None);
    }

    #[test]
    fn load_reports_hidden_slides() {
        let deck = TempDeck::new(&EDITED.replace(" id=\"b\"", " id=\"b\" data-hidden"));
        let loaded = load(&deck.file()).unwrap();
        let hidden: Vec<_> = loaded.slides.iter().map(|s| s.hidden).collect();
        assert_eq!(hidden, [false, true]);
    }

    #[test]
    fn narration_is_loaded_saved_and_refused_on_locked_slides() {
        let deck = TempDeck::new(EDITED);
        let narrations = |d: &Deck| {
            d.slides
                .iter()
                .map(|s| s.narration.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(narrations(&load(&deck.file()).unwrap()), ["", ""]);
        let before = load(&deck.file()).unwrap().slides[1].hash.clone();
        let saved = set_slide_narration(&deck.file(), "b", "Point at the chart.").unwrap();
        assert_eq!(narrations(&saved), ["", "Point at the chart."]);
        assert_ne!(saved.slides[1].hash, before);
        assert!(deck
            .html()
            .contains("<aside class=\"narration\">Point at the chart.</aside>"));
        let cleared = set_slide_narration(&deck.file(), "b", "").unwrap();
        assert_eq!(narrations(&cleared), ["", ""]);
        assert_eq!(deck.html(), EDITED);

        set_slide_locked(&deck.file(), None, "a", true).unwrap();
        let locked = deck.html();
        assert!(set_slide_narration(&deck.file(), "a", "No").is_err());
        assert_eq!(deck.html(), locked);
    }

    #[test]
    fn a_slide_keeps_its_expected_time() {
        let deck = TempDeck::new(EDITED);
        let times = |d: &Deck| d.slides.iter().map(|s| s.time).collect::<Vec<_>>();
        assert_eq!(times(&load(&deck.file()).unwrap()), [0, 0]);
        let saved = set_slide_time(&deck.file(), "b", 90).unwrap();
        assert_eq!(times(&saved), [0, 90]);
        assert!(deck.html().contains("data-time=\"90\""));
        let changed = set_slide_time(&deck.file(), "b", 45).unwrap();
        assert_eq!(times(&changed), [0, 45]);
        assert!(!deck.html().contains("data-time=\"90\""));
        let cleared = set_slide_time(&deck.file(), "b", 0).unwrap();
        assert_eq!(times(&cleared), [0, 0]);
        assert_eq!(deck.html(), EDITED);

        set_slide_locked(&deck.file(), None, "a", true).unwrap();
        let locked = deck.html();
        assert!(set_slide_time(&deck.file(), "a", 30).is_err());
        assert_eq!(deck.html(), locked);
        assert!(set_slide_time(&deck.file(), "nope", 30).is_err());
    }

    #[test]
    fn a_time_that_is_no_number_counts_as_none() {
        let deck = TempDeck::new(&EDITED.replacen("id=\"b\"", "id=\"b\" data-time=\"soon\"", 1));
        assert_eq!(load(&deck.file()).unwrap().slides[1].time, 0);
    }

    #[test]
    fn narration_is_added_to_and_refused_on_locked_slides() {
        let deck = TempDeck::new(EDITED);
        let saved = append_slide_narration(&deck.file(), "b", "First.", true).unwrap();
        assert_eq!(saved.slides[1].narration, "First.");
        let saved = append_slide_narration(&deck.file(), "b", "Second.", false).unwrap();
        assert_eq!(saved.slides[1].narration, "First. Second.");
        assert!(!slide_locked(&deck.file(), "b").unwrap());

        set_slide_locked(&deck.file(), None, "b", true).unwrap();
        assert!(slide_locked(&deck.file(), "b").unwrap());
        let locked = deck.html();
        assert!(append_slide_narration(&deck.file(), "b", "No.", true).is_err());
        assert_eq!(deck.html(), locked);
    }

    #[test]
    fn the_narration_voice_and_language_are_kept_in_the_deck() {
        let deck = TempDeck::new(EDITED);
        let settings = |d: &Deck| (d.narration.voice.clone(), d.narration.language.clone());
        assert_eq!(
            settings(&load(&deck.file()).unwrap()),
            ("marin".into(), "en".into())
        );
        let voiced = set_narration_voice(&deck.file(), "coral").unwrap();
        assert_eq!(settings(&voiced), ("coral".into(), "en".into()));
        let spoken = set_narration_language(&deck.file(), "ko").unwrap();
        assert_eq!(settings(&spoken), ("coral".into(), "ko".into()));
        assert!(deck
            .html()
            .contains("<meta name=\"slopslide-narration-voice\" content=\"coral\">"));
        assert!(deck
            .html()
            .contains("<meta name=\"slopslide-narration-language\" content=\"ko\">"));
        // Setting it again replaces the tag.
        set_narration_voice(&deck.file(), "ash").unwrap();
        assert_eq!(deck.html().matches("slopslide-narration-voice").count(), 1);
        let html = deck.html();
        assert!(set_narration_voice(&deck.file(), "nobody").is_err());
        assert!(set_narration_language(&deck.file(), "xx").is_err());
        assert_eq!(deck.html(), html);
    }

    #[test]
    fn the_narration_provider_is_kept_in_the_deck_with_a_voice_it_has() {
        let deck = TempDeck::new(EDITED);
        let narration = |d: &Deck| d.narration.clone();
        set_narration_voice(&deck.file(), "coral").unwrap();
        // An ElevenLabs voice id is no voice of OpenAI, the default.
        assert!(set_narration_voice(&deck.file(), "JBFqnCBsd6RMkjVDRZzb").is_err());

        let eleven = narration(&set_narration_provider(&deck.file(), "elevenlabs").unwrap());
        assert_eq!(eleven.provider, "elevenlabs");
        // OpenAI's voice is replaced by ElevenLabs' default rather than left invalid.
        assert_eq!(eleven.voice, "JBFqnCBsd6RMkjVDRZzb");
        assert!(deck
            .html()
            .contains("<meta name=\"slopslide-narration-provider\" content=\"elevenlabs\">"));
        assert!(deck.html().contains(
            "<meta name=\"slopslide-narration-voice\" content=\"JBFqnCBsd6RMkjVDRZzb\">"
        ));
        // Any ElevenLabs voice id, such as the user's own.
        let own = set_narration_voice(&deck.file(), "abcdefghij1234567890").unwrap();
        assert_eq!(narration(&own).voice, "abcdefghij1234567890");
        assert!(set_narration_voice(&deck.file(), "coral").is_err());

        // Back to OpenAI, the default: no provider meta, and one of its voices.
        let openai = narration(&set_narration_provider(&deck.file(), "openai").unwrap());
        assert_eq!(
            (openai.provider.as_str(), openai.voice.as_str()),
            ("openai", "marin")
        );
        assert!(!deck.html().contains("slopslide-narration-provider"));
        let html = deck.html();
        assert!(set_narration_provider(&deck.file(), "acme").is_err());
        // The removed local model is no provider any more.
        assert!(set_narration_provider(&deck.file(), "local").is_err());
        assert_eq!(deck.html(), html);
    }

    #[test]
    fn load_reports_locked_slides() {
        let deck = TempDeck::new(&EDITED.replace(" id=\"a\"", " id=\"a\" data-locked"));
        assert_eq!(locked_flags(&load(&deck.file()).unwrap()), [true, false]);
    }

    const LOCKED: &str = "<html><head><title>Talk</title></head><body><main>\n<section class=\"slide\" id=\"a\" data-locked>A</section>\n<section class=\"slide\" id=\"b\">B</section>\n</main></body></html>";

    fn locked_flags(deck: &Deck) -> Vec<bool> {
        deck.slides.iter().map(|s| s.locked).collect()
    }

    #[test]
    fn locks_and_unlocks_slides_on_disk() {
        let deck = TempDeck::new(EDITED);
        let locked = set_slide_locked(&deck.file(), Some(&deck.session()), "b", true).unwrap();
        assert_eq!(locked_flags(&locked), [false, true]);
        assert!(deck
            .html()
            .contains("<section data-locked class=\"slide\" id=\"b\">B<"));
        let unlocked = set_slide_locked(&deck.file(), Some(&deck.session()), "b", false).unwrap();
        assert_eq!(locked_flags(&unlocked), [false, false]);
        assert_eq!(deck.html(), EDITED);
        assert!(set_slide_locked(&deck.file(), Some(&deck.session()), "zz", true).is_err());
    }

    #[test]
    fn the_editor_cannot_change_or_delete_a_locked_slide() {
        let deck = TempDeck::new(LOCKED);
        let base = load(&deck.file()).unwrap().slides[0].hash.clone();
        let markup = "<section class=\"slide\" id=\"a\" data-locked>mine</section>";
        let err = update_slide(&deck.file(), "a", markup, &base).unwrap_err();
        assert!(err.to_string().contains("locked"), "{err}");
        let err = delete_slides(&deck.file(), &ids(&["a"])).unwrap_err();
        assert!(err.to_string().contains("locked"), "{err}");
        assert_eq!(deck.html(), LOCKED);

        // Other slides, hiding, and moving it stay open.
        let base = load(&deck.file()).unwrap().slides[1].hash.clone();
        let other = "<section class=\"slide\" id=\"b\">B!</section>";
        update_slide(&deck.file(), "b", other, &base).unwrap();
        set_slides_hidden(&deck.file(), Some(&deck.session()), &ids(&["a"]), true).unwrap();
        let moved = reorder(&deck.file(), vec!["b".into(), "a".into()]).unwrap();
        assert_eq!(slide_ids(&moved.deck), ["b", "a"]);
        delete_slides(&deck.file(), &ids(&["b"])).unwrap();
    }

    #[test]
    fn source_edits_cannot_change_a_locked_slide() {
        let deck = TempDeck::new(LOCKED);
        let changed = LOCKED.replace(">A<", ">mine<");
        let err = save_source(&deck.file(), &changed, Some(LOCKED), false).unwrap_err();
        assert!(
            err.to_string()
                .contains("Locked slides cannot be changed: a"),
            "{err}"
        );
        let unlocked = LOCKED.replace(" data-locked", "");
        assert!(save_source(&deck.file(), &unlocked, Some(LOCKED), false).is_err());
        assert_eq!(deck.html(), LOCKED);

        // Changing the rest of the deck, or locking another slide, is fine.
        let other = LOCKED
            .replace(">B<", ">B!<")
            .replace("id=\"b\"", "id=\"b\" data-locked");
        save_source(&deck.file(), &other, Some(LOCKED), false).unwrap();
        assert_eq!(deck.html(), other);
        let crlf = other.replace('\n', "\r\n").replace(">B!<", ">B<");
        assert!(
            save_source(&deck.file(), &crlf, Some(&other), false).is_err(),
            "line endings alone are not a change, the text is"
        );
        let crlf = other.replace('\n', "\r\n");
        save_source(&deck.file(), &crlf, Some(&other), false).unwrap();
    }

    #[test]
    fn opening_a_deck_drops_a_stale_guard() {
        let deck = TempDeck::new(LOCKED);
        guard_locked(&deck.file(), &deck.session()).unwrap();
        open(&deck.file(), Some(&deck.session()), false).unwrap();
        assert_eq!(
            read_guard(&deck.file(), Some(&deck.session())).len(),
            1,
            "a running turn keeps its guard"
        );
        open(&deck.file(), Some(&deck.session()), true).unwrap();
        assert!(read_guard(&deck.file(), Some(&deck.session())).is_empty());
    }

    #[test]
    fn save_reports_missing_deck() {
        let deck = TempDeck::new(ORIGINAL);
        fs::remove_file(deck.0.join(DECK_FILE)).unwrap();
        assert!(save_source(&deck.file(), EDITED, Some(ORIGINAL), false).is_err());
        assert!(!deck.0.join(DECK_FILE).exists());
    }

    #[test]
    fn edit_base_ignores_line_endings() {
        assert!(same_text("<p>\r\n</p>\r\n", "<p>\n</p>\n"));
        assert!(same_text("", ""));
        assert!(!same_text("<p>a</p>", "<p>b</p>"));
        assert!(!same_text("<p>\n</p>", "<p>\n\n</p>"));
    }

    #[test]
    fn template_is_a_valid_empty_deck() {
        let deck = html::ensure_runtime(&html::set_title(DECK_TEMPLATE, "Hello"));
        assert!(html::find_slides(&deck).is_empty());
        assert_eq!(html::title(&deck).as_deref(), Some("Hello"));
        let (with_slide, id) = html::insert(&deck, None, BLANK_SLIDE, "slide").unwrap();
        assert_eq!(id, "slide");
        assert_eq!(html::find_slides(&with_slide).len(), 1);
    }

    /// A throwaway library folder.
    struct TempLib(TempDir);

    impl TempLib {
        fn new() -> Self {
            TempLib(TempDir::new("lib"))
        }
        fn add(&self, id: &str, html: &str) -> PathBuf {
            let dir = self.0.join(id);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join(DECK_FILE), html).unwrap();
            dir
        }
    }

    const THREE: &str = "<html><head><title>Three</title></head><body><main class=\"deck\">\n  <section class=\"slide\" id=\"a\">A</section>\n  <section class=\"slide\" id=\"b\">B</section>\n  <section class=\"slide\" id=\"c\">C</section>\n</main></body></html>";

    fn slide_ids(deck: &Deck) -> Vec<&str> {
        deck.slides.iter().map(|s| s.id.as_str()).collect()
    }

    #[test]
    fn resolve_accepts_nested_and_dot_paths() {
        let dir = Path::new("/tmp/deck");
        assert_eq!(
            resolve_in_deck(dir, "./assets/a b.png").unwrap(),
            dir.join("./assets/a b.png")
        );
        assert!(resolve_in_deck(dir, "deck.html").is_ok());
        assert!(resolve_in_deck(dir, "").is_err());
        assert!(resolve_in_deck(dir, "..").is_err());
    }

    #[test]
    fn deck_file_takes_absolute_paths_of_html_files() {
        let lib = TempLib::new();
        let talk = lib.add("talk", ORIGINAL).join(DECK_FILE);
        let other = lib.0.join("talk/q3.HTM");
        fs::write(&other, ORIGINAL).unwrap();
        fs::write(lib.0.join("notes.txt"), "x").unwrap();
        assert_eq!(deck_file(&talk.to_string_lossy()).unwrap(), talk);
        assert_eq!(deck_file(&other.to_string_lossy()).unwrap(), other);
        for bad in [
            "".to_string(),
            "talk/deck.html".into(),
            lib.0.join("notes.txt").to_string_lossy().into_owned(),
            lib.0.join("talk").to_string_lossy().into_owned(),
        ] {
            let err = deck_file(&bad).unwrap_err().to_string();
            assert!(err.contains("invalid deck id"), "{bad}: {err}");
        }
        let missing = lib.0.join("missing.html");
        let err = deck_file(&missing.to_string_lossy())
            .unwrap_err()
            .to_string();
        assert!(err.contains("deck not found"), "{err}");
    }

    #[test]
    fn creates_decks_in_unique_slugged_folders() {
        let lib = TempLib::new();
        let first = create(&lib.0, "  Series A pitch!  ", None).unwrap();
        let file = lib.0.join("series-a-pitch").join(DECK_FILE);
        assert_eq!(Path::new(&first.id), file);
        assert_eq!(first.path, first.id);
        assert_eq!(first.title, "Series A pitch!");
        assert!(first.slides.is_empty());
        let folder_of = |deck: &Deck| {
            let file = PathBuf::from(&deck.id);
            folder(&file)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        };
        let second = create(&lib.0, "Series A Pitch", None).unwrap();
        assert_eq!(folder_of(&second), "series-a-pitch-2");
        let untitled = create(&lib.0, "   ", None).unwrap();
        assert_eq!(
            (folder_of(&untitled).as_str(), untitled.title.as_str()),
            ("untitled-deck", "Untitled deck")
        );
        let symbols = create(&lib.0, "日本語", None).unwrap();
        assert_eq!(folder_of(&symbols), "untitled");
        assert_eq!(symbols.title, "日本語");

        let html = fs::read_to_string(&file).unwrap();
        assert!(html.contains("<title>Series A pitch!</title>"));
        assert!(
            html.contains("slopslide:runtime-js"),
            "created decks are normalized"
        );
    }

    #[test]
    fn normalize_writes_only_the_deck_file_and_is_idempotent() {
        let deck = TempDeck::new(&EDITED.replace(" id=\"b\"", ""));
        normalize(&deck.file()).unwrap();
        let entries: Vec<_> = fs::read_dir(&deck.0)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, [DECK_FILE], "nothing next to the deck");
        let once = deck.html();
        assert!(once.contains("id=\"slide-2\""));
        normalize(&deck.file()).unwrap();
        assert_eq!(deck.html(), once);
    }

    #[test]
    fn normalize_does_not_rewrite_an_already_tidy_deck() {
        let deck = TempDeck::new(ORIGINAL);
        normalize(&deck.file()).unwrap();
        let past = SystemTime::now() - std::time::Duration::from_secs(3600);
        let file = deck.0.join(DECK_FILE);
        fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(past)
            .unwrap();
        let modified = |file: &Path| fs::metadata(file).unwrap().modified().unwrap();
        let before = modified(&file);
        normalize(&deck.file()).unwrap();
        assert_eq!(
            modified(&file),
            before,
            "no write, so the watcher stays quiet"
        );
    }

    #[test]
    fn open_only_normalizes_when_asked() {
        let deck = TempDeck::new(&EDITED.replace(" id=\"b\"", ""));
        let raw = open(&deck.file(), Some(&deck.session()), false).unwrap();
        assert_eq!(slide_ids(&raw), ["a", "#2"]);
        assert!(!deck.html().contains("slopslide:runtime"));
        let tidy = open(&deck.file(), Some(&deck.session()), true).unwrap();
        assert_eq!(slide_ids(&tidy), ["a", "slide-2"]);
    }

    #[test]
    fn load_hashes_change_per_slide() {
        let deck = TempDeck::new(THREE);
        let before = load(&deck.file()).unwrap();
        assert_eq!(Path::new(&before.id), deck.file());
        assert_eq!(before.path, before.id);
        assert_eq!(before.title, "Three");
        fs::write(deck.0.join(DECK_FILE), THREE.replace(">B<", ">Bee<")).unwrap();
        let after = load(&deck.file()).unwrap();
        let changed: Vec<_> = before
            .slides
            .iter()
            .zip(&after.slides)
            .filter(|(a, b)| a.hash != b.hash)
            .map(|(a, _)| a.id.as_str())
            .collect();
        assert_eq!(changed, ["b"]);
        assert_eq!(before.shell_hash, after.shell_hash);

        fs::write(
            deck.0.join(DECK_FILE),
            THREE.replace("<head>", "<head><style>x</style>"),
        )
        .unwrap();
        let restyled = load(&deck.file()).unwrap();
        assert_ne!(before.shell_hash, restyled.shell_hash);
        assert!(before
            .slides
            .iter()
            .zip(&restyled.slides)
            .all(|(a, b)| a.hash == b.hash));
    }

    #[test]
    fn load_falls_back_to_the_file_name_for_the_title() {
        let lib = TempLib::new();
        let file = lib.add("my-talk", "<main></main>").join(DECK_FILE);
        assert_eq!(load(&file).unwrap().title, "my talk");
        let other = file.with_file_name("q3_numbers.html");
        fs::write(&other, "<main></main>").unwrap();
        assert_eq!(load(&other).unwrap().title, "q3 numbers");
    }

    #[test]
    fn deck_serializes_in_camel_case_for_the_frontend() {
        let deck = TempDeck::new(ORIGINAL);
        let json = serde_json::to_value(load(&deck.file()).unwrap()).unwrap();
        assert!(json["shellHash"].is_string());
        assert_eq!(json["slides"][0]["id"], "a");
        assert!(json["slides"][0]["hash"].is_string());
        assert_eq!(
            json["size"],
            serde_json::json!({"width":1920.0,"height":1080.0,"unit":"px","pixelWidth":1920,"pixelHeight":1080})
        );
    }

    fn marks(ids: &[&str]) -> Review {
        ids.iter()
            .map(|id| {
                let stroke = review::Stroke {
                    tool: review::InkTool::Highlighter,
                    color: "#facc15".into(),
                    points: vec![[0.25, 0.5], [0.75, 0.5]],
                };
                (id.to_string(), vec![stroke])
            })
            .collect()
    }

    #[test]
    fn review_marks_are_saved_in_the_deck_and_loaded_back() {
        let deck = TempDeck::new(THREE);
        save_review(&deck.file(), &marks(&["b", "gone"])).unwrap();
        let loaded = load(&deck.file()).unwrap();
        assert_eq!(
            loaded.review,
            marks(&["b"]),
            "marks of missing slides are dropped"
        );
        assert!(deck.html().contains(review::START));

        save_review(&deck.file(), &Review::new()).unwrap();
        assert_eq!(deck.html(), THREE, "clearing every mark removes the block");
    }

    fn notes(ids: &[&str]) -> Comments {
        ids.iter()
            .map(|id| {
                let comment = comments::Comment {
                    id: format!("on-{id}"),
                    text: "Bigger".into(),
                    x: 0.5,
                    y: 0.5,
                    target: None,
                    area: None,
                };
                (id.to_string(), vec![comment])
            })
            .collect()
    }

    #[test]
    fn comments_are_saved_in_the_deck_and_loaded_back() {
        let deck = TempDeck::new(THREE);
        save_comments(&deck.file(), &notes(&["b", "gone"])).unwrap();
        assert_eq!(load(&deck.file()).unwrap().comments, notes(&["b"]));
        assert!(deck.html().contains(comments::START));
        save_comments(&deck.file(), &Comments::new()).unwrap();
        assert!(!deck.html().contains(comments::START));
    }

    #[test]
    fn normalizing_drops_marks_and_comments_of_slides_that_are_gone() {
        let html = comments::write(
            &review::write(THREE, &marks(&["a", "gone"])),
            &notes(&["b", "gone"]),
        );
        let deck = TempDeck::new(&html);
        normalize(&deck.file()).unwrap();
        let loaded = load(&deck.file()).unwrap();
        assert_eq!(loaded.review, marks(&["a"]));
        assert_eq!(loaded.comments, notes(&["b"]));
    }

    #[test]
    fn saving_unchanged_review_marks_leaves_the_file_alone() {
        let deck = TempDeck::new(THREE);
        save_review(&deck.file(), &marks(&["a"])).unwrap();
        let path = deck.0.join(DECK_FILE);
        let before = fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        save_review(&deck.file(), &marks(&["a"])).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), before);
    }

    #[test]
    fn review_marks_and_comments_leave_slide_and_shell_hashes_alone() {
        let deck = TempDeck::new(THREE);
        let before = load(&deck.file()).unwrap();
        save_review(&deck.file(), &marks(&["a", "c"])).unwrap();
        save_comments(&deck.file(), &notes(&["a", "c"])).unwrap();
        let after = load(&deck.file()).unwrap();
        assert_eq!(before.shell_hash, after.shell_hash);
        let hashes = |d: &Deck| d.slides.iter().map(|s| s.hash.clone()).collect::<Vec<_>>();
        assert_eq!(hashes(&after), hashes(&before));
    }

    #[test]
    fn rename_trims_and_escapes() {
        let deck = TempDeck::new(THREE);
        let renamed = rename(&deck.file(), "  R&D <2025>  ").unwrap();
        assert_eq!(renamed.title, "R&D <2025>");
        assert!(deck.html().contains("<title>R&amp;D &lt;2025&gt;</title>"));
        assert_eq!(slide_ids(&renamed), ["a", "b", "c"]);
    }

    #[test]
    fn reorder_persists_and_refuses_stale_orders() {
        let deck = TempDeck::new(THREE);
        let order = vec!["c".to_string(), "a".to_string(), "b".to_string()];
        assert_eq!(
            slide_ids(&reorder(&deck.file(), order).unwrap().deck),
            ["c", "a", "b"]
        );
        assert_eq!(slide_ids(&load(&deck.file()).unwrap()), ["c", "a", "b"]);
        let before = deck.html();
        let err = reorder(&deck.file(), vec!["a".into(), "b".into()]).unwrap_err();
        assert!(err.to_string().contains("try again"), "{err}");
        assert_eq!(deck.html(), before, "a refused edit writes nothing");
    }

    #[test]
    fn add_blank_inserts_after_the_given_slide() {
        let deck = TempDeck::new(THREE);
        let (after_a, id) = add_blank(&deck.file(), Some("a".into())).unwrap();
        assert_eq!(id, "slide");
        assert_eq!(slide_ids(&after_a), ["a", "slide", "b", "c"]);
        let (at_end, id) = add_blank(&deck.file(), None).unwrap();
        assert_eq!(id, "slide-2");
        assert_eq!(slide_ids(&at_end), ["a", "slide", "b", "c", "slide-2"]);
        assert!(deck
            .html()
            .contains("<section class=\"slide layout-blank\" id=\"slide\"></section>"));
        assert!(!deck.html().contains("Untitled slide"));
    }

    #[test]
    fn restores_slides_from_an_earlier_version() {
        let deck = TempDeck::new(THREE);
        let version = deck.html();
        let edited = THREE
            .replace(">A<", ">A edited<")
            .replace(">B<", ">B edited<");
        fs::write(deck.file(), &edited).unwrap();
        let restored = restore_slides(&deck.file(), &version, &ids(&["a", "gone"])).unwrap();
        assert!(deck.html().contains(">A</section>"));
        assert!(
            deck.html().contains(">B edited<"),
            "other slides keep their edits"
        );
        assert_eq!(slide_ids(&restored), ["a", "b", "c"]);
        fs::write(
            deck.file(),
            edited.replace("id=\"b\"", "id=\"b\" data-locked"),
        )
        .unwrap();
        assert!(restore_slides(&deck.file(), &version, &ids(&["b"])).is_err());
    }

    fn ids(slides: &[&str]) -> Vec<String> {
        slides.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn rail_edits_change_many_slides_in_one_write() {
        let deck = TempDeck::new(THREE);
        let hidden = set_slides_hidden(&deck.file(), None, &ids(&["a", "c"]), true).unwrap();
        assert_eq!(
            hidden
                .deck
                .slides
                .iter()
                .map(|s| s.hidden)
                .collect::<Vec<_>>(),
            [true, false, true]
        );
        let copied = duplicate_slides(&deck.file(), &ids(&["a", "c"])).unwrap();
        assert_eq!(copied.created, ["a-copy", "c-copy"]);
        assert_eq!(slide_ids(&copied.deck), ["a", "a-copy", "b", "c", "c-copy"]);
        assert_eq!(
            deck.html().matches(">C</section>").count(),
            2,
            "copies the markup"
        );
        let deleted = delete_slides(&deck.file(), &ids(&["a", "b"])).unwrap();
        assert_eq!(slide_ids(&deleted.deck), ["a-copy", "c", "c-copy"]);
    }

    #[test]
    fn a_rail_edit_is_undone_by_saving_its_previous_source_back() {
        let deck = TempDeck::new(THREE);
        save_review(&deck.file(), &marks(&["a", "b"])).unwrap();
        let before = deck.html();
        let deleted = delete_slides(&deck.file(), &ids(&["b"])).unwrap();
        assert_eq!(deleted.previous, before);
        assert_eq!(deleted.source, deck.html());

        let restored = save_source(
            &deck.file(),
            &deleted.previous,
            Some(&deleted.source),
            false,
        )
        .unwrap();
        assert_eq!(slide_ids(&restored), ["a", "b", "c"]);
        assert_eq!(restored.review, marks(&["a", "b"]));
        assert_eq!(deck.html(), before);

        let moved = reorder(&deck.file(), ids(&["c", "b", "a"])).unwrap();
        set_slide_notes(&deck.file(), "a", "Changed since").unwrap();
        assert!(
            save_source(&deck.file(), &moved.previous, Some(&moved.source), false).is_err(),
            "an undo refuses to overwrite what came after the edit"
        );
    }

    #[test]
    fn a_rail_delete_with_a_locked_or_missing_slide_changes_nothing() {
        let deck = TempDeck::new(THREE);
        set_slide_locked(&deck.file(), None, "b", true).unwrap();
        let before = deck.html();
        let err = delete_slides(&deck.file(), &ids(&["a", "b"])).unwrap_err();
        assert!(err.to_string().contains("locked"), "{err}");
        assert!(delete_slides(&deck.file(), &ids(&["a", "nope"])).is_err());
        assert!(set_slides_hidden(&deck.file(), None, &ids(&["a", "nope"]), true).is_err());
        assert!(duplicate_slides(&deck.file(), &ids(&["a", "nope"])).is_err());
        assert_eq!(deck.html(), before);
    }

    #[test]
    fn notes_are_loaded_saved_and_refused_on_locked_slides() {
        let deck = TempDeck::new(EDITED);
        let notes = |d: &Deck| d.slides.iter().map(|s| s.notes.clone()).collect::<Vec<_>>();
        assert_eq!(notes(&load(&deck.file()).unwrap()), ["", ""]);
        let saved = set_slide_notes(&deck.file(), "b", "Mention the budget.").unwrap();
        assert_eq!(notes(&saved), ["", "Mention the budget."]);
        assert_eq!(saved.slides[1].narration, "");
        assert!(deck
            .html()
            .contains("<aside class=\"notes\">Mention the budget.</aside>"));
        assert_eq!(
            notes(&set_slide_notes(&deck.file(), "b", "").unwrap()),
            ["", ""]
        );
        assert_eq!(deck.html(), EDITED);

        set_slide_locked(&deck.file(), None, "a", true).unwrap();
        let locked = deck.html();
        let err = set_slide_notes(&deck.file(), "a", "No").unwrap_err();
        assert!(err.to_string().contains("locked"), "{err}");
        assert_eq!(deck.html(), locked);
    }

    #[test]
    fn deleting_a_slide_drops_its_review_marks_and_comments() {
        let deck = TempDeck::new(THREE);
        save_review(&deck.file(), &marks(&["a", "b"])).unwrap();
        save_comments(&deck.file(), &notes(&["a", "b"])).unwrap();
        let deleted = delete_slides(&deck.file(), &ids(&["b"])).unwrap();
        assert_eq!(deleted.deck.review, marks(&["a"]));
        assert_eq!(deleted.deck.comments, notes(&["a"]));
        let loaded = load(&deck.file()).unwrap();
        assert_eq!(
            (loaded.review, loaded.comments),
            (marks(&["a"]), notes(&["a"]))
        );

        delete_slides(&deck.file(), &ids(&["a"])).unwrap();
        assert!(
            !deck.html().contains(review::START),
            "deleting the last marked slide removes the block"
        );
    }

    #[test]
    fn the_teleprompter_example_lints_clean_and_has_a_script_to_follow() {
        let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/teleprompter/deck.html");
        let issues = lint(&file, None).unwrap();
        assert!(issues.is_empty(), "{issues:?}");
        let deck = load(&file).unwrap();
        assert_eq!(deck.slides.len(), 8);
        let slide = |id: &str| deck.slides.iter().find(|s| s.id == id).unwrap();
        assert!(slide("origin").narration.contains("\n\n"));
        assert!(slide("notes-only").narration.is_empty());
        assert!(!slide("notes-only").notes.is_empty());
        assert!(slide("end").notes.is_empty());
    }

    #[test]
    fn lint_checks_assets_on_disk() {
        let deck = TempDeck::new(
            "<!DOCTYPE html><html><head><title>T</title></head><body><main class=\"deck\"><section class=\"slide\" id=\"a\"><img src=\"assets/my%20dot.png\" alt=\"\"><img src=\"assets/missing.png\" alt=\"\"><img src=\"assets/../deck.html\" alt=\"\"></section></main></body></html>",
        );
        fs::create_dir_all(deck.0.join("assets")).unwrap();
        fs::write(deck.0.join("assets/my dot.png"), [0]).unwrap();
        let missing: Vec<_> = lint(&deck.file(), Some(&deck.session()))
            .unwrap()
            .into_iter()
            .filter(|i| i.rule == "missing-asset")
            .map(|i| i.message)
            .collect();
        assert_eq!(missing.len(), 2, "{missing:?}");
        assert!(missing[0].contains("assets/missing.png"));
        assert!(
            missing[1].contains("assets/../deck.html"),
            "escaping paths count as missing"
        );
        assert!(lint(&deck.0.join("nope"), None).is_err());
    }

    #[test]
    fn export_keeps_shared_heroes_and_the_motion_player() {
        let deck = TempDeck::new(
            r#"<html><head></head><body><main class="deck"><section class="slide" id="a"><img data-morph="hero" src="assets/dot.png"></section><section class="slide" id="b"><img data-morph="hero" src="assets/dot.png"></section></main></body></html>"#,
        );
        fs::create_dir_all(deck.0.join("assets")).unwrap();
        fs::write(deck.0.join("assets/dot.png"), [0x89, b'P', b'N', b'G']).unwrap();
        let dest = deck.0.join("motion.html");
        export(&deck.file(), &dest).unwrap();
        let out = fs::read_to_string(dest).unwrap();
        assert_eq!(out.matches(r#"data-morph="hero""#).count(), 2);
        assert_eq!(out.matches("src=\"data:image/png;base64,").count(), 2);
        assert!(out.contains("document.startViewTransition(update)"));
        assert!(out.contains("::view-transition-group(*)"));
        assert!(!out.contains("src=\"assets/dot.png\""));
    }

    #[test]
    fn export_inlines_assets_and_installs_the_runtime() {
        let deck = TempDeck::new(
            "<html><head></head><body><main class=\"deck\"><section class=\"slide\" id=\"a\"><img src=\"assets/dot.png\"><img src=\"assets/missing.png\"><img src=\"assets/../../escape.png\"></section></main></body></html>",
        );
        fs::create_dir_all(deck.0.join("assets")).unwrap();
        fs::write(deck.0.join("assets/dot.png"), [0x89, b'P', b'N', b'G']).unwrap();
        let dest = deck.0.join("out.html");
        export(&deck.file(), &dest).unwrap();
        let out = fs::read_to_string(&dest).unwrap();
        assert!(
            out.contains("src=\"data:image/png;base64,iVBORw==\""),
            "{out}"
        );
        assert!(
            out.contains("src=\"assets/missing.png\""),
            "missing assets are left as-is"
        );
        assert!(
            out.contains("src=\"assets/../../escape.png\""),
            "escaping paths are not read"
        );
        assert!(out.contains("slopslide:runtime-js"));
        assert!(
            !deck.html().contains("data:"),
            "the deck itself is unchanged"
        );
    }

    #[test]
    fn named_decks_resolve_their_own_assets_and_reject_shared_parent_images() {
        let deck = TempDeck::new(ORIGINAL);
        fs::create_dir_all(deck.0.join("assets")).unwrap();
        fs::write(deck.0.join("assets/x.png"), "png").unwrap();
        let file = deck.0.join("q3.html");
        fs::write(&file, "<html><body><main class=\"deck\"><section class=\"slide\" id=\"a\"><img src=\"assets/x.png\" alt=\"X\"><img src=\"../shared/x.png\" alt=\"X\"></section></main></body></html>").unwrap();
        let issues = lint(&file, None).unwrap();
        assert!(!issues.iter().any(|i| i.rule == "missing-asset"));
        assert!(issues.iter().any(|i| i.rule == "asset-outside-deck"));
    }

    const SECTIONED: &str = "<html><head><title>S</title></head><body><main class=\"deck\">\n  <section class=\"slide\" id=\"a\">A</section>\n  <div class=\"deck-section\" data-title=\"Part two\"></div>\n  <section class=\"slide\" id=\"b\">B</section>\n  <section class=\"slide\" id=\"c\">C</section>\n</main></body></html>";

    fn sections(deck: &Deck) -> Vec<(usize, &str, usize)> {
        deck.sections
            .iter()
            .map(|s| (s.index, s.title.as_str(), s.before))
            .collect()
    }

    #[test]
    fn load_lists_sections_without_counting_them_as_slides() {
        let deck = TempDeck::new(SECTIONED);
        let loaded = load(&deck.file()).unwrap();
        assert_eq!(slide_ids(&loaded), ["a", "b", "c"]);
        assert_eq!(sections(&loaded), [(0, "Part two", 1)]);
        assert!(load(&TempDeck::new(THREE).file())
            .unwrap()
            .sections
            .is_empty());
        let json = serde_json::to_value(&loaded).unwrap();
        assert_eq!(json["sections"][0]["title"], "Part two");
        assert_eq!(json["sections"][0]["before"], 1);
    }

    #[test]
    fn adds_renames_and_deletes_sections() {
        let deck = TempDeck::new(THREE);
        let added = add_section(&deck.file(), Some("c".into()), "Finale").unwrap();
        assert_eq!(sections(&added), [(0, "Finale", 2)]);
        let added = add_section(&deck.file(), Some("a".into()), "Start").unwrap();
        assert_eq!(sections(&added), [(0, "Start", 0), (1, "Finale", 2)]);
        let renamed = rename_section(&deck.file(), 1, "The end").unwrap();
        assert_eq!(sections(&renamed), [(0, "Start", 0), (1, "The end", 2)]);
        let removed = delete_section(&deck.file(), 0).unwrap();
        assert_eq!(sections(&removed), [(0, "The end", 2)]);
        assert_eq!(slide_ids(&removed), ["a", "b", "c"]);
        assert!(delete_section(&deck.file(), 4).is_err());
        assert!(rename_section(&deck.file(), 4, "x").is_err());
        assert!(add_section(&deck.file(), Some("zzz".into()), "x").is_err());
    }

    #[test]
    fn section_edits_do_not_reload_slide_previews() {
        let deck = TempDeck::new(SECTIONED);
        let before = load(&deck.file()).unwrap();
        let renamed = rename_section(&deck.file(), 0, "Renamed").unwrap();
        assert_eq!(before.shell_hash, renamed.shell_hash);
        assert!(before
            .slides
            .iter()
            .zip(&renamed.slides)
            .all(|(a, b)| a.hash == b.hash));
    }

    #[test]
    fn reorder_slides_and_sections_together() {
        let deck = TempDeck::new(SECTIONED);
        let order = ["a", "b", "section:0", "c"].map(String::from).to_vec();
        let out = reorder(&deck.file(), order).unwrap().deck;
        assert_eq!(slide_ids(&out), ["a", "b", "c"]);
        assert_eq!(sections(&out), [(0, "Part two", 2)]);
        assert!(reorder(&deck.file(), vec!["a".into(), "b".into(), "c".into()]).is_err());
    }

    #[test]
    fn export_keeps_section_markers_for_the_player_to_hide() {
        let deck = TempDeck::new(SECTIONED);
        let dest = deck.0.join("out.html");
        export(&deck.file(), &dest).unwrap();
        let exported = fs::read_to_string(dest).unwrap();
        assert!(exported.contains("data-title=\"Part two\""));
        assert!(exported.contains(".deck > .deck-section"));
    }

    #[test]
    fn creates_decks_from_a_template() {
        let lib = TempLib::new();
        let source = include_str!("../templates/swiss.html");
        let deck = create(
            &lib.0,
            "Board update",
            Some(TemplateSource {
                id: "swiss",
                html: source,
            }),
        )
        .unwrap();
        assert_eq!(deck.title, "Board update");
        assert_eq!(deck.template.as_deref(), Some("swiss"));
        assert!(deck.slides.is_empty());
        let html = fs::read_to_string(PathBuf::from(&deck.id)).unwrap();
        assert!(
            html.contains("Hanken Grotesk"),
            "takes the template's styles"
        );
        assert_eq!(lint(Path::new(&deck.id), None).unwrap(), vec![]);
        assert_eq!(create(&lib.0, "Plain", None).unwrap().template, None);
    }

    #[test]
    fn applies_a_template_to_an_empty_deck_only() {
        let lib = TempLib::new();
        let deck = create(&lib.0, "Pitch", None).unwrap();
        let dir = PathBuf::from(&deck.id);
        let source = include_str!("../templates/synthwave.html");
        let template = || TemplateSource {
            id: "synthwave",
            html: source,
        };
        let styled = apply_template(&dir, template()).unwrap();
        assert_eq!(styled.template.as_deref(), Some("synthwave"));
        assert_eq!(styled.title, "Pitch", "keeps the deck's title");
        assert!(read_html(&dir).unwrap().contains("Audiowide"));

        let (with_slide, _) = add_blank(&dir, None).unwrap();
        assert_eq!(with_slide.slides.len(), 1);
        let before = read_html(&dir).unwrap();
        assert!(apply_template(&dir, template()).is_err());
        assert_eq!(read_html(&dir).unwrap(), before);
    }

    #[test]
    fn sets_the_slide_size_and_refreshes_the_runtime() {
        let lib = TempLib::new();
        let deck = create(&lib.0, "Poster", None).unwrap();
        assert_eq!(deck.size, SizeInfo::from(SlideSize::default()));
        let dir = PathBuf::from(&deck.id);
        add_blank(&dir, None).unwrap();

        let a4 = SlideSize::parse("21x29.7cm").unwrap();
        let resized = set_slide_size(&dir, a4).unwrap();
        assert_eq!(resized.size.size, a4);
        assert_eq!(
            (resized.size.pixel_width, resized.size.pixel_height),
            (794, 1123)
        );
        assert_eq!(resized.slides.len(), 1, "keeps the slides");
        let html = read_html(&dir).unwrap();
        assert!(html.contains("<meta name=\"slopslide-size\" content=\"21x29.7cm\">"));
        assert!(
            html.contains("--slop-w: 794px;"),
            "the stage takes the new size"
        );
        assert!(!html.contains("--slop-w: 1920px;"));
        assert_eq!(lint(&dir, None).unwrap(), vec![]);
        assert_eq!(load(&dir).unwrap().size, resized.size);

        // Back to the default: the meta goes away again.
        let back = set_slide_size(&dir, SlideSize::default()).unwrap();
        assert_eq!(back.size, SizeInfo::from(SlideSize::default()));
        let html = read_html(&dir).unwrap();
        assert!(!html.contains("<meta name=\"slopslide-size\""));
        assert!(html.contains("--slop-w: 1920px;"));

        let tiny = SlideSize {
            width: 10.0,
            ..SlideSize::default()
        };
        assert!(set_slide_size(&dir, tiny).is_err());
        assert_eq!(read_html(&dir).unwrap(), html, "a bad size changes nothing");
    }

    #[test]
    fn applying_a_template_keeps_a_chosen_slide_size() {
        let lib = TempLib::new();
        let source = include_str!("../templates/swiss.html");
        let template = || TemplateSource {
            id: "swiss",
            html: source,
        };
        let deck = create(&lib.0, "Square", None).unwrap();
        let dir = PathBuf::from(&deck.id);
        let square = SlideSize::parse("1080x1080").unwrap();
        set_slide_size(&dir, square).unwrap();
        let styled = apply_template(&dir, template()).unwrap();
        assert_eq!(styled.template.as_deref(), Some("swiss"));
        assert_eq!(styled.size.size, square);
        assert!(read_html(&dir).unwrap().contains("--slop-h: 1080px;"));
        assert!(read_html(&dir).unwrap().contains("--slop-w: 1080px;"));
        assert_eq!(lint(&dir, None).unwrap(), vec![]);

        // A portrait template gives its size to a deck that never picked one.
        let portrait = html::set_slide_size(source, SlideSize::parse("1080x1350").unwrap());
        let plain = create(&lib.0, "Plain", None).unwrap();
        let styled = apply_template(
            Path::new(&plain.id),
            TemplateSource {
                id: "swiss",
                html: &portrait,
            },
        )
        .unwrap();
        assert_eq!(
            (styled.size.pixel_width, styled.size.pixel_height),
            (1080, 1350)
        );
    }

    #[test]
    fn adds_slides_from_a_template() {
        let deck = TempDeck::new(THREE);
        let source = include_str!("../templates/editorial.html");
        let (after_a, id) =
            add_template_slide(&deck.file(), Some("a".into()), source, "quote").unwrap();
        assert_eq!(id, "quote");
        assert_eq!(slide_ids(&after_a), ["a", "quote", "b", "c"]);
        assert!(deck.html().contains("layout-quote"));
        let (at_end, second) = add_template_slide(&deck.file(), None, source, "quote").unwrap();
        assert_eq!(second, "quote-2");
        assert_eq!(slide_ids(&at_end).last(), Some(&"quote-2"));
        assert!(add_template_slide(&deck.file(), None, source, "nope").is_err());
    }
}
