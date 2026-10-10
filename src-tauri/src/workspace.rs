//! Workspaces: a folder the user opens to browse, holding any number of decks among their
//! other files. The file tree lists it one folder at a time ([`list_dir`]); clicking a file
//! opens it in the viewer its [`FileKind`] calls for: an HTML file that is a SlopSlide deck
//! in the editor, any other HTML page as it is.
//!
//! The open workspace bounds what the `slop://` protocol serves ([`OpenWorkspace`]); the
//! folders opened before are remembered in `~/.slopslides/recent-workspaces.json`.

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::deck;
use crate::error::{Error, Result};
use crate::html;

const RECENT_FILE: &str = "recent-workspaces.json";
const RECENT_KEPT: usize = 10;
/// How much of an HTML file the file tree reads to tell decks from other pages. The markers
/// [`classify`] looks for first are in `<head>`.
const SNIFF_BYTES: u64 = 16 * 1024;

/// What a workspace file is, which decides how it opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileKind {
    Directory,
    /// A SlopSlide deck: opens in the slide editor.
    Deck,
    /// A slideshow made with another tool (reveal.js, Marp, …): shown as it is.
    Slideshow,
    /// Any other HTML page: shown as it is.
    Webpage,
    /// Anything else; there is no viewer for it yet.
    File,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    /// Workspace-relative, `/`-separated.
    pub path: String,
    pub kind: FileKind,
}

/// The markup other slideshow tools leave in their output.
const SLIDESHOW_MARKERS: &[&str] = &[
    "class=\"reveal\"",                  // reveal.js
    "reveal.js",                         // reveal.js (script or stylesheet)
    "id=\"impress\"",                    // impress.js
    "data-marpit-svg",                   // Marp
    "remark.create(",                    // remark
    "class=\"shower",                    // Shower
    "bespoke.from(",                     // Bespoke.js
    "name=\"generator\" content=\"marp", // Marp CLI
];

/// Tells a SlopSlide deck from other slideshows and plain web pages. A deck has any of: the
/// player runtime blocks, an app setting `<meta>`, or the slide container `<main class="deck">`
/// (a new deck has no slides yet, so the slides themselves are no sign).
pub fn classify(source: &str) -> FileKind {
    let is_deck = source.contains(html::CSS_START)
        || source.contains(html::JS_START)
        || html::app_meta_content(source, html::TEMPLATE_META).is_some()
        || html::app_meta_content(source, crate::size::SIZE_META).is_some()
        || html::has_deck_container(source);
    if is_deck {
        return FileKind::Deck;
    }
    let lower = source.to_ascii_lowercase();
    if SLIDESHOW_MARKERS.iter().any(|m| lower.contains(m)) {
        return FileKind::Slideshow;
    }
    FileKind::Webpage
}

/// The kind of the file at `path`, reading at most `limit` bytes of an HTML file.
fn kind_of(path: &Path, limit: Option<u64>) -> FileKind {
    if path.is_dir() {
        return FileKind::Directory;
    }
    if !deck::is_html(path) {
        return FileKind::File;
    }
    let Ok(file) = fs::File::open(path) else {
        return FileKind::File;
    };
    let mut bytes = Vec::new();
    let read = match limit {
        Some(limit) => file.take(limit).read_to_end(&mut bytes),
        None => (&file).read_to_end(&mut bytes),
    };
    match read {
        Ok(_) => classify(&String::from_utf8_lossy(&bytes)),
        Err(_) => FileKind::File,
    }
}

/// The workspace folder: an existing, absolute directory.
pub fn root(path: &str) -> Result<PathBuf> {
    let root = PathBuf::from(path);
    if !root.is_absolute() || !root.is_dir() {
        return Err(Error::msg(format!("not a folder: {path}")));
    }
    Ok(root.canonicalize()?)
}

/// Resolves a workspace-relative path (`""` is the root), refusing anything outside it.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf> {
    let safe = Path::new(rel)
        .components()
        .all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    if !safe {
        return Err(Error::msg(format!("invalid path: {rel}")));
    }
    let path = if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    };
    if !inside(root, &path) {
        return Err(Error::msg(format!(
            "path outside workspace or missing: {rel}"
        )));
    }
    Ok(path)
}

/// Files and folders hidden from the tree: dotfiles (`.git`, `.DS_Store`, …) and the app's
/// atomic-write temp files.
fn hidden(name: &str) -> bool {
    name.starts_with('.') || name.contains(".tmp-")
}

/// One folder of the workspace, folders first, then by name. HTML files are told apart by
/// their first few kilobytes.
pub fn list_dir(root: &Path, rel: &str) -> Result<Vec<Entry>> {
    let dir = resolve(root, rel)?;
    let mut entries: Vec<Entry> = fs::read_dir(&dir)?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if hidden(&name) {
                return None;
            }
            let path = if rel.is_empty() {
                name.clone()
            } else {
                format!("{}/{name}", rel.trim_end_matches('/'))
            };
            let kind = kind_of(&e.path(), Some(SNIFF_BYTES));
            Some(Entry { name, path, kind })
        })
        .collect();
    entries.sort_by(|a, b| {
        let dir = |e: &Entry| e.kind != FileKind::Directory;
        dir(a)
            .cmp(&dir(b))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}

/// A file the user opens, with what to open it in: the whole file is read to classify it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
    pub path: String,
    /// Absolute path, which the viewer loads it by.
    pub absolute: String,
    pub kind: FileKind,
}

pub fn open_file(root: &Path, rel: &str) -> Result<OpenedFile> {
    let file = resolve(root, rel)?;
    if !file.exists() {
        return Err(Error::msg(format!("file not found: {rel}")));
    }
    Ok(OpenedFile {
        path: rel.to_string(),
        absolute: file.to_string_lossy().into_owned(),
        kind: kind_of(&file, None),
    })
}

/// The folder the user has open, if any. `slop://` serves files from inside it only.
#[derive(Default)]
pub struct OpenWorkspace(Mutex<Option<PathBuf>>);

impl OpenWorkspace {
    pub fn set(&self, root: Option<PathBuf>) {
        *self.0.lock().unwrap() = root.map(|r| r.canonicalize().unwrap_or(r));
    }

    pub fn get(&self) -> Option<PathBuf> {
        self.0.lock().unwrap().clone()
    }

    /// Whether `path` is an existing file inside the open workspace.
    pub fn contains(&self, path: &Path) -> bool {
        self.get().is_some_and(|root| inside(&root, path))
    }
}

/// Whether `path` exists inside `root` (both resolved, so `..` and links cannot leave it).
pub fn inside(root: &Path, path: &Path) -> bool {
    match (path.canonicalize(), root.canonicalize()) {
        (Ok(path), Ok(root)) => path.starts_with(&root),
        _ => false,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentWorkspace {
    pub path: String,
    pub name: String,
    pub opened_ms: u64,
}

/// Folders opened before, newest first; ones that no longer exist are left out.
pub fn recent(app_home: &Path) -> Vec<RecentWorkspace> {
    read_recent(app_home)
        .into_iter()
        .filter(|w| Path::new(&w.path).is_dir())
        .collect()
}

fn read_recent(app_home: &Path) -> Vec<RecentWorkspace> {
    fs::read_to_string(app_home.join(RECENT_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Puts `root` first among the recent workspaces.
pub fn remember(app_home: &Path, root: &Path) -> Result<()> {
    let path = root.to_string_lossy().into_owned();
    let mut list = read_recent(app_home);
    list.retain(|w| w.path != path);
    list.insert(
        0,
        RecentWorkspace {
            name: display_name(root),
            path,
            opened_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        },
    );
    list.truncate(RECENT_KEPT);
    fs::create_dir_all(app_home)?;
    fs::write(
        app_home.join(RECENT_FILE),
        serde_json::to_string_pretty(&list).expect("json"),
    )?;
    Ok(())
}

/// Takes `root` off the recent workspaces.
pub fn forget(app_home: &Path, root: &str) -> Result<()> {
    let mut list = read_recent(app_home);
    list.retain(|w| w.path != root);
    fs::write(
        app_home.join(RECENT_FILE),
        serde_json::to_string_pretty(&list).expect("json"),
    )?;
    Ok(())
}

/// The folder's name, for titles and the recent list.
pub fn display_name(root: &Path) -> String {
    root.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Temp(PathBuf);

    impl Temp {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("slopslide-ws-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            Temp(dir)
        }
        fn write(&self, rel: &str, text: &str) -> PathBuf {
            let path = self.0.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, text).unwrap();
            path
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const DECK: &str = "<!DOCTYPE html><html><head><title>T</title></head><body><main class=\"deck\">\n<section class=\"slide\" id=\"a\">A</section>\n</main></body></html>";

    #[test]
    fn classifies_slopslide_decks() {
        assert_eq!(classify(DECK), FileKind::Deck);
        assert_eq!(
            classify("<html><body><main class=\"deck\"></main></body></html>"),
            FileKind::Deck,
            "a new deck has no slides yet"
        );
        assert_eq!(
            classify(&html::ensure_runtime("<html><body></body></html>")),
            FileKind::Deck,
            "the runtime blocks alone mark a deck"
        );
        assert_eq!(
            classify("<head><meta name=\"slopslide-template\" content=\"swiss\"></head>"),
            FileKind::Deck
        );
        assert_eq!(
            classify("<head><meta name=\"slopslide-size\" content=\"1080x1080\"></head>"),
            FileKind::Deck
        );
        assert_eq!(
            classify("<MAIN CLASS=\"wide deck\"></MAIN>"),
            FileKind::Deck,
            "tags and other classes don't matter"
        );
    }

    #[test]
    fn classifies_other_slideshows() {
        for page in [
            "<div class=\"reveal\"><div class=\"slides\"><section>A</section></div></div>",
            "<link rel=\"stylesheet\" href=\"dist/reveal.js/reveal.css\">",
            "<div id=\"impress\"><div class=\"step\">A</div></div>",
            "<svg data-marpit-svg viewBox=\"0 0 1280 720\"></svg>",
            "<textarea id=\"source\"></textarea><script>var slideshow = remark.create();</script>",
            "<body class=\"shower list\"></body>",
        ] {
            assert_eq!(classify(page), FileKind::Slideshow, "{page}");
        }
    }

    #[test]
    fn everything_else_is_a_webpage() {
        for page in [
            "",
            "<html><body><h1>Hello</h1><section class=\"slide\">not in a deck</section></body></html>",
            "<main class=\"decked-out\"></main>",
            "<p>main class=\"deck\" in text is no container</p>",
        ] {
            assert_eq!(classify(page), FileKind::Webpage, "{page}");
        }
    }

    #[test]
    fn lists_one_folder_folders_first_and_tells_files_apart() {
        let t = Temp::new();
        t.write("talk/deck.html", DECK);
        t.write("Notes.md", "# notes");
        t.write("about.html", "<h1>About</h1>");
        t.write("b-deck.HTM", DECK);
        t.write("assets/a.png", "png");
        t.write(".git/HEAD", "ref");
        t.write(".DS_Store", "");
        t.write("deck.tmp-0a1b", "partial");

        let root = list_dir(&t.0, "").unwrap();
        let names: Vec<_> = root.iter().map(|e| (e.name.as_str(), e.kind)).collect();
        assert_eq!(
            names,
            [
                ("assets", FileKind::Directory),
                ("talk", FileKind::Directory),
                ("about.html", FileKind::Webpage),
                ("b-deck.HTM", FileKind::Deck),
                ("Notes.md", FileKind::File),
            ]
        );
        assert_eq!(
            list_dir(&t.0, "talk").unwrap(),
            [Entry {
                name: "deck.html".into(),
                path: "talk/deck.html".into(),
                kind: FileKind::Deck
            }]
        );
    }

    #[test]
    fn sniffing_reads_the_head_but_opening_reads_it_all() {
        let t = Temp::new();
        let late = format!(
            "<html><body>{}<main class=\"deck\"></main></body></html>",
            "x".repeat(SNIFF_BYTES as usize)
        );
        t.write("long.html", &late);
        assert_eq!(list_dir(&t.0, "").unwrap()[0].kind, FileKind::Webpage);
        let opened = open_file(&t.0, "long.html").unwrap();
        assert_eq!(opened.kind, FileKind::Deck);
        assert_eq!(opened.path, "long.html");
        assert_eq!(Path::new(&opened.absolute), t.0.join("long.html").as_path());
    }

    #[test]
    fn paths_stay_inside_the_workspace() {
        let t = Temp::new();
        t.write("a/b.txt", "x");
        assert_eq!(resolve(&t.0, "").unwrap(), t.0);
        assert_eq!(resolve(&t.0, "a/b.txt").unwrap(), t.0.join("a/b.txt"));
        for bad in ["..", "../x", "a/../../x", "/etc/hosts"] {
            assert!(resolve(&t.0, bad).is_err(), "{bad}");
            assert!(list_dir(&t.0, bad).is_err(), "{bad}");
        }
        assert!(open_file(&t.0, "missing.html").is_err());
        assert!(root("relative/path").is_err());
        assert!(root(&t.0.join("a/b.txt").to_string_lossy()).is_err());
        assert_eq!(
            root(&t.0.to_string_lossy()).unwrap(),
            t.0.canonicalize().unwrap()
        );
    }

    #[test]
    fn the_open_workspace_bounds_what_is_served() {
        let t = Temp::new();
        let inner = t.write("ws/talk/deck.html", DECK);
        let outer = t.write("secret.txt", "x");
        let open = OpenWorkspace::default();
        assert!(!open.contains(&inner), "nothing is open");
        open.set(Some(t.0.join("ws")));
        assert!(open.contains(&inner));
        assert!(!open.contains(&outer));
        assert!(!open.contains(&t.0.join("ws/../secret.txt")));
        assert!(!open.contains(&t.0.join("ws/missing.html")));
        open.set(None);
        assert!(!open.contains(&inner));
    }

    #[test]
    fn remembers_recent_workspaces_newest_first() {
        let t = Temp::new();
        let home = t.0.join("home");
        let (a, b) = (t.0.join("a"), t.0.join("b"));
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        assert!(recent(&home).is_empty());
        remember(&home, &a).unwrap();
        remember(&home, &b).unwrap();
        remember(&home, &a).unwrap();
        let names: Vec<_> = recent(&home).into_iter().map(|w| w.name).collect();
        assert_eq!(names, ["a", "b"], "reopening moves it to the top");

        fs::remove_dir_all(&b).unwrap();
        assert_eq!(recent(&home).len(), 1, "gone folders are left out");

        forget(&home, &a.to_string_lossy()).unwrap();
        assert!(recent(&home).is_empty());

        for n in 0..RECENT_KEPT + 3 {
            let dir = t.0.join(format!("w{n}"));
            fs::create_dir_all(&dir).unwrap();
            remember(&home, &dir).unwrap();
        }
        assert_eq!(recent(&home).len(), RECENT_KEPT);
        assert_eq!(recent(&home)[0].name, format!("w{}", RECENT_KEPT + 2));
    }
}
