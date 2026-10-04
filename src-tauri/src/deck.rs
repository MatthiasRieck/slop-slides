//! Deck storage. A deck is a folder in the library:
//!
//! ```text
//! <library>/<deck-id>/
//!   deck.json      title + ordered slide paths (source of truth for order)
//!   theme.css      shared design system
//!   slides/*.html  one 1920×1080 document per slide
//!   assets/        user-attached media
//!   .slopslide/    app internals: chat history, agent session, reference docs, trash
//! ```

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};

pub const INTERNAL_DIR: &str = ".slopslide";
const MANIFEST: &str = "deck.json";
const BLANK_SLIDE: &str = include_str!("../assets/blank-slide.html");
const STARTER_THEME: &str = include_str!("../assets/theme.css");
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub title: String,
    #[serde(default)]
    pub slides: Vec<String>,
}

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
pub struct Deck {
    pub id: String,
    pub title: String,
    pub path: String,
    pub slides: Vec<String>,
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
    if !dir.join(MANIFEST).is_file() {
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

pub fn read_manifest(dir: &Path) -> Result<Manifest> {
    let raw = fs::read_to_string(dir.join(MANIFEST))?;
    serde_json::from_str(&raw).map_err(|e| Error::msg(format!("deck.json is invalid: {e}")))
}

pub fn write_manifest(dir: &Path, manifest: &Manifest) -> Result<()> {
    let json = serde_json::to_string_pretty(manifest).expect("manifest serializes");
    atomic_write(&dir.join(MANIFEST), format!("{json}\n").as_bytes())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Slides listed in the manifest whose files exist, in manifest order, deduplicated.
fn existing_slides(dir: &Path, manifest: &Manifest) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    manifest
        .slides
        .iter()
        .map(|s| s.trim_start_matches("./").to_string())
        .filter(|s| seen.insert(s.clone()))
        .filter(|s| {
            resolve_in_deck(dir, s)
                .map(|p| p.is_file())
                .unwrap_or(false)
        })
        .collect()
}

fn modified_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn list(app: &AppHandle) -> Result<Vec<DeckSummary>> {
    let root = library_root(app)?;
    let mut decks = Vec::new();
    for entry in fs::read_dir(&root)? {
        let dir = entry?.path();
        let Ok(manifest) = read_manifest(&dir) else {
            continue;
        };
        let Some(id) = dir.file_name().and_then(|n| n.to_str()).map(str::to_string) else {
            continue;
        };
        let slides = existing_slides(&dir, &manifest);
        decks.push(DeckSummary {
            id,
            title: manifest.title,
            slide_count: slides.len(),
            first_slide: slides.first().cloned(),
            updated_ms: modified_ms(&dir.join(MANIFEST)),
        });
    }
    decks.sort_by_key(|d| std::cmp::Reverse(d.updated_ms));
    Ok(decks)
}

fn slugify(title: &str) -> String {
    let mut slug = String::new();
    for ch in title.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    let slug = slug.trim_end_matches('-');
    let slug: String = slug.chars().take(48).collect();
    if slug.is_empty() {
        "untitled".into()
    } else {
        slug
    }
}

fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let suffix = if ext.is_empty() {
        String::new()
    } else {
        format!(".{ext}")
    };
    let first = dir.join(format!("{stem}{suffix}"));
    if !first.exists() {
        return first;
    }
    (2..)
        .map(|n| dir.join(format!("{stem}-{n}{suffix}")))
        .find(|p| !p.exists())
        .expect("unbounded range yields a free name")
}

/// Writes app-owned files (reference docs, folders). Safe to call on every open.
pub fn ensure_scaffold(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir.join("slides"))?;
    fs::create_dir_all(dir.join("assets"))?;
    let reference = dir.join(INTERNAL_DIR).join("reference");
    fs::create_dir_all(&reference)?;
    for (name, body) in REFERENCE_DOCS {
        fs::write(reference.join(name), body)?;
    }
    if !dir.join("theme.css").exists() {
        fs::write(dir.join("theme.css"), STARTER_THEME)?;
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
    let dir = unique_path(&library_root(app)?, &slugify(title), "");
    fs::create_dir_all(&dir)?;
    ensure_scaffold(&dir)?;
    write_manifest(
        &dir,
        &Manifest {
            title: title.to_string(),
            slides: Vec::new(),
        },
    )?;
    let id = dir.file_name().unwrap().to_string_lossy().into_owned();
    open(app, &id, true)
}

/// Loads a deck and, when `prune` is set, moves slide files that fell out of the manifest
/// into the trash. Do not prune while the agent may be writing a slide it has yet to list.
pub fn open(app: &AppHandle, id: &str, prune: bool) -> Result<Deck> {
    let dir = deck_dir(app, id)?;
    ensure_scaffold(&dir)?;
    if !prune {
        return load(&dir, id);
    }
    let manifest = read_manifest(&dir)?;
    let slides = existing_slides(&dir, &manifest);
    for entry in fs::read_dir(dir.join("slides"))? {
        let path = entry?.path();
        let rel = format!("slides/{}", path.file_name().unwrap().to_string_lossy());
        if path.extension().is_some_and(|e| e == "html") && !slides.contains(&rel) {
            trash(&dir, &rel)?;
        }
    }
    load(&dir, id)
}

pub fn load(dir: &Path, id: &str) -> Result<Deck> {
    let manifest = read_manifest(dir)?;
    Ok(Deck {
        id: id.to_string(),
        title: manifest.title.clone(),
        path: dir.to_string_lossy().into_owned(),
        slides: existing_slides(dir, &manifest),
    })
}

fn trash(dir: &Path, rel: &str) -> Result<()> {
    let src = resolve_in_deck(dir, rel)?;
    if !src.exists() {
        return Ok(());
    }
    let trash_dir = dir.join(INTERNAL_DIR).join("trash");
    fs::create_dir_all(&trash_dir)?;
    let name = src.file_stem().unwrap().to_string_lossy();
    let ext = src
        .extension()
        .map(|e| e.to_string_lossy().into_owned())
        .unwrap_or_default();
    fs::rename(&src, unique_path(&trash_dir, &name, &ext))?;
    Ok(())
}

fn update<F: FnOnce(&Path, &mut Manifest) -> Result<()>>(
    app: &AppHandle,
    id: &str,
    f: F,
) -> Result<Deck> {
    let dir = deck_dir(app, id)?;
    let mut manifest = read_manifest(&dir)?;
    manifest.slides = existing_slides(&dir, &manifest);
    f(&dir, &mut manifest)?;
    write_manifest(&dir, &manifest)?;
    load(&dir, id)
}

pub fn rename(app: &AppHandle, id: &str, title: &str) -> Result<Deck> {
    update(app, id, |_, m| {
        m.title = title.trim().to_string();
        Ok(())
    })
}

pub fn reorder(app: &AppHandle, id: &str, slides: Vec<String>) -> Result<Deck> {
    update(app, id, |_, m| {
        let mut current = m.slides.clone();
        current.sort();
        let mut proposed = slides.clone();
        proposed.sort();
        if current != proposed {
            return Err(Error::msg("slide list changed while reordering; try again"));
        }
        m.slides = slides;
        Ok(())
    })
}

fn next_slide_path(dir: &Path, stem_hint: &str) -> String {
    let slides = dir.join("slides");
    let path = unique_path(&slides, stem_hint, "html");
    format!("slides/{}", path.file_name().unwrap().to_string_lossy())
}

fn insert_after(m: &mut Manifest, after: Option<&str>, rel: String) {
    let index = after
        .and_then(|a| m.slides.iter().position(|s| s == a))
        .map(|i| i + 1)
        .unwrap_or(m.slides.len());
    m.slides.insert(index, rel);
}

pub fn add_blank(app: &AppHandle, id: &str, after: Option<String>) -> Result<(Deck, String)> {
    let mut created = String::new();
    let deck = update(app, id, |dir, m| {
        let rel = next_slide_path(dir, &format!("{:02}-slide", m.slides.len() + 1));
        fs::write(resolve_in_deck(dir, &rel)?, BLANK_SLIDE)?;
        insert_after(m, after.as_deref(), rel.clone());
        created = rel;
        Ok(())
    })?;
    Ok((deck, created))
}

pub fn duplicate(app: &AppHandle, id: &str, slide: &str) -> Result<(Deck, String)> {
    let mut created = String::new();
    let deck = update(app, id, |dir, m| {
        let src = resolve_in_deck(dir, slide)?;
        let stem = src.file_stem().unwrap().to_string_lossy().into_owned();
        let rel = next_slide_path(dir, &format!("{stem}-copy"));
        fs::copy(&src, resolve_in_deck(dir, &rel)?)?;
        insert_after(m, Some(slide), rel.clone());
        created = rel;
        Ok(())
    })?;
    Ok((deck, created))
}

pub fn delete_slide(app: &AppHandle, id: &str, slide: &str) -> Result<Deck> {
    update(app, id, |dir, m| {
        m.slides.retain(|s| s != slide);
        trash(dir, slide)
    })
}

pub fn delete_deck(app: &AppHandle, id: &str) -> Result<()> {
    let dir = deck_dir(app, id)?;
    fs::remove_dir_all(dir)?;
    Ok(())
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
        let stem = slugify(&source.file_stem().unwrap_or_default().to_string_lossy());
        let ext = source
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let dest = unique_path(&assets, &stem, &ext);
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
    fn slugify_produces_safe_names() {
        assert_eq!(slugify("Q3 Board Update!"), "q3-board-update");
        assert_eq!(slugify("  "), "untitled");
        assert_eq!(slugify("Über Café"), "ber-caf");
    }

    #[test]
    fn resolve_rejects_escapes() {
        let dir = Path::new("/tmp/deck");
        assert!(resolve_in_deck(dir, "../secret").is_err());
        assert!(resolve_in_deck(dir, "/etc/passwd").is_err());
        assert!(resolve_in_deck(dir, "slides/../../x").is_err());
        assert!(resolve_in_deck(dir, "slides/01.html").is_ok());
    }

    #[test]
    fn plain_names_only() {
        assert!(is_plain_name("my-deck"));
        assert!(!is_plain_name("a/b"));
        assert!(!is_plain_name(".."));
    }
}
