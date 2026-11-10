//! File helpers the whole app shares: where its folders are, writing a file whole, and naming
//! new files and folders so they never replace one that is there.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};

/// The app's folder in the user's home.
pub const HOME_DIR: &str = ".slopslides";

/// `~/.slopslides`, created on first use. Not through Tauri: the lint server, which runs
/// without the app, needs it too.
pub fn app_home() -> Result<PathBuf> {
    let home = std::env::home_dir().ok_or_else(|| Error::msg("cannot locate home folder"))?;
    let root = home.join(HOME_DIR);
    fs::create_dir_all(&root)?;
    Ok(root)
}

/// `~/Documents/SlopSlide`, where decks lived before workspaces; the default workspace.
pub fn library_root(app: &AppHandle) -> Result<PathBuf> {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| Error::msg(format!("cannot locate documents folder: {e}")))?;
    let root = base.join("SlopSlide");
    fs::create_dir_all(&root)?;
    Ok(root)
}

/// Writes `bytes` to `path` through a temporary file next to it, so a reader never sees half
/// of it.
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// `<root>/<stem>`, or `<stem>-2`, `<stem>-3`, … when that is taken; `untitled` for no stem.
pub fn unique_dir(root: &Path, stem: &str) -> PathBuf {
    let stem = if stem.is_empty() { "untitled" } else { stem };
    std::iter::once(root.join(stem))
        .chain((2..).map(|n| root.join(format!("{stem}-{n}"))))
        .find(|p| !p.exists())
        .expect("unbounded")
}

/// `text` without characters file systems reject, trimmed of spaces and trailing dots.
pub(crate) fn safe_file_name(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .filter(|c| !c.is_control() && !r#"\/:*?"<>|"#.contains(*c))
        .collect();
    cleaned.trim().trim_end_matches('.').trim().to_string()
}

/// Creates a new folder for exported slide images inside `parent`, named after the deck
/// title (made safe for file systems); `Title 2`, `Title 3`, … if that name is taken.
pub fn create_export_dir(parent: &Path, title: &str) -> Result<PathBuf> {
    if !parent.is_dir() {
        return Err(Error::msg(format!("not a folder: {}", parent.display())));
    }
    let name = safe_file_name(title);
    let name = if name.is_empty() {
        "presentation".into()
    } else {
        name
    };
    for n in 1.. {
        let dir = parent.join(if n == 1 {
            name.clone()
        } else {
            format!("{name} {n}")
        });
        match fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    unreachable!("unbounded")
}

/// File name of the `index`th (0-based) of `total` exported slides: `slide-01.png`, with
/// enough digits that the files sort in slide order.
pub fn slide_image_name(index: usize, total: usize) -> String {
    let digits = total.max(1).to_string().len().max(2);
    format!("slide-{:0digits$}.png", index + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway folder.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("slopslide-files-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn atomic_write_leaves_no_temp_files() {
        let dir = TempDir::new();
        let file = dir.0.join("deck.html");
        fs::write(&file, "old").unwrap();
        atomic_write(&file, b"new").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "new");
        let names: Vec<_> = fs::read_dir(&dir.0)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["deck.html"]);
    }

    #[test]
    fn export_dir_is_named_after_the_deck() {
        let parent = TempDir::new();
        let dir = create_export_dir(&parent.0, "Q3 Review").unwrap();
        assert_eq!(dir, parent.0.join("Q3 Review"));
        assert!(dir.is_dir());
    }

    #[test]
    fn export_dir_never_reuses_an_existing_folder() {
        let parent = TempDir::new();
        fs::create_dir(parent.0.join("Talk")).unwrap();
        fs::write(parent.0.join("Talk").join("slide-01.png"), b"keep").unwrap();
        assert_eq!(
            create_export_dir(&parent.0, "Talk").unwrap(),
            parent.0.join("Talk 2")
        );
        assert_eq!(
            create_export_dir(&parent.0, "Talk").unwrap(),
            parent.0.join("Talk 3")
        );
        assert_eq!(
            fs::read(parent.0.join("Talk").join("slide-01.png")).unwrap(),
            b"keep"
        );
    }

    #[test]
    fn export_dir_names_are_safe() {
        let parent = TempDir::new();
        let dir = create_export_dir(&parent.0, " A/B: \"why?\" <draft>. ").unwrap();
        assert_eq!(dir.file_name().unwrap(), "AB why draft");
        let dir = create_export_dir(&parent.0, "../..").unwrap();
        assert_eq!(dir, parent.0.join("presentation"));
        let dir = create_export_dir(&parent.0, "\t").unwrap();
        assert_eq!(dir, parent.0.join("presentation 2"));
    }

    #[test]
    fn export_dir_needs_an_existing_parent() {
        let parent = TempDir::new();
        let file = parent.0.join("deck.html");
        fs::write(&file, "").unwrap();
        assert!(create_export_dir(&parent.0.join("missing"), "Talk").is_err());
        assert!(create_export_dir(&file, "Talk").is_err());
    }

    #[test]
    fn slide_images_sort_in_slide_order() {
        assert_eq!(slide_image_name(0, 1), "slide-01.png");
        assert_eq!(slide_image_name(8, 12), "slide-09.png");
        assert_eq!(slide_image_name(99, 120), "slide-100.png");
        assert_eq!(slide_image_name(4, 120), "slide-005.png");
        assert_eq!(slide_image_name(0, 0), "slide-01.png");
    }
}
