//! Workspaces: a folder the user opens to browse, holding any number of decks among their
//! other files. The file tree lists it one folder at a time ([`list_dir`]); clicking a file
//! opens it in the viewer its [`FileKind`] calls for: an HTML file that is a SlopSlide deck
//! in the editor, any other HTML page as it is.
//!
//! Each window opens one workspace, and one deck in it at a time; together the workspaces bound
//! what the `slop://` protocol serves ([`OpenWorkspace`]). Windows may share a folder, each
//! with another of its decks. The
//! folders opened before are remembered in `~/.slopslides/recent-workspaces.json`, and the decks
//! opened in them in `~/.slopslides/recent-decks.json`.

use std::collections::HashMap;
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
const RECENT_DECKS_FILE: &str = "recent-decks.json";
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
    // In whatever case, compared in place: the folder scan asks this of every page whole.
    let has = |marker: &str| html::find_ci(source, 0, marker).is_some();
    if SLIDESHOW_MARKERS.iter().copied().any(has) {
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

/// What a window has open.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Open {
    root: PathBuf,
    /// The deck open in the folder, if one is.
    deck: Option<PathBuf>,
    /// What the window's chat is about: the deck, or the folder for its own chat (also while
    /// that chat is still at work on the deck it made, see [`OpenWorkspace::open_deck`]).
    chat: PathBuf,
}

/// The folder each window has open, and the deck open in it, by window label. `slop://`
/// serves files from inside the folders only.
///
/// Windows may share a folder, but never a deck or a chat: two windows on one chat would
/// overwrite each other's messages. So a deck is open in one window, and so is a folder
/// without a deck (whose chat is the folder's own).
#[derive(Default)]
pub struct OpenWorkspace(Mutex<HashMap<String, Open>>);

fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

impl OpenWorkspace {
    /// Opens `root` in `window` with no deck, or closes the window's folder for None.
    pub fn set(&self, window: &str, root: Option<PathBuf>) {
        let mut open = self.0.lock().unwrap();
        match root {
            Some(root) => {
                let root = canonical(&root);
                open.insert(
                    window.to_string(),
                    Open {
                        chat: root.clone(),
                        deck: None,
                        root,
                    },
                )
            }
            None => open.remove(window),
        };
    }

    pub fn get(&self, window: &str) -> Option<PathBuf> {
        self.0.lock().unwrap().get(window).map(|o| o.root.clone())
    }

    /// The deck `window` has open.
    pub fn deck(&self, window: &str) -> Option<PathBuf> {
        self.0.lock().unwrap().get(window)?.deck.clone()
    }

    /// What the chat of `window` is about: its deck, or its folder.
    pub fn chat(&self, window: &str) -> Option<PathBuf> {
        self.0.lock().unwrap().get(window).map(|o| o.chat.clone())
    }

    /// The window other than `except` whose chat is about `subject`: for a folder, the one
    /// that has it open without a deck.
    pub fn window_with(&self, subject: &Path, except: &str) -> Option<String> {
        let subject = canonical(subject);
        self.0
            .lock()
            .unwrap()
            .iter()
            .find(|(window, open)| window.as_str() != except && open.chat == subject)
            .map(|(window, _)| window.clone())
    }

    /// What the chats of the windows other than `except` are about.
    pub fn chats_except(&self, except: &str) -> Vec<PathBuf> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|(window, _)| window.as_str() != except)
            .map(|(_, open)| open.chat.clone())
            .collect()
    }

    /// The window other than `except` that has the deck `file` open.
    pub fn window_with_deck(&self, file: &Path, except: &str) -> Option<String> {
        let file = canonical(file);
        self.0
            .lock()
            .unwrap()
            .iter()
            .find(|(window, open)| window.as_str() != except && open.deck.as_ref() == Some(&file))
            .map(|(window, _)| window.clone())
    }

    /// Opens the deck `file` in `window`, whose chat becomes the deck's; with `keep_chat`, the
    /// folder's chat stays instead (it made the deck and is still at work on it). `Err` names
    /// the window that has the deck open already.
    pub fn open_deck(
        &self,
        window: &str,
        file: &Path,
        keep_chat: bool,
    ) -> std::result::Result<(), String> {
        let file = canonical(file);
        let mut open = self.0.lock().unwrap();
        let taken = open.iter().find(|(other, o)| {
            other.as_str() != window && (o.deck.as_ref() == Some(&file) || o.chat == file)
        });
        if let Some((other, _)) = taken {
            return Err(other.clone());
        }
        if let Some(mine) = open.get_mut(window) {
            if !(keep_chat && mine.chat == mine.root) {
                mine.chat = file.clone();
            }
            mine.deck = Some(file);
        }
        Ok(())
    }

    /// Closes the deck of `window`, whose chat becomes the folder's own. `Err` names the
    /// window that has the folder open without a deck already; the deck stays open then.
    pub fn close_deck(&self, window: &str) -> std::result::Result<(), String> {
        let mut open = self.0.lock().unwrap();
        let Some(root) = open.get(window).map(|o| o.root.clone()) else {
            return Ok(());
        };
        let taken = open
            .iter()
            .find(|(other, o)| other.as_str() != window && o.chat == root);
        if let Some((other, _)) = taken {
            return Err(other.clone());
        }
        let mine = open.get_mut(window).unwrap();
        mine.deck = None;
        mine.chat = root;
        Ok(())
    }

    /// The chat of `window` is about its deck from here on: the folder's chat, which made the
    /// deck, moved there (see [`crate::sessions::Sessions::move_current`]).
    pub fn chat_follows_deck(&self, window: &str) {
        if let Some(mine) = self.0.lock().unwrap().get_mut(window) {
            if let Some(deck) = &mine.deck {
                mine.chat = deck.clone();
            }
        }
    }

    /// Whether `path` is an existing file inside a folder some window has open. The folders
    /// were resolved when they were opened ([`OpenWorkspace::set`]), so only `path` is resolved
    /// here, once: the protocol asks this for every file it serves.
    pub fn contains(&self, path: &Path) -> bool {
        let Ok(path) = path.canonicalize() else {
            return false;
        };
        self.0
            .lock()
            .unwrap()
            .values()
            .any(|open| path.starts_with(&open.root))
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
    read_list::<RecentWorkspace>(app_home, RECENT_FILE)
        .into_iter()
        .filter(|w| Path::new(&w.path).is_dir())
        .collect()
}

/// Puts `root` first among the recent workspaces.
pub fn remember(app_home: &Path, root: &Path) -> Result<()> {
    let path = root.to_string_lossy().into_owned();
    let mut list: Vec<RecentWorkspace> = read_list(app_home, RECENT_FILE);
    list.retain(|w| w.path != path);
    list.insert(
        0,
        RecentWorkspace {
            name: display_name(root),
            path,
            opened_ms: now_ms(),
        },
    );
    list.truncate(RECENT_KEPT);
    write_list(app_home, RECENT_FILE, &list)
}

/// Takes `root` off the recent workspaces.
pub fn forget(app_home: &Path, root: &str) -> Result<()> {
    let mut list: Vec<RecentWorkspace> = read_list(app_home, RECENT_FILE);
    list.retain(|w| w.path != root);
    write_list(app_home, RECENT_FILE, &list)
}

/// A deck opened before, for the start screen to open again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentDeck {
    /// The deck file, which is the deck's id.
    pub path: String,
    /// The deck's title when it was last opened or renamed.
    pub title: String,
    /// The folder it was open in, which opens with it again.
    pub workspace: String,
    pub opened_ms: u64,
}

/// Decks opened before, newest first. Ones whose file no longer exists are left out; one whose
/// folder is gone, or no longer holds it, opens in the folder the file is in.
pub fn recent_decks(app_home: &Path) -> Vec<RecentDeck> {
    read_list::<RecentDeck>(app_home, RECENT_DECKS_FILE)
        .into_iter()
        .filter(|deck| Path::new(&deck.path).is_file())
        .map(|mut deck| {
            let file = Path::new(&deck.path);
            let workspace = Path::new(&deck.workspace);
            if !(workspace.is_dir() && inside(workspace, file)) {
                if let Some(parent) = file.parent() {
                    deck.workspace = parent.to_string_lossy().into_owned();
                }
            }
            deck
        })
        .collect()
}

/// Puts the deck `file`, open in the folder `root` and called `title`, first among the recent decks.
pub fn remember_deck(app_home: &Path, root: &Path, file: &Path, title: &str) -> Result<()> {
    let path = file.to_string_lossy().into_owned();
    let mut list: Vec<RecentDeck> = read_list(app_home, RECENT_DECKS_FILE);
    list.retain(|deck| deck.path != path);
    list.insert(
        0,
        RecentDeck {
            path,
            title: title.to_string(),
            workspace: root.to_string_lossy().into_owned(),
            opened_ms: now_ms(),
        },
    );
    list.truncate(RECENT_KEPT);
    write_list(app_home, RECENT_DECKS_FILE, &list)
}

/// Gives the recent deck `file` the title it was renamed to; a deck that is not among them stays out.
pub fn retitle_deck(app_home: &Path, file: &Path, title: &str) -> Result<()> {
    let path = file.to_string_lossy();
    let mut list: Vec<RecentDeck> = read_list(app_home, RECENT_DECKS_FILE);
    let Some(deck) = list.iter_mut().find(|deck| deck.path == path) else {
        return Ok(());
    };
    if deck.title == title {
        return Ok(());
    }
    deck.title = title.to_string();
    write_list(app_home, RECENT_DECKS_FILE, &list)
}

/// Takes the deck file `path` off the recent decks.
pub fn forget_deck(app_home: &Path, path: &str) -> Result<()> {
    let mut list: Vec<RecentDeck> = read_list(app_home, RECENT_DECKS_FILE);
    list.retain(|deck| deck.path != path);
    write_list(app_home, RECENT_DECKS_FILE, &list)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A recent list as stored in `name`; empty when there is none or it cannot be read.
fn read_list<T: serde::de::DeserializeOwned>(app_home: &Path, name: &str) -> Vec<T> {
    fs::read_to_string(app_home.join(name))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_list<T: Serialize>(app_home: &Path, name: &str, list: &[T]) -> Result<()> {
    fs::create_dir_all(app_home)?;
    fs::write(
        app_home.join(name),
        serde_json::to_string_pretty(list).expect("json"),
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
    use crate::test_support::TempDir;

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
        let t = TempDir::new("ws");
        t.write("talk/deck.html", DECK);
        t.write("Notes.md", "# notes");
        t.write("about.html", "<h1>About</h1>");
        t.write("b-deck.HTM", DECK);
        t.write("assets/a.png", "png");
        t.write(".git/HEAD", "ref");
        t.write(".DS_Store", "");
        t.write("deck.tmp-0a1b", "partial");

        let root = list_dir(&t, "").unwrap();
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
            list_dir(&t, "talk").unwrap(),
            [Entry {
                name: "deck.html".into(),
                path: "talk/deck.html".into(),
                kind: FileKind::Deck
            }]
        );
    }

    #[test]
    fn sniffing_reads_the_head_but_opening_reads_it_all() {
        let t = TempDir::new("ws");
        let late = format!(
            "<html><body>{}<main class=\"deck\"></main></body></html>",
            "x".repeat(SNIFF_BYTES as usize)
        );
        t.write("long.html", &late);
        assert_eq!(list_dir(&t, "").unwrap()[0].kind, FileKind::Webpage);
        let opened = open_file(&t, "long.html").unwrap();
        assert_eq!(opened.kind, FileKind::Deck);
        assert_eq!(opened.path, "long.html");
        assert_eq!(Path::new(&opened.absolute), t.join("long.html").as_path());
    }

    #[test]
    fn paths_stay_inside_the_workspace() {
        let t = TempDir::new("ws");
        t.write("a/b.txt", "x");
        assert_eq!(resolve(&t, "").unwrap(), t.path());
        assert_eq!(resolve(&t, "a/b.txt").unwrap(), t.join("a/b.txt"));
        for bad in ["..", "../x", "a/../../x", "/etc/hosts"] {
            assert!(resolve(&t, bad).is_err(), "{bad}");
            assert!(list_dir(&t, bad).is_err(), "{bad}");
        }
        assert!(open_file(&t, "missing.html").is_err());
        assert!(root("relative/path").is_err());
        assert!(root(&t.join("a/b.txt").to_string_lossy()).is_err());
        assert_eq!(
            root(&t.to_string_lossy()).unwrap(),
            t.canonicalize().unwrap()
        );
    }

    #[test]
    fn the_open_workspace_bounds_what_is_served() {
        let t = TempDir::new("ws");
        let inner = t.write("ws/talk/deck.html", DECK);
        let outer = t.write("secret.txt", "x");
        let open = OpenWorkspace::default();
        assert!(!open.contains(&inner), "nothing is open");
        open.set("main", Some(t.join("ws")));
        assert!(open.contains(&inner));
        assert!(!open.contains(&outer));
        assert!(!open.contains(&t.join("ws/../secret.txt")));
        assert!(!open.contains(&t.join("ws/missing.html")));
        open.set("main", None);
        assert!(!open.contains(&inner));
    }

    #[test]
    fn each_window_has_its_own_workspace() {
        let t = TempDir::new("ws");
        let a = t.write("a/talk/deck.html", DECK);
        let b = t.write("b/talk/deck.html", DECK);
        let open = OpenWorkspace::default();
        open.set("main", Some(t.join("a")));
        open.set("window-2", Some(t.join("b")));
        assert_eq!(open.get("main"), Some(t.join("a").canonicalize().unwrap()));
        assert_eq!(
            open.get("window-2"),
            Some(t.join("b").canonicalize().unwrap())
        );
        assert_eq!(open.get("window-3"), None);
        assert!(open.contains(&a) && open.contains(&b), "both are served");
        assert_eq!(
            open.window_with(&t.join("a"), "window-2").as_deref(),
            Some("main")
        );
        assert_eq!(open.window_with(&t.join("a"), "main"), None, "not itself");
        open.set("main", None);
        assert!(!open.contains(&a));
        assert!(open.contains(&b));
        assert_eq!(open.window_with(&t.join("a"), "window-2"), None);
    }

    #[test]
    fn windows_share_a_folder_but_not_a_deck_or_a_chat() {
        let t = TempDir::canonical("ws-decks");
        let a = t.write("talks/a.html", DECK);
        let b = t.write("talks/b.html", DECK);
        let root = t.join("talks");
        let open = OpenWorkspace::default();
        open.set("main", Some(root.clone()));
        assert_eq!(open.chat("main"), Some(root.clone()), "the folder's own");
        assert_eq!(open.open_deck("main", &a, false), Ok(()));
        assert_eq!(open.chat("main"), Some(a.clone()));
        assert_eq!(open.window_with(&root, ""), None, "its chat is the deck's");

        // The same folder in another window, with another of its decks.
        open.set("window-2", Some(root.clone()));
        assert_eq!(open.window_with(&root, "main").as_deref(), Some("window-2"));
        assert_eq!(open.open_deck("window-2", &a, false), Err("main".into()));
        assert_eq!(open.chat("window-2"), Some(root.clone()), "as it was");
        assert_eq!(open.open_deck("window-2", &b, false), Ok(()));
        assert_eq!(
            open.window_with_deck(&b, "main").as_deref(),
            Some("window-2")
        );
        assert_eq!(open.window_with_deck(&b, "window-2"), None, "not itself");
        // Opening its own deck again is fine.
        assert_eq!(open.open_deck("window-2", &b, false), Ok(()));

        // One window at a time has the folder open without a deck.
        assert_eq!(open.close_deck("main"), Ok(()));
        assert_eq!(open.chat("main"), Some(root.clone()));
        assert_eq!(open.close_deck("window-2"), Err("main".into()));
        assert_eq!(
            open.chat("window-2"),
            Some(b.clone()),
            "the deck stays open"
        );
        assert_eq!(open.close_deck("window-3"), Ok(()), "nothing is open there");
    }

    #[test]
    fn the_folders_chat_stays_with_the_deck_it_made_until_it_moves_there() {
        let t = TempDir::canonical("ws-keep");
        let deck = t.write("talks/new.html", DECK);
        let root = t.join("talks");
        let open = OpenWorkspace::default();
        open.set("main", Some(root.clone()));
        assert_eq!(open.open_deck("main", &deck, true), Ok(()));
        assert_eq!(open.chat("main"), Some(root.clone()));
        assert_eq!(open.window_with_deck(&deck, "").as_deref(), Some("main"));
        open.chat_follows_deck("main");
        assert_eq!(open.chat("main"), Some(deck.clone()));

        // A deck's chat does not stay when the window goes on to another deck.
        let other = t.write("talks/other.html", DECK);
        assert_eq!(open.open_deck("main", &other, true), Ok(()));
        assert_eq!(open.chat("main"), Some(other));
    }

    #[test]
    fn remembers_recent_workspaces_newest_first() {
        let t = TempDir::new("ws");
        let home = t.join("home");
        let (a, b) = (t.join("a"), t.join("b"));
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
            let dir = t.join(format!("w{n}"));
            fs::create_dir_all(&dir).unwrap();
            remember(&home, &dir).unwrap();
        }
        assert_eq!(recent(&home).len(), RECENT_KEPT);
        assert_eq!(recent(&home)[0].name, format!("w{}", RECENT_KEPT + 2));
    }

    #[test]
    fn remembers_recent_decks_newest_first_with_their_folder() {
        let t = TempDir::canonical("ws-recent-decks");
        let home = t.join("home");
        let a = t.write("library/a/deck.html", DECK);
        let b = t.write("library/b/deck.html", DECK);
        let library = t.join("library");
        assert!(recent_decks(&home).is_empty());
        remember_deck(&home, &library, &a, "Alpha").unwrap();
        remember_deck(&home, &library, &b, "Beta").unwrap();
        remember_deck(&home, &library, &a, "Alpha").unwrap();
        let decks = recent_decks(&home);
        let titles: Vec<_> = decks.iter().map(|d| d.title.as_str()).collect();
        assert_eq!(titles, ["Alpha", "Beta"], "reopening moves it to the top");
        assert_eq!(decks[0].path, a.to_string_lossy());
        assert_eq!(decks[0].workspace, library.to_string_lossy());
        assert!(decks[0].opened_ms > 0);

        retitle_deck(&home, &b, "Beta, renamed").unwrap();
        retitle_deck(&home, &t.join("library/c/deck.html"), "Not recent").unwrap();
        let decks = recent_decks(&home);
        let titles: Vec<_> = decks.iter().map(|d| d.title.as_str()).collect();
        assert_eq!(
            titles,
            ["Alpha", "Beta, renamed"],
            "renaming keeps the order"
        );

        fs::remove_file(&b).unwrap();
        assert_eq!(recent_decks(&home).len(), 1, "missing files are left out");

        forget_deck(&home, &a.to_string_lossy()).unwrap();
        assert!(recent_decks(&home).is_empty());
    }

    #[test]
    fn a_recent_deck_whose_folder_is_gone_opens_in_its_own() {
        let t = TempDir::canonical("ws-recent-moved");
        let home = t.join("home");
        let deck = t.write("talks/q3/deck.html", DECK);
        let elsewhere = t.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        remember_deck(&home, &elsewhere, &deck, "Q3").unwrap();
        assert_eq!(
            recent_decks(&home)[0].workspace,
            t.join("talks/q3").to_string_lossy(),
            "a folder that does not hold the deck"
        );
        remember_deck(&home, &t.join("gone"), &deck, "Q3").unwrap();
        assert_eq!(
            recent_decks(&home)[0].workspace,
            t.join("talks/q3").to_string_lossy(),
            "a folder that is gone"
        );
    }

    #[test]
    fn keeps_as_many_recent_decks_as_folders() {
        let t = TempDir::new("ws-recent-cap");
        let home = t.join("home");
        for n in 0..RECENT_KEPT + 3 {
            let deck = t.write(format!("d{n}/deck.html"), DECK);
            remember_deck(&home, &t, &deck, &format!("Deck {n}")).unwrap();
        }
        let decks = recent_decks(&home);
        assert_eq!(decks.len(), RECENT_KEPT);
        assert_eq!(decks[0].title, format!("Deck {}", RECENT_KEPT + 2));
    }
}
