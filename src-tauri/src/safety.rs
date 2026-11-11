//! Turn-wide protection. Capture all decks, and checkpoint their histories, before granting the
//! agent a turn; capturing eagerly avoids watcher races (atomic replacements, deletes, and rapid
//! rewrites). Each deck the turn changed gets one history entry when it ends.
//! The turn of a deck's chat answers for that deck alone: the chats of other decks in the folder
//! may be at work beside it, and what one changes must not be taken for the other's.
//! Limits fail closed: a partially scanned workspace is never handed to the agent.
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::history::{self, Change};
use crate::{deck, workspace};

const MAX_ENTRIES: usize = 10_000;
const MAX_BYTES: u64 = 64 * 1024 * 1024;

pub struct Guard {
    root: PathBuf,
    session: PathBuf,
    /// The app's folder, which keeps the decks' histories.
    home: PathBuf,
    before: BTreeMap<PathBuf, Vec<u8>>,
    /// The turn is for one deck: the decks it adds are left alone.
    one_deck: bool,
}

/// The deck `file` alone, as [`decks`] would have it; nothing while it is no deck.
fn deck(file: &Path) -> Result<BTreeMap<PathBuf, Vec<u8>>> {
    let mut found = BTreeMap::new();
    if fs::metadata(file)?.len() > MAX_BYTES {
        return Err(Error::msg("Deck exceeds the safety size limit."));
    }
    let source = fs::read(file)?;
    if workspace::classify(&String::from_utf8_lossy(&source)) == workspace::FileKind::Deck {
        found.insert(file.to_path_buf(), source);
    }
    Ok(found)
}

fn decks(root: &Path) -> Result<BTreeMap<PathBuf, Vec<u8>>> {
    scan(root, MAX_ENTRIES, MAX_BYTES)
}

fn scan(root: &Path, max_entries: usize, max_bytes: u64) -> Result<BTreeMap<PathBuf, Vec<u8>>> {
    let mut todo = vec![root.to_path_buf()];
    let mut seen = std::collections::HashSet::new();
    let mut found = BTreeMap::new();
    let (mut count, mut bytes) = (0, 0);
    while let Some(dir) = todo.pop() {
        if !seen.insert(dir.canonicalize()?) {
            continue;
        }
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') || name.contains(".tmp-") {
                continue;
            }
            count += 1;
            if count > max_entries {
                return Err(Error::msg("Workspace safety scan exceeds the file limit."));
            }
            let path = entry.path();
            if !workspace::inside(root, &path) {
                continue;
            }
            if path.is_dir() {
                todo.push(path);
                continue;
            }
            if !deck::is_html(&path) {
                continue;
            }
            bytes += fs::metadata(&path)?.len();
            if bytes > max_bytes {
                return Err(Error::msg(
                    "Workspace safety scan exceeds the HTML size limit.",
                ));
            }
            // Also bound actual reads if a file grows between stat and read.
            use std::io::Read;
            let mut source = Vec::new();
            fs::File::open(&path)?
                .take(max_bytes + 1)
                .read_to_end(&mut source)?;
            if source.len() as u64 > max_bytes {
                return Err(Error::msg("Deck exceeds the safety size limit."));
            }
            if workspace::classify(&String::from_utf8_lossy(&source)) == workspace::FileKind::Deck {
                found.insert(path, source);
            }
        }
    }
    Ok(found)
}

impl Guard {
    /// Guards the decks in `root`, or the deck `only` for the turn of that deck's chat.
    pub fn start(root: &Path, only: Option<&Path>, session: &Path, home: &Path) -> Result<Self> {
        let before = match only {
            Some(file) => deck(file)?,
            None => decks(root)?,
        };
        // Discard a stale guard from an interrupted app instance, once the full scan succeeds.
        fs::create_dir_all(session)?;
        fs::write(session.join("locked.json"), "{}")?;
        for file in before.keys() {
            history::checkpoint(home, file)?;
            crate::guard::guard_locked(file, session)?;
        }
        Ok(Self {
            root: root.into(),
            session: session.into(),
            home: home.into(),
            before,
            one_deck: only.is_some(),
        })
    }

    /// Ends the turn: puts back locked slides, normalizes the decks it touched, and adds what it
    /// did to each deck's history as `change`.
    pub fn finish(self, change: &Change) -> Result<Vec<(String, Vec<String>)>> {
        let mut restored = Vec::new();
        let mut errors = Vec::new();
        // Restore every pre-existing deck, even if one cannot be restored or has been deleted.
        for (file, original) in &self.before {
            if file.exists() && !workspace::inside(&self.root, file) {
                errors.push(format!("{} moved outside the workspace", file.display()));
                continue;
            }
            let changed = fs::read(file).map_or(true, |now| now != *original);
            match crate::guard::release_guard(file, &self.session) {
                Ok(ids) if !ids.is_empty() => restored.push((
                    file.strip_prefix(&self.root)
                        .unwrap_or(file)
                        .components()
                        .map(|part| part.as_os_str().to_string_lossy().into_owned())
                        .collect::<Vec<_>>()
                        .join("/"),
                    ids,
                )),
                Ok(_) => {}
                Err(e) => errors.push(format!("{}: {e}", file.display())),
            }
            // Existing decks remain decks even when an agent removes all their format markers.
            if changed && file.exists() {
                if let Err(e) = deck::normalize(file) {
                    errors.push(format!("{}: {e}", file.display()));
                }
                if let Err(e) = history::record(&self.home, file, change) {
                    errors.push(format!("{}: {e}", file.display()));
                }
            }
        }
        // New decks have no lock guard but still need ids and the runtime. Beside other chats
        // there is no telling whose they are: they get both when they are opened.
        let now = if self.one_deck {
            Ok(BTreeMap::new())
        } else {
            decks(&self.root)
        };
        match now {
            Ok(now) => {
                for file in now.keys().filter(|f| !self.before.contains_key(*f)) {
                    // A new deck's history starts with the version the agent wrote.
                    let normalized = deck::normalize(file)
                        .and_then(|()| history::record(&self.home, file, change));
                    if let Err(e) = normalized {
                        errors.push(format!("{}: {e}", file.display()));
                    }
                }
            }
            Err(e) => errors.push(e.to_string()),
        }
        if errors.is_empty() {
            let _ = fs::remove_file(self.session.join("locked.json"));
            Ok(restored)
        } else {
            // Keep the guard available for recovery if a write failed.
            Err(Error::msg(errors.join("\n")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::Sessions;
    use crate::test_support::TempDir;

    fn turn() -> Change {
        Change::chat("Tidy the slides", Some("m1".into()))
    }

    #[test]
    fn protects_other_decks_snapshots_per_file_and_normalizes_new_decks() {
        let temp = TempDir::new("guard");
        let root = temp.join("work");
        fs::create_dir_all(root.join("talks").join("quarterly")).unwrap();
        let a = root.join("deck.html");
        let b = root.join("talks").join("quarterly").join("q3.html");
        let source = "<html><body><main class=\"deck\"><section class=\"slide\" id=\"a\" data-locked>A</section><section class=\"slide\" id=\"b\">B</section></main></body></html>";
        fs::write(&a, source).unwrap();
        fs::write(&b, source).unwrap();
        let session = Sessions::new(&temp.join("home")).start(&root).unwrap();
        let guard = Guard::start(&root, None, &session, &temp.join("home")).unwrap();
        fs::write(
            &b,
            source.replace(">A<", ">changed<").replace(" id=\"b\"", ""),
        )
        .unwrap();
        assert!(deck::lint(&b, Some(&session))
            .unwrap()
            .iter()
            .any(|i| i.rule == "locked-slide-changed"));
        let new = root.join("new.html");
        fs::write(
            &new,
            "<main class=\"deck\"><section class=\"slide\">New</section></main>",
        )
        .unwrap();
        assert_eq!(
            guard.finish(&turn()).unwrap(),
            [("talks/quarterly/q3.html".into(), vec!["a".into()])]
        );
        let out = fs::read_to_string(&b).unwrap();
        assert!(out.contains(">A</section>"));
        assert!(out.contains("slopslide:runtime-js"));
        assert!(!deck::load(&b).unwrap().slides[1].id.is_empty());
        assert!(fs::read_to_string(&new)
            .unwrap()
            .contains("slopslide:runtime-js"));
        // One entry for the turn in the history of each deck it changed; none for the other.
        let home = temp.join("home");
        let undo = history::status(&home, &b, false).unwrap().undo.unwrap();
        assert_eq!(
            (undo.source, undo.label.as_str()),
            (history::Source::Chat, "Tidy the slides")
        );
        assert_eq!(undo.message.as_deref(), Some("m1"));
        assert!(history::status(&home, &a, false).unwrap().undo.is_none());
        history::undo(&home, &b).unwrap();
        assert_eq!(fs::read_to_string(&b).unwrap(), source);
        // A new deck's history starts with the agent's version.
        let created = history::status(&home, &new, false).unwrap();
        assert!(created.undo.is_none() && created.current.is_some());
        assert!(!session.join("locked.json").exists());
    }

    #[test]
    fn the_turn_of_a_decks_chat_answers_for_that_deck_alone() {
        let temp = TempDir::canonical("guard-one");
        let root = temp.join("work");
        fs::create_dir_all(&root).unwrap();
        let (a, b) = (root.join("a.html"), root.join("b.html"));
        let source = "<html><body><main class=\"deck\"><section class=\"slide\" id=\"a\" data-locked>A</section><section class=\"slide\" id=\"b\">B</section></main></body></html>";
        fs::write(&a, source).unwrap();
        fs::write(&b, source).unwrap();
        let home = temp.join("home");
        let session = Sessions::new(&home).start(&a).unwrap();
        let guard = Guard::start(&root, Some(&a), &session, &home).unwrap();
        // The chat of the other deck is at work beside it, and adds a deck.
        let other = source.replace(">A<", ">theirs<");
        fs::write(&b, &other).unwrap();
        assert!(
            crate::guard::read_guard(&b, Some(&session)).is_empty(),
            "the other deck's locked slides are not this turn's to guard"
        );
        let new = "<main class=\"deck\"><section class=\"slide\">New</section></main>";
        fs::write(root.join("new.html"), new).unwrap();
        fs::write(
            &a,
            source.replace(">A<", ">changed<").replace(">B<", ">mine<"),
        )
        .unwrap();
        assert_eq!(
            guard.finish(&turn()).unwrap(),
            [("a.html".into(), vec!["a".into()])]
        );
        let out = fs::read_to_string(&a).unwrap();
        assert!(out.contains(">A</section>") && out.contains(">mine</section>"));
        let undo = history::status(&home, &a, false).unwrap().undo.unwrap();
        assert_eq!(undo.label, "Tidy the slides");
        // The others are as their own turn left them, and not in this turn's histories.
        assert_eq!(fs::read_to_string(&b).unwrap(), other);
        assert_eq!(fs::read_to_string(root.join("new.html")).unwrap(), new);
        // Their first version noticed is theirs, not a change to undo.
        assert!(history::status(&home, &b, false).unwrap().undo.is_none());
        assert!(!session.join("locked.json").exists());
    }

    #[test]
    fn restores_deleted_locked_decks_and_refreshes_only_the_users_file() {
        let temp = TempDir::new("delete");
        let root = temp.join("work");
        fs::create_dir_all(root.join("talks")).unwrap();
        let a = root.join("deck.html");
        let b = root.join("talks/q3.html");
        let source = "<html><body><main class=\"deck\"><section class=\"slide\" id=\"a\" data-locked>A</section></main></body></html>";
        fs::write(&a, source).unwrap();
        fs::write(&b, source).unwrap();
        let session = Sessions::new(&temp.join("home")).start(&root).unwrap();
        let guard = Guard::start(&root, None, &session, &temp.join("home")).unwrap();
        deck::set_slide_locked(&a, Some(&session), "a", false).unwrap();
        assert!(crate::guard::read_guard(&a, Some(&session)).is_empty());
        assert_eq!(crate::guard::read_guard(&b, Some(&session)).len(), 1);
        fs::remove_dir_all(root.join("talks")).unwrap();
        assert_eq!(
            guard.finish(&turn()).unwrap(),
            [("talks/q3.html".into(), vec!["a".into()])]
        );
        assert!(fs::read_to_string(&b).unwrap().contains(">A</section>"));
        let guard = Guard::start(&root, None, &session, &temp.join("home")).unwrap();
        fs::write(&b, "broken document without a slide container").unwrap();
        assert_eq!(
            guard.finish(&turn()).unwrap(),
            [("talks/q3.html".into(), vec!["a".into()])]
        );
        let restored = fs::read_to_string(&b).unwrap();
        assert!(restored.contains(">A</section>"));
        assert!(restored.contains("slopslide:runtime-js"));
    }

    #[test]
    fn skips_dot_folders_and_pages_and_fails_closed_at_limits() {
        let root = TempDir::new("scan");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(
            root.join(".git/hidden.html"),
            "<main class=\"deck\"></main>",
        )
        .unwrap();
        fs::write(root.join("page.html"), "<html>Page</html>").unwrap();
        fs::write(root.join("q3.html"), "<main class=\"deck\"></main>").unwrap();
        assert_eq!(scan(&root, 10, 1000).unwrap().len(), 1);
        assert!(scan(&root, 1, 1000).is_err());
        assert!(scan(&root, 10, 1).is_err());
    }
}
