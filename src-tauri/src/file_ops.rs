//! What the Files tab does to the open workspace beyond opening files: it lists a folder with
//! its decks named ([`list_dir`]), finds files by name ([`search`]), renames a file or folder
//! ([`rename`]), makes a folder ([`create_folder`]), moves one to the system's trash ([`trash`]),
//! reads a text file to show it ([`read_text`]) and says whether a file may be handed to the
//! system to open ([`openable`]).
//!
//! Every path comes in workspace-relative and goes through [`workspace::resolve`], so nothing
//! here reaches outside the open folder. The folder itself is never renamed or removed, a name
//! never holds a path, and nothing is overwritten.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{Error, Result};
use crate::sessions::Sessions;
use crate::workspace::{self, Entry, FileKind};
use crate::{deck, history, html, safety};

/// The file that makes a folder a deck's folder (`<name>/deck.html`, see [`deck::create`]).
const DECK_FILE: &str = "deck.html";
/// What a new folder is called until the user names it.
const NEW_FOLDER: &str = "New folder";
/// How much of a text file the viewer shows.
pub const TEXT_PREVIEW_BYTES: u64 = 512 * 1024;
/// How many files and folders a search looks at, and how many it gives back.
const SEARCH_VISITED: usize = 20_000;
pub const SEARCH_RESULTS: usize = 200;
/// How many files of a renamed folder are looked at for a deck's history to carry over.
const MOVED_VISITED: usize = 5_000;

/// A file or folder as the Files tab lists it: a folder that is a deck's (it holds a
/// `deck.html` that is a SlopSlide deck) comes with the deck's title, and shows as the deck.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    #[serde(flatten)]
    pub entry: Entry,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deck_title: Option<String>,
}

/// The title of the deck whose folder `dir` is; None when `dir` is no deck's folder. Only the
/// start of the deck file is read, as for the file tree's kinds: a title further in than that
/// reads as the folder's name.
fn deck_title(dir: &Path) -> Option<String> {
    let file = fs::File::open(dir.join(DECK_FILE)).ok()?;
    let mut bytes = Vec::new();
    file.take(workspace::SNIFF_BYTES)
        .read_to_end(&mut bytes)
        .ok()?;
    let source = String::from_utf8_lossy(&bytes);
    if workspace::classify(&source) != FileKind::Deck {
        return None;
    }
    Some(html::title(&source).unwrap_or_else(|| {
        dir.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    }))
}

fn listed(root: &Path, entry: Entry) -> Listed {
    let deck_title = (entry.kind == FileKind::Directory)
        .then(|| deck_title(&root.join(&entry.path)))
        .flatten();
    Listed { entry, deck_title }
}

/// One folder of the workspace (see [`workspace::list_dir`]), its deck folders named.
pub fn list_dir(root: &Path, rel: &str) -> Result<Vec<Listed>> {
    let entries = workspace::list_dir(root, rel)?;
    Ok(entries
        .into_iter()
        .map(|entry| listed(root, entry))
        .collect())
}

/// The workspace-relative path of `name` in the folder `parent` (`""` for the root).
fn join(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

/// The files and folders anywhere in the workspace whose name holds `query`, and the deck
/// folders whose deck's title does, whatever the case; by path, at most [`SEARCH_RESULTS`].
/// Hidden files, folders of downloaded code and what a link leads to are not searched, and a
/// deck's `deck.html` is left to its folder, which shows as the deck. `truncated` says there
/// was more than the search looked at or gives back.
pub fn search(root: &Path, query: &str) -> Result<SearchResults> {
    let query = query.trim().to_lowercase();
    let mut found = Vec::new();
    let mut truncated = false;
    if query.is_empty() {
        return Ok(SearchResults { found, truncated });
    }
    let mut todo = vec![String::new()];
    let mut visited = 0;
    'walk: while let Some(folder) = todo.pop() {
        let Ok(dir) = workspace::resolve(root, &folder) else {
            continue;
        };
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let mut names: Vec<(String, fs::FileType)> = entries
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let name = entry.file_name().to_string_lossy().into_owned();
                (!workspace::hidden(&name)).then_some((name, entry.file_type().ok()?))
            })
            .collect();
        names.sort_by(|a, b| a.0.cmp(&b.0));
        let in_deck_folder = !folder.is_empty() && deck_title(&dir).is_some();
        for (name, kind) in names {
            visited += 1;
            if visited > SEARCH_VISITED {
                truncated = true;
                break 'walk;
            }
            if in_deck_folder && name == DECK_FILE {
                continue;
            }
            let path = join(&folder, &name);
            let title = if kind.is_dir() {
                deck_title(&dir.join(&name))
            } else {
                None
            };
            let matches = name.to_lowercase().contains(&query)
                || title
                    .as_ref()
                    .is_some_and(|title| title.to_lowercase().contains(&query));
            if matches {
                if found.len() == SEARCH_RESULTS {
                    truncated = true;
                    break 'walk;
                }
                found.push(Listed {
                    entry: Entry {
                        kind: workspace::kind_of(&dir.join(&name), Some(workspace::SNIFF_BYTES)),
                        name: name.clone(),
                        path: path.clone(),
                    },
                    deck_title: title,
                });
            }
            if kind.is_dir() && !safety::DEPENDENCY_DIRS.contains(&name.as_str()) {
                todo.push(path);
            }
        }
    }
    found.sort_by(|a, b| {
        a.entry
            .path
            .to_lowercase()
            .cmp(&b.entry.path.to_lowercase())
    });
    Ok(SearchResults { found, truncated })
}

/// What [`search`] found.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub found: Vec<Listed>,
    /// There may be more: the search stopped at its limit.
    pub truncated: bool,
}

/// `name` as a file or folder may be called: trimmed, and one name, not a path. A leading dot
/// is refused because the file tree hides such names, so the file would seem to vanish.
pub fn valid_name(name: &str) -> Result<&str> {
    let name = name.trim();
    let refuse = |why: &str| Err(Error::msg(why.to_string()));
    if name.is_empty() {
        return refuse("Give it a name.");
    }
    if name == "." || name == ".." || name.contains(['/', '\\']) {
        return refuse("A name cannot hold a slash: it is one name, not a path.");
    }
    if name.starts_with('.') {
        return refuse("A name cannot start with a dot: the file list hides such files.");
    }
    if name.contains(['<', '>', ':', '"', '|', '?', '*']) || name.chars().any(char::is_control) {
        return refuse("A name cannot hold any of < > : \" | ? *");
    }
    if name.ends_with('.') || name.contains(".tmp-") {
        return refuse("That name cannot be used. Try another one.");
    }
    Ok(name)
}

/// The existing file or folder `rel` of the workspace, which is not the workspace itself.
fn existing(root: &Path, rel: &str) -> Result<PathBuf> {
    if rel.trim_matches('/').is_empty() {
        return Err(Error::msg("The open folder itself cannot be changed here."));
    }
    workspace::resolve(root, rel)
}

/// The name of `path`, for a message.
fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Refuses to touch `path` while a deck that is it, or inside it, is open in a window: the
/// window would be left with a deck that is gone.
fn not_open(path: &Path, open_decks: &[PathBuf], to: &str) -> Result<()> {
    let path = path.canonicalize()?;
    match open_decks.iter().find(|deck| deck.starts_with(&path)) {
        Some(deck) => Err(Error::msg(format!(
            "{} is open in a window. Close that deck first, then {to}.",
            deck.strip_prefix(path.parent().unwrap_or(&path))
                .unwrap_or(deck)
                .display()
        ))),
        None => Ok(()),
    }
}

/// Renames the file or folder `rel` to `name`, in the folder it is in, and gives its new
/// workspace-relative path. Nothing is replaced: a taken name is refused. The chats and undo
/// histories of the decks renamed with it, which the app keeps by path under `home`, follow
/// them. `open_decks` are the decks open in the app's windows, which stay where they are.
pub fn rename(
    root: &Path,
    rel: &str,
    name: &str,
    open_decks: &[PathBuf],
    home: &Path,
) -> Result<String> {
    let from = existing(root, rel)?;
    let name = valid_name(name)?;
    let parent = from
        .parent()
        .ok_or_else(|| Error::msg(format!("invalid path: {rel}")))?;
    let to = parent.join(name);
    if from.file_name().is_some_and(|old| old == name) {
        return Ok(rel.to_string());
    }
    not_open(&from, open_decks, "rename it")?;
    // The same file under another spelling (a change of case where case does not count) is no
    // other file in the way.
    let same = |a: &Path, b: &Path| matches!((a.canonicalize(), b.canonicalize()), (Ok(a), Ok(b)) if a == b);
    if fs::symlink_metadata(&to).is_ok() && !same(&from, &to) {
        return Err(Error::msg(format!(
            "There is already something named {name} here. Choose another name."
        )));
    }
    let before = from.canonicalize()?;
    fs::rename(&from, &to)?;
    // What the app keeps about the decks is best effort: the rename itself has happened.
    if let Ok(after) = to.canonicalize() {
        let _ = Sessions::new(home).rehome(&before, &after);
        carry_histories(home, &before, &after);
    }
    let parent_rel = rel.rsplit_once('/').map_or("", |(parent, _)| parent);
    Ok(join(parent_rel, name))
}

/// Moves the undo history of every HTML file at or under `after`, which was at or under
/// `before` until now, to where the file is.
fn carry_histories(home: &Path, before: &Path, after: &Path) {
    let mut todo = vec![after.to_path_buf()];
    let mut visited = 0;
    while let Some(path) = todo.pop() {
        visited += 1;
        if visited > MOVED_VISITED {
            return;
        }
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            let entries = fs::read_dir(&path).into_iter().flatten().flatten();
            todo.extend(entries.map(|entry| entry.path()));
        } else if meta.is_file() && deck::is_html(&path) {
            if let Ok(rest) = path.strip_prefix(after) {
                let was = if rest.as_os_str().is_empty() {
                    before.to_path_buf()
                } else {
                    before.join(rest)
                };
                let _ = history::moved(home, &was, &path);
            }
        }
    }
}

/// Makes a folder in the folder `parent` (`""` for the workspace's root), called "New folder"
/// or, while that is taken, "New folder 2" and so on; its workspace-relative path.
pub fn create_folder(root: &Path, parent: &str) -> Result<String> {
    let parent = parent.trim_matches('/');
    let dir = workspace::resolve(root, parent)?;
    if !dir.is_dir() {
        return Err(Error::msg(format!("not a folder: {parent}")));
    }
    let name = (1..)
        .map(|n| match n {
            1 => NEW_FOLDER.to_string(),
            n => format!("{NEW_FOLDER} {n}"),
        })
        .find(|name| fs::symlink_metadata(dir.join(name)).is_err())
        .expect("an unused name");
    fs::create_dir(dir.join(&name))?;
    Ok(join(parent, &name))
}

/// Takes the file or folder `rel` out of the workspace with `remove`, which moves it to the
/// system's trash (so it can be put back from there). `open_decks` are the decks open in the
/// app's windows: one of them, or a folder holding one, stays.
pub fn trash(
    root: &Path,
    rel: &str,
    open_decks: &[PathBuf],
    remove: impl FnOnce(&Path) -> Result<()>,
) -> Result<()> {
    let path = existing(root, rel)?;
    not_open(&path, open_decks, "move it to the trash")?;
    remove(&path)
}

/// A text file's content, for the viewer.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPreview {
    pub text: String,
    /// The file is longer than what is shown.
    pub truncated: bool,
}

/// The start of the file `rel` as text, at most `limit` bytes of it. A file that is not text
/// (it holds a zero byte, or is not UTF-8) is refused, for the viewer to say there is no preview.
pub fn read_text(root: &Path, rel: &str, limit: u64) -> Result<TextPreview> {
    let path = existing(root, rel)?;
    if !path.is_file() {
        return Err(Error::msg(format!("not a file: {rel}")));
    }
    let mut bytes = Vec::new();
    fs::File::open(&path)?
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    let truncated = bytes.len() as u64 > limit;
    bytes.truncate(limit as usize);
    if bytes.contains(&0) {
        return Err(Error::msg("This file is not text."));
    }
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        // A cut in the middle of a character is no sign of anything; what comes before it is text.
        Err(error) if truncated && error.utf8_error().error_len().is_none() => {
            let valid = error.utf8_error().valid_up_to();
            String::from_utf8_lossy(&error.as_bytes()[..valid]).into_owned()
        }
        Err(_) => return Err(Error::msg("This file is not text.")),
    };
    Ok(TextPreview { text, truncated })
}

/// Kinds of file that run when opened, by extension: the app never hands these to the system.
const RUNNABLE: &[&str] = &[
    "app",
    "command",
    "tool",
    "terminal",
    "workflow",
    "action",
    "scpt",
    "scptd",
    "applescript",
    "sh",
    "bash",
    "zsh",
    "fish",
    "csh",
    "exe",
    "com",
    "bat",
    "cmd",
    "msi",
    "msp",
    "scr",
    "pif",
    "ps1",
    "vbs",
    "vbe",
    "js",
    "jse",
    "wsf",
    "wsh",
    "hta",
    "cpl",
    "lnk",
    "reg",
    "jar",
    "desktop",
    "appimage",
    "run",
    "bin",
    "py",
    "pl",
    "rb",
    "php",
];

/// The file `rel`, when it may be handed to the system to open in the app it opens in by
/// default. Refused: a folder, and a file that would run rather than show (a script, a program,
/// anything marked executable), since the agent may have written it.
pub fn openable(root: &Path, rel: &str) -> Result<PathBuf> {
    let path = existing(root, rel)?.canonicalize()?;
    let name = name_of(&path);
    let extension = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let meta = fs::metadata(&path)?;
    #[cfg(unix)]
    let executable = {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    };
    #[cfg(not(unix))]
    let executable = false;
    if !meta.is_file() || executable || RUNNABLE.contains(&extension.as_str()) {
        return Err(Error::msg(format!(
            "{name} can run as a program, so SlopSlide does not open it. Show it in the file manager to open it yourself."
        )));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::{Change, Source};
    use crate::test_support::TempDir;

    const DECK: &str = "<html><head><title>Q3 board update</title></head><body><main class=\"deck\"></main></body></html>";

    fn paths(found: &[Listed]) -> Vec<&str> {
        found.iter().map(|l| l.entry.path.as_str()).collect()
    }

    #[test]
    fn a_deck_folder_is_listed_with_its_decks_title() {
        let t = TempDir::new("ops");
        t.write("untitled-deck-7/deck.html", DECK);
        t.write(
            "no-title/deck.html",
            "<html><body><main class=\"deck\"></main></body></html>",
        );
        t.write("site/deck.html", "<h1>Not a deck</h1>");
        t.write("assets/a.png", "png");
        t.write("notes.md", "# notes");
        let root = list_dir(&t, "").unwrap();
        let titles: Vec<_> = root
            .iter()
            .map(|l| (l.entry.name.as_str(), l.deck_title.as_deref()))
            .collect();
        assert_eq!(
            titles,
            [
                ("assets", None),
                ("no-title", Some("no-title")),
                ("site", None),
                ("untitled-deck-7", Some("Q3 board update")),
                ("notes.md", None),
            ]
        );
        // As the frontend reads it: the entry's own fields, and the title only where there is one.
        let json = serde_json::to_value(&root).unwrap();
        assert_eq!(
            json[3],
            serde_json::json!({ "name": "untitled-deck-7", "path": "untitled-deck-7", "kind": "directory", "deckTitle": "Q3 board update" })
        );
        assert_eq!(
            json[4],
            serde_json::json!({ "name": "notes.md", "path": "notes.md", "kind": "file" })
        );
        assert!(list_dir(&t, "../x").is_err());
    }

    #[test]
    fn search_finds_names_and_deck_titles_anywhere() {
        let t = TempDir::new("ops");
        t.write("untitled-deck-7/deck.html", DECK);
        t.write("untitled-deck-7/assets/board.png", "png");
        t.write("talks/2026/Board notes.md", "x");
        t.write("talks/readme.txt", "x");
        t.write(".git/board", "x");
        t.write("node_modules/board/index.js", "x");
        let results = search(&t, "  BOARD ").unwrap();
        assert_eq!(
            paths(&results.found),
            [
                "talks/2026/Board notes.md",
                "untitled-deck-7",
                "untitled-deck-7/assets/board.png",
            ]
        );
        assert!(!results.truncated);
        assert_eq!(
            results.found[1].deck_title.as_deref(),
            Some("Q3 board update")
        );
        assert_eq!(results.found[1].entry.kind, FileKind::Directory);
        // A deck's file is its folder's row; the folder of downloaded code is found, not searched.
        assert_eq!(
            paths(&search(&t, "deck").unwrap().found),
            ["untitled-deck-7"]
        );
        assert_eq!(paths(&search(&t, "node").unwrap().found), ["node_modules"]);
        assert_eq!(paths(&search(&t, "index").unwrap().found), [] as [&str; 0]);
        assert!(search(&t, "   ").unwrap().found.is_empty());
    }

    #[test]
    fn search_stops_at_its_limit_and_says_so() {
        let t = TempDir::new("ops");
        for n in 0..SEARCH_RESULTS + 5 {
            t.write(format!("file-{n:04}.txt"), "x");
        }
        let results = search(&t, "file").unwrap();
        assert_eq!(results.found.len(), SEARCH_RESULTS);
        assert!(results.truncated);
    }

    #[cfg(unix)]
    #[test]
    fn search_does_not_follow_links_out_of_the_workspace() {
        let outside = TempDir::new("ops-outside");
        outside.write("secret-plan.txt", "x");
        let t = TempDir::new("ops");
        t.write("plan.txt", "x");
        std::os::unix::fs::symlink(outside.path(), t.join("link")).unwrap();
        assert_eq!(paths(&search(&t, "plan").unwrap().found), ["plan.txt"]);
    }

    #[test]
    fn names_are_one_plain_name() {
        assert_eq!(valid_name("  Q3 board.md ").unwrap(), "Q3 board.md");
        for bad in [
            "",
            "  ",
            ".",
            "..",
            "a/b",
            "a\\b",
            "../x",
            ".hidden",
            "a:b",
            "what?",
            "x.tmp-1",
            "dot.",
            "new\nline",
        ] {
            assert!(valid_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn renames_in_place_and_never_over_something() {
        let t = TempDir::new("ops");
        let home = TempDir::new("ops-home");
        t.write("talks/a.md", "a");
        t.write("talks/b.md", "b");
        assert_eq!(
            rename(&t, "talks/a.md", "c.md", &[], &home).unwrap(),
            "talks/c.md"
        );
        assert!(t.join("talks/c.md").is_file() && !t.join("talks/a.md").exists());
        // A taken name is refused, and both files stay as they are.
        let taken = rename(&t, "talks/c.md", "b.md", &[], &home).unwrap_err();
        assert!(taken.to_string().contains("already"), "{taken}");
        assert_eq!(fs::read_to_string(t.join("talks/b.md")).unwrap(), "b");
        assert_eq!(fs::read_to_string(t.join("talks/c.md")).unwrap(), "a");
        // Its own name changes nothing; a folder renames with what it holds.
        assert_eq!(
            rename(&t, "talks/c.md", " c.md ", &[], &home).unwrap(),
            "talks/c.md"
        );
        assert_eq!(
            rename(&t, "talks", "Talks 2026", &[], &home).unwrap(),
            "Talks 2026"
        );
        assert!(t.join("Talks 2026/b.md").is_file());
    }

    #[test]
    fn nothing_reaches_outside_the_workspace_or_takes_the_workspace_itself() {
        let outer = TempDir::new("ops-outer");
        outer.write("ws/a.md", "a");
        outer.write("other.md", "o");
        let root = outer.join("ws");
        let home = TempDir::new("ops-home");
        let removed = std::cell::Cell::new(false);
        let remove = |_: &Path| {
            removed.set(true);
            Ok(())
        };
        for bad in [
            "",
            "/",
            "..",
            "../other.md",
            "a.md/../../other.md",
            "missing.md",
        ] {
            assert!(rename(&root, bad, "x.md", &[], &home).is_err(), "{bad:?}");
            assert!(trash(&root, bad, &[], remove).is_err(), "{bad:?}");
            assert!(read_text(&root, bad, 10).is_err(), "{bad:?}");
            assert!(openable(&root, bad).is_err(), "{bad:?}");
        }
        for bad in ["..", "../x", "missing", "a.md"] {
            assert!(create_folder(&root, bad).is_err(), "{bad:?}");
        }
        for bad in ["../x.md", "sub/x.md", "..", "/tmp/x"] {
            assert!(rename(&root, "a.md", bad, &[], &home).is_err(), "{bad:?}");
        }
        assert!(!removed.get());
        assert!(outer.join("other.md").is_file() && root.join("a.md").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_out_of_the_workspace_is_not_followed() {
        let outside = TempDir::new("ops-outside");
        outside.write("secret.txt", "s");
        let t = TempDir::new("ops");
        let home = TempDir::new("ops-home");
        std::os::unix::fs::symlink(outside.path(), t.join("link")).unwrap();
        assert!(read_text(&t, "link/secret.txt", 10).is_err());
        assert!(rename(&t, "link/secret.txt", "mine.txt", &[], &home).is_err());
        assert!(create_folder(&t, "link").is_err());
        assert!(outside.join("secret.txt").is_file());
    }

    #[test]
    fn a_renamed_decks_history_and_chat_follow_it() {
        let t = TempDir::canonical("ops");
        let home = TempDir::new("ops-home");
        let file = t.write("untitled-deck/deck.html", DECK);
        history::checkpoint(&home, &file).unwrap();
        fs::write(&file, DECK.replace("Q3", "Q4")).unwrap();
        history::record(&home, &file, &Change::new(Source::Edit, "Rename")).unwrap();
        let sessions = Sessions::new(&home);
        let session = sessions.start(&file).unwrap();

        assert_eq!(
            rename(&t, "untitled-deck", "q4-board", &[], &home).unwrap(),
            "q4-board"
        );
        let moved = t.join("q4-board/deck.html");
        assert!(history::status(&home, &moved, false)
            .unwrap()
            .undo
            .is_some());
        assert_eq!(sessions.current(&moved), Some(session));
        assert_eq!(sessions.current(&file), None);
    }

    #[test]
    fn an_open_deck_stays_where_it_is() {
        let t = TempDir::canonical("ops");
        let home = TempDir::new("ops-home");
        let file = t.write("talk/deck.html", DECK);
        t.write("other/deck.html", DECK);
        let open = [file.clone()];
        let remove = |path: &Path| Ok(fs::remove_dir_all(path)?);
        for rel in ["talk", "talk/deck.html"] {
            let refused = rename(&t, rel, "x", &open, &home).unwrap_err();
            assert!(
                refused.to_string().contains("Close that deck first"),
                "{refused}"
            );
            assert!(trash(&t, rel, &open, remove).is_err());
        }
        assert!(file.is_file());
        // What holds no open deck goes.
        trash(&t, "other", &open, remove).unwrap();
        assert!(!t.join("other").exists());
    }

    #[test]
    fn new_folders_take_the_first_free_name() {
        let t = TempDir::new("ops");
        t.write("talks/a.md", "a");
        assert_eq!(create_folder(&t, "").unwrap(), "New folder");
        assert_eq!(create_folder(&t, "").unwrap(), "New folder 2");
        assert_eq!(create_folder(&t, "talks/").unwrap(), "talks/New folder");
        assert!(t.join("talks/New folder").is_dir() && t.join("New folder 2").is_dir());
    }

    #[test]
    fn trash_hands_over_the_path_inside_the_workspace() {
        let t = TempDir::new("ops");
        let file = t.write("old/notes.md", "x");
        let mut gone = None;
        trash(&t, "old/notes.md", &[], |path| {
            gone = Some(path.to_path_buf());
            Ok(())
        })
        .unwrap();
        assert_eq!(gone, Some(file));
    }

    #[test]
    fn reads_text_up_to_a_limit_and_refuses_what_is_not_text() {
        let t = TempDir::new("ops");
        t.write("a.md", "# Title\nText");
        t.write("long.txt", "aé".repeat(10));
        t.write("image.bin", [0x89, b'P', b'N', b'G', 0, 1, 2]);
        t.write("latin1.txt", [b'a', 0xE9, b'b']);
        assert_eq!(
            read_text(&t, "a.md", 100).unwrap(),
            TextPreview {
                text: "# Title\nText".into(),
                truncated: false
            }
        );
        // Cut inside the two-byte é: the text ends before it.
        let cut = read_text(&t, "long.txt", 5).unwrap();
        assert_eq!((cut.text.as_str(), cut.truncated), ("aéa", true));
        assert!(read_text(&t, "image.bin", 100).is_err());
        assert!(read_text(&t, "latin1.txt", 100).is_err());
        assert!(read_text(&t, "", 100).is_err());
    }

    #[test]
    fn only_files_that_show_are_handed_to_the_system() {
        let t = TempDir::canonical("ops");
        let pdf = t.write("report.pdf", "%PDF");
        t.write("run.command", "#!/bin/sh");
        t.write("Setup.EXE", "MZ");
        t.write("folder/a.txt", "a");
        assert_eq!(openable(&t, "report.pdf").unwrap(), pdf);
        for refused in ["run.command", "Setup.EXE", "folder"] {
            assert!(openable(&t, refused).is_err(), "{refused}");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let tool = t.write("tool", "#!/bin/sh");
            fs::set_permissions(&tool, fs::Permissions::from_mode(0o755)).unwrap();
            assert!(openable(&t, "tool").is_err());
        }
    }
}
