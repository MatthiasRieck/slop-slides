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
//! app ([`crate::agent::SYSTEM_PROMPT`]) or in the user's [`app_home`] folder (user templates,
//! the agent's MCP config, sessions). Functions taking a `session` keep their part of that
//! state in the workspace's current session folder.
//!
//! A deck opens directly in any browser as a slideshow; [`export`] inlines the assets so the
//! single file can be shared on its own.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};
use crate::html;
use crate::lint;
use crate::review::{self, Review};
use crate::sessions;
use crate::size::{SizeInfo, SlideSize, SIZE_META};
use crate::templates;

/// The app's folder in the user's home.
pub const HOME_DIR: &str = ".slopslides";
/// The file name of decks the app creates.
pub const DECK_FILE: &str = "deck.html";
const DECK_TEMPLATE: &str = include_str!("../assets/deck-template.html");
const BLANK_SLIDE: &str = include_str!("../assets/blank-slide.html");
const SNAPSHOTS_KEPT: usize = 30;
const SKETCHES_KEPT: usize = 30;
/// The locked slides as they were when the agent's turn started (see [`guard_locked`]).
const LOCKS_FILE: &str = "locked.json";

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
    /// Id of the template the deck's design comes from (see [`crate::templates`]).
    pub template: Option<String>,
    /// Every slide's canvas (see [`crate::size`]).
    pub size: SizeInfo,
}

/// `~/Documents/SlopSlide`, where decks lived before workspaces; the default workspace.
pub fn library_root(app: &AppHandle) -> Result<PathBuf> {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| Error::msg(format!("cannot locate documents folder: {e}")))?;
    let root = base.join("SlopSlide");
    fs::create_dir_all(&root)?;
    Ok(root)
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

fn read_html(file: &Path) -> Result<String> {
    Ok(fs::read_to_string(file)?)
}

fn write_html(file: &Path, html: &str) -> Result<()> {
    atomic_write(file, html.as_bytes())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
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

fn unique_dir(root: &Path, stem: &str) -> PathBuf {
    let stem = if stem.is_empty() { "untitled" } else { stem };
    std::iter::once(root.join(stem))
        .chain((2..).map(|n| root.join(format!("{stem}-{n}"))))
        .find(|p| !p.exists())
        .expect("unbounded")
}

/// Keeps the deck consistent: unique slide ids and the current player runtime. Safe to call
/// repeatedly; only writes when something changed.
pub fn normalize(file: &Path) -> Result<()> {
    let source = read_html(file)?;
    let fixed = html::normalize_ids(&source).unwrap_or_else(|| source.clone());
    let fixed = html::ensure_runtime(&fixed);
    let fixed = prune_review(&fixed).unwrap_or(fixed);
    if fixed != source {
        write_html(file, &fixed)?;
    }
    Ok(())
}

/// `~/.slopslides`, created on first use. Not through Tauri: the lint server, which runs
/// without the app, needs it too.
pub fn app_home() -> Result<PathBuf> {
    let home = std::env::home_dir().ok_or_else(|| Error::msg("cannot locate home folder"))?;
    let root = home.join(HOME_DIR);
    fs::create_dir_all(&root)?;
    Ok(root)
}

/// `html` without review marks of slides it no longer has; None when there are none to drop.
fn prune_review(html: &str) -> Option<String> {
    let slides = html::find_slides(html);
    let ids = slides.iter().filter_map(|s| s.id.as_deref()).collect();
    review::prune(html, &ids)
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
            let _ = fs::remove_file(session.join(LOCKS_FILE));
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
        .map(|(index, span)| Slide {
            // A slide the agent has not given an id yet is addressed by position until
            // the turn ends and `normalize` assigns one.
            id: span.id.clone().unwrap_or_else(|| format!("#{}", index + 1)),
            hash: html::content_hash(&source[span.range.clone()]),
            hidden: span.hidden.is_some(),
            locked: span.locked.is_some(),
            moved: html::has_moved(&source[span.range.clone()]),
        })
        .collect();
    let path = file.to_string_lossy().into_owned();
    Ok(Deck {
        id: path.clone(),
        title: html::title(&source).unwrap_or_else(|| fallback_title(file)),
        path,
        shell_hash: html::shell_hash(&source, &spans, &section_spans),
        review: review::read(&source),
        template: html::template(&source),
        size: html::slide_size(&source).into(),
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

/// Saves a copy of the deck file under the session's `snapshots/`, keeping the newest few.
pub fn snapshot(file: &Path, session: &Path) -> Result<()> {
    let snapshots = snapshot_dir(file, session)?;
    fs::create_dir_all(&snapshots)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    fs::copy(
        file,
        snapshots.join(format!("{stamp}-{}.html", uuid::Uuid::new_v4().simple())),
    )?;
    prune_oldest(&snapshots, SNAPSHOTS_KEPT)
}

/// Per-file history prevents decks in the same workspace from overwriting each other.
fn snapshot_dir(file: &Path, session: &Path) -> Result<PathBuf> {
    let base = session.join("snapshots");
    match sessions::workspace_of(session) {
        Some(root) => Ok(base.join(guard_key(file, &root)?)),
        None => Ok(base), // Legacy sessions remain readable.
    }
}

fn guard_key(file: &Path, root: &Path) -> Result<String> {
    // Canonicalize the parent, so a deleted deck still has its original key.
    let mut parent = folder(file);
    let mut missing = Vec::new();
    while !parent.exists() {
        missing.push(
            parent
                .file_name()
                .ok_or_else(|| Error::msg("missing parent"))?
                .to_os_string(),
        );
        parent = parent
            .parent()
            .ok_or_else(|| Error::msg("missing parent"))?;
    }
    let mut parent = parent.canonicalize()?;
    for part in missing.iter().rev() {
        parent.push(part);
    }
    let root = root.canonicalize()?;
    let path = parent.join(
        file.file_name()
            .ok_or_else(|| Error::msg("missing file name"))?,
    );
    Ok(path
        .strip_prefix(root)
        .map_err(|_| Error::msg("deck outside workspace"))?
        .to_string_lossy()
        .replace('\\', "/"))
}

/// Saves a screenshot of a sketched-on slide under the session's `sketches/`, keeping the
/// newest few. Returns its absolute path, for the agent to read.
pub fn save_sketch(session: &Path, png: &[u8]) -> Result<String> {
    let sketches = session.join("sketches");
    fs::create_dir_all(&sketches)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let short = &uuid::Uuid::new_v4().simple().to_string()[..8];
    let name = format!("{stamp}-{short}.png");
    fs::write(sketches.join(&name), png)?;
    prune_oldest(&sketches, SKETCHES_KEPT)?;
    Ok(sketches.join(name).to_string_lossy().into_owned())
}

/// Deletes all but the `keep` newest files of `dir`, whose names start with a timestamp.
fn prune_oldest(dir: &Path, keep: usize) -> Result<()> {
    let mut files: Vec<_> = fs::read_dir(dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .collect();
    files.sort();
    for old in files.iter().rev().skip(keep) {
        let _ = fs::remove_file(old);
    }
    Ok(())
}

type EditResult<T> = std::result::Result<(String, T), String>;

fn edit<T>(file: &Path, f: impl FnOnce(&str) -> EditResult<T>) -> Result<(Deck, T)> {
    let source = read_html(file)?;
    let (updated, value) = f(&source).map_err(Error::Message)?;
    write_html(file, &updated)?;
    Ok((load(file)?, value))
}

/// Stores the user's review marks in deck.html, dropping those of slides that are gone.
/// Leaves the file alone when nothing changed, so the watcher stays quiet.
pub fn save_review(file: &Path, review: &Review) -> Result<()> {
    let source = read_html(file)?;
    let updated = review::write(&source, review);
    let updated = prune_review(&updated).unwrap_or(updated);
    if updated != source {
        write_html(file, &updated)?;
    }
    Ok(())
}

pub fn rename(file: &Path, title: &str) -> Result<Deck> {
    let title = title.trim().to_string();
    Ok(edit(file, |s| Ok((html::set_title(s, &title), ())))?.0)
}

pub fn reorder(file: &Path, slides: Vec<String>) -> Result<Deck> {
    Ok(edit(file, |s| Ok((html::reorder(s, &slides)?, ())))?.0)
}

pub fn add_blank(file: &Path, after: Option<String>) -> Result<(Deck, String)> {
    edit(file, |s| {
        html::insert(s, after.as_deref(), BLANK_SLIDE, "slide")
    })
}

/// Gives a deck without slides the template's design (styles, fonts), keeping its title.
pub fn apply_template(file: &Path, template: TemplateSource) -> Result<Deck> {
    Ok(edit(file, |s| {
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
        Ok((shell, ()))
    })?
    .0)
}

/// Inserts a copy of the template's slide `slide` after `after` (or at the end).
pub fn add_template_slide(
    file: &Path,
    after: Option<String>,
    template: &str,
    slide: &str,
) -> Result<(Deck, String)> {
    edit(file, |s| {
        html::copy_slide(s, after.as_deref(), template, slide)
    })
}

pub fn duplicate(file: &Path, slide: &str) -> Result<(Deck, String)> {
    edit(file, |s| html::duplicate(s, slide))
}

pub fn set_slide_hidden(
    file: &Path,
    session: Option<&Path>,
    slide: &str,
    hidden: bool,
) -> Result<Deck> {
    let deck = edit(file, |s| Ok((html::set_hidden(s, slide, hidden)?, ())))?.0;
    refresh_guard(file, session, slide)?;
    Ok(deck)
}

/// Gives every slide the canvas `size` and refreshes the player runtime to match. The slides'
/// content stays as it is; the agent lays it out again for the new size.
pub fn set_slide_size(file: &Path, size: SlideSize) -> Result<Deck> {
    size.check().map_err(Error::Message)?;
    Ok(edit(file, |s| {
        Ok((html::ensure_runtime(&html::set_slide_size(s, size)), ()))
    })?
    .0)
}

/// Locks or unlocks a slide. Neither the user nor the agent can change a locked slide.
pub fn set_slide_locked(
    file: &Path,
    session: Option<&Path>,
    slide: &str,
    locked: bool,
) -> Result<Deck> {
    let deck = edit(file, |s| Ok((html::set_locked(s, slide, locked)?, ())))?.0;
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

/// The locked slides an agent turn must leave alone; empty when no turn is guarded.
pub fn read_guard(file: &Path, session: Option<&Path>) -> Vec<html::LockedSlide> {
    let Some(session) = session else {
        return Vec::new();
    };
    let raw = fs::read_to_string(session.join(LOCKS_FILE)).unwrap_or_default();
    if let Some(root) = sessions::workspace_of(session) {
        let entries: std::collections::BTreeMap<String, Vec<html::LockedSlide>> =
            serde_json::from_str(&raw).unwrap_or_default();
        guard_key(file, &root)
            .ok()
            .and_then(|key| entries.get(&key).cloned())
            .unwrap_or_default()
    } else {
        serde_json::from_str(&raw).unwrap_or_default()
    }
}

fn write_guard(file: &Path, session: &Path, locked: &[html::LockedSlide]) -> Result<()> {
    fs::create_dir_all(session)?;
    let value = if let Some(root) = sessions::workspace_of(session) {
        let mut entries: std::collections::BTreeMap<String, Vec<html::LockedSlide>> =
            fs::read_to_string(session.join(LOCKS_FILE))
                .ok()
                .and_then(|raw| serde_json::from_str(&raw).ok())
                .unwrap_or_default();
        entries.insert(guard_key(file, &root)?, locked.to_vec());
        serde_json::to_string(&entries).expect("json")
    } else {
        serde_json::to_string(locked).expect("json")
    };
    atomic_write(&session.join(LOCKS_FILE), value.as_bytes())
}

/// Records the locked slides before an agent turn, so [`release_guard`] can put back any the
/// agent changes and the lint tool can tell it about them.
pub fn guard_locked(file: &Path, session: &Path) -> Result<()> {
    write_guard(file, session, &html::locked_slides(&read_html(file)?))
}

/// Keeps a running turn's guard in step with what the user did to `slide`: locking,
/// unlocking or hiding it mid-turn is theirs to do, and must not be undone after the turn.
fn refresh_guard(file: &Path, session: Option<&Path>, slide: &str) -> Result<()> {
    let Some(session) = session.filter(|s| s.join(LOCKS_FILE).is_file()) else {
        return Ok(());
    };
    let mut guard = read_guard(file, Some(session));
    let now = html::locked_slides(&read_html(file)?);
    guard.retain(|l| l.id != slide);
    guard.extend(now.into_iter().filter(|l| l.id == slide));
    write_guard(file, session, &guard)
}

/// Ends an agent turn's guard: puts back every locked slide the agent changed or removed.
/// Returns their ids.
pub fn release_guard(file: &Path, session: &Path) -> Result<Vec<String>> {
    let guard = read_guard(file, Some(session));
    if sessions::workspace_of(session).is_none() {
        let _ = fs::remove_file(session.join(LOCKS_FILE));
    }
    if guard.is_empty() {
        return Ok(Vec::new());
    }
    let source = if file.exists() {
        String::from_utf8_lossy(&fs::read(file)?).into_owned()
    } else {
        String::from("<html><body><main class=\"deck\"></main></body></html>")
    };
    let (mut restored, mut ids) = html::restore_locked(&source, &guard);
    if !html::changed_locked(&restored, &guard).is_empty() {
        // A removed or broken slide container cannot host the missing locked slides.
        // Rebuild their container; the snapshot keeps the complete pre-turn deck.
        (restored, ids) = html::restore_locked(
            "<html><body><main class=\"deck\"></main></body></html>",
            &guard,
        );
    }
    if !ids.is_empty() {
        fs::create_dir_all(folder(file))?;
        write_html(file, &restored)?;
    }
    Ok(ids)
}

pub fn add_section(file: &Path, before: Option<String>, title: &str) -> Result<Deck> {
    Ok(edit(file, |s| {
        Ok((html::add_section(s, before.as_deref(), title)?, ()))
    })?
    .0)
}

pub fn rename_section(file: &Path, index: usize, title: &str) -> Result<Deck> {
    Ok(edit(file, |s| Ok((html::rename_section(s, index, title)?, ())))?.0)
}

pub fn delete_section(file: &Path, index: usize) -> Result<Deck> {
    Ok(edit(file, |s| Ok((html::delete_section(s, index)?, ())))?.0)
}

/// Deletes a slide along with its review marks.
pub fn delete_slide(file: &Path, session: &Path, slide: &str) -> Result<Deck> {
    ensure_unlocked(&read_html(file)?, slide).map_err(Error::Message)?;
    snapshot(file, session)?;
    Ok(edit(file, |s| {
        let updated = html::delete(s, slide)?;
        Ok((prune_review(&updated).unwrap_or(updated), ()))
    })?
    .0)
}

/// Replaces one slide with markup edited on the stage. `base` is the slide's hash the edit
/// started from; the save is refused when the slide has changed since. Returns the slide's
/// previous markup, so the edit can be undone by saving it back.
pub fn update_slide(
    file: &Path,
    session: &Path,
    slide: &str,
    markup: &str,
    base: &str,
) -> Result<(Deck, String)> {
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
    snapshot(file, session)?;
    edit(file, |s| html::replace_slide(s, slide, markup))
}

/// Replaces deck.html with hand-edited source. `base` is the text the edit started from;
/// when given and the file has changed since (say, the agent wrote to it), the save is
/// refused so neither side's work is silently lost.
pub fn save_source(
    file: &Path,
    session: &Path,
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
    snapshot(file, session)?;
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

/// Creates a new folder for exported slide images inside `parent`, named after the deck
/// title (made safe for file systems); `Title 2`, `Title 3`, … if that name is taken.
pub fn create_export_dir(parent: &Path, title: &str) -> Result<PathBuf> {
    if !parent.is_dir() {
        return Err(Error::msg(format!("not a folder: {}", parent.display())));
    }
    let name = safe_file_name(title);
    let name = if name.is_empty() {
        "presentation".into()
    } else {
        name
    };
    for n in 1.. {
        let dir = parent.join(if n == 1 {
            name.clone()
        } else {
            format!("{name} {n}")
        });
        match fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    unreachable!("unbounded")
}

/// `text` without characters file systems reject, trimmed of spaces and trailing dots.
fn safe_file_name(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .filter(|c| !c.is_control() && !r#"\/:*?"<>|"#.contains(*c))
        .collect();
    cleaned.trim().trim_end_matches('.').trim().to_string()
}

/// File name of the `index`th (0-based) of `total` exported slides: `slide-01.png`, with
/// enough digits that the files sort in slide order.
pub fn slide_image_name(index: usize, total: usize) -> String {
    let digits = total.max(1).to_string().len().max(2);
    format!("slide-{:0digits$}.png", index + 1)
}

/// Lints the deck file; asset references are checked against the files next to it, and during
/// an agent turn, locked slides against how they were when it started.
pub fn lint(file: &Path, session: Option<&Path>) -> Result<Vec<lint::Issue>> {
    let source = read_html(file)?;
    let asset_exists = |rel: &str| {
        let rel = percent_encoding::percent_decode_str(rel).decode_utf8_lossy();
        resolve_in_deck(folder(file), &rel).is_ok_and(|path| path.is_file())
    };
    Ok(lint::lint(
        &source,
        asset_exists,
        &read_guard(file, session),
    ))
}

pub fn mime_for(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

pub fn import_assets(file: &Path, paths: Vec<String>) -> Result<Vec<String>> {
    let assets = if file.is_dir() { file } else { folder(file) }.join("assets");
    fs::create_dir_all(&assets)?;
    let mut imported = Vec::new();
    for source in paths {
        let source = PathBuf::from(source);
        if !source.is_file() {
            continue;
        }
        let dest = free_asset_path(&assets, &source);
        fs::copy(&source, &dest)?;
        imported.push(asset_ref(&dest));
    }
    Ok(imported)
}

/// Writes pasted file contents (base64) into `assets/`, named after `name`; returns its ref.
pub fn save_asset(file: &Path, name: &str, data: &str) -> Result<String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|e| Error::msg(format!("invalid pasted data: {e}")))?;
    let assets = if file.is_dir() { file } else { folder(file) }.join("assets");
    fs::create_dir_all(&assets)?;
    // Only the file name counts; a pasted name must not reach outside `assets/`.
    let name = Path::new(name).file_name().unwrap_or_default();
    let dest = free_asset_path(&assets, Path::new(name));
    fs::write(&dest, bytes)?;
    Ok(asset_ref(&dest))
}

/// A path in `assets` for a file named like `source`: slugged, lowercase extension, unused.
fn free_asset_path(assets: &Path, source: &Path) -> PathBuf {
    let stem = html::slugify(&source.file_stem().unwrap_or_default().to_string_lossy());
    let stem = if stem.is_empty() {
        "asset".to_string()
    } else {
        stem
    };
    let ext = source
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    std::iter::once(assets.join(format!("{stem}{ext}")))
        .chain((2..).map(|n| assets.join(format!("{stem}-{n}{ext}"))))
        .find(|p| !p.exists())
        .expect("unbounded")
}

fn asset_ref(path: &Path) -> String {
    format!("assets/{}", path.file_name().unwrap().to_string_lossy())
}

/// The session's chat; Null for a deck without one yet.
pub fn load_chat(session: Option<&Path>) -> Result<serde_json::Value> {
    let Some(session) = session else {
        return Ok(serde_json::Value::Null);
    };
    match fs::read_to_string(session.join(sessions::CHAT_FILE)) {
        Ok(raw) => Ok(serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::Value::Null),
        Err(e) => Err(e.into()),
    }
}

pub fn save_chat(session: &Path, chat: &serde_json::Value) -> Result<()> {
    fs::create_dir_all(session)?;
    atomic_write(
        &session.join(sessions::CHAT_FILE),
        serde_json::to_string(chat).expect("json").as_bytes(),
    )
}

/// Each agent provider keeps its own resumable session id in the session, stored under `name`.
pub fn read_session(session: &Path, name: &str) -> Option<String> {
    fs::read_to_string(session.join(name))
        .ok()
        .map(|s| s.trim().to_string())
}

pub fn write_session(session: &Path, name: &str, session_id: Option<&str>) -> Result<()> {
    fs::create_dir_all(session)?;
    let path = session.join(name);
    match session_id {
        Some(id) => fs::write(path, id)?,
        None if path.exists() => fs::remove_file(path)?,
        None => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_rejects_escapes() {
        let dir = Path::new("/tmp/deck");
        assert!(resolve_in_deck(dir, "../secret").is_err());
        assert!(resolve_in_deck(dir, "/etc/passwd").is_err());
        assert!(resolve_in_deck(dir, "assets/../../x").is_err());
        assert!(resolve_in_deck(dir, "assets/photo.png").is_ok());
    }

    #[test]
    fn falls_back_to_the_file_or_folder_name_for_the_title() {
        assert_eq!(fallback_title(Path::new("/w/q3-review.html")), "q3 review");
        assert_eq!(fallback_title(Path::new("/w/my_talk/deck.html")), "my talk");
    }

    /// A throwaway deck folder holding `html` as deck.html.
    struct TempDeck(PathBuf);

    impl TempDeck {
        /// The deck file, deck.html.
        fn file(&self) -> PathBuf {
            self.0.join(DECK_FILE)
        }
        fn new(html: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("slopslide-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join(DECK_FILE), html).unwrap();
            TempDeck(dir)
        }
        fn html(&self) -> String {
            fs::read_to_string(self.0.join(DECK_FILE)).unwrap()
        }
        /// The deck's session folder, outside the deck.
        fn session(&self) -> PathBuf {
            PathBuf::from(format!("{}-session", self.0.display()))
        }
        fn snapshots(&self) -> Vec<String> {
            let dir = self.session().join("snapshots");
            let Ok(entries) = fs::read_dir(dir) else {
                return Vec::new();
            };
            entries
                .map(|e| fs::read_to_string(e.unwrap().path()).unwrap())
                .collect()
        }
    }

    impl Drop for TempDeck {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(self.session());
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const ORIGINAL: &str = "<html><head><title>Talk</title></head><body><main>\n<section class=\"slide\" id=\"a\">A</section>\n</main></body></html>";
    const EDITED: &str = "<html><head><title>Talk</title></head><body><main>\n<section class=\"slide\" id=\"a\">A!</section>\n<section class=\"slide\" id=\"b\">B</section>\n</main></body></html>";

    #[test]
    fn saves_source_when_base_matches() {
        let deck = TempDeck::new(ORIGINAL);
        let saved =
            save_source(&deck.file(), &deck.session(), EDITED, Some(ORIGINAL), false).unwrap();
        assert_eq!(deck.html(), EDITED);
        let ids: Vec<_> = saved.slides.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["a", "b"]);
        assert_eq!(saved.title, "Talk");
    }

    #[test]
    fn save_snapshots_the_previous_version() {
        let deck = TempDeck::new(ORIGINAL);
        save_source(&deck.file(), &deck.session(), EDITED, Some(ORIGINAL), false).unwrap();
        assert_eq!(deck.snapshots(), [ORIGINAL]);
    }

    #[test]
    fn save_refuses_when_file_changed_since_base() {
        let deck = TempDeck::new(ORIGINAL);
        let agent_version = ORIGINAL.replace(">A<", ">Agent<");
        fs::write(deck.0.join(DECK_FILE), &agent_version).unwrap();
        let err =
            save_source(&deck.file(), &deck.session(), EDITED, Some(ORIGINAL), false).unwrap_err();
        assert!(err.to_string().contains("changed on disk"), "{err}");
        assert_eq!(
            deck.html(),
            agent_version,
            "the agent's version must survive"
        );
        assert!(deck.snapshots().is_empty());
    }

    #[test]
    fn save_without_base_overwrites() {
        let deck = TempDeck::new(ORIGINAL);
        fs::write(deck.0.join(DECK_FILE), "<html>agent</html>").unwrap();
        save_source(&deck.file(), &deck.session(), EDITED, None, false).unwrap();
        assert_eq!(deck.html(), EDITED);
    }

    #[test]
    fn save_accepts_base_with_different_line_endings() {
        let deck = TempDeck::new(&ORIGINAL.replace('\n', "\r\n"));
        save_source(&deck.file(), &deck.session(), EDITED, Some(ORIGINAL), false).unwrap();
        assert_eq!(deck.html(), EDITED);
    }

    #[test]
    fn save_normalizes_when_asked() {
        let deck = TempDeck::new(ORIGINAL);
        let no_id = EDITED.replace(" id=\"b\"", "");
        let saved =
            save_source(&deck.file(), &deck.session(), &no_id, Some(ORIGINAL), true).unwrap();
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
        let saved = save_source(&deck.file(), &deck.session(), &no_id, None, false).unwrap();
        assert_eq!(deck.html(), no_id);
        assert_eq!(
            saved.slides[1].id, "#2",
            "unnamed slide addressed by position"
        );
    }

    #[test]
    fn update_slide_replaces_it_and_returns_the_old_markup() {
        let deck = TempDeck::new(EDITED);
        let base = load(&deck.file()).unwrap().slides[0].hash.clone();
        let markup = "<section class=\"slide\" id=\"a\"><p data-moved=\"\" style=\"translate: 10px 0px\">A!</p></section>";
        let (saved, previous) =
            update_slide(&deck.file(), &deck.session(), "a", markup, &base).unwrap();
        assert_eq!(previous, "<section class=\"slide\" id=\"a\">A!</section>");
        assert_eq!(deck.html(), EDITED.replace(&previous, markup));
        assert_eq!(deck.snapshots(), [EDITED]);
        let moved: Vec<_> = saved.slides.iter().map(|s| s.moved).collect();
        assert_eq!(moved, [true, false]);
        assert_ne!(saved.slides[0].hash, base);

        // Undo: save the previous markup back on top of the new version.
        let (restored, _) = update_slide(
            &deck.file(),
            &deck.session(),
            "a",
            &previous,
            &saved.slides[0].hash,
        )
        .unwrap();
        assert_eq!(deck.html(), EDITED);
        assert_eq!(restored.slides[0].hash, base);
    }

    #[test]
    fn update_slide_refuses_when_the_slide_changed_since_base() {
        let deck = TempDeck::new(EDITED);
        let markup = "<section class=\"slide\" id=\"a\">mine</section>";
        let err = update_slide(&deck.file(), &deck.session(), "a", markup, "stale").unwrap_err();
        assert!(err.to_string().contains("changed"), "{err}");
        assert_eq!(deck.html(), EDITED);
        assert!(deck.snapshots().is_empty());

        let base = load(&deck.file()).unwrap().slides[0].hash.clone();
        assert!(update_slide(&deck.file(), &deck.session(), "zz", markup, &base).is_err());
        let other = "<section class=\"slide\" id=\"b\">mine</section>";
        assert!(update_slide(&deck.file(), &deck.session(), "a", other, &base).is_err());
        assert_eq!(deck.html(), EDITED);
    }

    #[test]
    fn load_reports_hidden_slides() {
        let deck = TempDeck::new(&EDITED.replace(" id=\"b\"", " id=\"b\" data-hidden"));
        let loaded = load(&deck.file()).unwrap();
        let hidden: Vec<_> = loaded.slides.iter().map(|s| s.hidden).collect();
        assert_eq!(hidden, [false, true]);
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
        let err = update_slide(&deck.file(), &deck.session(), "a", markup, &base).unwrap_err();
        assert!(err.to_string().contains("locked"), "{err}");
        let err = delete_slide(&deck.file(), &deck.session(), "a").unwrap_err();
        assert!(err.to_string().contains("locked"), "{err}");
        assert_eq!(deck.html(), LOCKED);
        assert!(deck.snapshots().is_empty());

        // Other slides, hiding, and moving it stay open.
        let base = load(&deck.file()).unwrap().slides[1].hash.clone();
        let other = "<section class=\"slide\" id=\"b\">B!</section>";
        update_slide(&deck.file(), &deck.session(), "b", other, &base).unwrap();
        set_slide_hidden(&deck.file(), Some(&deck.session()), "a", true).unwrap();
        let moved = reorder(&deck.file(), vec!["b".into(), "a".into()]).unwrap();
        assert_eq!(slide_ids(&moved), ["b", "a"]);
        delete_slide(&deck.file(), &deck.session(), "b").unwrap();
    }

    #[test]
    fn source_edits_cannot_change_a_locked_slide() {
        let deck = TempDeck::new(LOCKED);
        let changed = LOCKED.replace(">A<", ">mine<");
        let err =
            save_source(&deck.file(), &deck.session(), &changed, Some(LOCKED), false).unwrap_err();
        assert!(
            err.to_string()
                .contains("Locked slides cannot be changed: a"),
            "{err}"
        );
        let unlocked = LOCKED.replace(" data-locked", "");
        assert!(save_source(
            &deck.file(),
            &deck.session(),
            &unlocked,
            Some(LOCKED),
            false
        )
        .is_err());
        assert_eq!(deck.html(), LOCKED);

        // Changing the rest of the deck, or locking another slide, is fine.
        let other = LOCKED
            .replace(">B<", ">B!<")
            .replace("id=\"b\"", "id=\"b\" data-locked");
        save_source(&deck.file(), &deck.session(), &other, Some(LOCKED), false).unwrap();
        assert_eq!(deck.html(), other);
        let crlf = other.replace('\n', "\r\n").replace(">B!<", ">B<");
        assert!(
            save_source(&deck.file(), &deck.session(), &crlf, Some(&other), false).is_err(),
            "line endings alone are not a change, the text is"
        );
        let crlf = other.replace('\n', "\r\n");
        save_source(&deck.file(), &deck.session(), &crlf, Some(&other), false).unwrap();
    }

    #[test]
    fn a_guarded_turn_puts_back_the_locked_slides() {
        let deck = TempDeck::new(LOCKED);
        guard_locked(&deck.file(), &deck.session()).unwrap();
        assert_eq!(read_guard(&deck.file(), Some(&deck.session())).len(), 1);
        // The agent rewrites everything, dropping the locked slide.
        let agent = "<html><head><title>Talk</title></head><body><main>\n<section class=\"slide\" id=\"b\">New B</section>\n</main></body></html>";
        fs::write(deck.0.join(DECK_FILE), agent).unwrap();
        let issues = lint(&deck.file(), Some(&deck.session())).unwrap();
        assert!(
            issues.iter().any(|i| i.rule == "locked-slide-changed"),
            "{issues:?}"
        );

        assert_eq!(release_guard(&deck.file(), &deck.session()).unwrap(), ["a"]);
        assert_eq!(
            deck.html(),
            "<html><head><title>Talk</title></head><body><main>\n<section class=\"slide\" id=\"a\" data-locked>A</section>\n<section class=\"slide\" id=\"b\">New B</section>\n</main></body></html>"
        );
        assert!(
            read_guard(&deck.file(), Some(&deck.session())).is_empty(),
            "the guard ends with the turn"
        );
        assert!(!lint(&deck.file(), Some(&deck.session()))
            .unwrap()
            .iter()
            .any(|i| i.rule == "locked-slide-changed"));
        assert!(release_guard(&deck.file(), &deck.session())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn locking_mid_turn_updates_the_guard() {
        let deck = TempDeck::new(LOCKED);
        guard_locked(&deck.file(), &deck.session()).unwrap();
        // The user unlocks `a`, locks `b` and hides it while the agent works.
        set_slide_locked(&deck.file(), Some(&deck.session()), "a", false).unwrap();
        set_slide_locked(&deck.file(), Some(&deck.session()), "b", true).unwrap();
        set_slide_hidden(&deck.file(), Some(&deck.session()), "b", true).unwrap();
        let ids: Vec<_> = read_guard(&deck.file(), Some(&deck.session()))
            .into_iter()
            .map(|l| l.id)
            .collect();
        assert_eq!(ids, ["b"]);
        let mine = deck.html();
        let agent = mine.replace(">A<", ">Agent A<");
        fs::write(deck.0.join(DECK_FILE), &agent).unwrap();
        assert!(release_guard(&deck.file(), &deck.session())
            .unwrap()
            .is_empty());
        assert_eq!(
            deck.html(),
            agent,
            "unlocked `a` keeps the agent's edit, `b` stays hidden"
        );
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
        assert!(save_source(&deck.file(), &deck.session(), EDITED, Some(ORIGINAL), false).is_err());
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
    struct TempLib(PathBuf);

    impl TempLib {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("slopslide-lib-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            TempLib(dir)
        }
        fn add(&self, id: &str, html: &str) -> PathBuf {
            let dir = self.0.join(id);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join(DECK_FILE), html).unwrap();
            dir
        }
    }

    impl Drop for TempLib {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
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

    #[test]
    fn snapshots_keep_only_the_newest() {
        let deck = TempDeck::new(ORIGINAL);
        let snapshots = deck.session().join("snapshots");
        fs::create_dir_all(&snapshots).unwrap();
        // Older snapshots, named by timestamp like real ones.
        for n in 0..SNAPSHOTS_KEPT + 5 {
            fs::write(
                snapshots.join(format!("{}.html", 1_000_000_000_000u64 + n as u64)),
                "old",
            )
            .unwrap();
        }
        snapshot(&deck.file(), &deck.session()).unwrap();
        let mut names: Vec<_> = fs::read_dir(&snapshots)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names.len(), SNAPSHOTS_KEPT);
        assert!(
            !names.contains(&"1000000000000.html".to_string()),
            "oldest pruned"
        );
        let newest = snapshots.join(names.last().unwrap());
        assert_eq!(fs::read_to_string(newest).unwrap(), ORIGINAL);
    }

    #[test]
    fn save_sketch_writes_a_png_and_prunes_old_ones() {
        let deck = TempDeck::new(ORIGINAL);
        let sketches = deck.session().join("sketches");
        fs::create_dir_all(&sketches).unwrap();
        for n in 0..SKETCHES_KEPT + 3 {
            let name = format!("{}-old.png", 1_000_000_000_000u64 + n as u64);
            fs::write(sketches.join(name), b"old").unwrap();
        }
        let path = save_sketch(&deck.session(), b"\x89PNG fake").unwrap();
        assert!(
            Path::new(&path).starts_with(&sketches) && path.ends_with(".png"),
            "absolute, in the session: {path}"
        );
        assert_eq!(fs::read(&path).unwrap(), b"\x89PNG fake");
        let names: Vec<_> = fs::read_dir(&sketches)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), SKETCHES_KEPT);
        assert!(
            !names.contains(&"1000000000000-old.png".to_string()),
            "oldest pruned"
        );
        assert!(
            path.ends_with(names.iter().max().unwrap().as_str()),
            "new sketch kept"
        );
    }

    #[test]
    fn export_dir_is_named_after_the_deck() {
        let parent = TempDeck::new(ORIGINAL);
        let dir = create_export_dir(&parent.0, "Q3 Review").unwrap();
        assert_eq!(dir, parent.0.join("Q3 Review"));
        assert!(dir.is_dir());
    }

    #[test]
    fn export_dir_never_reuses_an_existing_folder() {
        let parent = TempDeck::new(ORIGINAL);
        fs::create_dir(parent.0.join("Talk")).unwrap();
        fs::write(parent.0.join("Talk").join("slide-01.png"), b"keep").unwrap();
        assert_eq!(
            create_export_dir(&parent.0, "Talk").unwrap(),
            parent.0.join("Talk 2")
        );
        assert_eq!(
            create_export_dir(&parent.0, "Talk").unwrap(),
            parent.0.join("Talk 3")
        );
        assert_eq!(
            fs::read(parent.0.join("Talk").join("slide-01.png")).unwrap(),
            b"keep"
        );
    }

    #[test]
    fn export_dir_names_are_safe() {
        let parent = TempDeck::new(ORIGINAL);
        let dir = create_export_dir(&parent.0, " A/B: \"why?\" <draft>. ").unwrap();
        assert_eq!(dir.file_name().unwrap(), "AB why draft");
        let dir = create_export_dir(&parent.0, "../..").unwrap();
        assert_eq!(dir, parent.0.join("presentation"));
        let dir = create_export_dir(&parent.0, "\t").unwrap();
        assert_eq!(dir, parent.0.join("presentation 2"));
    }

    #[test]
    fn export_dir_needs_an_existing_parent() {
        let parent = TempDeck::new(ORIGINAL);
        assert!(create_export_dir(&parent.0.join("missing"), "Talk").is_err());
        assert!(create_export_dir(&parent.0.join(DECK_FILE), "Talk").is_err());
    }

    #[test]
    fn slide_images_sort_in_slide_order() {
        assert_eq!(slide_image_name(0, 1), "slide-01.png");
        assert_eq!(slide_image_name(8, 12), "slide-09.png");
        assert_eq!(slide_image_name(99, 120), "slide-100.png");
        assert_eq!(slide_image_name(4, 120), "slide-005.png");
        assert_eq!(slide_image_name(0, 0), "slide-01.png");
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
    fn review_marks_leave_slide_and_shell_hashes_alone() {
        let deck = TempDeck::new(THREE);
        let before = load(&deck.file()).unwrap();
        save_review(&deck.file(), &marks(&["a", "c"])).unwrap();
        let after = load(&deck.file()).unwrap();
        assert_eq!(before.shell_hash, after.shell_hash);
        assert!(before
            .slides
            .iter()
            .zip(&after.slides)
            .all(|(a, b)| a.hash == b.hash));
    }

    #[test]
    fn normalize_drops_marks_of_deleted_slides() {
        let deck = TempDeck::new(&review::write(THREE, &marks(&["a", "b"])));
        fs::write(
            deck.0.join(DECK_FILE),
            deck.html()
                .replace("<section class=\"slide\" id=\"b\">B</section>", ""),
        )
        .unwrap();
        normalize(&deck.file()).unwrap();
        assert_eq!(load(&deck.file()).unwrap().review, marks(&["a"]));
    }

    #[test]
    fn save_sketch_names_are_unique() {
        let deck = TempDeck::new(ORIGINAL);
        let a = save_sketch(&deck.session(), b"a").unwrap();
        let b = save_sketch(&deck.session(), b"b").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn snapshot_fails_without_a_deck_file() {
        let deck = TempDeck::new(ORIGINAL);
        fs::remove_file(deck.0.join(DECK_FILE)).unwrap();
        assert!(snapshot(&deck.file(), &deck.session()).is_err());
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
            slide_ids(&reorder(&deck.file(), order).unwrap()),
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
    fn duplicate_and_delete_slides_on_disk() {
        let deck = TempDeck::new(THREE);
        let (copied, id) = duplicate(&deck.file(), "b").unwrap();
        assert_eq!(id, "b-copy");
        assert_eq!(slide_ids(&copied), ["a", "b", "b-copy", "c"]);
        assert!(deck.html().contains("id=\"b-copy\">B</section>"));

        let before_delete = deck.html();
        let deleted = delete_slide(&deck.file(), &deck.session(), "b").unwrap();
        assert_eq!(slide_ids(&deleted), ["a", "b-copy", "c"]);
        assert_eq!(
            deck.snapshots(),
            [before_delete],
            "deleting keeps a snapshot to recover from"
        );

        assert!(duplicate(&deck.file(), "nope").is_err());
        assert!(delete_slide(&deck.file(), &deck.session(), "nope").is_err());
    }

    #[test]
    fn deleting_a_slide_drops_its_review_marks() {
        let deck = TempDeck::new(THREE);
        save_review(&deck.file(), &marks(&["a", "b"])).unwrap();
        let deleted = delete_slide(&deck.file(), &deck.session(), "b").unwrap();
        assert_eq!(deleted.review, marks(&["a"]));
        assert_eq!(load(&deck.file()).unwrap().review, marks(&["a"]));

        delete_slide(&deck.file(), &deck.session(), "a").unwrap();
        assert!(
            !deck.html().contains(review::START),
            "deleting the last marked slide removes the block"
        );
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
    fn mime_types() {
        assert_eq!(mime_for("deck.html"), "text/html; charset=utf-8");
        assert_eq!(mime_for("assets/PHOTO.JPG"), "image/jpeg");
        assert_eq!(mime_for("assets/a.jpeg"), "image/jpeg");
        assert_eq!(mime_for("assets/logo.svg"), "image/svg+xml");
        assert_eq!(mime_for("assets/font.woff2"), "font/woff2");
        assert_eq!(mime_for("assets/clip.webm"), "video/webm");
        assert_eq!(mime_for("assets/data.json"), "application/json");
        assert_eq!(mime_for("assets/x.tar.gz"), "application/octet-stream");
        assert_eq!(mime_for("assets/no-extension"), "application/octet-stream");
        assert_eq!(mime_for(""), "application/octet-stream");
    }

    #[test]
    fn imports_assets_with_slugged_unique_names() {
        let deck = TempDeck::new(ORIGINAL);
        let src = TempLib::new();
        let photo = src.0.join("My Photo.PNG");
        fs::write(&photo, "png").unwrap();
        let nameless = src.0.join("日本.jpg");
        fs::write(&nameless, "jpg").unwrap();
        let no_ext = src.0.join("README");
        fs::write(&no_ext, "txt").unwrap();
        let path = |p: &PathBuf| p.to_string_lossy().into_owned();

        let imported = import_assets(
            &deck.file(),
            vec![
                path(&photo),
                path(&photo),
                path(&nameless),
                path(&no_ext),
                path(&src.0.join("does-not-exist.png")),
                path(&src.0),
            ],
        )
        .unwrap();
        assert_eq!(
            imported,
            [
                "assets/my-photo.png",
                "assets/my-photo-2.png",
                "assets/asset.jpg",
                "assets/readme"
            ]
        );
        assert_eq!(
            fs::read_to_string(deck.0.join("assets/my-photo-2.png")).unwrap(),
            "png"
        );
        assert!(import_assets(&deck.file(), vec![]).unwrap().is_empty());
    }

    #[test]
    fn saves_pasted_assets_with_unique_names() {
        let deck = TempDeck::new(ORIGINAL);
        // "aGk=" is "hi".
        assert_eq!(
            save_asset(&deck.file(), "Screen Shot.PNG", "aGk=").unwrap(),
            "assets/screen-shot.png"
        );
        assert_eq!(
            save_asset(&deck.file(), "Screen Shot.PNG", "aGk=").unwrap(),
            "assets/screen-shot-2.png"
        );
        assert_eq!(
            fs::read_to_string(deck.0.join("assets/screen-shot-2.png")).unwrap(),
            "hi"
        );
        assert_eq!(
            save_asset(&deck.file(), "../../evil.png", "aGk=").unwrap(),
            "assets/evil.png"
        );
        assert_eq!(
            save_asset(&deck.file(), "", "aGk=").unwrap(),
            "assets/asset"
        );
        assert!(save_asset(&deck.file(), "x.png", "not base64!").is_err());
        assert!(!deck.0.join("assets/x.png").exists());
    }

    #[test]
    fn chat_round_trips_and_tolerates_bad_files() {
        let deck = TempDeck::new(ORIGINAL);
        assert_eq!(
            load_chat(Some(&deck.session())).unwrap(),
            serde_json::Value::Null
        );
        let chat = serde_json::json!([{"id": "1", "role": "user", "text": "hi ✨"}]);
        save_chat(&deck.session(), &chat).unwrap();
        assert_eq!(load_chat(Some(&deck.session())).unwrap(), chat);
        fs::write(deck.session().join("chat.json"), "{not json").unwrap();
        assert_eq!(
            load_chat(Some(&deck.session())).unwrap(),
            serde_json::Value::Null
        );
        save_chat(&deck.session(), &serde_json::Value::Null).unwrap();
        assert_eq!(
            load_chat(Some(&deck.session())).unwrap(),
            serde_json::Value::Null
        );
    }

    #[test]
    fn session_is_stored_trimmed_and_cleared() {
        let deck = TempDeck::new(ORIGINAL);
        fs::create_dir_all(deck.session()).unwrap();
        assert_eq!(read_session(&deck.session(), "session"), None);
        write_session(&deck.session(), "session", Some("abc-123")).unwrap();
        assert_eq!(
            read_session(&deck.session(), "session").as_deref(),
            Some("abc-123")
        );
        fs::write(deck.session().join("session"), "  xyz\n").unwrap();
        assert_eq!(
            read_session(&deck.session(), "session").as_deref(),
            Some("xyz")
        );
        write_session(&deck.session(), "session", None).unwrap();
        assert_eq!(read_session(&deck.session(), "session"), None);
        write_session(&deck.session(), "session", None).unwrap();
    }

    #[test]
    fn sessions_are_kept_per_provider() {
        let deck = TempDeck::new(ORIGINAL);
        fs::create_dir_all(deck.session()).unwrap();
        write_session(&deck.session(), "session", Some("claude-1")).unwrap();
        write_session(&deck.session(), "codex-session", Some("codex-1")).unwrap();
        assert_eq!(
            read_session(&deck.session(), "session").as_deref(),
            Some("claude-1")
        );
        assert_eq!(
            read_session(&deck.session(), "codex-session").as_deref(),
            Some("codex-1")
        );
    }

    #[test]
    fn workspace_assets_without_a_deck_and_per_file_snapshot_retention() {
        let deck = TempDeck::new(ORIGINAL);
        assert_eq!(
            save_asset(&deck.0, "photo.png", "aGk=").unwrap(),
            "assets/photo.png"
        );
        assert_eq!(fs::read(deck.0.join("assets/photo.png")).unwrap(), b"hi");
        let session = crate::sessions::Sessions::new(&deck.session())
            .start(&deck.0)
            .unwrap();
        let other = deck.0.join("q3.html");
        fs::write(&other, ORIGINAL).unwrap();
        snapshot(&other, &session).unwrap();
        for _ in 0..SNAPSHOTS_KEPT + 2 {
            snapshot(&deck.file(), &session).unwrap();
        }
        assert_eq!(
            fs::read_dir(session.join("snapshots/deck.html"))
                .unwrap()
                .count(),
            SNAPSHOTS_KEPT
        );
        assert_eq!(
            fs::read_dir(session.join("snapshots/q3.html"))
                .unwrap()
                .count(),
            1
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

    #[test]
    fn atomic_write_leaves_no_temp_files() {
        let deck = TempDeck::new(ORIGINAL);
        write_html(&deck.file(), EDITED).unwrap();
        assert_eq!(deck.html(), EDITED);
        let names: Vec<_> = fs::read_dir(&deck.0)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, [DECK_FILE]);
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
        let out = reorder(&deck.file(), order).unwrap();
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
