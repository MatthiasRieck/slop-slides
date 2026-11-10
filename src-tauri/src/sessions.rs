//! Conversations belong to a workspace folder. The newest session records the active thread.
//! `meta.json` stores {"workspace": "<canonical folder>"}; chat, provider ids, sketches,
//! templates, where each turn's conversation started (`rewind.json`, see [`crate::rewind`]),
//! and locked.json keyed by relative deck path live here. The decks' undo histories do not:
//! they outlive chats (see [`crate::history`]).
//!
//! Migration: legacy {"deck": ...} sessions (including folder-keyed ones) remain
//! readable on disk. Opening a workspace starts a fresh conversation rather than
//! silently adopting one of several decks' unrelated histories.
//! provider.json records the provider chosen for the workspace conversation.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};

use crate::agent::Provider;
use crate::error::{Error, Result};
use crate::files::atomic_write;

const SESSIONS_DIR: &str = "sessions";
const META_FILE: &str = "meta.json";
pub const CHAT_FILE: &str = "chat.json";
const SKETCHES_KEPT: usize = 30;

/// The session's chat; Null for a deck without one yet.
pub fn load_chat(session: Option<&Path>) -> Result<Value> {
    let Some(session) = session else {
        return Ok(Value::Null);
    };
    match fs::read_to_string(session.join(CHAT_FILE)) {
        Ok(raw) => Ok(serde_json::from_str(&raw).unwrap_or(Value::Null)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(e.into()),
    }
}

pub fn save_chat(session: &Path, chat: &Value) -> Result<()> {
    fs::create_dir_all(session)?;
    atomic_write(
        &session.join(CHAT_FILE),
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

/// Restores a provider lock, including conversations saved before locks were recorded.
pub fn provider(session: &Path) -> Result<Option<Provider>> {
    match fs::read(session.join("provider.json")) {
        Ok(raw) => {
            return serde_json::from_slice(&raw)
                .map(Some)
                .map_err(|e| Error::msg(e.to_string()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    let chat = load_chat(Some(session))?;
    if let Some(reply) = chat
        .as_array()
        .and_then(|messages| messages.iter().rev().find(|m| m["role"] == "assistant"))
    {
        return match reply.get("provider") {
            Some(value) => serde_json::from_value(value.clone())
                .map(Some)
                .map_err(|e| Error::msg(e.to_string())),
            None => Ok(Some(Provider::Claude)),
        };
    }
    Ok(Provider::ALL
        .into_iter()
        .find(|p| read_session(session, p.session_file()).is_some()))
}

/// Called under the agent's running lock before launching a turn.
pub fn claim_provider(session: &Path, requested: Provider) -> Result<()> {
    if provider(session)?.is_some_and(|p| p != requested) {
        return Err(Error::msg("Start a new chat to change provider."));
    }
    let raw = serde_json::to_vec(&requested).map_err(|e| Error::msg(e.to_string()))?;
    fs::write(session.join("provider.json"), raw)?;
    Ok(())
}

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

    /// All folder and legacy deck conversations underneath the opened root.
    pub fn list_scoped(&self, workspace: &Path) -> Vec<PathBuf> {
        let root = canonical(workspace);
        let Ok(entries) = fs::read_dir(&self.root) else {
            return Vec::new();
        };
        let mut found: Vec<PathBuf> = entries
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|session| {
                association_of(session).is_some_and(|path| canonical(&path).starts_with(&root))
            })
            .collect();
        found.sort();
        found
    }

    /// The workspace's current session, if it has one.
    pub fn current(&self, workspace: &Path) -> Option<PathBuf> {
        let listed = self.list(workspace);
        let newest = listed.last()?;
        if let Ok(selected) = fs::read_to_string(newest.join("active-session")) {
            if let Some(path) = self.list_scoped(workspace).into_iter().find(|path| {
                path.file_name()
                    .is_some_and(|name| name == selected.as_str())
            }) {
                return Some(path);
            }
        }
        Some(newest.clone())
    }

    /// The session folder of conversation `thread`, one of [`Sessions::list_scoped`]; never
    /// any other path.
    fn thread(&self, workspace: &Path, thread: &str) -> Result<PathBuf> {
        self.list_scoped(workspace)
            .into_iter()
            .find(|path| path.file_name().is_some_and(|name| name == thread))
            .ok_or_else(|| Error::msg("Conversation not found in this workspace."))
    }

    /// Select only a session belonging to this workspace; never accept arbitrary paths.
    pub fn select(&self, workspace: &Path, thread: &str) -> Result<()> {
        self.thread(workspace, thread)?;
        // Keep the selection on this root's own session, so opening a parent folder
        // does not change the active conversation of a separately opened subfolder.
        let anchor = match self.list(workspace).pop() {
            Some(path) => path,
            None => self.start(workspace)?,
        };
        fs::write(anchor.join("active-session"), thread)?;
        Ok(())
    }

    /// The workspace's conversations, newest first, for picking one to go back to.
    pub fn threads(&self, workspace: &Path) -> Result<Vec<Thread>> {
        let current = self.current(workspace);
        self.list_scoped(workspace)
            .into_iter()
            .rev()
            .map(|path| {
                let chat = load_chat(Some(&path))?;
                let messages = chat.as_array();
                let first = messages.and_then(|items| items.iter().find(|m| m["role"] == "user"));
                let title = first
                    .and_then(|m| m["text"].as_str())
                    .unwrap_or("New conversation");
                Ok(Thread {
                    id: path.file_name().unwrap().to_string_lossy().into_owned(),
                    title: title.chars().take(100).collect(),
                    created_at: first.and_then(|m| m["createdAt"].as_u64()),
                    current: current.as_ref() == Some(&path),
                    message_count: messages.map_or(0, Vec::len),
                    association: association_of(&path).map(|associated| {
                        let relative = associated.strip_prefix(workspace).unwrap_or(&associated);
                        if relative.as_os_str().is_empty() {
                            ".".to_string()
                        } else {
                            relative.to_string_lossy().replace('\\', "/")
                        }
                    }),
                })
            })
            .collect()
    }

    /// Makes conversation `thread` the workspace's current one; returns its chat and provider.
    pub fn open_thread(&self, workspace: &Path, thread: &str) -> Result<OpenedThread> {
        let path = self.thread(workspace, thread)?;
        // Read before selecting: a damaged transcript must not change the active conversation.
        let chat = load_chat(Some(&path))?;
        let provider = provider(&path)?;
        self.select(workspace, thread)?;
        Ok(OpenedThread { chat, provider })
    }

    /// A session for a new chat: the current one while it has no conversation yet, else a new
    /// one.
    pub fn new_chat(&self, workspace: &Path) -> Result<PathBuf> {
        if let Some(current) = self.current(workspace) {
            if load_chat(Some(&current))?.is_null() && provider(&current)?.is_none() {
                for provider in Provider::ALL {
                    write_session(&current, provider.session_file(), None)?;
                }
                return Ok(current);
            }
        }
        self.start(workspace)
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
        self.select(workspace, dir.file_name().unwrap().to_str().unwrap())?;
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

/// One of a workspace's conversations, as the chat's history lists it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    /// The session folder's name.
    pub id: String,
    /// The start of its first message, or "New conversation".
    pub title: String,
    /// When its first message was written, in ms since the epoch.
    pub created_at: Option<u64>,
    /// Whether it is the workspace's current conversation.
    pub current: bool,
    pub message_count: usize,
    /// The folder or deck it started in, relative to the workspace (`.` for the workspace).
    pub association: Option<String>,
}

/// A conversation picked to go on with (see [`Sessions::open_thread`]).
#[derive(Debug, Serialize)]
pub struct OpenedThread {
    pub chat: Value,
    pub provider: Option<Provider>,
}

/// The folder or slide deck originally associated with a conversation.
pub fn association_of(session: &Path) -> Option<PathBuf> {
    let raw = fs::read_to_string(session.join(META_FILE)).ok()?;
    let meta: Value = serde_json::from_str(&raw).ok()?;
    meta["workspace"]
        .as_str()
        .or_else(|| meta["deck"].as_str())
        .map(PathBuf::from)
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
    fn chat_round_trips_and_tolerates_bad_files() {
        let t = Temp::new();
        let session = t.0.join("session");
        assert_eq!(load_chat(None).unwrap(), Value::Null);
        assert_eq!(load_chat(Some(&session)).unwrap(), Value::Null);
        let chat = json!([{"id": "1", "role": "user", "text": "hi ✨"}]);
        save_chat(&session, &chat).unwrap();
        assert_eq!(load_chat(Some(&session)).unwrap(), chat);
        fs::write(session.join(CHAT_FILE), "{not json").unwrap();
        assert_eq!(load_chat(Some(&session)).unwrap(), Value::Null);
        save_chat(&session, &Value::Null).unwrap();
        assert_eq!(load_chat(Some(&session)).unwrap(), Value::Null);
    }

    #[test]
    fn provider_session_ids_are_kept_per_provider_trimmed_and_cleared() {
        let t = Temp::new();
        let session = t.0.join("session");
        fs::create_dir_all(&session).unwrap();
        assert_eq!(read_session(&session, "session"), None);
        write_session(&session, "session", Some("abc-123")).unwrap();
        write_session(&session, "codex-session", Some("codex-1")).unwrap();
        assert_eq!(
            read_session(&session, "session").as_deref(),
            Some("abc-123")
        );
        assert_eq!(
            read_session(&session, "codex-session").as_deref(),
            Some("codex-1")
        );
        fs::write(session.join("session"), "  xyz\n").unwrap();
        assert_eq!(read_session(&session, "session").as_deref(), Some("xyz"));
        write_session(&session, "session", None).unwrap();
        assert_eq!(read_session(&session, "session"), None);
        write_session(&session, "session", None).unwrap();
        assert_eq!(
            read_session(&session, "codex-session").as_deref(),
            Some("codex-1")
        );
    }

    #[test]
    fn save_sketch_names_are_unique() {
        let t = Temp::new();
        let a = save_sketch(&t.0.join("session"), b"a").unwrap();
        let b = save_sketch(&t.0.join("session"), b"b").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn save_sketch_writes_a_png_and_prunes_old_ones() {
        let t = Temp::new();
        let session = t.0.join("session");
        let sketches = session.join("sketches");
        fs::create_dir_all(&sketches).unwrap();
        for n in 0..SKETCHES_KEPT + 3 {
            let name = format!("{}-old.png", 1_000_000_000_000u64 + n as u64);
            fs::write(sketches.join(name), b"old").unwrap();
        }
        let path = save_sketch(&session, b"\x89PNG fake").unwrap();
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
    fn resetting_a_claimed_session_starts_a_new_chat_even_without_saved_messages() {
        let t = Temp::new();
        let root = t.deck("talk");
        let sessions = t.sessions();
        let first = sessions.new_chat(&root).unwrap();
        assert_eq!(sessions.new_chat(&root).unwrap(), first);
        claim_provider(&first, Provider::Codex).unwrap();
        let next = sessions.new_chat(&root).unwrap();
        assert_ne!(next, first);
        assert_eq!(provider(&next).unwrap(), None);
        assert_eq!(provider(&first).unwrap(), Some(Provider::Codex));
    }

    #[test]
    fn threads_list_the_workspaces_conversations_newest_first() {
        let t = Temp::new();
        // Canonical, as commands get it from `workspace::root`.
        let root = t.deck("talks").canonicalize().unwrap();
        let nested = root.join("q3");
        fs::create_dir_all(&nested).unwrap();
        let sessions = t.sessions();
        let empty = sessions.start(&nested).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let talk = sessions.start(&root).unwrap();
        let long = "x".repeat(150);
        save_chat(
            &talk,
            &json!([
                {"role": "assistant", "text": "hello"},
                {"role": "user", "text": long, "createdAt": 1234},
                {"role": "user", "text": "later"}
            ]),
        )
        .unwrap();
        let json = serde_json::to_value(sessions.threads(&root).unwrap()).unwrap();
        assert_eq!(
            json,
            json!([
                {
                    "id": talk.file_name().unwrap().to_string_lossy(),
                    "title": "x".repeat(100),
                    "createdAt": 1234,
                    "current": true,
                    "messageCount": 3,
                    "association": ".",
                },
                {
                    "id": empty.file_name().unwrap().to_string_lossy(),
                    "title": "New conversation",
                    "createdAt": null,
                    "current": false,
                    "messageCount": 0,
                    "association": "q3",
                },
            ])
        );
    }

    #[test]
    fn opening_a_thread_selects_it_and_gives_its_chat_and_provider() {
        let t = Temp::new();
        let root = t.deck("talk");
        let sessions = t.sessions();
        let old = sessions.start(&root).unwrap();
        save_chat(&old, &json!([{"role": "assistant", "provider": "codex"}])).unwrap();
        let new = sessions.start(&root).unwrap();
        let id = old.file_name().unwrap().to_str().unwrap();
        let opened = serde_json::to_value(sessions.open_thread(&root, id).unwrap()).unwrap();
        assert_eq!(
            opened,
            json!({"chat": [{"role": "assistant", "provider": "codex"}], "provider": "codex"})
        );
        assert_eq!(sessions.current(&root), Some(old.clone()));

        // A damaged conversation leaves the current one as it is.
        let new_id = new.file_name().unwrap().to_str().unwrap();
        sessions.open_thread(&root, new_id).unwrap();
        fs::write(old.join("provider.json"), "{damaged").unwrap();
        assert!(sessions.open_thread(&root, id).is_err());
        assert_eq!(sessions.current(&root), Some(new));
        assert!(sessions.open_thread(&root, "../escape").is_err());
    }

    #[test]
    fn provider_is_locked_until_a_new_session_starts() {
        let t = Temp::new();
        let deck = t.deck("a");
        let session = t.sessions().start(&deck).unwrap();
        assert_eq!(provider(&session).unwrap(), None);
        claim_provider(&session, Provider::Codex).unwrap();
        claim_provider(&session, Provider::Codex).unwrap();
        assert!(claim_provider(&session, Provider::Claude).is_err());
        assert_eq!(provider(&session).unwrap(), Some(Provider::Codex));
        let next = t.sessions().start(&deck).unwrap();
        claim_provider(&next, Provider::Claude).unwrap();
    }

    #[test]
    fn legacy_chats_use_the_last_reply_provider_or_claude() {
        let t = Temp::new();
        let session = t.sessions().start(&t.deck("a")).unwrap();
        save_chat(
            &session,
            &json!([
                {"role": "assistant", "provider": "claude"},
                {"role": "assistant", "provider": "copilot"}
            ]),
        )
        .unwrap();
        assert_eq!(provider(&session).unwrap(), Some(Provider::Copilot));
        assert!(claim_provider(&session, Provider::Codex).is_err());
        save_chat(&session, &json!([{"role": "assistant"}])).unwrap();
        assert_eq!(provider(&session).unwrap(), Some(Provider::Claude));
    }

    #[test]
    fn provider_can_be_restored_from_a_legacy_session_id() {
        let t = Temp::new();
        let session = t.sessions().start(&t.deck("a")).unwrap();
        write_session(&session, Provider::Codex.session_file(), Some("thread")).unwrap();
        assert_eq!(provider(&session).unwrap(), Some(Provider::Codex));
        assert!(claim_provider(&session, Provider::Claude).is_err());
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
    fn root_history_includes_nested_folders_and_legacy_decks_only() {
        let t = Temp::new();
        let root = t.deck("talks");
        let nested = root.join("quarterly");
        fs::create_dir_all(&nested).unwrap();
        let sessions = t.sessions();
        let folder_chat = sessions.start(&nested).unwrap();
        let deck_chat = sessions.start(&nested).unwrap();
        let deck = nested.join("pitch.html");
        fs::write(&deck, "<html></html>").unwrap();
        fs::write(deck_chat.join(META_FILE), json!({"deck": deck}).to_string()).unwrap();
        let outside = sessions.start(&t.deck("talks-other")).unwrap();
        let listed = sessions.list_scoped(&root);
        assert!(listed.contains(&folder_chat));
        assert!(listed.contains(&deck_chat));
        assert!(!listed.contains(&outside));
        assert_eq!(
            sessions.current(&root),
            None,
            "do not silently adopt a nested chat"
        );
        let folder_current = sessions.current(&nested);
        sessions
            .select(&root, deck_chat.file_name().unwrap().to_str().unwrap())
            .unwrap();
        assert_eq!(t.sessions().current(&root), Some(deck_chat.clone()));
        assert_eq!(
            sessions.current(&nested),
            folder_current,
            "parent selection is independent"
        );
        assert!(sessions
            .select(&root, outside.file_name().unwrap().to_str().unwrap())
            .is_err());
        let fresh = sessions.start(&root).unwrap();
        assert_eq!(sessions.current(&root), Some(fresh));
        assert!(sessions.list_scoped(&root).contains(&deck_chat));
    }

    #[test]
    fn selected_threads_survive_reopening_and_cannot_cross_workspaces() {
        let t = Temp::new();
        let workspace = t.deck("talk");
        let sessions = t.sessions();
        let first = sessions.start(&workspace).unwrap();
        let second = sessions.start(&workspace).unwrap();
        let id = first.file_name().unwrap().to_str().unwrap();
        sessions.select(&workspace, id).unwrap();
        assert_eq!(t.sessions().current(&workspace), Some(first.clone()));
        assert!(sessions.select(&t.deck("other"), id).is_err());
        assert!(sessions.select(&workspace, "../escape").is_err());
        assert!(second.is_dir());
        let third = sessions.start(&workspace).unwrap();
        assert_eq!(sessions.current(&workspace), Some(third));
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
