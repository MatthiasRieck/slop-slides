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

/// The folder new decks from the start screen go in, the library: `custom` when the settings
/// name one, or `SlopSlide` in `documents` (the user's documents folder, or their home where
/// there is none). Not created here: just showing where it is must not touch a drive that may
/// be slow or away (see [`ensure_dir`]).
pub fn library_root(custom: Option<&str>, documents: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(custom) = custom.map(str::trim).filter(|c| !c.is_empty()) {
        return Ok(PathBuf::from(custom));
    }
    documents
        .map(|base| base.join("SlopSlide"))
        .ok_or_else(|| Error::msg("cannot locate the documents folder"))
}

/// The library of this app (see [`library_root`]).
pub fn app_library(app: &AppHandle, custom: Option<&str>) -> Result<PathBuf> {
    let documents = app.path().document_dir().or_else(|_| app.path().home_dir());
    library_root(custom, documents.ok())
}

/// Creates the folder `dir` where it is missing. The error names the folder and says what to
/// do: it is the user's own choice of place (a network drive that is away, say).
pub fn ensure_dir(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir).map_err(|e| {
        Error::msg(format!(
            "Cannot use the folder {}: {e}. Choose another location.",
            dir.display()
        ))
    })
}

/// `file` by its canonical path: the same whatever spelling of it is given, and whatever is
/// happening to the file just then. A file being written over (see [`atomic_write`]) cannot
/// be opened for an instant on Windows, so canonicalizing it fails; its folder still can be,
/// and the file's name goes after it. Falling back to `file` as given instead would key one
/// deck two ways, and its lock, history and cache (deck_lock.rs, history.rs, deck_cache.rs)
/// would take it for two decks.
pub(crate) fn canonical_file(file: &Path) -> PathBuf {
    if let Ok(path) = file.canonicalize() {
        return path;
    }
    let Some(name) = file.file_name() else {
        return file.into();
    };
    let parent = match file.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    parent
        .canonicalize()
        .map(|dir| dir.join(name))
        .unwrap_or_else(|_| file.into())
}

/// Writes `bytes` to `path` through a temporary file next to it, so a reader never sees half
/// of it.
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    atomic_write_stamped(path, bytes).map(drop)
}

/// [`atomic_write`], returning the metadata of the file as written. It is taken from the
/// temporary file before that takes `path`'s place (which keeps its modification time), so it
/// is that of these bytes even when someone else writes `path` right after.
pub(crate) fn atomic_write_stamped(path: &Path, bytes: &[u8]) -> Result<fs::Metadata> {
    let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    fs::write(&tmp, bytes)?;
    let metadata = fs::metadata(&tmp)?;
    fs::rename(&tmp, path)?;
    Ok(metadata)
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
    use crate::test_support::TempDir;

    #[test]
    fn a_file_is_named_the_same_whether_or_not_it_can_be_opened() {
        let dir = TempDir::new("files");
        let file = dir.join("deck.html");
        // As while it is renamed over: its folder is canonical, its name follows.
        let missing = canonical_file(&file);
        fs::write(&file, "x").unwrap();
        let there = canonical_file(&file);
        assert_eq!(missing, there);
        assert_eq!(canonical_file(&dir.join(".").join("deck.html")), there);
        // Nothing to canonicalize: the path as given.
        let nowhere = Path::new("/no/such/folder/deck.html");
        assert_eq!(canonical_file(nowhere), nowhere);
    }

    #[test]
    fn the_library_is_in_the_documents_unless_the_settings_name_a_folder() {
        let documents = || Some(PathBuf::from("/docs"));
        assert_eq!(
            library_root(None, documents()).unwrap(),
            Path::new("/docs/SlopSlide")
        );
        assert_eq!(
            library_root(Some("/decks"), documents()).unwrap(),
            Path::new("/decks")
        );
        // A folder named but empty is none.
        assert_eq!(
            library_root(Some("  "), documents()).unwrap(),
            Path::new("/docs/SlopSlide")
        );
        // The custom folder needs no documents folder; the default does.
        assert_eq!(
            library_root(Some("/decks"), None).unwrap(),
            Path::new("/decks")
        );
        assert!(library_root(None, None).is_err());
    }

    #[test]
    fn showing_where_the_library_is_does_not_create_it() {
        let dir = TempDir::new("files");
        let library = library_root(None, Some(dir.to_path_buf())).unwrap();
        assert!(!library.exists());
        ensure_dir(&library).unwrap();
        assert!(library.is_dir());
        // Once more is fine.
        ensure_dir(&library).unwrap();
    }

    #[test]
    fn a_folder_that_cannot_be_made_is_named_in_the_error() {
        let dir = TempDir::new("files");
        fs::write(dir.join("taken"), b"a file").unwrap();
        let error = ensure_dir(&dir.join("taken").join("decks"))
            .unwrap_err()
            .to_string();
        assert!(error.starts_with("Cannot use the folder "), "{error}");
        assert!(error.contains("taken"), "{error}");
        assert!(error.ends_with("Choose another location."), "{error}");
    }

    #[test]
    fn atomic_write_leaves_no_temp_files() {
        let dir = TempDir::new("files");
        let file = dir.join("deck.html");
        fs::write(&file, "old").unwrap();
        atomic_write(&file, b"new").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "new");
        let names: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["deck.html"]);
    }

    #[test]
    fn export_dir_is_named_after_the_deck() {
        let parent = TempDir::new("files");
        let dir = create_export_dir(&parent, "Q3 Review").unwrap();
        assert_eq!(dir, parent.join("Q3 Review"));
        assert!(dir.is_dir());
    }

    #[test]
    fn export_dir_never_reuses_an_existing_folder() {
        let parent = TempDir::new("files");
        fs::create_dir(parent.join("Talk")).unwrap();
        fs::write(parent.join("Talk").join("slide-01.png"), b"keep").unwrap();
        assert_eq!(
            create_export_dir(&parent, "Talk").unwrap(),
            parent.join("Talk 2")
        );
        assert_eq!(
            create_export_dir(&parent, "Talk").unwrap(),
            parent.join("Talk 3")
        );
        assert_eq!(
            fs::read(parent.join("Talk").join("slide-01.png")).unwrap(),
            b"keep"
        );
    }

    #[test]
    fn export_dir_names_are_safe() {
        let parent = TempDir::new("files");
        let dir = create_export_dir(&parent, " A/B: \"why?\" <draft>. ").unwrap();
        assert_eq!(dir.file_name().unwrap(), "AB why draft");
        let dir = create_export_dir(&parent, "../..").unwrap();
        assert_eq!(dir, parent.join("presentation"));
        let dir = create_export_dir(&parent, "\t").unwrap();
        assert_eq!(dir, parent.join("presentation 2"));
    }

    #[test]
    fn export_dir_needs_an_existing_parent() {
        let parent = TempDir::new("files");
        let file = parent.join("deck.html");
        fs::write(&file, "").unwrap();
        assert!(create_export_dir(&parent.join("missing"), "Talk").is_err());
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
