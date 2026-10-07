//! Watches the open decks' folders and tells the frontend which files changed, so slide
//! iframes refresh while the agent (or any editor) writes to disk. A deck can be open in the
//! window and on a phone or tablet (src/remote.rs) at once, so each deck is watched until
//! every client that opened it has closed it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::deck::INTERNAL_DIR;
use crate::error::{Error, Result};

#[derive(Default)]
pub struct DeckWatcher(Mutex<HashMap<String, Watched>>);

struct Watched {
    /// Clients that opened the deck and have not closed it yet.
    opens: usize,
    _debouncer: Debouncer<notify::RecommendedWatcher>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeckChanged {
    deck_id: String,
    paths: Vec<String>,
}

impl DeckWatcher {
    pub fn watch(&self, app: AppHandle, deck_id: String, dir: PathBuf) -> Result<()> {
        self.watch_with(deck_id, dir, move |changed| {
            let _ = app.emit("deck-changed", changed);
        })
    }

    fn watch_with(
        &self,
        deck_id: String,
        dir: PathBuf,
        notify: impl Fn(DeckChanged) + Send + 'static,
    ) -> Result<()> {
        let mut watched = self.0.lock().unwrap();
        if let Some(entry) = watched.get_mut(&deck_id) {
            entry.opens += 1;
            return Ok(());
        }
        let key = deck_id.clone();
        // Deleted files cannot be canonicalized, so match against both spellings of the root.
        let roots = [
            dir.canonicalize().unwrap_or_else(|_| dir.clone()),
            dir.clone(),
        ];
        let mut debouncer = new_debouncer(
            Duration::from_millis(120),
            move |res: DebounceEventResult| {
                let Ok(events) = res else { return };
                let paths = changed_paths(&roots, events.iter().map(|e| e.path.as_path()));
                if !paths.is_empty() {
                    notify(DeckChanged {
                        deck_id: deck_id.clone(),
                        paths,
                    });
                }
            },
        )
        .map_err(|e| Error::msg(format!("cannot watch deck: {e}")))?;
        debouncer
            .watcher()
            .watch(&dir, RecursiveMode::Recursive)
            .map_err(|e| Error::msg(format!("cannot watch deck: {e}")))?;
        watched.insert(
            key,
            Watched {
                opens: 1,
                _debouncer: debouncer,
            },
        );
        Ok(())
    }

    /// One client closed the deck; stops watching when it was the last.
    pub fn release(&self, deck_id: &str) {
        let mut watched = self.0.lock().unwrap();
        if let Some(entry) = watched.get_mut(deck_id) {
            entry.opens -= 1;
            if entry.opens == 0 {
                watched.remove(deck_id);
            }
        }
    }

    /// Stops watching the deck whoever has it open (it is being deleted).
    pub fn forget(&self, deck_id: &str) {
        self.0.lock().unwrap().remove(deck_id);
    }

    #[cfg(test)]
    fn opens(&self, deck_id: &str) -> usize {
        self.0.lock().unwrap().get(deck_id).map_or(0, |w| w.opens)
    }
}

/// Deck-relative paths worth telling the frontend about, sorted and deduplicated.
fn changed_paths<'a>(roots: &[PathBuf], events: impl Iterator<Item = &'a Path>) -> Vec<String> {
    let mut paths: Vec<String> = events
        .filter_map(|path| roots.iter().find_map(|root| relative(root, path)))
        .filter(|rel| !rel.starts_with(INTERNAL_DIR) && !is_temp_file(rel))
        .collect();
    paths.sort();
    paths.dedup();
    paths
}

fn relative(root: &Path, path: &Path) -> Option<String> {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_atomic_write_temp_files() {
        assert!(is_temp_file("slides/01-title.html.tmp.18967.9f8e072fc565"));
        assert!(is_temp_file("deck.tmp-0a1b2c"));
        assert!(!is_temp_file("slides/01-title.html"));
        assert!(!is_temp_file("assets/template.png"));
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("slopslide-watch-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(dir.join("assets")).unwrap();
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn relative_paths_use_forward_slashes() {
        let root = TempDir::new();
        let file = root.0.join("assets").join("a.png");
        std::fs::write(&file, "x").unwrap();
        // Existing paths are canonicalized (e.g. /var -> /private/var on macOS).
        let canonical = root.0.canonicalize().unwrap();
        assert_eq!(relative(&canonical, &file).as_deref(), Some("assets/a.png"));
        assert_eq!(
            relative(&canonical, &root.0),
            None,
            "the root itself is not a change"
        );
        assert_eq!(
            relative(&canonical, Path::new("/elsewhere/deck.html")),
            None
        );
    }

    #[test]
    fn relative_handles_deleted_files() {
        let root = TempDir::new();
        // A deleted file cannot be canonicalized; matching uses the path as given.
        let gone = root.0.join("deck.html");
        assert_eq!(relative(&root.0, &gone).as_deref(), Some("deck.html"));
    }

    #[test]
    fn changed_paths_filters_sorts_and_dedups() {
        let root = TempDir::new();
        let roots = [root.0.canonicalize().unwrap(), root.0.clone()];
        let deck = root.0.join("deck.html");
        std::fs::write(&deck, "x").unwrap();
        let events = [
            deck.clone(),
            root.0.join("assets/b.png"),
            root.0.join(INTERNAL_DIR).join("chat.json"),
            root.0.join(INTERNAL_DIR).join("snapshots/1.html"),
            root.0.join("deck.tmp-0a1b2c"),
            root.0.join("assets/a.png"),
            deck.clone(),
            PathBuf::from("/somewhere/else.html"),
            root.0.clone(),
        ];
        assert_eq!(
            changed_paths(&roots, events.iter().map(PathBuf::as_path)),
            ["assets/a.png", "assets/b.png", "deck.html"]
        );
        assert!(changed_paths(&roots, std::iter::empty()).is_empty());
    }

    #[test]
    fn watches_each_deck_until_its_last_client_closes_it() {
        let a = TempDir::new();
        let b = TempDir::new();
        let watcher = DeckWatcher::default();
        let (tx, rx) = std::sync::mpsc::channel();
        let notify = move |changed| tx.send(changed).unwrap();
        watcher
            .watch_with("a".into(), a.0.clone(), notify.clone())
            .unwrap();
        watcher
            .watch_with("a".into(), a.0.clone(), notify.clone())
            .unwrap();
        watcher.watch_with("b".into(), b.0.clone(), notify).unwrap();
        assert_eq!((watcher.opens("a"), watcher.opens("b")), (2, 1));

        // Both decks report changes, not just the one opened last. The OS may report a change
        // more than once, so wait for each deck's rather than assuming the order.
        let next_for = |deck: &str| loop {
            let changed = rx.recv_timeout(Duration::from_secs(5)).expect("a change");
            if changed.deck_id == deck {
                return changed;
            }
        };
        std::fs::write(b.0.join("deck.html"), "b").unwrap();
        assert_eq!(next_for("b").paths, ["deck.html"]);
        std::fs::write(a.0.join("deck.html"), "a").unwrap();
        assert_eq!(next_for("a").paths, ["deck.html"]);

        watcher.release("a");
        assert_eq!(watcher.opens("a"), 1, "the other client still has it open");
        watcher.release("a");
        assert_eq!(watcher.opens("a"), 0);
        watcher.release("a");
        watcher.release("unknown");
        watcher.forget("b");
        assert_eq!(watcher.opens("b"), 0);
    }

    #[test]
    fn temp_file_detection_looks_at_the_file_name_only() {
        assert!(!is_temp_file("my.tmp-dir/deck.html"));
        assert!(is_temp_file("assets/photo.png.tmp.1.2"));
        assert!(!is_temp_file("assets/template.html"));
    }
}
