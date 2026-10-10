//! Conversations belong to a workspace folder. The newest session is current.
//! `meta.json` stores {"workspace": "<canonical folder>"}; chat, provider ids,
//! sketches and templates live here, with snapshots/<relative deck path>/<stamp>.html
//! and locked.json keyed by relative deck path.
//!
//! Migration: legacy {"deck": ...} sessions (including folder-keyed ones) remain
//! readable on disk. Opening a workspace starts a fresh conversation rather than
//! silently adopting one of several decks' unrelated histories.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::error::Result;

const SESSIONS_DIR: &str = "sessions";
const META_FILE: &str = "meta.json";
pub const CHAT_FILE: &str = "chat.json";

/// All sessions, under the app's home folder.
#[derive(Debug, Clone)]
pub struct Sessions {
    root: PathBuf,
}

impl Sessions {
    pub fn new(app_home: &Path) -> Self {
        Sessions {
            root: app_home.join(SESSIONS_DIR),
        }
    }

    /// Session folders of the workspace folder `workspace`, oldest first.
    pub fn list(&self, workspace: &Path) -> Vec<PathBuf> {
        let workspace = canonical(workspace);
        let Ok(entries) = fs::read_dir(&self.root) else {
            return Vec::new();
        };
        let mut found: Vec<PathBuf> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|dir| workspace_of(dir).is_some_and(|d| canonical(&d) == workspace))
            .collect();
        found.sort();
        found
    }

    /// The workspace's current session, if it has one.
    pub fn current(&self, workspace: &Path) -> Option<PathBuf> {
        self.list(workspace).pop()
    }

    /// The workspace's current session, starting one if it has none.
    pub fn current_or_start(&self, workspace: &Path) -> Result<PathBuf> {
        match self.current(workspace) {
            Some(dir) => Ok(dir),
            None => self.start(workspace),
        }
    }

    /// Starts a new, empty session for `workspace` and makes it the current one.
    pub fn start(&self, workspace: &Path) -> Result<PathBuf> {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let short = &uuid::Uuid::new_v4().simple().to_string()[..8];
        let dir = self.root.join(format!("{stamp:013}-{short}"));
        fs::create_dir_all(&dir)?;
        let meta = json!({ "workspace": canonical(workspace) });
        fs::write(dir.join(META_FILE), meta.to_string())?;
        Ok(dir)
    }

    /// Whether `path` lies inside a session folder (for serving session files to the UI).
    pub fn contains(&self, path: &Path) -> bool {
        match (path.canonicalize(), self.root.canonicalize()) {
            (Ok(path), Ok(root)) => path.starts_with(&root) && path != root,
            _ => false,
        }
    }
}

/// The workspace folder a session belongs to; legacy deck sessions have no workspace.
pub fn workspace_of(session: &Path) -> Option<PathBuf> {
    let raw = fs::read_to_string(session.join(META_FILE)).ok()?;
    let meta: Value = serde_json::from_str(&raw).ok()?;
    meta["workspace"].as_str().map(PathBuf::from)
}

/// The workspace's path in one canonical spelling, so the same folder always matches.
fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Temp(PathBuf);

    impl Temp {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("slopslide-sessions-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(dir.join("library")).unwrap();
            fs::create_dir_all(dir.join("home")).unwrap();
            Temp(dir)
        }

        fn sessions(&self) -> Sessions {
            Sessions::new(&self.0.join("home"))
        }

        /// `library/<id>/deck.html`.
        fn deck(&self, id: &str) -> PathBuf {
            let dir = self.0.join("library").join(id);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("deck.html"), "<html></html>").unwrap();
            dir
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_workspace_has_no_session_until_one_starts() {
        let t = Temp::new();
        let deck = t.deck("talk");
        let sessions = t.sessions();
        assert_eq!(sessions.current(&deck), None);
        let started = sessions.current_or_start(&deck).unwrap();
        assert!(started.starts_with(t.0.join("home").join("sessions")));
        assert!(!started.starts_with(&deck), "kept outside the deck");
        assert_eq!(sessions.current(&deck), Some(started.clone()));
        assert_eq!(sessions.current_or_start(&deck).unwrap(), started);
    }

    #[test]
    fn the_newest_session_is_current_and_older_ones_are_kept() {
        let t = Temp::new();
        let deck = t.deck("talk");
        let sessions = t.sessions();
        let first = sessions.start(&deck).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let second = sessions.start(&deck).unwrap();
        assert_eq!(sessions.list(&deck), [first.clone(), second.clone()]);
        assert_eq!(sessions.current(&deck), Some(second));
        assert!(first.is_dir());
    }

    #[test]
    fn sessions_belong_to_one_workspace() {
        let t = Temp::new();
        let (a, b) = (t.deck("a"), t.deck("b"));
        let sessions = t.sessions();
        let session_a = sessions.start(&a).unwrap();
        assert_eq!(sessions.current(&b), None);
        let session_b = sessions.start(&b).unwrap();
        // The same file spelled differently is the same deck.
        let spelled = t.0.join("library").join(".").join("a");
        assert_eq!(sessions.list(&spelled), [session_a]);
        assert_eq!(sessions.list(&b), [session_b]);
    }

    #[test]
    fn every_deck_in_a_workspace_shares_its_session() {
        let t = Temp::new();
        let folder = t.deck("talks");
        fs::write(folder.join("q3.html"), "<html></html>").unwrap();
        let sessions = t.sessions();
        let session = sessions.current_or_start(&folder).unwrap();
        assert_eq!(sessions.current_or_start(&folder).unwrap(), session);
        assert_eq!(workspace_of(&session), Some(folder.canonicalize().unwrap()));
    }

    #[test]
    fn legacy_deck_sessions_are_preserved_but_not_adopted() {
        let t = Temp::new();
        let folder = t.deck("talk");
        let file = folder.join("deck.html");
        let sessions = t.sessions();
        let old = sessions.start(&folder).unwrap();
        fs::write(old.join(META_FILE), json!({"deck": file}).to_string()).unwrap();
        fs::write(old.join(CHAT_FILE), "[1]").unwrap();
        assert_eq!(sessions.current(&folder), None);
        let new = sessions.current_or_start(&folder).unwrap();
        assert_ne!(new, old);
        assert_eq!(fs::read_to_string(old.join(CHAT_FILE)).unwrap(), "[1]");
        assert_eq!(workspace_of(&new), Some(folder.canonicalize().unwrap()));
    }

    #[test]
    fn contains_only_paths_inside_a_session() {
        let t = Temp::new();
        let deck = t.deck("talk");
        let sessions = t.sessions();
        let session = sessions.start(&deck).unwrap();
        fs::write(session.join("x.png"), "png").unwrap();
        assert!(sessions.contains(&session.join("x.png")));
        assert!(!sessions.contains(&session.join("..").join("..").join("other")));
        assert!(!sessions.contains(&deck));
        assert!(!sessions.contains(&t.0.join("home").join("sessions")));
        assert!(!sessions.contains(&session.join("missing.png")));
    }
}
