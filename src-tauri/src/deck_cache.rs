//! Deck files as last read, with what the app parses out of them, shared by everything that
//! looks at a deck. One save of one slide is followed by a handful of commands that each need
//! the deck (its history, lint, narration audio, the deck itself); each used to read and scan
//! the whole file again.
//!
//! An entry is trusted while the file's [`Stamp`] is the one it was read with. The app's own
//! writes [`put`](DeckCache::put) the text they wrote, so it is not read back. A change made
//! outside the app changes the stamp and the file is read again; while a stamp is too young to
//! tell (see [`Stamp::settled`]) the file is read and compared instead, so that an outside
//! change is never missed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use sha2::{Digest, Sha256};

use crate::deck::Parsed;
use crate::error::Result;
use crate::html::SlideSpan;
use crate::stamp::Stamp;

/// Decks kept; the one looked at longest ago goes first. A window has one deck open, and
/// templates and decks pasted from come and go.
const DECKS_KEPT: usize = 12;

/// One deck file as it was read, with what is worked out from it on first use.
pub struct Cached {
    stamp: Stamp,
    source: Arc<str>,
    parsed: OnceLock<Parsed>,
    sha256: OnceLock<String>,
}

impl Cached {
    fn new(stamp: Stamp, source: Arc<str>) -> Self {
        Self {
            stamp,
            source,
            parsed: OnceLock::new(),
            sha256: OnceLock::new(),
        }
    }

    /// The file's text.
    pub fn source(&self) -> &Arc<str> {
        &self.source
    }

    /// What the app reads out of the deck, parsed on first use and once: a second thread
    /// asking meanwhile waits for the first one's result.
    pub fn parsed(&self) -> &Parsed {
        self.parsed.get_or_init(|| Parsed::of(&self.source))
    }

    pub fn slides(&self) -> &[SlideSpan] {
        &self.parsed().slides
    }

    /// SHA-256 of the file, in hex: what the deck's history names its versions by.
    pub fn sha256(&self) -> &str {
        self.sha256
            .get_or_init(|| format!("{:x}", Sha256::digest(self.source.as_bytes())))
    }
}

struct Entry {
    cached: Arc<Cached>,
    /// Whether the stamp alone tells that the file is unchanged (see [`Stamp::settled`]).
    settled: bool,
    /// When it was last asked for, on the cache's own clock.
    used: u64,
}

/// The decks read so far, by canonical path.
#[derive(Default)]
pub struct DeckCache {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    entries: HashMap<PathBuf, Entry>,
    clock: u64,
}

impl State {
    fn touch(&mut self, key: &Path) -> Option<&mut Entry> {
        self.clock += 1;
        let clock = self.clock;
        let entry = self.entries.get_mut(key)?;
        entry.used = clock;
        Some(entry)
    }

    fn insert(&mut self, key: PathBuf, cached: Arc<Cached>, settled: bool) {
        self.clock += 1;
        let entry = Entry {
            cached,
            settled,
            used: self.clock,
        };
        self.entries.insert(key, entry);
        while self.entries.len() > DECKS_KEPT {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, e)| e.used)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.entries.remove(&oldest);
        }
    }
}

#[cfg(test)]
thread_local! {
    static READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// How many times this thread has read a deck file for the cache, for tests that pin how
/// often an operation does.
#[cfg(test)]
pub(crate) fn reads() -> usize {
    READS.get()
}

fn key(file: &Path) -> PathBuf {
    file.canonicalize().unwrap_or_else(|_| file.into())
}

impl DeckCache {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Deck `file` as it is on disk now: the entry kept of it when the file is unchanged, else
    /// read again. The lock is not held while the file is read or parsed.
    pub fn get(&self, file: &Path) -> Result<Arc<Cached>> {
        let key = key(file);
        let now = SystemTime::now();
        // Before the read: a write between the two gives a stamp older than the text, which
        // the next look sets right; the other way round would keep old text for good.
        let stamp = Stamp::of(file)?;
        let known = self
            .state()
            .touch(&key)
            .filter(|entry| entry.cached.stamp == stamp)
            .map(|entry| (entry.cached.clone(), entry.settled));
        if let Some((cached, true)) = known {
            return Ok(cached);
        }
        let text = std::fs::read_to_string(file)?;
        #[cfg(test)]
        READS.set(READS.get() + 1);
        let settled = stamp.settled(now);
        // A stamp too young to trust: the text itself says whether the file is the same.
        let cached = match known {
            Some((cached, _)) if *cached.source == *text => cached,
            _ => Arc::new(Cached::new(stamp, text.into())),
        };
        self.state().insert(key, cached.clone(), settled);
        Ok(cached)
    }

    /// Keeps `source`, the text the app just wrote to `file` with `stamp`, so that it is not
    /// read back.
    pub fn put(&self, file: &Path, source: Arc<str>, stamp: Stamp) -> Arc<Cached> {
        self.keep(file, Cached::new(stamp, source))
    }

    /// [`put`](Self::put), with `parsed`, what [`Parsed::of`] gives for `source`, worked out
    /// by the writer without parsing it all.
    pub fn put_parsed(
        &self,
        file: &Path,
        source: Arc<str>,
        stamp: Stamp,
        parsed: Parsed,
    ) -> Arc<Cached> {
        let cached = Cached::new(stamp, source);
        let _ = cached.parsed.set(parsed);
        self.keep(file, cached)
    }

    fn keep(&self, file: &Path, cached: Cached) -> Arc<Cached> {
        let cached = Arc::new(cached);
        // Just written: its stamp is too young to tell a second write by.
        self.state().insert(key(file), cached.clone(), false);
        cached
    }
}

/// The cache every command shares.
pub fn shared() -> &'static DeckCache {
    static SHARED: OnceLock<DeckCache> = OnceLock::new();
    SHARED.get_or_init(DeckCache::default)
}

/// Deck `file` as it is on disk now, from the shared cache.
pub fn get(file: &Path) -> Result<Arc<Cached>> {
    shared().get(file)
}

/// The text of deck `file` as it is on disk now, from the shared cache: for whoever serves
/// the deck (its slides are at [`Cached::slides`] of [`get`]).
pub fn source_of(file: &Path) -> Result<Arc<str>> {
    Ok(get(file)?.source().clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deck::parses;
    use crate::test_support::TempDir;
    use std::time::Duration;

    const ONE: &str = "<main class=\"deck\"><section class=\"slide\" id=\"a\">A</section></main>";
    const TWO: &str = "<main class=\"deck\"><section class=\"slide\" id=\"b\">B</section></main>";

    /// Sets the file's modification time `seconds` back, so its stamp is settled.
    fn age(file: &Path, seconds: u64) {
        let modified = SystemTime::now() - Duration::from_secs(seconds);
        std::fs::File::options()
            .write(true)
            .open(file)
            .unwrap()
            .set_modified(modified)
            .unwrap();
    }

    fn ids(cached: &Cached) -> Vec<String> {
        cached
            .slides()
            .iter()
            .filter_map(|s| s.id.clone())
            .collect()
    }

    #[test]
    fn an_unchanged_file_is_read_and_parsed_once() {
        let dir = TempDir::new("deck-cache");
        let file = dir.write("deck.html", ONE);
        age(&file, 60);
        let cache = DeckCache::default();
        let before = parses();
        let reads_before = reads();
        let first = cache.get(&file).unwrap();
        assert_eq!(ids(&first), ["a"]);
        let again = cache.get(&file).unwrap();
        assert_eq!(reads() - reads_before, 1);
        assert!(Arc::ptr_eq(&first, &again));
        assert_eq!(ids(&again), ["a"]);
        // Another spelling of the path is the same deck.
        let spelled = cache.get(&dir.join(".").join("deck.html")).unwrap();
        assert!(Arc::ptr_eq(&first, &spelled));
        assert_eq!(parses() - before, 1);
        assert!(cache.get(&dir.join("missing.html")).is_err());
    }

    #[test]
    fn a_file_is_not_parsed_until_someone_asks() {
        let dir = TempDir::new("deck-cache");
        let file = dir.write("deck.html", ONE);
        let cache = DeckCache::default();
        let before = parses();
        let cached = cache.get(&file).unwrap();
        assert_eq!(&**cached.source(), ONE);
        assert_eq!(cached.sha256().len(), 64);
        assert_eq!(parses(), before);
    }

    #[test]
    fn an_outside_write_with_another_stamp_is_read_again() {
        let dir = TempDir::new("deck-cache");
        let file = dir.write("deck.html", ONE);
        age(&file, 60);
        let cache = DeckCache::default();
        assert_eq!(ids(&cache.get(&file).unwrap()), ["a"]);
        std::fs::write(&file, TWO.replace(">B<", ">Longer<")).unwrap();
        age(&file, 30);
        let changed = cache.get(&file).unwrap();
        assert_eq!(ids(&changed), ["b"]);
        assert!(changed.source().contains("Longer"));
    }

    #[test]
    fn a_rewrite_of_the_same_length_at_another_time_is_read_again() {
        let dir = TempDir::new("deck-cache");
        let file = dir.write("deck.html", ONE);
        age(&file, 60);
        let cache = DeckCache::default();
        assert_eq!(ids(&cache.get(&file).unwrap()), ["a"]);
        assert_eq!(ONE.len(), TWO.len());
        std::fs::write(&file, TWO).unwrap();
        age(&file, 30);
        assert_eq!(ids(&cache.get(&file).unwrap()), ["b"]);
    }

    #[test]
    fn a_rewrite_the_stamp_cannot_tell_is_still_noticed() {
        // Same length, same modification time: what a coarse file-system clock makes of two
        // writes close together.
        let dir = TempDir::new("deck-cache");
        let file = dir.write("deck.html", ONE);
        let stamp = Stamp::of(&file).unwrap();
        let modified = std::fs::metadata(&file).unwrap().modified().unwrap();
        let cache = DeckCache::default();
        assert_eq!(ids(&cache.get(&file).unwrap()), ["a"]);
        std::fs::write(&file, TWO).unwrap();
        let rewritten = std::fs::File::options().write(true).open(&file).unwrap();
        rewritten.set_modified(modified).unwrap();
        drop(rewritten);
        assert_eq!(Stamp::of(&file).unwrap(), stamp);
        assert_eq!(ids(&cache.get(&file).unwrap()), ["b"]);
    }

    #[test]
    fn what_the_app_wrote_is_not_parsed_twice() {
        let dir = TempDir::new("deck-cache");
        let file = dir.write("deck.html", ONE);
        let cache = DeckCache::default();
        let before = parses();
        let put = cache.put(&file, ONE.into(), Stamp::of(&file).unwrap());
        assert_eq!(ids(&put), ["a"]);
        // Its stamp is young, so the file is compared; it is the same text, and the entry stays.
        let got = cache.get(&file).unwrap();
        assert!(Arc::ptr_eq(&put, &got));
        assert_eq!(parses() - before, 1);
        // An outside write right after the app's own, of the same length, is still seen.
        std::fs::write(&file, TWO).unwrap();
        assert_eq!(ids(&cache.get(&file).unwrap()), ["b"]);
    }

    #[test]
    fn keeps_only_the_decks_looked_at_last() {
        let dir = TempDir::new("deck-cache");
        let cache = DeckCache::default();
        let files: Vec<_> = (0..DECKS_KEPT + 3)
            .map(|n| dir.write(format!("{n}.html"), ONE))
            .collect();
        let first = cache.get(&files[0]).unwrap();
        for file in &files[1..] {
            cache.get(file).unwrap();
            // The first stays in use, so it is never the one to go.
            cache.get(&files[0]).unwrap();
        }
        assert_eq!(cache.state().entries.len(), DECKS_KEPT);
        assert!(Arc::ptr_eq(&first, &cache.get(&files[0]).unwrap()));
    }
}
