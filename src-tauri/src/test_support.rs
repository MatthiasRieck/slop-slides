//! Helpers shared by the crate's tests: a temporary folder that cleans up after itself, and
//! (on unix) scripts standing in for a CLI.

use std::path::{Path, PathBuf};

/// A fresh, empty folder for one test, removed with everything in it when dropped, also when
/// the test fails. It derefs to its [`Path`]:
///
/// ```ignore
/// let dir = TempDir::new("history");
/// std::fs::write(dir.join("deck.html"), "…").unwrap();
/// some_fn(&dir); // &Path
/// ```
pub struct TempDir(PathBuf);

impl TempDir {
    /// A new folder in the system's temporary folder, named `slopslide-<label>-<uuid>`. `label`
    /// tells whose it is when one is left behind (a test killed mid-way).
    pub fn new(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("slopslide-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    /// [`TempDir::new`], spelled canonically (`/private/var/…` rather than `/var/…` on macOS),
    /// for tests comparing it with paths the code under test canonicalizes.
    pub fn canonical(label: &str) -> Self {
        let mut dir = Self::new(label);
        dir.0 = dir.0.canonicalize().unwrap();
        dir
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    /// Writes `contents` to `rel` in the folder, creating the folders on the way; its path.
    pub fn write(&self, rel: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> PathBuf {
        let path = self.0.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&path, contents).unwrap();
        path
    }
}

impl std::ops::Deref for TempDir {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<Path> for TempDir {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Writes an executable script at `path`, in a child process. A file this process had open for
/// writing could fail to start with "Text file busy" on Linux: a test forking on another thread
/// at that moment inherits the open handle until it execs.
#[cfg(unix)]
pub fn write_script(path: &Path, script: &str) {
    let draft = path.with_extension("draft");
    std::fs::write(&draft, script).unwrap();
    let status = std::process::Command::new("install")
        .args(["-m", "755"])
        .arg(&draft)
        .arg(path)
        .status()
        .unwrap();
    assert!(status.success(), "could not install {}", path.display());
    std::fs::remove_file(&draft).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_temp_dir_is_fresh_and_removed_when_dropped() {
        let dir = TempDir::new("support");
        let kept = dir.path().to_path_buf();
        assert!(kept.is_dir());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0, "empty");
        assert_ne!(kept, TempDir::new("support").path(), "one per test");
        let file = dir.write("a/b.txt", "hi");
        assert_eq!(file, dir.join("a/b.txt"));
        assert_eq!(std::fs::read_to_string(file).unwrap(), "hi");
        drop(dir);
        assert!(!kept.exists());
    }

    #[test]
    fn a_temp_dir_is_removed_when_its_test_panics() {
        let kept = std::sync::Mutex::new(PathBuf::new());
        let panicked = std::panic::catch_unwind(|| {
            let dir = TempDir::new("support");
            dir.write("left.txt", "x");
            *kept.lock().unwrap() = dir.to_path_buf();
            panic!("the test fails");
        });
        assert!(panicked.is_err());
        assert!(!kept.into_inner().unwrap().exists());
    }

    #[test]
    fn a_canonical_temp_dir_is_spelled_canonically_and_removed_when_dropped() {
        let dir = TempDir::canonical("support");
        let kept = dir.to_path_buf();
        assert_eq!(kept, kept.canonicalize().unwrap());
        drop(dir);
        assert!(!kept.exists());
    }

    #[cfg(unix)]
    #[test]
    fn writes_a_script_that_runs_and_leaves_no_draft() {
        let dir = TempDir::new("script");
        let path = dir.join("cli");
        write_script(&path, "#!/bin/sh\necho ran\n");
        let output = std::process::Command::new(&path).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout), "ran\n");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    }
}
