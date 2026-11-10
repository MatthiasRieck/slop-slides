//! The locked-slide guard of an agent turn. Before a turn, the deck's locked slides are recorded
//! in the session ([`LOCKS_FILE`]); while it runs, the lint tool tells the agent about any it
//! changed, and when it ends, [`release_guard`] puts them back. In a workspace session the
//! file holds the guards of every deck, keyed by the deck's path in the workspace.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use crate::deck::{folder, read_html, write_html};
use crate::error::{Error, Result};
use crate::files::atomic_write;
use crate::html::{self, LockedSlide};
use crate::sessions;

/// The locked slides as they were when the agent's turn started (see [`guard_locked`]).
const LOCKS_FILE: &str = "locked.json";
/// What stands in for a deck file the agent removed, to put its locked slides back into.
const EMPTY_DECK: &str = "<html><body><main class=\"deck\"></main></body></html>";

/// A workspace session's guards, by [`guard_key`].
type Guards = BTreeMap<String, Vec<LockedSlide>>;

/// The deck's path in the workspace `root`, with `/` separators; the same for a deck the agent
/// deleted.
fn guard_key(file: &Path, root: &Path) -> Result<String> {
    // Canonicalize the parent, so a deleted deck still has its original key.
    let mut parent = folder(file);
    let mut missing = Vec::new();
    while !parent.exists() {
        missing.push(
            parent
                .file_name()
                .ok_or_else(|| Error::msg("missing parent"))?
                .to_os_string(),
        );
        parent = parent
            .parent()
            .ok_or_else(|| Error::msg("missing parent"))?;
    }
    let mut parent = parent.canonicalize()?;
    for part in missing.iter().rev() {
        parent.push(part);
    }
    let root = root.canonicalize()?;
    let path = parent.join(
        file.file_name()
            .ok_or_else(|| Error::msg("missing file name"))?,
    );
    Ok(path
        .strip_prefix(root)
        .map_err(|_| Error::msg("deck outside workspace"))?
        .to_string_lossy()
        .replace('\\', "/"))
}

/// The locked slides an agent turn must leave alone; empty when no turn is guarded.
pub fn read_guard(file: &Path, session: Option<&Path>) -> Vec<LockedSlide> {
    let Some(session) = session else {
        return Vec::new();
    };
    let raw = fs::read_to_string(session.join(LOCKS_FILE)).unwrap_or_default();
    if let Some(root) = sessions::workspace_of(session) {
        let entries: Guards = serde_json::from_str(&raw).unwrap_or_default();
        guard_key(file, &root)
            .ok()
            .and_then(|key| entries.get(&key).cloned())
            .unwrap_or_default()
    } else {
        serde_json::from_str(&raw).unwrap_or_default()
    }
}

fn write_guard(file: &Path, session: &Path, locked: &[LockedSlide]) -> Result<()> {
    fs::create_dir_all(session)?;
    let value = if let Some(root) = sessions::workspace_of(session) {
        let mut entries: Guards = fs::read_to_string(session.join(LOCKS_FILE))
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        entries.insert(guard_key(file, &root)?, locked.to_vec());
        serde_json::to_string(&entries).expect("json")
    } else {
        serde_json::to_string(locked).expect("json")
    };
    atomic_write(&session.join(LOCKS_FILE), value.as_bytes())
}

/// Records the locked slides before an agent turn, so [`release_guard`] can put back any the
/// agent changes and the lint tool can tell it about them.
pub fn guard_locked(file: &Path, session: &Path) -> Result<()> {
    write_guard(file, session, &html::locked_slides(&read_html(file)?))
}

/// Keeps a running turn's guard in step with what the user did to `slide`: locking,
/// unlocking or hiding it mid-turn is theirs to do, and must not be undone after the turn.
pub(crate) fn refresh_guard(file: &Path, session: Option<&Path>, slide: &str) -> Result<()> {
    let Some(session) = session.filter(|s| s.join(LOCKS_FILE).is_file()) else {
        return Ok(());
    };
    let mut guard = read_guard(file, Some(session));
    let now = html::locked_slides(&read_html(file)?);
    guard.retain(|l| l.id != slide);
    guard.extend(now.into_iter().filter(|l| l.id == slide));
    write_guard(file, session, &guard)
}

/// Drops the session's guard, left behind when no turn is running (say, the app quit
/// mid-turn).
pub(crate) fn drop_stale(session: &Path) {
    let _ = fs::remove_file(session.join(LOCKS_FILE));
}

/// Ends an agent turn's guard: puts back every locked slide the agent changed or removed.
/// Returns their ids.
pub fn release_guard(file: &Path, session: &Path) -> Result<Vec<String>> {
    let guard = read_guard(file, Some(session));
    if sessions::workspace_of(session).is_none() {
        drop_stale(session);
    }
    if guard.is_empty() {
        return Ok(Vec::new());
    }
    let source = if file.exists() {
        String::from_utf8_lossy(&fs::read(file)?).into_owned()
    } else {
        String::from(EMPTY_DECK)
    };
    let (mut restored, mut ids) = html::restore_locked(&source, &guard);
    if !html::changed_locked(&restored, &guard).is_empty() {
        // A removed or broken slide container cannot host the missing locked slides.
        // Rebuild their container; the deck's history keeps the complete pre-turn deck.
        (restored, ids) = html::restore_locked(EMPTY_DECK, &guard);
    }
    if !ids.is_empty() {
        fs::create_dir_all(folder(file))?;
        write_html(file, &restored)?;
    }
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deck::{self, DECK_FILE};
    use crate::test_support::TempDir;
    use std::path::PathBuf;

    const LOCKED: &str = "<html><head><title>Talk</title></head><body><main>\n<section class=\"slide\" id=\"a\" data-locked>A</section>\n<section class=\"slide\" id=\"b\">B</section>\n</main></body></html>";

    /// A throwaway folder with a deck.html and a session folder (outside any workspace).
    struct TempDeck(TempDir);

    impl TempDeck {
        fn new(html: &str) -> Self {
            let dir = TempDir::new("guard");
            fs::create_dir_all(dir.join("deck")).unwrap();
            fs::write(dir.join("deck").join(DECK_FILE), html).unwrap();
            TempDeck(dir)
        }
        fn file(&self) -> PathBuf {
            self.0.join("deck").join(DECK_FILE)
        }
        fn html(&self) -> String {
            fs::read_to_string(self.file()).unwrap()
        }
        fn session(&self) -> PathBuf {
            self.0.join("session")
        }
    }

    fn ids(slides: &[&str]) -> Vec<String> {
        slides.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_guarded_turn_puts_back_the_locked_slides() {
        let deck = TempDeck::new(LOCKED);
        guard_locked(&deck.file(), &deck.session()).unwrap();
        assert_eq!(read_guard(&deck.file(), Some(&deck.session())).len(), 1);
        // The agent rewrites everything, dropping the locked slide.
        let agent = "<html><head><title>Talk</title></head><body><main>\n<section class=\"slide\" id=\"b\">New B</section>\n</main></body></html>";
        fs::write(deck.file(), agent).unwrap();
        let issues = deck::lint(&deck.file(), Some(&deck.session())).unwrap();
        assert!(
            issues.iter().any(|i| i.rule == "locked-slide-changed"),
            "{issues:?}"
        );

        assert_eq!(release_guard(&deck.file(), &deck.session()).unwrap(), ["a"]);
        assert_eq!(
            deck.html(),
            "<html><head><title>Talk</title></head><body><main>\n<section class=\"slide\" id=\"a\" data-locked>A</section>\n<section class=\"slide\" id=\"b\">New B</section>\n</main></body></html>"
        );
        assert!(
            read_guard(&deck.file(), Some(&deck.session())).is_empty(),
            "the guard ends with the turn"
        );
        assert!(!deck::lint(&deck.file(), Some(&deck.session()))
            .unwrap()
            .iter()
            .any(|i| i.rule == "locked-slide-changed"));
        assert!(release_guard(&deck.file(), &deck.session())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn locking_mid_turn_updates_the_guard() {
        let deck = TempDeck::new(LOCKED);
        let session = Some(deck.session());
        guard_locked(&deck.file(), &deck.session()).unwrap();
        // The user unlocks `a`, locks `b` and hides it while the agent works.
        deck::set_slide_locked(&deck.file(), session.as_deref(), "a", false).unwrap();
        deck::set_slide_locked(&deck.file(), session.as_deref(), "b", true).unwrap();
        deck::set_slides_hidden(&deck.file(), session.as_deref(), &ids(&["b"]), true).unwrap();
        let guarded: Vec<_> = read_guard(&deck.file(), session.as_deref())
            .into_iter()
            .map(|l| l.id)
            .collect();
        assert_eq!(guarded, ["b"]);
        let mine = deck.html();
        let agent = mine.replace(">A<", ">Agent A<");
        fs::write(deck.file(), &agent).unwrap();
        assert!(release_guard(&deck.file(), &deck.session())
            .unwrap()
            .is_empty());
        assert_eq!(
            deck.html(),
            agent,
            "unlocked `a` keeps the agent's edit, `b` stays hidden"
        );
    }

    #[test]
    fn hiding_many_slides_keeps_a_running_turns_guard_in_step() {
        let deck = TempDeck::new(
            "<html><head><title>Three</title></head><body><main class=\"deck\">\n  <section class=\"slide\" id=\"a\">A</section>\n  <section class=\"slide\" id=\"b\">B</section>\n  <section class=\"slide\" id=\"c\">C</section>\n</main></body></html>",
        );
        deck::set_slide_locked(&deck.file(), None, "a", true).unwrap();
        deck::set_slide_locked(&deck.file(), None, "c", true).unwrap();
        guard_locked(&deck.file(), &deck.session()).unwrap();
        deck::set_slides_hidden(&deck.file(), Some(&deck.session()), &ids(&["a", "c"]), true)
            .unwrap();
        assert_eq!(
            release_guard(&deck.file(), &deck.session()).unwrap(),
            Vec::<String>::new()
        );
        assert!(deck::load(&deck.file()).unwrap().slides[2].hidden);
    }
}
