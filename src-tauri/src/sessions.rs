//! Chat sessions: what the app keeps about a conversation with the agent, stored outside the
//! deck folder so it is never shared or committed along with the deck:
//!
//! ```text
//! ~/.slopslides/sessions/<session-id>/
//!   meta.json        {"deck": "<deck file>"}: the deck the session belongs to
//!   chat.json        the conversation as the chat panel shows it
//!   *-session        each agent provider's resumable session id
//!   snapshots/       copies of the deck file from before agent turns and destructive edits
//!   sketches/        screenshots of slides the user drew on, for the agent
//!   templates/       templates staged for the agent to read
//!   locked.json      the locked slides while an agent turn runs
//! ```
//!
//! Session ids start with their creation time, so they sort oldest first. A deck's current
//! session is its newest; starting a new chat starts a new session and keeps the old ones.
//!
//! Sessions from before decks were addressed by file name their deck's folder; they still
//! belong to that folder's `deck.html`.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::deck::DECK_FILE;
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

    /// Session folders of the deck file `deck`, oldest first.
    pub fn list(&self, deck: &Path) -> Vec<PathBuf> {
        let deck = canonical(deck);
        // A `deck.html`'s folder, which sessions from before named instead of the file.
        let legacy = (deck.file_name().and_then(|n| n.to_str()) == Some(DECK_FILE))
            .then(|| deck.parent().map(Path::to_path_buf))
            .flatten();
        let Ok(entries) = fs::read_dir(&self.root) else {
            return Vec::new();
        };
        let mut found: Vec<PathBuf> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|dir| deck_of(dir).is_some_and(|d| d == deck || legacy.as_ref() == Some(&d)))
            .collect();
        found.sort();
        found
    }

    /// The deck's current session, if it has one.
    pub fn current(&self, deck: &Path) -> Option<PathBuf> {
        self.list(deck).pop()
    }

    /// The deck's current session, starting one if it has none.
    pub fn current_or_start(&self, deck: &Path) -> Result<PathBuf> {
        match self.current(deck) {
            Some(dir) => Ok(dir),
            None => self.start(deck),
        }
    }

    /// Starts a new, empty session for `deck` and makes it the current one.
    pub fn start(&self, deck: &Path) -> Result<PathBuf> {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let short = &uuid::Uuid::new_v4().simple().to_string()[..8];
        let dir = self.root.join(format!("{stamp:013}-{short}"));
        fs::create_dir_all(&dir)?;
        let meta = json!({ "deck": canonical(deck) });
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

/// The deck file a session belongs to (its folder, for sessions from before).
fn deck_of(session: &Path) -> Option<PathBuf> {
    let raw = fs::read_to_string(session.join(META_FILE)).ok()?;
    let meta: Value = serde_json::from_str(&raw).ok()?;
    meta["deck"].as_str().map(PathBuf::from)
}

/// The deck's path in one canonical spelling, so the same file always matches.
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
            dir.join("deck.html")
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_deck_has_no_session_until_one_starts() {
        let t = Temp::new();
        let deck = t.deck("talk");
        let sessions = t.sessions();
        assert_eq!(sessions.current(&deck), None);
        let started = sessions.current_or_start(&deck).unwrap();
        assert!(started.starts_with(t.0.join("home").join("sessions")));
        assert!(
            !started.starts_with(deck.parent().unwrap()),
            "kept outside the deck"
        );
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
    fn sessions_belong_to_one_deck() {
        let t = Temp::new();
        let (a, b) = (t.deck("a"), t.deck("b"));
        let sessions = t.sessions();
        let session_a = sessions.start(&a).unwrap();
        assert_eq!(sessions.current(&b), None);
        let session_b = sessions.start(&b).unwrap();
        // The same file spelled differently is the same deck.
        let spelled = t.0.join("library").join(".").join("a").join("deck.html");
        assert_eq!(sessions.list(&spelled), [session_a]);
        assert_eq!(sessions.list(&b), [session_b]);
    }

    #[test]
    fn decks_in_one_folder_have_their_own_sessions() {
        let t = Temp::new();
        let deck = t.deck("talks");
        let other = deck.with_file_name("q3.html");
        fs::write(&other, "<html></html>").unwrap();
        let sessions = t.sessions();
        let session = sessions.start(&deck).unwrap();
        assert_eq!(sessions.current(&other), None);
        let other_session = sessions.start(&other).unwrap();
        assert_eq!(sessions.list(&deck), [session]);
        assert_eq!(sessions.list(&other), [other_session]);
    }

    #[test]
    fn sessions_named_by_the_deck_folder_belong_to_its_deck_html() {
        let t = Temp::new();
        let deck = t.deck("talk");
        let folder = deck.parent().unwrap().to_path_buf();
        let sessions = t.sessions();
        // How sessions were started before decks were files.
        let old = sessions.start(&folder).unwrap();
        assert_eq!(sessions.current(&deck), Some(old.clone()));
        let other = deck.with_file_name("other.html");
        fs::write(&other, "<html></html>").unwrap();
        assert_eq!(
            sessions.current(&other),
            None,
            "only deck.html inherits them"
        );
        std::thread::sleep(std::time::Duration::from_millis(2));
        let new = sessions.start(&deck).unwrap();
        assert_eq!(sessions.list(&deck), [old, new]);
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
