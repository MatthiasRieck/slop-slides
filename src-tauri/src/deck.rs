//! Deck storage. A deck is a folder in the library holding one self-contained HTML file:
//!
//! ```text
//! <library>/<deck-id>/
//!   deck.html      every slide, the shared styles, and the embedded player runtime
//!   assets/        user-attached media, referenced as assets/<file>
//!   .slopslide/    app internals: chat history, agent session, reference docs, snapshots
//! ```
//!
//! `deck.html` opens directly in any browser as a slideshow; [`export`] inlines the
//! assets so the single file can be shared on its own.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};
use crate::html;

pub const INTERNAL_DIR: &str = ".slopslide";
pub const DECK_FILE: &str = "deck.html";
const DECK_TEMPLATE: &str = include_str!("../assets/deck-template.html");
const BLANK_SLIDE: &str = include_str!("../assets/blank-slide.html");
const SNAPSHOTS_KEPT: usize = 30;
const REFERENCE_DOCS: &[(&str, &str)] = &[
    (
        "STYLE_PRESETS.md",
        include_str!("../prompts/STYLE_PRESETS.md"),
    ),
    (
        "animation-patterns.md",
        include_str!("../prompts/animation-patterns.md"),
    ),
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckSummary {
    pub id: String,
    pub title: String,
    pub slide_count: usize,
    pub first_slide: Option<String>,
    pub updated_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Slide {
    pub id: String,
    /// Changes whenever this slide's markup changes, so only its preview reloads.
    pub hash: String,
    /// Skipped by the player (presenting, exported file); still shown in the editor.
    pub hidden: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Deck {
    pub id: String,
    pub title: String,
    pub path: String,
    pub slides: Vec<Slide>,
    /// Changes whenever anything outside the slides (styles, fonts, runtime) changes.
    pub shell_hash: String,
}

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

pub fn deck_dir(app: &AppHandle, id: &str) -> Result<PathBuf> {
    if id.is_empty() || !is_plain_name(id) {
        return Err(Error::msg(format!("invalid deck id: {id}")));
    }
    let dir = library_root(app)?.join(id);
    if !dir.join(DECK_FILE).is_file() {
        return Err(Error::msg(format!("deck not found: {id}")));
    }
    Ok(dir)
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

fn is_plain_name(name: &str) -> bool {
    let mut parts = Path::new(name).components();
    matches!(parts.next(), Some(Component::Normal(_))) && parts.next().is_none()
}

fn read_html(dir: &Path) -> Result<String> {
    Ok(fs::read_to_string(dir.join(DECK_FILE))?)
}

fn write_html(dir: &Path, html: &str) -> Result<()> {
    atomic_write(&dir.join(DECK_FILE), html.as_bytes())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

fn modified_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn fallback_title(id: &str) -> String {
    id.replace('-', " ")
}

pub fn list(app: &AppHandle) -> Result<Vec<DeckSummary>> {
    let root = library_root(app)?;
    let mut decks = Vec::new();
    for entry in fs::read_dir(&root)? {
        let dir = entry?.path();
        let Ok(source) = read_html(&dir) else {
            continue;
        };
        let Some(id) = dir.file_name().and_then(|n| n.to_str()).map(str::to_string) else {
            continue;
        };
        let slides = html::find_slides(&source);
        decks.push(DeckSummary {
            title: html::title(&source).unwrap_or_else(|| fallback_title(&id)),
            slide_count: slides.len(),
            first_slide: slides.first().and_then(|s| s.id.clone()),
            updated_ms: modified_ms(&dir.join(DECK_FILE)),
            id,
        });
    }
    decks.sort_by_key(|d| std::cmp::Reverse(d.updated_ms));
    Ok(decks)
}

fn unique_dir(root: &Path, stem: &str) -> PathBuf {
    let stem = if stem.is_empty() { "untitled" } else { stem };
    std::iter::once(root.join(stem))
        .chain((2..).map(|n| root.join(format!("{stem}-{n}"))))
        .find(|p| !p.exists())
        .expect("unbounded")
}

/// Writes app-owned files and keeps the deck consistent: unique slide ids and the current
/// player runtime. Safe to call repeatedly; only writes when something changed.
pub fn normalize(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir.join("assets"))?;
    let reference = dir.join(INTERNAL_DIR).join("reference");
    fs::create_dir_all(&reference)?;
    for (name, body) in REFERENCE_DOCS {
        fs::write(reference.join(name), body)?;
    }
    let source = read_html(dir)?;
    let fixed = html::normalize_ids(&source).unwrap_or_else(|| source.clone());
    let fixed = html::ensure_runtime(&fixed);
    if fixed != source {
        write_html(dir, &fixed)?;
    }
    Ok(())
}

pub fn create(app: &AppHandle, title: &str) -> Result<Deck> {
    let title = title.trim();
    let title = if title.is_empty() {
        "Untitled deck"
    } else {
        title
    };
    let dir = unique_dir(&library_root(app)?, &html::slugify(title));
    fs::create_dir_all(&dir)?;
    write_html(&dir, &html::set_title(DECK_TEMPLATE, title))?;
    let id = dir.file_name().unwrap().to_string_lossy().into_owned();
    open(app, &id, true)
}

/// Loads a deck, normalizing it first unless the agent may be mid-edit.
pub fn open(app: &AppHandle, id: &str, normalize_first: bool) -> Result<Deck> {
    let dir = deck_dir(app, id)?;
    if normalize_first {
        normalize(&dir)?;
    }
    load(&dir, id)
}

pub fn load(dir: &Path, id: &str) -> Result<Deck> {
    let source = read_html(dir)?;
    let spans = html::find_slides(&source);
    let slides = spans
        .iter()
        .enumerate()
        .map(|(index, span)| Slide {
            // A slide the agent has not given an id yet is addressed by position until
            // the turn ends and `normalize` assigns one.
            id: span.id.clone().unwrap_or_else(|| format!("#{}", index + 1)),
            hash: html::content_hash(&source[span.range.clone()]),
            hidden: span.hidden.is_some(),
        })
        .collect();
    Ok(Deck {
        id: id.to_string(),
        title: html::title(&source).unwrap_or_else(|| fallback_title(id)),
        path: dir.to_string_lossy().into_owned(),
        shell_hash: html::shell_hash(&source, &spans),
        slides,
    })
}

/// Saves a copy of deck.html under `.slopslide/snapshots/`, keeping the newest few.
pub fn snapshot(dir: &Path) -> Result<()> {
    let snapshots = dir.join(INTERNAL_DIR).join("snapshots");
    fs::create_dir_all(&snapshots)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    fs::copy(dir.join(DECK_FILE), snapshots.join(format!("{stamp}.html")))?;
    let mut files: Vec<_> = fs::read_dir(&snapshots)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .collect();
    files.sort();
    for old in files.iter().rev().skip(SNAPSHOTS_KEPT) {
        let _ = fs::remove_file(old);
    }
    Ok(())
}

type EditResult<T> = std::result::Result<(String, T), String>;

fn edit<T>(app: &AppHandle, id: &str, f: impl FnOnce(&str) -> EditResult<T>) -> Result<(Deck, T)> {
    let dir = deck_dir(app, id)?;
    let source = read_html(&dir)?;
    let (updated, value) = f(&source).map_err(Error::Message)?;
    write_html(&dir, &updated)?;
    Ok((load(&dir, id)?, value))
}

pub fn rename(app: &AppHandle, id: &str, title: &str) -> Result<Deck> {
    let title = title.trim().to_string();
    Ok(edit(app, id, |s| Ok((html::set_title(s, &title), ())))?.0)
}

pub fn reorder(app: &AppHandle, id: &str, slides: Vec<String>) -> Result<Deck> {
    Ok(edit(app, id, |s| Ok((html::reorder(s, &slides)?, ())))?.0)
}

pub fn add_blank(app: &AppHandle, id: &str, after: Option<String>) -> Result<(Deck, String)> {
    edit(app, id, |s| {
        html::insert(s, after.as_deref(), BLANK_SLIDE, "slide")
    })
}

pub fn duplicate(app: &AppHandle, id: &str, slide: &str) -> Result<(Deck, String)> {
    edit(app, id, |s| html::duplicate(s, slide))
}

pub fn set_slide_hidden(app: &AppHandle, id: &str, slide: &str, hidden: bool) -> Result<Deck> {
    Ok(edit(app, id, |s| Ok((html::set_hidden(s, slide, hidden)?, ())))?.0)
}

pub fn delete_slide(app: &AppHandle, id: &str, slide: &str) -> Result<Deck> {
    snapshot(&deck_dir(app, id)?)?;
    Ok(edit(app, id, |s| Ok((html::delete(s, slide)?, ())))?.0)
}

/// Replaces deck.html with hand-edited source. `base` is the text the edit started from;
/// when given and the file has changed since (say, the agent wrote to it), the save is
/// refused so neither side's work is silently lost.
pub fn save_source(
    app: &AppHandle,
    id: &str,
    source: &str,
    base: Option<&str>,
    normalize_after: bool,
) -> Result<Deck> {
    write_source(&deck_dir(app, id)?, id, source, base, normalize_after)
}

fn write_source(
    dir: &Path,
    id: &str,
    source: &str,
    base: Option<&str>,
    normalize_after: bool,
) -> Result<Deck> {
    if let Some(base) = base {
        if !same_text(&read_html(dir)?, base) {
            return Err(Error::msg(
                "deck.html changed on disk since you started editing",
            ));
        }
    }
    snapshot(dir)?;
    write_html(dir, source)?;
    if normalize_after {
        normalize(dir)?;
    }
    load(dir, id)
}

/// Equal up to line endings (the editor normalizes them to `\n`).
fn same_text(a: &str, b: &str) -> bool {
    a.replace("\r\n", "\n") == b.replace("\r\n", "\n")
}

pub fn delete_deck(app: &AppHandle, id: &str) -> Result<()> {
    fs::remove_dir_all(deck_dir(app, id)?)?;
    Ok(())
}

/// Writes a standalone copy of the deck with attached assets embedded as data URIs.
pub fn export(app: &AppHandle, id: &str, dest: &Path) -> Result<()> {
    let dir = deck_dir(app, id)?;
    let source = html::ensure_runtime(&read_html(&dir)?);
    let standalone = html::inline_assets(&source, |rel| {
        let path = resolve_in_deck(&dir, rel).ok()?;
        Some((mime_for(rel).to_string(), fs::read(path).ok()?))
    });
    fs::write(dest, standalone)?;
    Ok(())
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

pub fn import_assets(app: &AppHandle, id: &str, paths: Vec<String>) -> Result<Vec<String>> {
    let dir = deck_dir(app, id)?;
    let assets = dir.join("assets");
    fs::create_dir_all(&assets)?;
    let mut imported = Vec::new();
    for source in paths {
        let source = PathBuf::from(source);
        if !source.is_file() {
            continue;
        }
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
        let dest = std::iter::once(assets.join(format!("{stem}{ext}")))
            .chain((2..).map(|n| assets.join(format!("{stem}-{n}{ext}"))))
            .find(|p| !p.exists())
            .expect("unbounded");
        fs::copy(&source, &dest)?;
        imported.push(format!(
            "assets/{}",
            dest.file_name().unwrap().to_string_lossy()
        ));
    }
    Ok(imported)
}

fn internal_file(app: &AppHandle, id: &str, name: &str) -> Result<PathBuf> {
    let dir = deck_dir(app, id)?.join(INTERNAL_DIR);
    fs::create_dir_all(&dir)?;
    Ok(dir.join(name))
}

pub fn load_chat(app: &AppHandle, id: &str) -> Result<serde_json::Value> {
    let path = internal_file(app, id, "chat.json")?;
    match fs::read_to_string(&path) {
        Ok(raw) => Ok(serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::Value::Null),
        Err(e) => Err(e.into()),
    }
}

pub fn save_chat(app: &AppHandle, id: &str, chat: &serde_json::Value) -> Result<()> {
    let path = internal_file(app, id, "chat.json")?;
    atomic_write(&path, serde_json::to_string(chat).expect("json").as_bytes())
}

pub fn read_session(dir: &Path) -> Option<String> {
    fs::read_to_string(dir.join(INTERNAL_DIR).join("session"))
        .ok()
        .map(|s| s.trim().to_string())
}

pub fn write_session(dir: &Path, session_id: Option<&str>) -> Result<()> {
    let path = dir.join(INTERNAL_DIR).join("session");
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
    fn plain_names_only() {
        assert!(is_plain_name("my-deck"));
        assert!(!is_plain_name("a/b"));
        assert!(!is_plain_name(".."));
    }

    /// A throwaway deck folder holding `html` as deck.html.
    struct TempDeck(PathBuf);

    impl TempDeck {
        fn new(html: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("slopslide-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join(DECK_FILE), html).unwrap();
            TempDeck(dir)
        }
        fn html(&self) -> String {
            fs::read_to_string(self.0.join(DECK_FILE)).unwrap()
        }
        fn snapshots(&self) -> Vec<String> {
            let dir = self.0.join(INTERNAL_DIR).join("snapshots");
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
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const ORIGINAL: &str = "<html><head><title>Talk</title></head><body><main>\n<section class=\"slide\" id=\"a\">A</section>\n</main></body></html>";
    const EDITED: &str = "<html><head><title>Talk</title></head><body><main>\n<section class=\"slide\" id=\"a\">A!</section>\n<section class=\"slide\" id=\"b\">B</section>\n</main></body></html>";

    #[test]
    fn saves_source_when_base_matches() {
        let deck = TempDeck::new(ORIGINAL);
        let saved = write_source(&deck.0, "talk", EDITED, Some(ORIGINAL), false).unwrap();
        assert_eq!(deck.html(), EDITED);
        let ids: Vec<_> = saved.slides.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["a", "b"]);
        assert_eq!(saved.title, "Talk");
    }

    #[test]
    fn save_snapshots_the_previous_version() {
        let deck = TempDeck::new(ORIGINAL);
        write_source(&deck.0, "talk", EDITED, Some(ORIGINAL), false).unwrap();
        assert_eq!(deck.snapshots(), [ORIGINAL]);
    }

    #[test]
    fn save_refuses_when_file_changed_since_base() {
        let deck = TempDeck::new(ORIGINAL);
        let agent_version = ORIGINAL.replace(">A<", ">Agent<");
        fs::write(deck.0.join(DECK_FILE), &agent_version).unwrap();
        let err = write_source(&deck.0, "talk", EDITED, Some(ORIGINAL), false).unwrap_err();
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
        write_source(&deck.0, "talk", EDITED, None, false).unwrap();
        assert_eq!(deck.html(), EDITED);
    }

    #[test]
    fn save_accepts_base_with_different_line_endings() {
        let deck = TempDeck::new(&ORIGINAL.replace('\n', "\r\n"));
        write_source(&deck.0, "talk", EDITED, Some(ORIGINAL), false).unwrap();
        assert_eq!(deck.html(), EDITED);
    }

    #[test]
    fn save_normalizes_when_asked() {
        let deck = TempDeck::new(ORIGINAL);
        let no_id = EDITED.replace(" id=\"b\"", "");
        let saved = write_source(&deck.0, "talk", &no_id, Some(ORIGINAL), true).unwrap();
        let html = deck.html();
        assert!(html.contains("slopslide:runtime-js"), "runtime installed");
        assert!(
            saved.slides.iter().all(|s| !s.id.starts_with('#')),
            "ids assigned"
        );
        assert_eq!(saved.slides.len(), 2);
        assert!(deck.0.join("assets").is_dir());
    }

    #[test]
    fn save_leaves_markup_alone_without_normalizing() {
        let deck = TempDeck::new(ORIGINAL);
        let no_id = EDITED.replace(" id=\"b\"", "");
        let saved = write_source(&deck.0, "talk", &no_id, None, false).unwrap();
        assert_eq!(deck.html(), no_id);
        assert_eq!(
            saved.slides[1].id, "#2",
            "unnamed slide addressed by position"
        );
    }

    #[test]
    fn load_reports_hidden_slides() {
        let deck = TempDeck::new(&EDITED.replace(" id=\"b\"", " id=\"b\" data-hidden"));
        let loaded = load(&deck.0, "talk").unwrap();
        let hidden: Vec<_> = loaded.slides.iter().map(|s| s.hidden).collect();
        assert_eq!(hidden, [false, true]);
    }

    #[test]
    fn save_reports_missing_deck() {
        let deck = TempDeck::new(ORIGINAL);
        fs::remove_file(deck.0.join(DECK_FILE)).unwrap();
        assert!(write_source(&deck.0, "talk", EDITED, Some(ORIGINAL), false).is_err());
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
}
