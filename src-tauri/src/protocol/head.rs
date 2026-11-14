//! Files as of the last commit, remembered. Reading one starts `git`, and a page of the
//! comparison view asks for the same deck once per slide and for each of its assets, so what a
//! commit holds at a path is kept: it can never change. The memory is small and bounded; the
//! files asked for longest ago go first.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// A file of a commit: the commit's id and the file's path.
type Key = (String, PathBuf);

/// How many files are remembered at most.
const MAX_FILES: usize = 256;
/// How many bytes of them: a few decks with their pictures.
const MAX_BYTES: usize = 48 * 1024 * 1024;

#[derive(Default)]
struct Files {
    /// What each commit has at each path; None where it has nothing.
    held: HashMap<Key, Option<Arc<[u8]>>>,
    /// The keys, the one asked for longest ago first.
    order: VecDeque<Key>,
    bytes: usize,
}

pub(super) struct HeadFiles {
    files: Mutex<Files>,
    max_files: usize,
    max_bytes: usize,
}

impl Default for HeadFiles {
    fn default() -> Self {
        Self::bounded(MAX_FILES, MAX_BYTES)
    }
}

impl HeadFiles {
    pub fn bounded(max_files: usize, max_bytes: usize) -> Self {
        HeadFiles {
            files: Mutex::default(),
            max_files,
            max_bytes,
        }
    }

    /// What commit `commit` has at `path`: remembered, or else read with `read` and remembered.
    /// The lock is not held while reading, so two first requests for one file may both read it.
    pub fn get(
        &self,
        commit: &str,
        path: &Path,
        read: impl FnOnce() -> Option<Vec<u8>>,
    ) -> Option<Arc<[u8]>> {
        let key = (commit.to_string(), path.to_path_buf());
        if let Some(known) = self.recall(&key) {
            return known;
        }
        let bytes: Option<Arc<[u8]>> = read().map(Arc::from);
        self.keep(key, bytes.clone());
        bytes
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Files> {
        self.files.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn recall(&self, key: &Key) -> Option<Option<Arc<[u8]>>> {
        let mut files = self.lock();
        let known = files.held.get(key)?.clone();
        if let Some(at) = files.order.iter().position(|k| k == key) {
            let key = files.order.remove(at).expect("in range");
            files.order.push_back(key);
        }
        Some(known)
    }

    fn keep(&self, key: Key, bytes: Option<Arc<[u8]>>) {
        let size = bytes.as_ref().map_or(0, |b| b.len());
        // One file larger than the whole memory is not worth emptying it for.
        if size > self.max_bytes {
            return;
        }
        let mut files = self.lock();
        if files.held.insert(key.clone(), bytes).is_none() {
            files.order.push_back(key);
            files.bytes += size;
        }
        while files.order.len() > self.max_files || files.bytes > self.max_bytes {
            let Some(oldest) = files.order.pop_front() else {
                break;
            };
            if let Some(dropped) = files.held.remove(&oldest).flatten() {
                files.bytes -= dropped.len();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    #[test]
    fn reads_a_file_of_a_commit_once() {
        let files = HeadFiles::default();
        let reads = Cell::new(0);
        let read = |commit: &str, path: &str| {
            files.get(commit, Path::new(path), || {
                reads.set(reads.get() + 1);
                (path != "/ws/gone.png").then(|| format!("{commit}:{path}").into_bytes())
            })
        };
        assert_eq!(
            read("c1", "/ws/deck.html").as_deref(),
            Some(&b"c1:/ws/deck.html"[..])
        );
        assert_eq!(
            read("c1", "/ws/deck.html").as_deref(),
            Some(&b"c1:/ws/deck.html"[..])
        );
        assert_eq!(reads.get(), 1, "the second request starts no git");
        assert_eq!(read("c1", "/ws/gone.png"), None);
        assert_eq!(read("c1", "/ws/gone.png"), None);
        assert_eq!(reads.get(), 2, "what a commit lacks is remembered too");
        assert_eq!(
            read("c2", "/ws/deck.html").as_deref(),
            Some(&b"c2:/ws/deck.html"[..])
        );
        assert_eq!(reads.get(), 3, "another commit is another file");
    }

    #[test]
    fn forgets_the_files_asked_for_longest_ago() {
        let files = HeadFiles::bounded(2, 1024);
        let reads = Cell::new(0);
        let read = |path: &str| {
            files.get("c", Path::new(path), || {
                reads.set(reads.get() + 1);
                Some(vec![0; 10])
            })
        };
        read("a");
        read("b");
        read("a");
        read("c");
        assert_eq!(reads.get(), 3);
        read("a");
        assert_eq!(reads.get(), 3, "a was asked for after b, so it stayed");
        read("b");
        assert_eq!(reads.get(), 4, "b went to make room for c");
    }

    #[test]
    fn stays_within_its_bytes() {
        let files = HeadFiles::bounded(100, 25);
        let reads = Cell::new(0);
        let read = |path: &str, len: usize| {
            files.get("c", Path::new(path), || {
                reads.set(reads.get() + 1);
                Some(vec![0; len])
            })
        };
        read("a", 10);
        read("b", 10);
        read("c", 10);
        read("b", 10);
        read("c", 10);
        assert_eq!(reads.get(), 3, "b and c fit together");
        read("a", 10);
        assert_eq!(reads.get(), 4, "a went to make room");
        read("huge", 26);
        read("huge", 26);
        assert_eq!(reads.get(), 6, "a file larger than the memory is not kept");
        read("a", 10);
        assert_eq!(reads.get(), 6, "nor does it push the others out");
    }
}
