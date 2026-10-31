//! Helpers for tests that run a script standing in for a CLI.

use std::path::Path;
use std::process::Command;

/// Writes an executable script at `path`, in a child process. A file this process had open for
/// writing could fail to start with "Text file busy" on Linux: a test forking on another thread
/// at that moment inherits the open handle until it execs.
pub fn write_script(path: &Path, script: &str) {
    let draft = path.with_extension("draft");
    std::fs::write(&draft, script).unwrap();
    let status = Command::new("install")
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
    fn writes_a_script_that_runs_and_leaves_no_draft() {
        let dir = std::env::temp_dir().join(format!("slopslide-script-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cli");
        write_script(&path, "#!/bin/sh\necho ran\n");
        let output = Command::new(&path).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout), "ran\n");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
