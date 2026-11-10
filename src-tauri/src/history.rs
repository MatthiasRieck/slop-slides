//! The undo history of each deck file, shared by everything that changes it: edits on the
//! stage, the slide rail, review marks, narration, the code view, agent turns, and changes made
//! outside the app. It is one line of whole-file versions with a cursor at the deck's current
//! one; undo and redo move the cursor and write that version back over the deck. A new change
//! after an undo drops the versions that could have been redone.
//!
//! It is kept per deck file rather than per chat (sessions are chats), outside the workspace:
//!
//! ```text
//! ~/.slopslides/history/<key of the deck's path>/
//!   journal.json   {"path", "cursor", "entries": [{id, hash, source, label, time, …}]}
//!   <hash>.html    each version of the deck, once
//! ```
//!
//! Only the deck's HTML is kept, not its assets. Changes made outside the app are noticed
//! lazily, when the history is next looked at ([`checkpoint`]), as one "Outside change".

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};

const HISTORY_DIR: &str = "history";
const JOURNAL_FILE: &str = "journal.json";
/// Versions kept per deck; older ones are dropped, along with their files.
const ENTRIES_KEPT: usize = 100;
/// Grouped changes (typing notes, drawing review marks) this close together are one entry.
const COALESCE_MS: u64 = 3_000;

/// One process-wide lock: a change, its checkpoint and its record must not interleave with
/// another history operation, or an app write would be recorded as an outside change.
static LOCK: Mutex<()> = Mutex::new(());

/// What made a change, for its label in the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    /// The deck as it was when the history started.
    Open,
    /// A change made outside the app (another editor, git, a sync tool).
    External,
    /// Edit mode on the stage, and find and replace.
    Edit,
    /// The slide rail: adding, moving, hiding, deleting slides and sections.
    Rail,
    /// Review marks and comments.
    Review,
    Narration,
    Notes,
    /// Deck-wide settings: title, slide size, template, restoring from git.
    Deck,
    /// The code view.
    Code,
    /// An agent turn.
    Chat,
}

/// A change about to be made to a deck.
#[derive(Debug, Clone)]
pub struct Change {
    pub source: Source,
    pub label: String,
    /// Consecutive changes with the same group, close together, become one entry.
    pub group: Option<String>,
    /// The id of the chat message whose agent turn made the change.
    pub message: Option<String>,
}

impl Change {
    pub fn new(source: Source, label: impl Into<String>) -> Self {
        Self {
            source,
            label: label.into(),
            group: None,
            message: None,
        }
    }

    pub fn grouped(mut self, group: impl Into<String>) -> Self {
        self.group = Some(group.into());
        self
    }

    pub fn chat(label: &str, message: Option<String>) -> Self {
        let label = label.split_whitespace().collect::<Vec<_>>().join(" ");
        let short: String = label.chars().take(LABEL_CHARS).collect();
        let label = if short.len() < label.len() {
            format!("{}…", short.trim_end())
        } else {
            short
        };
        Self {
            message,
            ..Self::new(
                Source::Chat,
                if label.is_empty() {
                    "Chat".into()
                } else {
                    label
                },
            )
        }
    }
}

/// How much of a chat message labels its turn.
const LABEL_CHARS: usize = 60;

/// One version of the deck, with what made it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    /// SHA-256 of the deck file; its contents are stored as `<hash>.html`.
    pub hash: String,
    pub source: Source,
    pub label: String,
    /// Milliseconds since the Unix epoch.
    pub time: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Journal {
    path: String,
    cursor: usize,
    entries: Vec<Entry>,
}

/// What undo and redo would do now.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The change undo takes back.
    pub undo: Option<Entry>,
    /// The change redo makes again.
    pub redo: Option<Entry>,
    /// The id of the version the deck is at.
    pub current: Option<String>,
}

/// Where the history of `file` is kept.
fn dir(home: &Path, file: &Path) -> PathBuf {
    let path = file.canonicalize().unwrap_or_else(|_| file.into());
    let key = hex(&Sha256::digest(path.to_string_lossy().as_bytes()));
    home.join(HISTORY_DIR).join(&key[..20])
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// The history of one deck file, loaded.
struct History {
    dir: PathBuf,
    file: PathBuf,
    journal: Journal,
}

impl History {
    fn load(home: &Path, file: &Path) -> Result<Self> {
        let dir = dir(home, file);
        let journal = match fs::read(dir.join(JOURNAL_FILE)) {
            Ok(raw) => serde_json::from_slice(&raw).unwrap_or_default(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Journal::default(),
            Err(e) => return Err(e.into()),
        };
        let mut journal: Journal = journal;
        journal.path = file.to_string_lossy().into_owned();
        journal.cursor = journal.cursor.min(journal.entries.len().saturating_sub(1));
        Ok(Self {
            dir,
            file: file.into(),
            journal,
        })
    }

    fn save(&mut self) -> Result<()> {
        self.prune()?;
        fs::create_dir_all(&self.dir)?;
        let json =
            serde_json::to_vec_pretty(&self.journal).map_err(|e| Error::msg(e.to_string()))?;
        crate::files::atomic_write(&self.dir.join(JOURNAL_FILE), &json)
    }

    fn head(&self) -> Option<&Entry> {
        self.journal.entries.get(self.journal.cursor)
    }

    /// The deck file's contents and hash; None when it is gone.
    fn read(&self) -> Result<Option<(Vec<u8>, String)>> {
        match fs::read(&self.file) {
            Ok(bytes) => {
                let hash = hex(&Sha256::digest(&bytes));
                Ok(Some((bytes, hash)))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn blob(&self, hash: &str) -> PathBuf {
        self.dir.join(format!("{hash}.html"))
    }

    /// Adds the deck as it is now, made by `change`. Nothing when it did not change.
    fn record(&mut self, change: &Change) -> Result<bool> {
        let Some((bytes, hash)) = self.read()? else {
            return Ok(false);
        };
        if self.head().is_some_and(|head| head.hash == hash) {
            return Ok(false);
        }
        fs::create_dir_all(&self.dir)?;
        let blob = self.blob(&hash);
        if !blob.exists() {
            crate::files::atomic_write(&blob, &bytes)?;
        }
        let time = now();
        let last = self.journal.entries.len().saturating_sub(1);
        let cursor = self.journal.cursor;
        if let Some(head) = self.journal.entries.get_mut(cursor) {
            let joins = cursor > 0
                && cursor == last
                && change.group.is_some()
                && head.group == change.group
                && head.source == change.source
                && time.saturating_sub(head.time) <= COALESCE_MS;
            if joins {
                head.hash = hash;
                head.time = time;
                return Ok(true);
            }
        }
        self.journal.entries.truncate(cursor + 1);
        self.journal.entries.push(Entry {
            id: uuid::Uuid::new_v4().simple().to_string(),
            hash,
            source: change.source,
            label: change.label.clone(),
            time,
            group: change.group.clone(),
            message: change.message.clone(),
        });
        self.journal.cursor = self.journal.entries.len() - 1;
        Ok(true)
    }

    /// Starts the history with the deck as it is, or adds an outside change to it when the deck
    /// is no longer the version the history is at.
    fn checkpoint(&mut self) -> Result<bool> {
        let change = if self.journal.entries.is_empty() {
            Change::new(Source::Open, "Opened")
        } else {
            Change::new(Source::External, "Outside change")
        };
        self.record(&change)
    }

    /// Writes version `index` over the deck and moves the cursor there.
    fn go_to(&mut self, index: usize) -> Result<()> {
        let hash = self.journal.entries[index].hash.clone();
        let bytes = fs::read(self.blob(&hash))
            .map_err(|_| Error::msg("That version of the deck is no longer available."))?;
        crate::files::atomic_write(&self.file, &bytes)?;
        self.journal.cursor = index;
        Ok(())
    }

    fn status(&self) -> Status {
        let cursor = self.journal.cursor;
        let entries = &self.journal.entries;
        Status {
            undo: (cursor > 0).then(|| entries[cursor].clone()),
            redo: entries.get(cursor + 1).cloned(),
            current: self.head().map(|e| e.id.clone()),
        }
    }

    /// Drops the oldest versions beyond [`ENTRIES_KEPT`] and the files no version uses.
    fn prune(&mut self) -> Result<()> {
        let excess = self.journal.entries.len().saturating_sub(ENTRIES_KEPT);
        if excess > 0 {
            self.journal.entries.drain(..excess);
            self.journal.cursor = self.journal.cursor.saturating_sub(excess);
        }
        let Ok(files) = fs::read_dir(&self.dir) else {
            return Ok(());
        };
        let used: std::collections::HashSet<_> = self
            .journal
            .entries
            .iter()
            .map(|e| format!("{}.html", e.hash))
            .collect();
        for file in files.filter_map(|f| f.ok()) {
            let name = file.file_name().to_string_lossy().into_owned();
            if name.ends_with(".html") && !used.contains(&name) {
                let _ = fs::remove_file(file.path());
            }
        }
        Ok(())
    }
}

/// Notices a change made to `file` outside the app since the history last saw it, starting the
/// history if it has none.
pub fn checkpoint(home: &Path, file: &Path) -> Result<()> {
    let _lock = lock();
    let mut history = History::load(home, file)?;
    if history.checkpoint()? {
        history.save()?;
    }
    Ok(())
}

/// Runs `f`, which changes `file`, and adds what it did to the history as `change`.
pub fn change<T>(
    home: &Path,
    file: &Path,
    change: Change,
    f: impl FnOnce() -> Result<T>,
) -> Result<T> {
    let _lock = lock();
    let mut history = History::load(home, file)?;
    history.checkpoint()?;
    let value = f();
    if value.is_ok() {
        history.record(&change)?;
    }
    // Saved even when `f` failed: the checkpoint may have recorded an outside change.
    history.save()?;
    value
}

/// Adds `file` as it is now to the history as `change`; its history starts here if it has none.
pub fn record(home: &Path, file: &Path, change: &Change) -> Result<()> {
    let _lock = lock();
    let mut history = History::load(home, file)?;
    if history.record(change)? {
        history.save()?;
    }
    Ok(())
}

/// What undo and redo would do. With `look`, an outside change is noticed first; leave it off
/// while the agent is working, or its unfinished edits would become an entry.
pub fn status(home: &Path, file: &Path, look: bool) -> Result<Status> {
    let _lock = lock();
    let mut history = History::load(home, file)?;
    if look && history.checkpoint()? {
        history.save()?;
    }
    Ok(history.status())
}

/// What [`undo`] or [`redo`] did.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    /// The change taken back or made again; None when there was none.
    pub entry: Option<Entry>,
    pub status: Status,
}

/// Puts the deck back as it was before its newest change.
pub fn undo(home: &Path, file: &Path) -> Result<Step> {
    step(home, file, |cursor, _| cursor.checked_sub(1), 0)
}

/// Makes the change undone last again.
pub fn redo(home: &Path, file: &Path) -> Result<Step> {
    step(
        home,
        file,
        |cursor, len| (cursor + 1 < len).then_some(cursor + 1),
        1,
    )
}

/// Moves the cursor where `target` says and reports the entry between the two versions (`at`
/// 0: the one left, 1: the one arrived at).
fn step(
    home: &Path,
    file: &Path,
    target: impl Fn(usize, usize) -> Option<usize>,
    at: usize,
) -> Result<Step> {
    let _lock = lock();
    let mut history = History::load(home, file)?;
    history.checkpoint()?;
    let from = history.journal.cursor;
    let entry = match target(from, history.journal.entries.len()) {
        Some(to) => {
            history.go_to(to)?;
            Some(history.journal.entries[if at == 0 { from } else { to }].clone())
        }
        None => None,
    };
    history.save()?;
    Ok(Step {
        entry,
        status: history.status(),
    })
}

/// The deck as it was at version `id`.
pub fn version(home: &Path, file: &Path, id: &str) -> Result<String> {
    let _lock = lock();
    let history = History::load(home, file)?;
    let entry = history
        .journal
        .entries
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| Error::msg("That version of the deck is no longer in its history."))?;
    Ok(String::from_utf8_lossy(&fs::read(history.blob(&entry.hash))?).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Deck {
        temp: PathBuf,
    }

    impl Deck {
        fn new(source: &str) -> Self {
            let temp =
                std::env::temp_dir().join(format!("slopslide-history-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(temp.join("work")).unwrap();
            let deck = Self { temp };
            deck.write(source);
            deck
        }
        fn home(&self) -> PathBuf {
            self.temp.join("home")
        }
        fn file(&self) -> PathBuf {
            self.temp.join("work/deck.html")
        }
        fn write(&self, source: &str) {
            fs::write(self.file(), source).unwrap();
        }
        fn read(&self) -> String {
            fs::read_to_string(self.file()).unwrap()
        }
        /// Changes the deck to `source` through the history.
        fn change(&self, change: Change, source: &str) {
            change_ok(&self.home(), &self.file(), change, || {
                self.write(source);
                Ok(())
            });
        }
        fn status(&self) -> Status {
            status(&self.home(), &self.file(), true).unwrap()
        }
        fn undo(&self) -> Option<Entry> {
            undo(&self.home(), &self.file()).unwrap().entry
        }
        fn redo(&self) -> Option<Entry> {
            redo(&self.home(), &self.file()).unwrap().entry
        }
        fn journal(&self) -> Journal {
            History::load(&self.home(), &self.file()).unwrap().journal
        }
    }

    fn change_ok(home: &Path, file: &Path, change: Change, f: impl FnOnce() -> Result<()>) {
        super::change(home, file, change, f).unwrap();
    }

    impl Drop for Deck {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.temp);
        }
    }

    fn edit(label: &str) -> Change {
        Change::new(Source::Edit, label)
    }

    #[test]
    fn undo_and_redo_step_through_changes() {
        let deck = Deck::new("v1");
        deck.change(edit("first"), "v2");
        deck.change(Change::new(Source::Rail, "second"), "v3");
        assert_eq!(deck.status().undo.unwrap().label, "second");
        assert!(deck.status().redo.is_none());

        assert_eq!(deck.undo().unwrap().label, "second");
        assert_eq!(deck.read(), "v2");
        assert_eq!(deck.undo().unwrap().label, "first");
        assert_eq!(deck.read(), "v1");
        assert!(deck.undo().is_none(), "nothing before the first version");
        assert_eq!(deck.read(), "v1");

        assert_eq!(deck.redo().unwrap().label, "first");
        assert_eq!(deck.read(), "v2");
        assert_eq!(deck.status().redo.unwrap().label, "second");
        assert_eq!(deck.redo().unwrap().label, "second");
        assert_eq!(deck.read(), "v3");
        assert!(deck.redo().is_none());
    }

    #[test]
    fn a_change_after_undo_drops_what_could_be_redone() {
        let deck = Deck::new("v1");
        deck.change(edit("first"), "v2");
        deck.change(edit("second"), "v3");
        deck.undo();
        deck.change(edit("other"), "v2b");
        let status = deck.status();
        assert!(status.redo.is_none());
        assert_eq!(status.undo.unwrap().label, "other");
        let hashes: Vec<_> = deck
            .journal()
            .entries
            .iter()
            .map(|e| e.label.clone())
            .collect();
        assert_eq!(hashes, ["Opened", "first", "other"]);
        let blobs = fs::read_dir(dir(&deck.home(), &deck.file()))
            .unwrap()
            .filter(|f| {
                f.as_ref()
                    .unwrap()
                    .path()
                    .extension()
                    .is_some_and(|e| e == "html")
            })
            .count();
        assert_eq!(blobs, 3, "the dropped version's file is gone");
    }

    #[test]
    fn outside_changes_become_their_own_entry() {
        let deck = Deck::new("v1");
        deck.change(edit("first"), "v2");
        deck.write("outside");
        let status = deck.status();
        assert_eq!(status.undo.as_ref().unwrap().source, Source::External);
        assert_eq!(deck.undo().unwrap().source, Source::External);
        assert_eq!(deck.read(), "v2");
        // An outside change after an undo means nothing can be redone.
        deck.write("again");
        assert!(deck.redo().is_none());
        assert_eq!(deck.read(), "again");
    }

    #[test]
    fn status_without_looking_ignores_unseen_changes() {
        let deck = Deck::new("v1");
        deck.change(edit("first"), "v2");
        deck.write("mid-turn");
        let status = status(&deck.home(), &deck.file(), false).unwrap();
        assert_eq!(status.undo.unwrap().label, "first");
        assert_eq!(deck.journal().entries.len(), 2);
    }

    #[test]
    fn writes_that_change_nothing_add_no_entry() {
        let deck = Deck::new("v1");
        deck.change(edit("noop"), "v1");
        assert!(deck.status().undo.is_none());
        // Undoing writes the deck back; looking again sees no outside change.
        deck.change(edit("first"), "v2");
        deck.undo();
        assert!(deck.status().redo.is_some());
    }

    #[test]
    fn failed_changes_are_not_recorded() {
        let deck = Deck::new("v1");
        let failed = change(&deck.home(), &deck.file(), edit("fails"), || {
            deck.write("half");
            Err::<(), _>(Error::msg("no"))
        });
        assert!(failed.is_err());
        assert_eq!(deck.journal().entries.len(), 1);
    }

    #[test]
    fn grouped_changes_close_together_are_one_entry() {
        let deck = Deck::new("v1");
        let notes = || Change::new(Source::Notes, "Notes").grouped("notes:a");
        deck.change(notes(), "n1");
        deck.change(notes(), "n2");
        deck.change(notes(), "n3");
        assert_eq!(deck.journal().entries.len(), 2);
        assert_eq!(deck.undo().unwrap().label, "Notes");
        assert_eq!(deck.read(), "v1");

        // Another group, or the same one once it went stale, starts a new entry.
        deck.redo();
        deck.change(Change::new(Source::Notes, "Notes").grouped("notes:b"), "n4");
        let mut history = History::load(&deck.home(), &deck.file()).unwrap();
        history.journal.entries.last_mut().unwrap().time -= COALESCE_MS + 1;
        history.save().unwrap();
        deck.change(Change::new(Source::Notes, "Notes").grouped("notes:b"), "n5");
        assert_eq!(deck.journal().entries.len(), 4);
    }

    #[test]
    fn grouped_changes_do_not_join_after_an_undo() {
        let deck = Deck::new("v1");
        let notes = || Change::new(Source::Notes, "Notes").grouped("notes:a");
        deck.change(notes(), "n1");
        deck.change(edit("edit"), "e1");
        deck.undo();
        deck.change(notes(), "n2");
        let labels: Vec<_> = deck
            .journal()
            .entries
            .iter()
            .map(|e| e.label.clone())
            .collect();
        assert_eq!(labels, ["Opened", "Notes", "Notes"]);
    }

    #[test]
    fn keeps_only_the_newest_versions() {
        let deck = Deck::new("v0");
        for n in 1..=ENTRIES_KEPT + 5 {
            deck.change(edit(&format!("e{n}")), &format!("v{n}"));
        }
        let journal = deck.journal();
        assert_eq!(journal.entries.len(), ENTRIES_KEPT);
        assert_eq!(journal.cursor, ENTRIES_KEPT - 1);
        assert_eq!(journal.entries[0].label, "e6");
        let blobs = fs::read_dir(dir(&deck.home(), &deck.file()))
            .unwrap()
            .filter(|f| {
                f.as_ref()
                    .unwrap()
                    .path()
                    .extension()
                    .is_some_and(|e| e == "html")
            })
            .count();
        assert_eq!(blobs, ENTRIES_KEPT);
    }

    #[test]
    fn chat_changes_carry_their_message_and_a_short_label() {
        let deck = Deck::new("v1");
        let long = "Make   the title\nbigger ".repeat(10);
        deck.change(Change::chat(&long, Some("m1".into())), "v2");
        let entry = deck.status().undo.unwrap();
        assert_eq!(entry.source, Source::Chat);
        assert_eq!(entry.message.as_deref(), Some("m1"));
        assert!(entry.label.starts_with("Make the title bigger Make"));
        assert!(entry.label.ends_with('…'));
        assert!(entry.label.chars().count() <= LABEL_CHARS + 1);
        assert_eq!(Change::chat("  ", None).label, "Chat");
    }

    #[test]
    fn versions_can_be_read_back() {
        let deck = Deck::new("v1");
        deck.change(edit("first"), "v2");
        let first = deck.journal().entries[0].id.clone();
        assert_eq!(version(&deck.home(), &deck.file(), &first).unwrap(), "v1");
        assert!(version(&deck.home(), &deck.file(), "gone").is_err());
    }

    #[test]
    fn decks_have_separate_histories_outside_the_workspace() {
        let deck = Deck::new("v1");
        let other = deck.temp.join("work/other.html");
        fs::write(&other, "o1").unwrap();
        deck.change(edit("deck"), "v2");
        record(&deck.home(), &other, &Change::new(Source::Edit, "other")).unwrap();
        assert!(status(&deck.home(), &other, true).unwrap().undo.is_none());
        assert_eq!(deck.status().undo.unwrap().label, "deck");
        assert!(dir(&deck.home(), &deck.file()).starts_with(deck.home().join(HISTORY_DIR)));
        assert!(!deck.temp.join("work").read_dir().unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with('.')));
    }

    #[test]
    fn a_missing_deck_records_nothing() {
        let deck = Deck::new("v1");
        fs::remove_file(deck.file()).unwrap();
        checkpoint(&deck.home(), &deck.file()).unwrap();
        assert!(deck.journal().entries.is_empty());
    }

    #[test]
    fn a_lost_version_file_refuses_undo_and_keeps_the_deck() {
        let deck = Deck::new("v1");
        deck.change(edit("first"), "v2");
        let first = deck.journal().entries[0].hash.clone();
        fs::remove_file(dir(&deck.home(), &deck.file()).join(format!("{first}.html"))).unwrap();
        assert!(undo(&deck.home(), &deck.file()).is_err());
        assert_eq!(deck.read(), "v2");
    }

    #[test]
    fn sources_serialize_in_camel_case() {
        assert_eq!(serde_json::to_value(Source::External).unwrap(), "external");
        assert_eq!(serde_json::to_value(Source::Chat).unwrap(), "chat");
    }
}
