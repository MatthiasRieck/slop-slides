//! Watches the open workspace and tells the frontend which files changed, so the file tree
//! and slide iframes refresh while the agent (or any editor) writes to disk.
//!
//! The app's own changes to a deck come back from the watcher too, a moment after the command
//! that made them already gave the frontend the deck: told again, the frontend would load the
//! deck, its history and its narration a second time for nothing. So a command says what it
//! left on disk ([`OwnWrites::note`]), and a deck that is still exactly that is not reported.
//!
//! The debouncer only says that something happened at a path, not what: a change to a file's
//! content cannot be told from a file created or removed without keeping a picture of the
//! whole folder, so the payload does not say which it was.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime};

use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{Error, Result};

/// A watcher for each window's workspace, by window label.
#[derive(Default)]
pub struct WorkspaceWatcher(Mutex<HashMap<String, Debouncer<notify::RecommendedWatcher>>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceChanged {
    /// The workspace folder, as the frontend opened it.
    root: String,
    /// Workspace-relative, `/`-separated.
    paths: Vec<String>,
}

/// What a file is on disk: how long, and when written and created. The app writes a deck
/// through a new file it then renames into place (`files::atomic_write`), so each of its writes
/// has a creation time of its own, and anyone else's write changes at least one of the three.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
}

impl Stamp {
    fn of(path: &Path) -> Option<Self> {
        let meta = std::fs::metadata(path).ok()?;
        Some(Stamp {
            len: meta.len(),
            modified: meta.modified().ok(),
            created: meta.created().ok(),
        })
    }
}

/// The decks the app itself last wrote, as it left them: what the frontend already has.
#[derive(Default)]
pub struct OwnWrites(Mutex<HashMap<PathBuf, Stamp>>);

/// The app's own writes, for the watchers of all windows.
pub fn own_writes() -> &'static OwnWrites {
    static OWN: LazyLock<OwnWrites> = LazyLock::new(OwnWrites::default);
    &OWN
}

impl OwnWrites {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<PathBuf, Stamp>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Says that the deck file `path` is, as it is on disk now, what the app just wrote and
    /// gave the frontend. Only for a write whose result the frontend gets back: one it learns
    /// of from the watcher alone (the end of an agent's turn) must stay reported.
    pub fn note(&self, path: &Path) {
        let path = canonical(path);
        match Stamp::of(&path) {
            Some(stamp) => self.lock().insert(path, stamp),
            None => self.lock().remove(&path),
        };
    }

    /// Whether `path` (resolved) is still as the app left it. Once it is not, someone else
    /// wrote it, in the same moment or later, and it is the app's own no longer.
    fn is_own(&self, path: &Path) -> bool {
        let mut own = self.lock();
        let Some(noted) = own.get(path) else {
            return false;
        };
        if Stamp::of(path).as_ref() == Some(noted) {
            return true;
        }
        own.remove(path);
        false
    }
}

fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

impl WorkspaceWatcher {
    /// Watches `dir`, the folder `window` has open, and tells that window (no other) what
    /// changed in it.
    pub fn watch(&self, app: AppHandle, window: &str, dir: PathBuf) -> Result<()> {
        let root = dir.to_string_lossy().into_owned();
        let label = window.to_string();
        // Deleted files cannot be canonicalized, so match against both spellings of the root.
        let roots = [
            dir.canonicalize().unwrap_or_else(|_| dir.clone()),
            dir.clone(),
        ];
        let mut debouncer = new_debouncer(
            Duration::from_millis(120),
            move |res: DebounceEventResult| {
                let Ok(events) = res else { return };
                let events = events.iter().map(|e| e.path.as_path());
                let paths = changed_paths(&roots, events, own_writes());
                if !paths.is_empty() {
                    let _ = app.emit_to(
                        label.as_str(),
                        "workspace-changed",
                        WorkspaceChanged {
                            root: root.clone(),
                            paths,
                        },
                    );
                }
            },
        )
        .map_err(|e| Error::msg(format!("cannot watch the folder: {e}")))?;
        debouncer
            .watcher()
            .watch(&dir, RecursiveMode::Recursive)
            .map_err(|e| Error::msg(format!("cannot watch the folder: {e}")))?;
        self.0.lock().unwrap().insert(window.to_string(), debouncer);
        Ok(())
    }

    pub fn stop(&self, window: &str) {
        self.0.lock().unwrap().remove(window);
    }
}

/// Workspace-relative paths worth telling the frontend about, sorted and deduplicated: not the
/// decks that are as the app itself left them (`own`). Only a deck file can be one of those;
/// an asset is always reported.
fn changed_paths<'a>(
    roots: &[PathBuf],
    events: impl Iterator<Item = &'a Path>,
    own: &OwnWrites,
) -> Vec<String> {
    let mut paths: Vec<String> = events
        .map(canonical)
        .filter(|path| !(crate::deck::is_html(path) && own.is_own(path)))
        .filter_map(|path| roots.iter().find_map(|root| relative(root, &path)))
        .filter(|rel| !is_temp_file(rel) && !in_hidden_folder(rel))
        .collect();
    paths.sort();
    paths.dedup();
    paths
}

/// `path` (resolved) relative to `root`, `/`-separated; None outside it and for the root itself.
fn relative(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let parts: Vec<_> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// Atomic-write temp files: ours (`deck.tmp-<uuid>`) and Claude Code's (`x.html.tmp.<pid>.<hash>`).
fn is_temp_file(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name.contains(".tmp-") || name.contains(".tmp.")
}

/// Inside a dot folder (`.git/…`), which the file tree does not show either.
fn in_hidden_folder(rel: &str) -> bool {
    rel.split('/')
        .rev()
        .skip(1)
        .any(|part| part.starts_with('.'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn ignores_atomic_write_temp_files() {
        assert!(is_temp_file("slides/01-title.html.tmp.18967.9f8e072fc565"));
        assert!(is_temp_file("deck.tmp-0a1b2c"));
        assert!(!is_temp_file("slides/01-title.html"));
        assert!(!is_temp_file("assets/template.png"));
    }

    /// A root with an assets folder.
    fn temp_root() -> TempDir {
        let dir = TempDir::new("watch");
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        dir
    }

    #[test]
    fn relative_paths_use_forward_slashes() {
        let root = temp_root();
        let file = root.join("assets").join("a.png");
        std::fs::write(&file, "x").unwrap();
        // Existing paths are canonicalized (e.g. /var -> /private/var on macOS).
        let root_path = root.canonicalize().unwrap();
        assert_eq!(
            relative(&root_path, &canonical(&file)).as_deref(),
            Some("assets/a.png")
        );
        assert_eq!(
            relative(&root_path, &canonical(&root)),
            None,
            "the root itself is not a change"
        );
        assert_eq!(
            relative(&root_path, Path::new("/elsewhere/deck.html")),
            None
        );
    }

    #[test]
    fn relative_handles_deleted_files() {
        let root = temp_root();
        // A deleted file cannot be canonicalized; matching uses the path as given.
        let gone = root.join("deck.html");
        assert_eq!(relative(&root, &gone).as_deref(), Some("deck.html"));
    }

    #[test]
    fn changed_paths_filters_sorts_and_dedups() {
        let root = temp_root();
        let roots = [root.canonicalize().unwrap(), root.to_path_buf()];
        let deck = root.join("deck.html");
        std::fs::write(&deck, "x").unwrap();
        let events = [
            deck.clone(),
            root.join("assets/b.png"),
            root.join("deck.tmp-0a1b2c"),
            root.join("assets/a.png"),
            deck.clone(),
            PathBuf::from("/somewhere/else.html"),
            root.to_path_buf(),
        ];
        let own = OwnWrites::default();
        assert_eq!(
            changed_paths(&roots, events.iter().map(PathBuf::as_path), &own),
            ["assets/a.png", "assets/b.png", "deck.html"]
        );
        assert!(changed_paths(&roots, std::iter::empty(), &own).is_empty());
    }

    /// Writes `text` to `file` the way the app writes a deck.
    fn app_writes(file: &Path, text: &str) {
        crate::files::atomic_write(file, text.as_bytes()).unwrap();
    }

    #[test]
    fn the_apps_own_deck_write_is_not_reported_back() {
        let root = temp_root();
        let roots = [root.canonicalize().unwrap(), root.to_path_buf()];
        let deck = root.join("deck.html");
        let image = root.join("assets/a.png");
        std::fs::write(&image, "x").unwrap();
        let own = OwnWrites::default();
        let reported = |events: &[&Path]| changed_paths(&roots, events.iter().copied(), &own);

        app_writes(&deck, "<html>one</html>");
        assert_eq!(
            reported(&[&deck]),
            ["deck.html"],
            "a write nobody vouched for is reported"
        );
        own.note(&deck);
        assert!(reported(&[&deck]).is_empty(), "the frontend has it already");
        assert!(
            reported(&[&deck]).is_empty(),
            "however often the watcher says so"
        );
        assert_eq!(
            reported(&[&deck, &image]),
            ["assets/a.png"],
            "what changed beside it is still told"
        );

        app_writes(&deck, "<html>two</html>");
        own.note(&deck);
        assert!(reported(&[&deck]).is_empty(), "nor is the next own write");
    }

    #[test]
    fn an_outside_write_in_the_same_moment_is_still_reported() {
        let root = temp_root();
        let roots = [root.canonicalize().unwrap(), root.to_path_buf()];
        let deck = root.join("deck.html");
        let own = OwnWrites::default();
        let reported = |events: &[&Path]| changed_paths(&roots, events.iter().copied(), &own);

        // The app writes, then an agent replaces the file before the watcher speaks: one
        // batch of events, and the deck on disk is not what the frontend was given.
        app_writes(&deck, "<html>mine</html>");
        own.note(&deck);
        app_writes(&deck, "<html>agent</html>");
        assert_eq!(reported(&[&deck]), ["deck.html"]);

        // An editor that writes in place, to the very same length.
        app_writes(&deck, "<html>mine</html>");
        own.note(&deck);
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(&deck, "<html>ours</html>").unwrap();
        assert_eq!(reported(&[&deck]), ["deck.html"]);
        assert_eq!(
            reported(&[&deck]),
            ["deck.html"],
            "and it stays someone else's from then on"
        );

        // A deck deleted after the app wrote it.
        app_writes(&deck, "<html>mine</html>");
        own.note(&deck);
        std::fs::remove_file(&deck).unwrap();
        assert_eq!(reported(&[&deck]), ["deck.html"]);
    }

    #[test]
    fn an_asset_is_never_taken_for_an_own_write() {
        let root = temp_root();
        let roots = [root.canonicalize().unwrap(), root.to_path_buf()];
        let own = OwnWrites::default();
        let image = root.join("assets/a.png");
        std::fs::write(&image, "x").unwrap();
        // Even if someone noted it by mistake.
        own.note(&image);
        assert_eq!(
            changed_paths(&roots, [image.as_path()].into_iter(), &own),
            ["assets/a.png"]
        );
    }

    #[test]
    fn ignores_changes_inside_dot_folders() {
        assert!(in_hidden_folder(".git/index"));
        assert!(in_hidden_folder("talk/.cache/x.png"));
        assert!(
            !in_hidden_folder(".gitignore"),
            "dot files themselves still count"
        );
        assert!(!in_hidden_folder("talk/deck.html"));
    }

    #[test]
    fn temp_file_detection_looks_at_the_file_name_only() {
        assert!(!is_temp_file("my.tmp-dir/deck.html"));
        assert!(is_temp_file("assets/photo.png.tmp.1.2"));
        assert!(!is_temp_file("assets/template.html"));
    }
}
