//! Watches the open deck folder and tells the frontend which files changed, so slide
//! iframes refresh while the agent (or any editor) writes to disk.

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
pub struct DeckWatcher(Mutex<Option<Debouncer<notify::RecommendedWatcher>>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeckChanged {
    deck_id: String,
    paths: Vec<String>,
}

impl DeckWatcher {
    pub fn watch(&self, app: AppHandle, deck_id: String, dir: PathBuf) -> Result<()> {
        // Deleted files cannot be canonicalized, so match against both spellings of the root.
        let roots = [
            dir.canonicalize().unwrap_or_else(|_| dir.clone()),
            dir.clone(),
        ];
        let mut debouncer = new_debouncer(
            Duration::from_millis(120),
            move |res: DebounceEventResult| {
                let Ok(events) = res else { return };
                let mut paths: Vec<String> = events
                    .iter()
                    .filter_map(|event| roots.iter().find_map(|root| relative(root, &event.path)))
                    .filter(|rel| !rel.starts_with(INTERNAL_DIR) && !is_temp_file(rel))
                    .collect();
                paths.sort();
                paths.dedup();
                if !paths.is_empty() {
                    let _ = app.emit(
                        "deck-changed",
                        DeckChanged {
                            deck_id: deck_id.clone(),
                            paths,
                        },
                    );
                }
            },
        )
        .map_err(|e| Error::msg(format!("cannot watch deck: {e}")))?;
        debouncer
            .watcher()
            .watch(&dir, RecursiveMode::Recursive)
            .map_err(|e| Error::msg(format!("cannot watch deck: {e}")))?;
        *self.0.lock().unwrap() = Some(debouncer);
        Ok(())
    }

    pub fn stop(&self) {
        self.0.lock().unwrap().take();
    }
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
}
