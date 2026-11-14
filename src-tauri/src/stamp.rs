//! A file's stamp: what tells, without reading the file, that it is still the bytes last seen.

use std::fs::{self, Metadata};
use std::io;
use std::path::Path;
use std::time::{Duration, SystemTime};

/// When a file was last written and how long it is. Two reads of a file with one stamp gave
/// the same bytes, unless it was written twice within what its file system can tell apart (see
/// [`Stamp::settled`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stamp {
    modified: SystemTime,
    len: u64,
}

/// The coarsest modification times file systems keep (FAT's two seconds): a file written
/// again within this long of its stamp may keep the stamp.
const GRANULARITY: Duration = Duration::from_secs(2);

impl Stamp {
    pub fn of(file: &Path) -> io::Result<Self> {
        Self::from_metadata(&fs::metadata(file)?)
    }

    pub fn from_metadata(metadata: &Metadata) -> io::Result<Self> {
        Ok(Self {
            modified: metadata.modified()?,
            len: metadata.len(),
        })
    }

    /// Whether a file read at `now` with this stamp can be trusted to change its stamp when it
    /// is written again: its last write is longer ago than a file system's clock is coarse.
    /// Until then, only reading the file tells whether it changed.
    pub fn settled(&self, now: SystemTime) -> bool {
        now.duration_since(self.modified)
            .is_ok_and(|age| age > GRANULARITY)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn a_stamp_changes_with_the_files_length_or_time() {
        let dir = TempDir::new("stamp");
        let file = dir.write("deck.html", "one");
        let first = Stamp::of(&file).unwrap();
        assert_eq!(Stamp::of(&file).unwrap(), first);
        fs::write(&file, "longer").unwrap();
        assert_ne!(Stamp::of(&file).unwrap(), first);
        assert!(Stamp::of(&dir.join("missing.html")).is_err());
    }

    #[test]
    fn a_stamp_settles_once_its_write_is_long_enough_ago() {
        let now = SystemTime::now();
        let stamp = |age: Duration| Stamp {
            modified: now - age,
            len: 1,
        };
        assert!(!stamp(Duration::ZERO).settled(now));
        assert!(!stamp(GRANULARITY).settled(now));
        assert!(stamp(GRANULARITY + Duration::from_millis(1)).settled(now));
        // A file from the future (a clock that jumped) never settles.
        assert!(!stamp(Duration::ZERO).settled(now - Duration::from_secs(60)));
    }
}
