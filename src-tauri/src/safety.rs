//! Turn-wide protection. Capture and snapshot all decks before granting the agent a turn;
//! eager snapshots avoid watcher races (atomic replacements, deletes, and rapid rewrites).
//! Limits fail closed: a partially scanned workspace is never handed to the agent.
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::{deck, workspace};

const MAX_ENTRIES: usize = 10_000;
const MAX_BYTES: u64 = 64 * 1024 * 1024;

pub struct Guard {
    root: PathBuf,
    session: PathBuf,
    before: BTreeMap<PathBuf, Vec<u8>>,
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
    pub fn start(root: &Path, session: &Path) -> Result<Self> {
        let before = decks(root)?;
        // Discard a stale guard from an interrupted app instance, once the full scan succeeds.
        fs::create_dir_all(session)?;
        fs::write(session.join("locked.json"), "{}")?;
        for file in before.keys() {
            deck::snapshot(file, session)?;
            deck::guard_locked(file, session)?;
        }
        Ok(Self {
            root: root.into(),
            session: session.into(),
            before,
        })
    }

    pub fn finish(self) -> Result<Vec<(String, Vec<String>)>> {
        let mut restored = Vec::new();
        let mut errors = Vec::new();
        // Restore every pre-existing deck, even if one cannot be restored or has been deleted.
        for (file, original) in &self.before {
            if file.exists() && !workspace::inside(&self.root, file) {
                errors.push(format!("{} moved outside the workspace", file.display()));
                continue;
            }
            let changed = fs::read(file).map_or(true, |now| now != *original);
            match deck::release_guard(file, &self.session) {
                Ok(ids) if !ids.is_empty() => restored.push((
                    file.strip_prefix(&self.root)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
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
            }
        }
        // New decks have no lock guard but still need ids and the runtime.
        match decks(&self.root) {
            Ok(now) => {
                for file in now.keys().filter(|f| !self.before.contains_key(*f)) {
                    if let Err(e) = deck::normalize(file) {
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

    #[test]
    fn protects_other_decks_snapshots_per_file_and_normalizes_new_decks() {
        let temp = std::env::temp_dir().join(format!("slopslide-guard-{}", uuid::Uuid::new_v4()));
        let root = temp.join("work");
        fs::create_dir_all(root.join("talks")).unwrap();
        let a = root.join("deck.html");
        let b = root.join("talks/q3.html");
        let source = "<html><body><main class=\"deck\"><section class=\"slide\" id=\"a\" data-locked>A</section><section class=\"slide\" id=\"b\">B</section></main></body></html>";
        fs::write(&a, source).unwrap();
        fs::write(&b, source).unwrap();
        let session = Sessions::new(&temp.join("home")).start(&root).unwrap();
        let guard = Guard::start(&root, &session).unwrap();
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
            guard.finish().unwrap(),
            [("talks/q3.html".into(), vec!["a".into()])]
        );
        let out = fs::read_to_string(&b).unwrap();
        assert!(out.contains(">A</section>"));
        assert!(out.contains("slopslide:runtime-js"));
        assert!(!deck::load(&b).unwrap().slides[1].id.is_empty());
        assert!(fs::read_to_string(new)
            .unwrap()
            .contains("slopslide:runtime-js"));
        for path in ["deck.html", "talks/q3.html"] {
            let files: Vec<_> = fs::read_dir(session.join("snapshots").join(path))
                .unwrap()
                .collect();
            assert_eq!(files.len(), 1);
            assert_eq!(
                fs::read_to_string(files[0].as_ref().unwrap().path()).unwrap(),
                source
            );
        }
        assert!(!session.join("locked.json").exists());
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn restores_deleted_locked_decks_and_refreshes_only_the_users_file() {
        let temp = std::env::temp_dir().join(format!("slopslide-delete-{}", uuid::Uuid::new_v4()));
        let root = temp.join("work");
        fs::create_dir_all(root.join("talks")).unwrap();
        let a = root.join("deck.html");
        let b = root.join("talks/q3.html");
        let source = "<html><body><main class=\"deck\"><section class=\"slide\" id=\"a\" data-locked>A</section></main></body></html>";
        fs::write(&a, source).unwrap();
        fs::write(&b, source).unwrap();
        let session = Sessions::new(&temp.join("home")).start(&root).unwrap();
        let guard = Guard::start(&root, &session).unwrap();
        deck::set_slide_locked(&a, Some(&session), "a", false).unwrap();
        assert!(deck::read_guard(&a, Some(&session)).is_empty());
        assert_eq!(deck::read_guard(&b, Some(&session)).len(), 1);
        fs::remove_dir_all(root.join("talks")).unwrap();
        assert_eq!(
            guard.finish().unwrap(),
            [("talks/q3.html".into(), vec!["a".into()])]
        );
        assert!(fs::read_to_string(&b).unwrap().contains(">A</section>"));
        let guard = Guard::start(&root, &session).unwrap();
        fs::write(&b, "broken document without a slide container").unwrap();
        assert_eq!(
            guard.finish().unwrap(),
            [("talks/q3.html".into(), vec!["a".into()])]
        );
        let restored = fs::read_to_string(&b).unwrap();
        assert!(restored.contains(">A</section>"));
        assert!(restored.contains("slopslide:runtime-js"));
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn skips_dot_folders_and_pages_and_fails_closed_at_limits() {
        let root = std::env::temp_dir().join(format!("slopslide-scan-{}", uuid::Uuid::new_v4()));
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
        fs::remove_dir_all(root).unwrap();
    }
}
