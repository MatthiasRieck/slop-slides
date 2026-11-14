//! Version control: what changed in a deck since its last commit, slide by slide, the files of
//! that commit for the before and after comparison (see [`crate::protocol`]), and staging,
//! restoring and committing those changes. Works through the user's `git`, like a terminal would.
//!
//! Slides are matched by id, and then by content: slides get their ids when a deck opens, so a
//! slide committed without one is still the same slide. What is left is added or removed.
//!
//! Git stages whole files, so staging one slide writes the deck as the index has it with just
//! that slide changed to the index, leaving the file on disk alone. Restoring goes the other
//! way: the deck on disk, and the index, take the slide from the commit.
//!
//! The parts: [`process`] runs git and reads what it gives back, [`diff`] compares two versions
//! of a deck slide by slide, and [`merge`] makes one version with a slide (or the styles) of
//! another; this module stages, restores and commits with them.

mod diff;
mod merge;
mod process;
mod text;

#[cfg(test)]
mod fixtures;

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::comments;
use crate::deck;
use crate::error::{Error, Result};
use crate::html;
use crate::review;
use crate::size::SizeInfo;

use diff::{compare, mark_staged, same_slides, shell, slide_of, snapshots, strip_slides};
use merge::{adopt_slide, empty_deck, move_slide, with_slides_of};
use process::{
    changed_files, current_branch, git, git_write, head_commit, in_work_tree, matching_endings,
    paths, read_index, split, staged_files, unstaged_files, untracked, write_index,
};
pub use process::{existing_folder, head_oid, read_at_head};
pub use text::TextChange;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Tracking {
    /// The deck is not in a git repository, or git is not installed.
    NoRepository,
    /// The repository has no commit with this file: every slide is new.
    NotCommitted,
    Committed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SlideStatus {
    Added,
    Removed,
    Modified,
    /// The same slide, somewhere else in the deck.
    Moved,
    Unchanged,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideChange {
    /// Tells the rows of the list apart: the slide's id, or its id at the commit once removed.
    pub key: String,
    pub status: SlideStatus,
    /// The slide's id in the deck; None for a removed slide.
    pub id: Option<String>,
    /// The slide's id at the commit; None for an added slide.
    pub old_id: Option<String>,
    /// What changed that the slide's picture may not show, such as its speaker notes.
    pub details: Vec<String>,
    /// The texts of a modified slide that changed: on the slide, in its notes, in its narration.
    pub text_changes: Vec<TextChange>,
    /// It is elsewhere in the deck than at the commit, whatever else changed.
    pub moved: bool,
    /// Its number in the deck at the commit; None for an added slide.
    pub old_number: Option<usize>,
    /// The index has the slide as it is now.
    pub staged: bool,
    /// The index has the slide where it is now.
    pub move_staged: bool,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    /// Abbreviated hash; a new commit reloads the slides shown from it.
    pub hash: String,
    pub subject: String,
    /// When it was made, in seconds since 1970.
    pub time: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckChanges {
    pub tracking: Tracking,
    /// The branch checked out, which the next commit goes to; None outside a repository and
    /// while `detached`.
    pub branch: Option<String>,
    /// A commit is checked out rather than a branch, so the next commit is on no branch.
    pub detached: bool,
    /// HEAD, when the deck is in it.
    pub commit: Option<Commit>,
    /// Something every slide shares changed, so any of them may look different.
    pub styles_changed: bool,
    /// Every slide's canvas at the commit.
    pub old_size: Option<SizeInfo>,
    /// The deck's slides in order, with the removed ones where they used to be.
    pub slides: Vec<SlideChange>,
    /// The index has the shared styles as they are now.
    pub styles_staged: bool,
    /// How many files the next commit takes in.
    pub staged_files: usize,
    /// How many of those are outside the deck's folder.
    pub staged_elsewhere: usize,
    /// The deck or its folder has something the index does not.
    pub has_unstaged: bool,
}

/// A change to stage or restore, by the ids the list has for it.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Change {
    /// A slide's content: `id` is its id in the deck, `old_id` at the commit.
    Slide {
        id: Option<String>,
        old_id: Option<String>,
    },
    /// Where a slide is.
    Move { id: String, old_id: String },
    /// What the slides share.
    Styles,
}

/// The three versions of a deck.
struct Versions {
    /// The deck at the last commit; a deck never committed is its shell without any slide, so
    /// that every slide is an addition. That shell is the index's, when it has the deck, so
    /// that what changed in it since is a change to the styles, and the deck's own otherwise.
    head: String,
    index: String,
    work: String,
    /// The last commit has the deck.
    in_head: bool,
    /// The index has the deck.
    in_index: bool,
}

fn versions(file: &Path) -> Result<Versions> {
    Ok(versions_of(file, deck::read_html(file)?))
}

/// The versions of the deck `file` that is `work` on disk.
fn versions_of(file: &Path, work: String) -> Versions {
    let committed = read_at_head(file);
    let in_head = committed.is_some();
    let index = read_index(file).map(|index| matching_endings(&index, &work));
    let head = committed.map_or_else(
        || empty_deck(index.as_deref().unwrap_or(&work)),
        |head| matching_endings(&String::from_utf8_lossy(&head), &work),
    );
    Versions {
        in_index: index.is_some(),
        index: index.unwrap_or_else(|| head.clone()),
        work,
        head,
        in_head,
    }
}

/// What the index has the deck as from now on. A deck not committed yet leaves the index again
/// once none of its slides is staged: a commit of its shell alone would be a deck of nothing.
fn update_index(file: &Path, v: &Versions, text: &str) -> Result<()> {
    if v.in_head || !html::find_slides(text).is_empty() {
        return write_index(file, text);
    }
    if v.in_index {
        let (dir, name) = split(file)?;
        git_write(dir, &["update-index", "--force-remove", "--", name], b"")?;
    }
    Ok(())
}

/// Adds the changed or new files around the deck that `text` refers to, so that a commit of it
/// does not point at images it does not have.
fn stage_assets(file: &Path, text: &str) -> Result<()> {
    let (dir, name) = split(file)?;
    let args = ["ls-files", "-m", "-o", "-d", "--exclude-standard", "-z"];
    let files = paths(git(dir, &args));
    let used: Vec<&str> = files
        .iter()
        .map(String::as_str)
        .filter(|path| *path != name && text.contains(path))
        .collect();
    if used.is_empty() {
        return Ok(());
    }
    git_write(dir, &[&["add", "-A", "--"], used.as_slice()].concat(), b"")?;
    Ok(())
}

/// Puts the changed files around the deck that `text` refers to back as they were committed, and
/// says how many: the deck's undo history does not have them, so undoing does not bring them back.
fn restore_assets(file: &Path, text: &str) -> Result<usize> {
    let (dir, name) = split(file)?;
    let files = changed_files(dir);
    let used: Vec<&str> = files
        .iter()
        .map(String::as_str)
        .filter(|path| *path != name && text.contains(path))
        .collect();
    if used.is_empty() {
        return Ok(0);
    }
    let args = ["restore", "--source=HEAD", "--staged", "--worktree", "--"];
    git_write(dir, &[args.as_slice(), used.as_slice()].concat(), b"")?;
    Ok(used.len())
}

/// Stages `change`: the index takes it from the deck.
pub fn stage(file: &Path, change: &Change) -> Result<()> {
    let v = versions(file)?;
    let index = match change {
        Change::Slide { id, old_id } => adopt_slide(
            &v.index,
            &v.work,
            id.as_deref(),
            (&v.head, old_id.as_deref()),
        ),
        Change::Move { id, .. } => move_slide(&v.index, &v.work, id),
        Change::Styles => Ok(with_slides_of(&v.work, &v.index)),
    }
    .map_err(Error::Message)?;
    // Before a first commit, the index becomes the deck itself once everything of it is in.
    let index = match !v.in_head && same_slides(&index, &v.work) && shell(&index) == shell(&v.work)
    {
        true => v.work.clone(),
        false => index,
    };
    update_index(file, &v, &index)?;
    match change {
        Change::Slide { id: Some(id), .. } => stage_assets(file, slide_of(&v.work, id)),
        Change::Styles => stage_assets(file, &strip_slides(&v.work)),
        _ => Ok(()),
    }
}

/// Takes `change` out of the index again; the deck keeps it.
pub fn unstage(file: &Path, change: &Change) -> Result<()> {
    let v = versions(file)?;
    update_index(file, &v, &without_change(&v, &v.index, change)?)
}

/// `base` with `change` as it was committed.
fn without_change(v: &Versions, base: &str, change: &Change) -> Result<String> {
    match change {
        Change::Slide { id, old_id } => {
            adopt_slide(base, &v.head, old_id.as_deref(), (&v.work, id.as_deref()))
        }
        Change::Move { old_id, .. } => move_slide(base, &v.head, old_id),
        Change::Styles => Ok(with_slides_of(&v.head, base)),
    }
    .map_err(Error::Message)
}

/// The deck on disk with `change` undone, and what its restore needs of the commit.
pub fn restored(file: &Path, change: &Change) -> Result<String> {
    let v = versions(file)?;
    let work = without_change(&v, &v.work, change)?;
    Ok(match change {
        // Comments and review marks are not styles, though they live outside the slides.
        Change::Styles => comments::write(
            &review::write(&html::ensure_runtime(&work), &review::read(&v.work)),
            &comments::read(&v.work),
        ),
        _ => work,
    })
}

/// Takes `change` out of the index and puts the files it used back, saying how many files; the
/// deck is already written.
pub fn finish_restore(file: &Path, change: &Change, before: &str) -> Result<usize> {
    let v = Versions {
        work: before.to_string(),
        ..versions(file)?
    };
    update_index(file, &v, &without_change(&v, &v.index, change)?)?;
    match change {
        Change::Slide {
            old_id: Some(id), ..
        } => restore_assets(file, slide_of(&v.head, id)),
        Change::Styles => restore_assets(file, &strip_slides(&v.head)),
        _ => Ok(0),
    }
}

/// The deck as it was committed, with every change since undone; the comments and review marks
/// made since stay, as they are no change to the slides. An error for a deck never committed,
/// which has nothing to go back to.
pub fn restored_all(file: &Path) -> Result<String> {
    let v = versions(file)?;
    if !v.in_head {
        return Err(Error::msg(
            "This deck has no saved version yet, so there is nothing to go back to.",
        ));
    }
    Ok(comments::write(
        &review::write(&html::ensure_runtime(&v.head), &review::read(&v.work)),
        &comments::read(&v.work),
    ))
}

/// Takes the deck out of the index's changes and puts the files it used back, those of the
/// commit and those of `before`, the deck as it was, saying how many files; the deck is already
/// written.
pub fn finish_restore_all(file: &Path, before: &str) -> Result<usize> {
    let v = versions(file)?;
    let (dir, name) = split(file)?;
    git_write(dir, &["reset", "-q", "--", name], b"")?;
    restore_assets(file, &format!("{}\n{before}", v.head))
}

/// Stages the whole deck and every changed file it refers to.
pub fn stage_all(file: &Path) -> Result<()> {
    let (dir, name) = split(file)?;
    git_write(dir, &["add", "--", name], b"")?;
    stage_assets(file, &deck::read_html(file)?)
}

/// Unstages everything around the deck.
pub fn unstage_all(file: &Path) -> Result<()> {
    let (dir, _) = split(file)?;
    git_write(dir, &["reset", "-q", "--", "."], b"")?;
    Ok(())
}

/// Commits what is staged.
pub fn commit(file: &Path, message: &str) -> Result<()> {
    let (dir, _) = split(file)?;
    let message = message.trim();
    if message.is_empty() {
        return Err(Error::msg("Say what changed to save a version."));
    }
    git_write(dir, &["commit", "-q", "-m", message], b"")?;
    Ok(())
}

/// Whether the deck `file` is in a git repository; never when git is not installed.
pub fn in_repository(file: &Path) -> Result<bool> {
    Ok(in_work_tree(split(file)?.0))
}

/// What changed in the deck `file` since the last commit.
pub fn changes(file: &Path) -> Result<DeckChanges> {
    let source = deck::read_html(file)?;
    let (dir, name) = split(file)?;
    let slides = snapshots(&source);
    if !in_work_tree(dir) {
        return Ok(no_repository());
    }
    // A deck in the repository but not in its last commit is compared with its shell alone:
    // every slide is new, and the shell changed once it differs from the index's. Staging
    // works all the same.
    let Versions {
        head: committed,
        index,
        work: source,
        in_head,
        ..
    } = versions_of(file, source);
    let last = head_commit(dir);
    let branch = current_branch(dir);
    // Before the first commit there is nothing to be detached at.
    let detached = branch.is_none() && last.is_some();
    let commit = last.filter(|_| in_head);
    let others = |files: Vec<String>| -> Vec<String> {
        files.into_iter().filter(|path| path != name).collect()
    };
    let assets = others(changed_files(dir));
    let old = snapshots(&committed);
    let staged = snapshots(&index);
    let unstaged = others(unstaged_files(dir));
    let styles_changed = shell(&committed) != shell(&source)
        || assets.iter().any(|a| strip_slides(&source).contains(a));
    let mut list = compare(&old, &slides, &assets);
    mark_staged(
        &mut list,
        &compare(&staged, &slides, &unstaged),
        &index,
        &committed,
    );
    let (staged_files, staged_here) = staged_files(dir);
    Ok(DeckChanges {
        tracking: match commit {
            Some(_) => Tracking::Committed,
            None => Tracking::NotCommitted,
        },
        branch,
        detached,
        old_size: commit.as_ref().map(|_| html::slide_size(&committed).into()),
        commit,
        styles_changed,
        slides: list,
        styles_staged: styles_changed
            && shell(&index) == shell(&source)
            && !unstaged.iter().any(|a| strip_slides(&source).contains(a)),
        staged_files,
        staged_elsewhere: staged_files - staged_here,
        has_unstaged: index != source || !unstaged.is_empty() || !others(untracked(dir)).is_empty(),
    })
}

fn no_repository() -> DeckChanges {
    DeckChanges {
        tracking: Tracking::NoRepository,
        branch: None,
        detached: false,
        commit: None,
        styles_changed: false,
        old_size: None,
        slides: Vec::new(),
        styles_staged: false,
        staged_files: 0,
        staged_elsewhere: 0,
        has_unstaged: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::fixtures::*;
    use crate::test_support::TempDir;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use SlideStatus::{Added, Modified, Removed, Unchanged};

    /// A folder with a git repository in it, with the repository's commits made by a fixed person.
    struct Repo(TempDir);

    impl Repo {
        fn new() -> Self {
            let root = TempDir::new("git");
            fs::create_dir_all(root.join("talk/assets")).unwrap();
            let repo = Self(root);
            repo.run(&["init", "-q"]);
            // `commit` goes by the repository's identity, and CI machines have none of their own.
            repo.run(&["config", "user.name", "Test"]);
            repo.run(&["config", "user.email", "test@example.com"]);
            repo
        }

        fn run(&self, args: &[&str]) {
            let base = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];
            let out = Command::new("git")
                .args(base)
                .args(args)
                .current_dir(&self.0)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        }

        fn commit(&self, subject: &str) {
            self.run(&["add", "-A"]);
            self.run(&["commit", "-q", "-m", subject]);
        }

        fn write(&self, path: &str, text: &str) {
            fs::write(self.0.join(path), text).unwrap();
        }

        fn deck(&self) -> PathBuf {
            self.0.join("talk/deck.html")
        }
    }

    #[test]
    fn a_deck_outside_a_repository_has_nothing_to_compare() {
        let root = TempDir::new("norepo");
        let file = root.join("deck.html");
        fs::write(&file, deck(&["a=A"])).unwrap();
        let found = changes(&file).unwrap();
        assert_eq!(found.tracking, Tracking::NoRepository);
        assert!(found.slides.is_empty());
        assert!(!in_repository(&file).unwrap());
    }

    #[test]
    fn a_deck_in_a_folder_of_a_repository_is_in_it_before_any_commit() {
        let repo = Repo::new();
        repo.write("talk/deck.html", &deck(&["a=A"]));
        assert!(in_repository(&repo.deck()).unwrap());
    }

    #[test]
    fn a_deck_never_committed_is_all_new() {
        let repo = Repo::new();
        repo.write("talk/deck.html", &deck(&["a=A"]));
        let found = changes(&repo.deck()).unwrap();
        assert_eq!(found.tracking, Tracking::NotCommitted, "no commit at all");
        assert_eq!(found.slides[0].status, Added);

        repo.write("other.txt", "x");
        repo.run(&["add", "other.txt"]);
        repo.run(&["commit", "-q", "-m", "other"]);
        let found = changes(&repo.deck()).unwrap();
        assert_eq!(found.tracking, Tracking::NotCommitted, "no commit with it");
        assert_eq!(found.slides[0].status, Added);
    }

    #[test]
    fn compares_the_deck_with_the_last_commit() {
        let repo = Repo::new();
        repo.write("talk/deck.html", &deck(&["a=A", "b=B"]));
        repo.commit("First draft");
        let clean = changes(&repo.deck()).unwrap();
        assert_eq!(clean.tracking, Tracking::Committed);
        assert_eq!(clean.commit.as_ref().unwrap().subject, "First draft");
        let made = clean.commit.as_ref().unwrap().time;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        assert!((now - made).abs() < 3600, "the commit was made just now");
        assert!(!clean.styles_changed);
        assert!(clean.slides.iter().all(|s| s.status == Unchanged));
        assert_eq!(clean.old_size.unwrap().pixel_width, 1920);

        repo.write("talk/deck.html", &deck_styled("blue", &["a=Hi", "c=C"]));
        let found = changes(&repo.deck()).unwrap();
        assert!(found.styles_changed);
        let list: Vec<_> = found
            .slides
            .iter()
            .map(|s| (s.status, s.key.as_str()))
            .collect();
        assert_eq!(
            list,
            [(Modified, "a"), (Removed, "removed:1"), (Added, "c")]
        );
        let words = &found.slides[0].text_changes;
        assert_eq!(words.len(), 1, "the modified slide says which text changed");
        assert_eq!(
            (words[0].before.as_str(), words[0].after.as_str()),
            ("A", "Hi")
        );

        repo.commit("Second draft");
        let found = changes(&repo.deck()).unwrap();
        assert_eq!(found.commit.unwrap().subject, "Second draft");
        assert!(found.slides.iter().all(|s| s.status == Unchanged));
    }

    #[test]
    fn staged_changes_are_uncommitted_too() {
        let repo = Repo::new();
        repo.write("talk/deck.html", &deck(&["a=A"]));
        repo.commit("First");
        repo.write("talk/deck.html", &deck(&["a=B"]));
        repo.run(&["add", "-A"]);
        assert_eq!(changes(&repo.deck()).unwrap().slides[0].status, Modified);
    }

    #[test]
    fn replacing_an_image_changes_the_slides_showing_it() {
        let repo = Repo::new();
        repo.write(
            "talk/deck.html",
            &deck(&["a=<img src='assets/a.png'>", "b=B"]),
        );
        repo.write("talk/assets/a.png", "old");
        repo.commit("First");
        repo.write("talk/assets/a.png", "new");
        let found = changes(&repo.deck()).unwrap();
        assert_eq!(found.slides[0].status, Modified);
        assert_eq!(found.slides[0].details, ["assets/a.png"]);
        assert_eq!(found.slides[1].status, Unchanged);
        assert!(!found.styles_changed);
    }

    #[test]
    fn replacing_a_shared_asset_changes_the_styles() {
        let repo = Repo::new();
        let source = deck(&["a=A"]).replace(
            "</style>",
            "</style><link rel=stylesheet href=assets/a.css>",
        );
        repo.write("talk/deck.html", &source);
        repo.write("talk/assets/a.css", "old");
        repo.commit("First");
        repo.write("talk/assets/a.css", "new");
        assert!(changes(&repo.deck()).unwrap().styles_changed);
    }

    #[test]
    fn reads_files_as_of_the_last_commit() {
        let repo = Repo::new();
        repo.write("talk/deck.html", "old");
        repo.write("talk/assets/gone.png", "image");
        repo.commit("First");
        repo.write("talk/deck.html", "new");
        repo.write("talk/untracked.png", "x");
        fs::remove_dir_all(repo.0.join("talk/assets")).unwrap();

        assert_eq!(read_at_head(&repo.deck()).unwrap(), b"old");
        assert_eq!(
            read_at_head(&repo.0.join("talk/assets/gone.png")).unwrap(),
            b"image",
            "the file and its folder are gone from the disk"
        );
        assert_eq!(read_at_head(&repo.0.join("talk/untracked.png")), None);
    }

    fn slide(id: &str) -> Change {
        Change::Slide {
            id: Some(id.into()),
            old_id: Some(id.into()),
        }
    }

    fn moved(id: &str) -> Change {
        Change::Move {
            id: id.into(),
            old_id: id.into(),
        }
    }

    fn index_of(repo: &Repo) -> String {
        matching_endings(&read_index(&repo.deck()).unwrap(), &work_of(repo))
    }

    fn work_of(repo: &Repo) -> String {
        fs::read_to_string(repo.deck()).unwrap()
    }

    fn ids(source: &str) -> Vec<String> {
        snapshots(source).into_iter().map(|s| s.id).collect()
    }

    fn committed(slides: &[&str], now: &[&str]) -> Repo {
        let repo = Repo::new();
        repo.write("talk/deck.html", &deck(slides));
        repo.commit("First");
        repo.write("talk/deck.html", &deck(now));
        repo
    }

    /// Applies the deck `restored` wrote, as the app does; how many files went back with it.
    fn restore(repo: &Repo, change: &Change) -> usize {
        let before = work_of(repo);
        let after = restored(&repo.deck(), change).unwrap();
        fs::write(repo.deck(), after).unwrap();
        finish_restore(&repo.deck(), change, &before).unwrap()
    }

    #[test]
    fn stages_one_modified_slide_and_leaves_the_rest() {
        let repo = committed(&["a=A", "b=B"], &["a=Ay", "b=Bee"]);
        stage(&repo.deck(), &slide("a")).unwrap();
        assert!(index_of(&repo).contains("<h1>Ay</h1>"));
        assert!(index_of(&repo).contains("<h1>B</h1>"), "b stays unstaged");
        assert_eq!(
            work_of(&repo),
            deck(&["a=Ay", "b=Bee"]),
            "the file is left alone"
        );

        let found = changes(&repo.deck()).unwrap();
        assert!(found.slides[0].staged);
        assert!(!found.slides[1].staged);
        assert_eq!(found.staged_files, 1);
        assert!(found.has_unstaged);

        unstage(&repo.deck(), &slide("a")).unwrap();
        assert_eq!(index_of(&repo), deck(&["a=A", "b=B"]));
    }

    #[test]
    fn stages_an_added_slide_in_its_place() {
        let repo = committed(&["a=A", "b=B"], &["a=A", "new=N", "b=Bee"]);
        let added = Change::Slide {
            id: Some("new".into()),
            old_id: None,
        };
        stage(&repo.deck(), &added).unwrap();
        assert_eq!(ids(&index_of(&repo)), ["a", "new", "b"]);
        assert!(changes(&repo.deck()).unwrap().slides[1].staged);
        unstage(&repo.deck(), &added).unwrap();
        assert_eq!(index_of(&repo), deck(&["a=A", "b=B"]));
    }

    #[test]
    fn stages_an_added_first_slide_first() {
        let repo = committed(&["a=A"], &["new=N", "a=A"]);
        stage(
            &repo.deck(),
            &Change::Slide {
                id: Some("new".into()),
                old_id: None,
            },
        )
        .unwrap();
        assert_eq!(index_of(&repo), deck(&["new=N", "a=A"]));
    }

    #[test]
    fn stages_a_removal() {
        let repo = committed(&["a=A", "b=B", "c=C"], &["a=A", "c=C"]);
        let gone = Change::Slide {
            id: None,
            old_id: Some("b".into()),
        };
        stage(&repo.deck(), &gone).unwrap();
        assert_eq!(index_of(&repo), deck(&["a=A", "c=C"]));
        let found = changes(&repo.deck()).unwrap();
        assert_eq!(found.slides[1].status, Removed);
        assert!(found.slides[1].staged);
        unstage(&repo.deck(), &gone).unwrap();
        assert_eq!(index_of(&repo), deck(&["a=A", "b=B", "c=C"]));
    }

    #[test]
    fn stages_a_move_apart_from_the_slides_content() {
        let repo = committed(&["a=A", "b=B", "c=C"], &["c=Cee", "a=A", "b=B"]);
        stage(&repo.deck(), &moved("c")).unwrap();
        assert_eq!(index_of(&repo), deck(&["c=C", "a=A", "b=B"]));
        let found = changes(&repo.deck()).unwrap();
        assert!(found.slides[0].move_staged);
        assert!(!found.slides[0].staged, "only its place is staged");

        stage(&repo.deck(), &slide("c")).unwrap();
        assert!(changes(&repo.deck()).unwrap().slides[0].staged);
        unstage(&repo.deck(), &moved("c")).unwrap();
        assert_eq!(index_of(&repo), deck(&["a=A", "b=B", "c=Cee"]));
    }

    #[test]
    fn restores_a_move_and_keeps_the_edit() {
        let repo = committed(&["a=A", "b=B", "c=C"], &["c=Cee", "a=A", "b=B"]);
        restore(&repo, &moved("c"));
        assert_eq!(work_of(&repo), deck(&["a=A", "b=B", "c=Cee"]));
    }

    #[test]
    fn restores_a_modified_slide_and_keeps_its_new_place() {
        let repo = committed(&["a=A", "b=B"], &["b=Bee", "a=A"]);
        restore(&repo, &slide("b"));
        assert_eq!(work_of(&repo), deck(&["b=B", "a=A"]));
    }

    #[test]
    fn restores_removed_and_added_slides() {
        let repo = committed(&["a=A", "b=B", "c=C"], &["a=A", "c=C", "new=N"]);
        restore(
            &repo,
            &Change::Slide {
                id: None,
                old_id: Some("b".into()),
            },
        );
        assert_eq!(ids(&work_of(&repo)), ["a", "b", "c", "new"]);
        restore(
            &repo,
            &Change::Slide {
                id: Some("new".into()),
                old_id: None,
            },
        );
        assert_eq!(work_of(&repo), deck(&["a=A", "b=B", "c=C"]));
    }

    #[test]
    fn restoring_takes_a_staged_change_out_of_the_index_too() {
        let repo = committed(&["a=A", "b=B"], &["a=Ay", "b=Bee"]);
        stage(&repo.deck(), &slide("a")).unwrap();
        restore(&repo, &slide("a"));
        assert_eq!(index_of(&repo), deck(&["a=A", "b=B"]));
        assert_eq!(work_of(&repo), deck(&["a=A", "b=Bee"]));
    }

    #[test]
    fn stages_and_restores_the_styles_without_the_slides() {
        let repo = Repo::new();
        repo.write("talk/deck.html", &deck(&["a=A"]));
        repo.commit("First");
        repo.write("talk/deck.html", &deck_styled("blue", &["a=Ay"]));

        stage(&repo.deck(), &Change::Styles).unwrap();
        assert_eq!(index_of(&repo), deck_styled("blue", &["a=A"]));
        assert!(changes(&repo.deck()).unwrap().styles_staged);
        unstage(&repo.deck(), &Change::Styles).unwrap();
        assert_eq!(index_of(&repo), deck(&["a=A"]));

        restore(&repo, &Change::Styles);
        let work = work_of(&repo);
        assert!(work.contains("color: red") && work.contains("<h1>Ay</h1>"));
    }

    #[test]
    fn staging_a_slide_brings_the_images_it_shows() {
        let repo = committed(
            &["a=A", "b=B"],
            &[
                "a=<img src='assets/new.png'>",
                "b=<img src='assets/other.png'>",
            ],
        );
        repo.write("talk/assets/new.png", "new");
        repo.write("talk/assets/other.png", "other");
        stage(&repo.deck(), &slide("a")).unwrap();
        let file = repo.deck();
        let (dir, _) = split(&file).unwrap();
        let staged = paths(git(
            dir,
            &["diff", "--cached", "--name-only", "-z", "--relative"],
        ));
        assert!(staged.contains(&"assets/new.png".to_string()));
        assert!(!staged.contains(&"assets/other.png".to_string()));
    }

    #[test]
    fn restoring_a_slide_brings_back_its_committed_image() {
        let repo = Repo::new();
        repo.write("talk/deck.html", &deck(&["a=<img src='assets/a.png'>"]));
        repo.write("talk/assets/a.png", "old");
        repo.commit("First");
        repo.write("talk/assets/a.png", "new");
        assert_eq!(
            restore(&repo, &slide("a")),
            1,
            "it says that a file went back, which undo does not cover"
        );
        assert_eq!(
            fs::read_to_string(repo.0.join("talk/assets/a.png")).unwrap(),
            "old"
        );
    }

    #[test]
    fn says_which_branch_is_checked_out() {
        let repo = Repo::new();
        repo.run(&["checkout", "-q", "-b", "draft"]);
        repo.write("talk/deck.html", &deck(&["a=A"]));
        let found = changes(&repo.deck()).unwrap();
        assert_eq!(found.branch.as_deref(), Some("draft"), "before any commit");
        assert!(!found.detached);

        repo.commit("First");
        repo.run(&["checkout", "-q", "-b", "talks/q3"]);
        let found = changes(&repo.deck()).unwrap();
        assert_eq!(found.branch.as_deref(), Some("talks/q3"));
        assert!(!found.detached);
    }

    #[test]
    fn says_when_a_commit_is_checked_out_instead_of_a_branch() {
        let repo = Repo::new();
        repo.write("talk/deck.html", &deck(&["a=A"]));
        repo.commit("First");
        repo.run(&["checkout", "-q", "--detach"]);
        let found = changes(&repo.deck()).unwrap();
        assert_eq!(found.branch, None);
        assert!(found.detached);
        assert_eq!(found.commit.unwrap().subject, "First", "still compared");
    }

    #[test]
    fn a_deck_outside_a_repository_is_on_no_branch() {
        let root = TempDir::new("nobranch");
        let file = root.join("deck.html");
        fs::write(&file, deck(&["a=A"])).unwrap();
        let found = changes(&file).unwrap();
        assert_eq!(found.branch, None);
        assert!(!found.detached);
    }

    /// Discards every change, as the command does: writes the deck, then tidies the index.
    fn restore_all(repo: &Repo) -> usize {
        let before = work_of(repo);
        let text = restored_all(&repo.deck()).unwrap();
        fs::write(repo.deck(), text).unwrap();
        finish_restore_all(&repo.deck(), &before).unwrap()
    }

    #[test]
    fn discards_every_change_at_once() {
        let repo = Repo::new();
        repo.write("talk/assets/pic.png", "old");
        repo.write(
            "talk/deck.html",
            &deck(&["a=<img src='assets/pic.png'>", "b=B", "c=C"]),
        );
        repo.commit("First");
        repo.write("talk/assets/pic.png", "new");
        repo.write(
            "talk/deck.html",
            &deck_styled("blue", &["c=See", "a=<img src='assets/pic.png'>", "d=D"]),
        );
        stage(&repo.deck(), &slide("c")).unwrap();

        assert_eq!(restore_all(&repo), 1, "one image went back with the deck");
        let found = changes(&repo.deck()).unwrap();
        assert!(!found.styles_changed);
        assert!(found
            .slides
            .iter()
            .all(|s| s.status == Unchanged && !s.moved));
        assert_eq!(ids(&work_of(&repo)), ["a", "b", "c"]);
        assert_eq!(found.staged_files, 0, "what was staged of it is gone too");
        let picture = fs::read_to_string(repo.0.join("talk/assets/pic.png")).unwrap();
        assert_eq!(picture, "old", "the image it showed is back as committed");
    }

    #[test]
    fn discarding_everything_leaves_staged_files_elsewhere_alone() {
        let repo = committed(&["a=A"], &["a=Ay"]);
        repo.write("notes.txt", "x");
        repo.run(&["add", "notes.txt"]);
        restore_all(&repo);
        let found = changes(&repo.deck()).unwrap();
        assert_eq!((found.staged_files, found.staged_elsewhere), (1, 1));
        assert_eq!(found.slides[0].status, Unchanged);
    }

    #[test]
    fn a_deck_never_committed_has_nothing_to_go_back_to() {
        let repo = Repo::new();
        repo.write("talk/deck.html", &deck(&["a=A"]));
        let error = restored_all(&repo.deck()).unwrap_err().to_string();
        assert!(error.contains("no saved version"), "{error}");
    }

    #[test]
    fn commits_only_what_is_staged() {
        let repo = committed(&["a=A", "b=B"], &["a=Ay", "b=Bee"]);
        stage(&repo.deck(), &slide("a")).unwrap();
        commit(&repo.deck(), "  Reword a  ").unwrap();
        let found = changes(&repo.deck()).unwrap();
        assert_eq!(found.commit.unwrap().subject, "Reword a");
        assert_eq!(found.slides[0].status, Unchanged);
        assert_eq!(found.slides[1].status, Modified);
        assert_eq!(found.staged_files, 0);
    }

    #[test]
    fn stage_all_takes_the_deck_and_its_new_images_and_unstage_all_undoes_it() {
        let repo = committed(&["a=A"], &["a=<img src='assets/new.png'>", "b=B"]);
        repo.write("talk/assets/new.png", "new");
        stage_all(&repo.deck()).unwrap();
        let found = changes(&repo.deck()).unwrap();
        assert_eq!(found.staged_files, 2);
        assert!(!found.has_unstaged);
        assert!(found.slides.iter().all(|s| s.staged));

        unstage_all(&repo.deck()).unwrap();
        assert_eq!(changes(&repo.deck()).unwrap().staged_files, 0);
    }

    #[test]
    fn a_deck_never_committed_can_be_staged_slide_by_slide() {
        let repo = Repo::new();
        repo.write(
            "talk/deck.html",
            &deck(&["a=<img src='assets/a.png'>", "b=B", "c=C"]),
        );
        repo.write("talk/assets/a.png", "image");
        let found = changes(&repo.deck()).unwrap();
        assert_eq!(found.tracking, Tracking::NotCommitted);
        assert!(found.has_unstaged, "a new deck has everything to stage");
        assert_eq!(found.staged_files, 0);
        assert!(
            !found.styles_changed,
            "a new deck's shell is not a change of its own"
        );

        stage(
            &repo.deck(),
            &Change::Slide {
                id: Some("b".into()),
                old_id: None,
            },
        )
        .unwrap();
        assert_eq!(
            ids(&index_of(&repo)),
            ["b"],
            "the index has the shell with just that slide"
        );
        let found = changes(&repo.deck()).unwrap();
        assert_eq!(found.tracking, Tracking::NotCommitted);
        let staged: Vec<_> = found.slides.iter().map(|s| (s.status, s.staged)).collect();
        assert_eq!(staged, [(Added, false), (Added, true), (Added, false)]);
        assert_eq!(found.staged_files, 1);
        assert!(found.has_unstaged);

        stage(
            &repo.deck(),
            &Change::Slide {
                id: Some("a".into()),
                old_id: None,
            },
        )
        .unwrap();
        assert_eq!(ids(&index_of(&repo)), ["a", "b"], "in the deck's order");
        assert_eq!(
            changes(&repo.deck()).unwrap().staged_files,
            2,
            "with the image it shows"
        );

        stage(
            &repo.deck(),
            &Change::Slide {
                id: Some("c".into()),
                old_id: None,
            },
        )
        .unwrap();
        assert_eq!(
            index_of(&repo),
            work_of(&repo),
            "all staged: the deck itself"
        );
        let found = changes(&repo.deck()).unwrap();
        assert!(found.slides.iter().all(|s| s.staged));
        assert!(!found.has_unstaged);

        commit(&repo.deck(), "First").unwrap();
        let found = changes(&repo.deck()).unwrap();
        assert_eq!(found.tracking, Tracking::Committed);
        assert!(found.slides.iter().all(|s| s.status == Unchanged));
    }

    #[test]
    fn a_new_decks_styles_change_once_they_differ_from_the_staged_ones() {
        let repo = Repo::new();
        repo.write("talk/deck.html", &deck_styled("red", &["a=A", "b=B"]));
        let a = Change::Slide {
            id: Some("a".into()),
            old_id: None,
        };
        stage(&repo.deck(), &a).unwrap();
        assert!(!changes(&repo.deck()).unwrap().styles_changed);

        repo.write("talk/deck.html", &deck_styled("blue", &["a=A", "b=B"]));
        let found = changes(&repo.deck()).unwrap();
        assert_eq!(found.tracking, Tracking::NotCommitted);
        assert!(found.styles_changed, "the index has the red shell");
        assert!(!found.styles_staged);
        assert!(found.slides[0].staged, "the slide itself did not change");

        stage(&repo.deck(), &Change::Styles).unwrap();
        assert!(index_of(&repo).contains("blue"));
        assert_eq!(ids(&index_of(&repo)), ["a"], "the styles alone");
        assert!(!changes(&repo.deck()).unwrap().styles_changed);

        repo.write("talk/deck.html", &deck_styled("green", &["a=A", "b=B"]));
        restore(&repo, &Change::Styles);
        assert!(work_of(&repo).contains("blue"), "back as staged");
        assert_eq!(ids(&work_of(&repo)), ["a", "b"]);
        assert!(!changes(&repo.deck()).unwrap().styles_changed);
    }

    #[test]
    fn unstaging_the_last_slide_of_a_new_deck_takes_it_out_of_the_index() {
        let repo = Repo::new();
        repo.write("talk/deck.html", &deck(&["a=A", "b=B"]));
        let a = Change::Slide {
            id: Some("a".into()),
            old_id: None,
        };
        let b = Change::Slide {
            id: Some("b".into()),
            old_id: None,
        };
        stage(&repo.deck(), &a).unwrap();
        stage(&repo.deck(), &b).unwrap();
        unstage(&repo.deck(), &a).unwrap();
        assert_eq!(ids(&index_of(&repo)), ["b"]);
        assert!(!changes(&repo.deck()).unwrap().slides[0].staged);
        unstage(&repo.deck(), &b).unwrap();
        assert_eq!(
            read_index(&repo.deck()),
            None,
            "a deck of no slides is not staged"
        );
        assert_eq!(changes(&repo.deck()).unwrap().staged_files, 0);
        unstage(&repo.deck(), &b).unwrap();
        assert_eq!(read_index(&repo.deck()), None, "unstaging again is fine");
    }

    #[test]
    fn restoring_a_slide_of_a_new_deck_takes_it_out() {
        let repo = Repo::new();
        repo.write("talk/deck.html", &deck(&["a=A", "b=B"]));
        let a = Change::Slide {
            id: Some("a".into()),
            old_id: None,
        };
        stage(&repo.deck(), &a).unwrap();
        restore(&repo, &a);
        assert_eq!(ids(&work_of(&repo)), ["b"]);
        assert_eq!(
            read_index(&repo.deck()),
            None,
            "nothing of it staged any more"
        );
        let found = changes(&repo.deck()).unwrap();
        assert_eq!(found.tracking, Tracking::NotCommitted);
        assert_eq!(found.slides.len(), 1);

        let b = Change::Slide {
            id: Some("b".into()),
            old_id: None,
        };
        restore(&repo, &b);
        assert!(ids(&work_of(&repo)).is_empty(), "the deck keeps its shell");
        assert!(changes(&repo.deck()).unwrap().slides.is_empty());
    }

    #[test]
    fn a_new_deck_in_a_repository_with_commits_stages_like_one_before_the_first() {
        let repo = Repo::new();
        repo.write("other.txt", "x");
        repo.commit("other");
        repo.write("talk/deck.html", &deck(&["a=A", "b=B"]));
        stage(
            &repo.deck(),
            &Change::Slide {
                id: Some("a".into()),
                old_id: None,
            },
        )
        .unwrap();
        let found = changes(&repo.deck()).unwrap();
        assert_eq!(found.tracking, Tracking::NotCommitted);
        assert_eq!(found.commit, None, "the commit is not of this deck");
        assert_eq!(ids(&index_of(&repo)), ["a"]);
        assert!(found.slides[0].staged && !found.slides[1].staged);
        assert!(found.has_unstaged);
    }

    #[test]
    fn stage_all_works_for_a_first_commit() {
        let repo = Repo::new();
        repo.write("talk/deck.html", &deck(&["a=A"]));
        stage_all(&repo.deck()).unwrap();
        commit(&repo.deck(), "First").unwrap();
        assert_eq!(changes(&repo.deck()).unwrap().tracking, Tracking::Committed);
    }

    #[test]
    fn says_when_the_commit_takes_in_other_folders() {
        let repo = committed(&["a=A"], &["a=Ay"]);
        repo.write("elsewhere.txt", "x");
        repo.run(&["add", "elsewhere.txt"]);
        stage_all(&repo.deck()).unwrap();
        let found = changes(&repo.deck()).unwrap();
        assert_eq!((found.staged_files, found.staged_elsewhere), (2, 1));
    }

    #[test]
    fn a_commit_needs_a_message_and_reports_what_git_says() {
        let repo = committed(&["a=A"], &["a=Ay"]);
        assert!(commit(&repo.deck(), "  ").is_err());
        let refused = commit(&repo.deck(), "Nothing staged")
            .unwrap_err()
            .to_string();
        assert!(!refused.is_empty());
        assert_eq!(
            changes(&repo.deck()).unwrap().commit.unwrap().subject,
            "First"
        );
    }

    #[test]
    fn keeps_comments_when_restoring_the_styles() {
        let repo = Repo::new();
        repo.write("talk/deck.html", &deck(&["a=A"]));
        repo.commit("First");
        let with_marks = review::write(
            &deck_styled("blue", &["a=A"]),
            &[(
                "a".to_string(),
                vec![review::Stroke {
                    tool: review::InkTool::Pen,
                    color: "#000".into(),
                    points: vec![[0.1, 0.1]],
                }],
            )]
            .into_iter()
            .collect(),
        );
        repo.write("talk/deck.html", &with_marks);
        restore(&repo, &Change::Styles);
        assert_eq!(review::read(&work_of(&repo)).len(), 1);
    }

    #[test]
    fn line_endings_are_not_changes() {
        // What git for Windows does by default: commits have LF, checkouts get CRLF. The app
        // writes the deck with LF all the same.
        let repo = Repo::new();
        repo.run(&["config", "core.autocrlf", "true"]);
        repo.write("talk/deck.html", &deck(&["a=A", "b=B"]));
        repo.commit("First");

        let clean = changes(&repo.deck()).unwrap();
        assert!(!clean.styles_changed);
        assert!(clean.slides.iter().all(|s| s.status == Unchanged));
        assert!(!clean.has_unstaged);

        repo.write("talk/deck.html", &deck(&["a=Ay", "b=B"]));
        stage(&repo.deck(), &slide("a")).unwrap();
        let found = changes(&repo.deck()).unwrap();
        assert!(found.slides[0].staged);
        assert!(!found.has_unstaged);
        assert!(!found.styles_changed);
    }
}
