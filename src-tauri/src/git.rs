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

use std::collections::HashMap;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::comments;
use crate::deck;
use crate::error::{Error, Result};
use crate::html;
use crate::review;
use crate::size::SizeInfo;

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
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckChanges {
    pub tracking: Tracking,
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

/// A deck's source changed, or why it could not be.
type Edited = std::result::Result<String, String>;

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

fn command(dir: &Path, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command.args(args).current_dir(dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

/// `git <args>` in `dir`: its output, or None when it failed or git is not there. Optional locks
/// are off because the user's own git may be running in the repository at the same time.
fn git(dir: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let output = command(dir, args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    output.status.success().then_some(output.stdout)
}

/// `git <args>` that changes the repository, with `input` on its stdin: its output, or what git
/// says went wrong.
fn git_write(dir: &Path, args: &[&str], input: &[u8]) -> Result<Vec<u8>> {
    let mut child = command(dir, args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::msg(format!("could not run git: {e}")))?;
    let mut stdin = child.stdin.take().expect("stdin is piped");
    let input = input.to_vec();
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    let output = child.wait_with_output()?;
    let _ = writer.join();
    if output.status.success() {
        return Ok(output.stdout);
    }
    let said = [&output.stderr, &output.stdout]
        .map(|text| String::from_utf8_lossy(text).trim().to_string());
    let said = said.into_iter().find(|text| !text.is_empty());
    Err(Error::msg(said.unwrap_or_else(|| "git failed".into())))
}

/// The closest folder of `file` that exists; a file of a commit may be gone by now, folder and all.
pub fn existing_folder(file: &Path) -> Option<&Path> {
    file.ancestors().skip(1).find(|dir| dir.is_dir())
}

/// Whether `file` stays where it says, without a `..`.
pub fn is_plain_path(file: &Path) -> bool {
    !file.components().any(|c| c == Component::ParentDir)
}

/// `file` as of the last commit, as it would be checked out, so that line endings and the like
/// do not look like changes; None when the commit does not have it.
pub fn read_at_head(file: &Path) -> Option<Vec<u8>> {
    let dir = existing_folder(file)?;
    let relative: PathBuf = file.strip_prefix(dir).ok()?.into();
    let relative = relative.to_str()?.replace('\\', "/");
    git(
        dir,
        &["cat-file", "--filters", &format!("HEAD:./{relative}")],
    )
}

/// The last commit of the repository around `dir`.
fn head_commit(dir: &Path) -> Option<Commit> {
    let out = git(dir, &["log", "-1", "--format=%h%x00%s"])?;
    let out = String::from_utf8_lossy(&out);
    let (hash, subject) = out.trim_end().split_once('\0')?;
    Some(Commit {
        hash: hash.into(),
        subject: subject.into(),
    })
}

/// The files around `dir`, relative to it, that differ from the last commit.
fn changed_files(dir: &Path) -> Vec<String> {
    let args = ["diff", "--name-only", "-z", "--relative", "HEAD", "--", "."];
    let out = git(dir, &args).unwrap_or_default();
    String::from_utf8_lossy(&out)
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(String::from)
        .collect()
}

/// The NUL-separated paths git printed.
fn paths(out: Option<Vec<u8>>) -> Vec<String> {
    String::from_utf8_lossy(&out.unwrap_or_default())
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(String::from)
        .collect()
}

/// The files around `dir`, relative to it, that differ from the index.
fn unstaged_files(dir: &Path) -> Vec<String> {
    let args = ["diff", "--name-only", "-z", "--relative", "--", "."];
    paths(git(dir, &args))
}

/// What the next commit takes in: every file of it, and those around `dir`.
fn staged_files(dir: &Path) -> (usize, usize) {
    let all = ["diff", "--cached", "--name-only", "-z"];
    let here = [
        "diff",
        "--cached",
        "--name-only",
        "-z",
        "--relative",
        "--",
        ".",
    ];
    (paths(git(dir, &all)).len(), paths(git(dir, &here)).len())
}

/// `text`, from git, with the line endings of `deck`. Checkouts can get other ones than the file
/// has (`core.autocrlf`, the default of git for Windows), and those are not changes to the deck.
fn matching_endings(text: &str, deck: &str) -> String {
    let lf = text.replace("\r\n", "\n");
    match deck.contains("\r\n") {
        true => lf.replace('\n', "\r\n"),
        false => lf,
    }
}

/// The deck as the index has it; None when it does not have it.
fn read_index(file: &Path) -> Option<String> {
    let (dir, name) = split(file).ok()?;
    let out = git(dir, &["cat-file", "--filters", &format!(":./{name}")])?;
    Some(String::from_utf8_lossy(&out).into_owned())
}

/// The deck's folder and file name.
fn split(file: &Path) -> Result<(&Path, &str)> {
    let dir = file
        .parent()
        .ok_or_else(|| Error::msg("the deck is not in a folder"))?;
    let name = file.file_name().and_then(|name| name.to_str());
    Ok((
        dir,
        name.ok_or_else(|| Error::msg("the deck's name is not text"))?,
    ))
}

/// What the deck's file is staged as from now on, without touching it on disk.
fn write_index(file: &Path, text: &str) -> Result<()> {
    let (dir, name) = split(file)?;
    let listed = git(dir, &["ls-files", "-s", "--", name]).unwrap_or_default();
    let listed = String::from_utf8_lossy(&listed);
    let mode = listed
        .split(' ')
        .next()
        .filter(|m| !m.is_empty())
        .unwrap_or("100644");
    let path = format!("--path={name}");
    let args = ["hash-object", "-w", "--stdin", &path];
    let blob = git_write(dir, &args, text.as_bytes())?;
    let blob = String::from_utf8_lossy(&blob);
    let prefix = git(dir, &["rev-parse", "--show-prefix"]).unwrap_or_default();
    let prefix = String::from_utf8_lossy(&prefix);
    let entry = format!(
        "{mode},{},{}{name}",
        blob.trim(),
        prefix.trim_end_matches('\n')
    );
    git_write(dir, &["update-index", "--add", "--cacheinfo", &entry], b"")?;
    Ok(())
}

/// The three versions of a deck.
struct Versions {
    /// The deck at the last commit; a deck never committed is its shell without any slide, so
    /// that every slide is an addition, and the shell itself is not a change.
    head: String,
    index: String,
    work: String,
    /// The last commit has the deck.
    in_head: bool,
    /// The index has the deck.
    in_index: bool,
}

/// `source` without any of its slides: what a deck not committed yet is compared with.
fn empty_deck(source: &str) -> String {
    with_slides_of(source, "")
}

fn versions(file: &Path) -> Result<Versions> {
    let work = deck::read_html(file)?;
    let committed = read_at_head(file);
    let in_head = committed.is_some();
    let head = committed.map_or_else(
        || empty_deck(&work),
        |head| matching_endings(&String::from_utf8_lossy(&head), &work),
    );
    let index = read_index(file);
    Ok(Versions {
        in_index: index.is_some(),
        index: index.map_or_else(|| head.clone(), |index| matching_endings(&index, &work)),
        work,
        head,
        in_head,
    })
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

/// Whether `a` and `b` have the same slides in the same order, whatever is between them.
fn same_slides(a: &str, b: &str) -> bool {
    let key = |source: &str| -> Vec<(String, String)> {
        snapshots(source)
            .into_iter()
            .map(|slide| (slide.id, slide.hash))
            .collect()
    };
    key(a) == key(b)
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

/// Puts the changed files around the deck that `text` refers to back as they were committed.
fn restore_assets(file: &Path, text: &str) -> Result<()> {
    let (dir, name) = split(file)?;
    let files = changed_files(dir);
    let used: Vec<&str> = files
        .iter()
        .map(String::as_str)
        .filter(|path| *path != name && text.contains(path))
        .collect();
    if used.is_empty() {
        return Ok(());
    }
    let args = ["restore", "--source=HEAD", "--staged", "--worktree", "--"];
    git_write(dir, &[args.as_slice(), used.as_slice()].concat(), b"")?;
    Ok(())
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
    // Before a first commit the shell is not a change of its own: the index gets it as it is,
    // and the deck itself once every slide is in.
    let index = match v.in_head {
        true => index,
        false if same_slides(&index, &v.work) => v.work.clone(),
        false => with_slides_of(&v.work, &index),
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

/// Takes `change` out of the index and puts the files it used back; the deck is already written.
pub fn finish_restore(file: &Path, change: &Change, before: &str) -> Result<()> {
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
        _ => Ok(()),
    }
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
        return Err(Error::msg("Write a commit message first."));
    }
    git_write(dir, &["commit", "-q", "-m", message], b"")?;
    Ok(())
}

/// The markup of the slide `id`, or nothing when `source` does not have it.
fn slide_of<'a>(source: &'a str, id: &str) -> &'a str {
    let slides = html::find_slides(source);
    let at = snapshots(source).iter().position(|slide| slide.id == id);
    at.map_or("", |at| &source[slides[at].range.clone()])
}

/// The slide of `base` that is the slide `id` of `version`.
fn locate(base: &str, version: &str, id: &str) -> Option<usize> {
    let slides = snapshots(version);
    let at = slides.iter().position(|slide| slide.id == id)?;
    match_slides(&snapshots(base), &slides)[at]
}

/// `base` with `markup` put in where it goes by the order of `from`, whose slide `at` it is:
/// after the closest slide before it that `base` also has. The slide `leaving` of `base` goes out.
fn place(base: &str, from: &str, at: usize, markup: &str, leaving: Option<usize>) -> Edited {
    let spans = html::find_slides(base);
    let matches = match_slides(&snapshots(base), &snapshots(from));
    let before = matches[..at]
        .iter()
        .rev()
        .flatten()
        .copied()
        .find(|&slide| Some(slide) != leaving);
    let next = spans
        .iter()
        .enumerate()
        .find(|(index, _)| Some(*index) != leaving)
        .map(|(_, span)| span);
    let (spot, piece) = match (before.map(|slide| &spans[slide]), next) {
        (Some(span), _) => {
            let indent = html::indent_before(base, span.range.start);
            (span.range.end, format!("\n{indent}{markup}"))
        }
        (None, Some(span)) => {
            let indent = html::indent_before(base, span.range.start);
            (span.range.start, format!("{markup}\n{indent}"))
        }
        (None, None) if leaving.is_some() => return Ok(base.to_string()),
        (None, None) => (html::end_of_deck(base)?, format!("\n    {markup}")),
    };
    let Some(out) = leaving.map(|slide| out_range(base, &spans[slide])) else {
        return Ok(format!("{}{piece}{}", &base[..spot], &base[spot..]));
    };
    Ok(if spot >= out.end {
        format!(
            "{}{}{piece}{}",
            &base[..out.start],
            &base[out.end..spot],
            &base[spot..]
        )
    } else {
        format!(
            "{}{piece}{}{}",
            &base[..spot],
            &base[spot..out.start],
            &base[out.end..]
        )
    })
}

/// A slide with the whitespace before it.
fn out_range(source: &str, span: &html::SlideSpan) -> std::ops::Range<usize> {
    source[..span.range.start].trim_end().len()..span.range.end
}

/// `base` with one slide made as it is in `from`, where it goes by `id`, or taken out when `from`
/// does not have it. `other` is that slide's version and id elsewhere, to find it in `base` by.
fn adopt_slide(base: &str, from: &str, id: Option<&str>, other: (&str, Option<&str>)) -> Edited {
    let spans = html::find_slides(base);
    let elsewhere = || other.1.and_then(|other_id| locate(base, other.0, other_id));
    let Some(id) = id else {
        return Ok(match elsewhere() {
            Some(slide) => {
                let out = out_range(base, &spans[slide]);
                format!("{}{}", &base[..out.start], &base[out.end..])
            }
            None => base.to_string(),
        });
    };
    let slides = snapshots(from);
    let at = slides
        .iter()
        .position(|slide| slide.id == id)
        .ok_or_else(|| format!("Slide not found: {id}"))?;
    Ok(match locate(base, from, id).or_else(elsewhere) {
        Some(slide) => {
            let range = spans[slide].range.clone();
            format!(
                "{}{}{}",
                &base[..range.start],
                slides[at].markup,
                &base[range.end..]
            )
        }
        None => place(base, from, at, &slides[at].markup, None)?,
    })
}

/// `base` with the slide `id` of `from` where `from` has it, as far as `base` has the same slides.
fn move_slide(base: &str, from: &str, id: &str) -> Edited {
    let at = snapshots(from)
        .iter()
        .position(|slide| slide.id == id)
        .ok_or_else(|| format!("Slide not found: {id}"))?;
    let Some(slide) = locate(base, from, id) else {
        return Ok(base.to_string());
    };
    let span = &html::find_slides(base)[slide];
    place(base, from, at, &base[span.range.clone()], Some(slide))
}

/// Where a deck's slides and section markers are, from the first to the last.
fn slides_range(source: &str) -> Option<std::ops::Range<usize>> {
    let slides = html::find_slides(source).into_iter().map(|s| s.range);
    let sections = html::find_sections(source).into_iter().map(|s| s.range);
    let ranges: Vec<_> = slides.chain(sections).collect();
    let start = ranges.iter().map(|r| r.start).min()?;
    let end = ranges.iter().map(|r| r.end).max()?;
    Some(start..end)
}

/// Everything of `shell` but its slides and section markers, which are those of `slides`.
fn with_slides_of(shell: &str, slides: &str) -> String {
    let content = slides_range(slides).map_or("", |range| &slides[range]);
    match slides_range(shell) {
        Some(range) => format!("{}{content}{}", &shell[..range.start], &shell[range.end..]),
        None => match html::end_of_deck(shell) {
            Ok(at) if !content.is_empty() => {
                format!("{}\n    {content}{}", &shell[..at], &shell[at..])
            }
            _ => shell.to_string(),
        },
    }
}

/// Whether the deck `file` is in a git repository; never when git is not installed.
pub fn in_repository(file: &Path) -> Result<bool> {
    Ok(in_work_tree(split(file)?.0))
}

fn in_work_tree(dir: &Path) -> bool {
    git(dir, &["rev-parse", "--is-inside-work-tree"]).is_some()
}

/// What changed in the deck `file` since the last commit.
pub fn changes(file: &Path) -> Result<DeckChanges> {
    let source = deck::read_html(file)?;
    let (dir, name) = split(file)?;
    let slides = snapshots(&source);
    if !in_work_tree(dir) {
        return Ok(no_repository());
    }
    // A deck in the repository but not in its last commit is compared with nothing: every slide
    // is new, and its shell is not a change of its own. Staging works all the same.
    let commit = head_commit(dir);
    let committed = commit.as_ref().and_then(|_| read_at_head(file));
    let commit = commit.filter(|_| committed.is_some());
    let committed = match committed {
        Some(head) => matching_endings(&String::from_utf8_lossy(&head), &source),
        None => empty_deck(&source),
    };
    let others = |files: Vec<String>| -> Vec<String> {
        files.into_iter().filter(|path| path != name).collect()
    };
    let assets = others(changed_files(dir));
    let old = snapshots(&committed);
    let index = read_index(file).map_or_else(
        || committed.clone(),
        |index| matching_endings(&index, &source),
    );
    let staged = snapshots(&index);
    let unstaged = others(unstaged_files(dir));
    let styles_changed = commit.is_some()
        && (shell(&committed) != shell(&source)
            || assets.iter().any(|a| strip_slides(&source).contains(a)));
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

/// New files around `dir`, relative to it, that are not ignored.
fn untracked(dir: &Path) -> Vec<String> {
    paths(git(dir, &["ls-files", "-o", "--exclude-standard", "-z"]))
}

/// Says of each row of `list`, the deck against the commit, whether the index has that change
/// already: when the deck against the index, in `against_index`, no longer shows it.
fn mark_staged(
    list: &mut [SlideChange],
    against_index: &[SlideChange],
    index: &str,
    committed: &str,
) {
    for row in list.iter_mut() {
        let Some(id) = &row.id else {
            let old_id = row.old_id.as_deref().unwrap_or("");
            row.staged = locate(index, committed, old_id).is_none();
            continue;
        };
        let now = against_index.iter().find(|r| r.id.as_ref() == Some(id));
        let same =
            now.is_some_and(|r| matches!(r.status, SlideStatus::Unchanged | SlideStatus::Moved));
        row.staged = same && matches!(row.status, SlideStatus::Added | SlideStatus::Modified);
        row.move_staged = row.moved && now.is_some_and(|r| !r.moved);
    }
}

fn no_repository() -> DeckChanges {
    DeckChanges {
        tracking: Tracking::NoRepository,
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

/// `source` without its slides.
fn strip_slides(source: &str) -> String {
    let mut rest = String::with_capacity(source.len());
    let mut at = 0;
    for slide in html::find_slides(source) {
        rest.push_str(&source[at..slide.range.start]);
        at = slide.range.end;
    }
    rest.push_str(&source[at..]);
    rest
}

/// Hash of what the slides share. The player runtime does not count: the app brings it up to date
/// by itself, and that should not show as a change to every slide.
fn shell(source: &str) -> String {
    let source = html::ensure_runtime(source);
    let spans = html::find_slides(&source);
    html::shell_hash(&source, &spans, &html::find_sections(&source))
}

/// One slide of one version of a deck.
struct Snapshot {
    id: String,
    /// Hash of its markup but for its id, which the app may have given it since.
    hash: String,
    markup: String,
    /// The parts that do not show on the slide, under the name [`SlideChange::details`] gives them.
    parts: [(&'static str, String); 5],
}

fn snapshots(source: &str) -> Vec<Snapshot> {
    html::find_slides(source)
        .iter()
        .enumerate()
        .map(|(index, span)| {
            let markup = &source[span.range.clone()];
            let unnamed = without_id(source, span);
            let attr = |attr: &Option<(std::ops::Range<usize>, String)>| {
                attr.as_ref()
                    .map(|(_, value)| value.clone())
                    .unwrap_or_default()
            };
            Snapshot {
                id: span.id.clone().unwrap_or_else(|| format!("#{}", index + 1)),
                hash: html::content_hash(&unnamed),
                markup: markup.to_string(),
                parts: [
                    ("speaker notes", html::notes(markup)),
                    ("narration", html::narration(markup)),
                    ("hidden", span.hidden.is_some().to_string()),
                    ("locked", span.locked.is_some().to_string()),
                    (
                        "timing",
                        [&span.time, &span.duration, &span.narration_start]
                            .map(attr)
                            .join(","),
                    ),
                ],
            }
        })
        .collect()
}

/// A slide's markup without its `id` attribute, however that is written.
fn without_id(source: &str, span: &html::SlideSpan) -> String {
    let markup = &source[span.range.clone()];
    let Some(id) = &span.id_value else {
        return markup.to_string();
    };
    let before = source[span.range.start..id.start].trim_end_matches(['"', '\'']);
    let name = before.trim_end().strip_suffix('=').unwrap_or(before);
    let tag = name.trim_end();
    let tag = tag[..tag.len().saturating_sub("id".len())].trim_end();
    let after = &source[id.end..span.range.end];
    format!("{tag}{}", after.trim_start_matches(['"', '\'']))
}

/// For each slide in `new`, the slide in `old` it is: by id, and failing that by content.
fn match_slides(old: &[Snapshot], new: &[Snapshot]) -> Vec<Option<usize>> {
    let mut by_id: HashMap<&str, usize> = HashMap::new();
    let mut by_hash: HashMap<&str, Vec<usize>> = HashMap::new();
    for (index, slide) in old.iter().enumerate().rev() {
        // `#2` only says where a slide without an id is; another slide may be there now.
        if !slide.id.starts_with('#') {
            by_id.insert(&slide.id, index);
        }
    }
    let mut matches: Vec<Option<usize>> = new.iter().map(|s| by_id.remove(s.id.as_str())).collect();
    for (index, slide) in old.iter().enumerate().rev() {
        if !matches.contains(&Some(index)) {
            by_hash.entry(&slide.hash).or_default().push(index);
        }
    }
    for (found, slide) in matches.iter_mut().zip(new) {
        if found.is_none() {
            *found = by_hash.get_mut(slide.hash.as_str()).and_then(Vec::pop);
        }
    }
    matches
}

/// The slides that stayed in order: the most `matches` that rise, so that moving one slide far
/// marks that slide and not all those it passed.
fn in_order(matches: &[Option<usize>]) -> Vec<bool> {
    let mut best: Vec<(usize, Option<usize>)> = Vec::with_capacity(matches.len());
    let mut last = None;
    for (i, old) in matches.iter().enumerate() {
        let before = (0..i)
            .filter(|&j| matches[j].is_some() && matches[j] < *old)
            .max_by_key(|&j| best[j].0);
        best.push((1 + before.map_or(0, |j| best[j].0), before));
        if old.is_some() && last.map_or(true, |l: usize| best[l].0 < best[i].0) {
            last = Some(i);
        }
    }
    let mut kept = vec![false; matches.len()];
    while let Some(i) = last {
        kept[i] = true;
        last = best[i].1;
    }
    kept
}

/// Every slide of `new` and `old` in deck order, each removed one after the slide it followed.
/// `assets` are the files around the deck that changed, as slides refer to them.
fn compare(old: &[Snapshot], new: &[Snapshot], assets: &[String]) -> Vec<SlideChange> {
    let matches = match_slides(old, new);
    let kept = in_order(&matches);
    let new_index: HashMap<usize, usize> = matches
        .iter()
        .enumerate()
        .filter_map(|(new, old)| old.map(|old| (old, new)))
        .collect();

    // Keyed by where each removed slide goes back in: after that slide of `new`, or at the start.
    let mut removed: HashMap<Option<usize>, Vec<SlideChange>> = HashMap::new();
    let mut after = None;
    for (index, slide) in old.iter().enumerate() {
        if let Some(&new) = new_index.get(&index) {
            after = Some(new);
            continue;
        }
        removed.entry(after).or_default().push(SlideChange {
            key: format!("removed:{index}"),
            status: SlideStatus::Removed,
            id: None,
            old_id: Some(slide.id.clone()),
            details: Vec::new(),
            moved: false,
            old_number: Some(index + 1),
            staged: false,
            move_staged: false,
        });
    }

    let mut list = removed.remove(&None).unwrap_or_default();
    for (index, slide) in new.iter().enumerate() {
        let was = matches[index].map(|i| (i, &old[i]));
        list.push(change(slide, was, kept[index], assets));
        list.extend(removed.remove(&Some(index)).unwrap_or_default());
    }
    list
}

fn change(
    slide: &Snapshot,
    old: Option<(usize, &Snapshot)>,
    in_place: bool,
    assets: &[String],
) -> SlideChange {
    let row = |status, old_id, details, moved, old_number| SlideChange {
        key: slide.id.clone(),
        status,
        id: Some(slide.id.clone()),
        old_id,
        details,
        moved,
        old_number,
        staged: false,
        move_staged: false,
    };
    let Some((index, old)) = old else {
        return row(SlideStatus::Added, None, Vec::new(), false, None);
    };
    let parts = slide.parts.iter().zip(&old.parts);
    let details: Vec<String> = parts
        .filter(|(new, old)| new.1 != old.1)
        .map(|(new, _)| new.0.to_string())
        .chain(assets.iter().filter(|a| slide.markup.contains(*a)).cloned())
        .collect();
    let status = if slide.hash != old.hash || !details.is_empty() {
        SlideStatus::Modified
    } else if in_place {
        SlideStatus::Unchanged
    } else {
        SlideStatus::Moved
    };
    row(
        status,
        Some(old.id.clone()),
        details,
        !in_place,
        Some(index + 1),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn deck(slides: &[&str]) -> String {
        deck_styled("red", slides)
    }

    fn deck_styled(color: &str, slides: &[&str]) -> String {
        let slides: Vec<String> = slides
            .iter()
            .map(|slide| match slide.split_once('=') {
                Some((id, text)) => {
                    format!("<section class=\"slide\" id=\"{id}\"><h1>{text}</h1></section>")
                }
                None => format!("<section class=\"slide\"><h1>{slide}</h1></section>"),
            })
            .collect();
        format!(
            "<!DOCTYPE html><html><head><title>Talk</title><style>h1 {{ color: {color} }}</style></head>\n<body><main class=\"deck\">\n{}\n</main></body></html>\n",
            slides.join("\n")
        )
    }

    /// `(status, id, old id)` of each row.
    fn rows(old: &str, new: &str) -> Vec<(SlideStatus, Option<String>, Option<String>)> {
        compare(&snapshots(old), &snapshots(new), &[])
            .into_iter()
            .map(|row| (row.status, row.id, row.old_id))
            .collect()
    }

    fn statuses(old: &str, new: &str) -> Vec<(SlideStatus, String)> {
        rows(old, new)
            .into_iter()
            .map(|(status, id, old_id)| (status, id.or(old_id).unwrap()))
            .collect()
    }

    use SlideStatus::{Added, Modified, Moved, Removed, Unchanged};

    fn expect(rows: &[(SlideStatus, &str)]) -> Vec<(SlideStatus, String)> {
        rows.iter().map(|(s, id)| (*s, id.to_string())).collect()
    }

    #[test]
    fn tells_added_removed_and_modified_slides_apart() {
        let old = deck(&["a=A", "b=B", "c=C"]);
        let new = deck(&["a=A", "b=Bee", "d=D"]);
        assert_eq!(
            statuses(&old, &new),
            expect(&[
                (Unchanged, "a"),
                (Modified, "b"),
                (Removed, "c"),
                (Added, "d")
            ])
        );
    }

    #[test]
    fn removed_slides_stay_where_they_were() {
        let old = deck(&["a=A", "b=B", "c=C", "d=D"]);
        assert_eq!(
            statuses(&old, &deck(&["c=C", "d=D"])),
            expect(&[
                (Removed, "a"),
                (Removed, "b"),
                (Unchanged, "c"),
                (Unchanged, "d")
            ])
        );
        assert_eq!(
            statuses(&old, &deck(&["a=A", "d=D"])),
            expect(&[
                (Unchanged, "a"),
                (Removed, "b"),
                (Removed, "c"),
                (Unchanged, "d")
            ])
        );
    }

    #[test]
    fn a_slide_moved_far_is_the_one_marked() {
        let old = deck(&["a=A", "b=B", "c=C", "d=D"]);
        let new = deck(&["d=D", "a=A", "b=B", "c=C"]);
        assert_eq!(
            statuses(&old, &new),
            expect(&[
                (Moved, "d"),
                (Unchanged, "a"),
                (Unchanged, "b"),
                (Unchanged, "c")
            ])
        );
    }

    #[test]
    fn a_changed_slide_that_moved_is_both() {
        let old = deck(&["a=A", "b=B", "c=C"]);
        let new = deck(&["c=Cee", "a=A", "b=B"]);
        let list = compare(&snapshots(&old), &snapshots(&new), &[]);
        assert_eq!(list[0].status, Modified);
        assert!(list[0].moved, "the edit must not hide the move");
        assert_eq!(list[0].old_number, Some(3));
        assert!(!list[1].moved);
    }

    #[test]
    fn a_slide_that_got_its_id_later_is_still_the_same_slide() {
        let old = deck(&["A", "B"]);
        let new = deck(&["intro=A", "plan=B"]);
        assert_eq!(
            rows(&old, &new),
            vec![
                (Unchanged, Some("intro".into()), Some("#1".into())),
                (Unchanged, Some("plan".into()), Some("#2".into())),
            ]
        );
    }

    #[test]
    fn ignores_the_id_however_it_is_written() {
        let hash = |tag: &str| {
            snapshots(&format!("<main class=\"deck\">{tag}A</section></main>"))[0]
                .hash
                .clone()
        };
        let plain = hash("<section class=\"slide\">");
        assert_eq!(hash("<section id=\"a\" class=\"slide\">"), plain);
        assert_eq!(hash("<section class=\"slide\" id='a'>"), plain);
        assert_eq!(hash("<section class=\"slide\" id = \"a\">"), plain);
        assert_eq!(hash("<section class=\"slide\" id=a>"), plain);
    }

    #[test]
    fn a_position_is_not_an_identity() {
        // The second slide of each deck is another slide, though both go by `#2`.
        let old = deck(&["A", "B"]);
        let new = deck(&["A", "C"]);
        assert_eq!(
            statuses(&old, &new),
            expect(&[(Unchanged, "#1"), (Removed, "#2"), (Added, "#2")])
        );
    }

    #[test]
    fn equal_slides_pair_up_once_each() {
        let old = deck(&["same", "same"]);
        let new = deck(&["x=same", "y=same", "z=same"]);
        assert_eq!(
            statuses(&old, &new),
            expect(&[(Unchanged, "x"), (Unchanged, "y"), (Added, "z")])
        );
    }

    #[test]
    fn names_what_the_picture_does_not_show() {
        let old = deck(&["a=A", "b=B"]);
        let new = old
            .replace(
                "<h1>A</h1>",
                "<h1>A</h1><aside class=\"notes\">Say hello</aside>",
            )
            .replace("id=\"b\"", "id=\"b\" data-hidden");
        let list = compare(&snapshots(&old), &snapshots(&new), &[]);
        assert_eq!(list[0].status, Modified);
        assert_eq!(list[0].details, ["speaker notes"]);
        assert_eq!(list[1].details, ["hidden"]);
    }

    #[test]
    fn a_slide_showing_a_changed_asset_is_modified() {
        let old = deck(&["a=<img src='assets/a.png'>", "b=B"]);
        let assets = ["assets/a.png".to_string()];
        let list = compare(&snapshots(&old), &snapshots(&old), &assets);
        assert_eq!(list[0].status, Modified);
        assert_eq!(list[0].details, assets);
        assert_eq!(list[1].status, Unchanged);
    }

    #[test]
    fn the_runtime_is_not_a_change_but_the_styles_are() {
        let plain = deck(&["a=A"]);
        assert_eq!(shell(&plain), shell(&html::ensure_runtime(&plain)));
        assert_ne!(shell(&plain), shell(&deck_styled("blue", &["a=A"])));
        assert_eq!(
            shell(&plain),
            shell(&deck(&["a=A", "b=B"])),
            "slides are not styles"
        );
    }

    #[test]
    fn plain_paths_have_no_way_up() {
        assert!(is_plain_path(Path::new("/a/b/deck.html")));
        assert!(!is_plain_path(Path::new("/a/../b/deck.html")));
    }

    /// A folder with a git repository in it, with the repository's commits made by a fixed person.
    struct Repo(PathBuf);

    impl Repo {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("slopslide-git-{}", uuid::Uuid::new_v4()));
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

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_deck_outside_a_repository_has_nothing_to_compare() {
        let root = std::env::temp_dir().join(format!("slopslide-norepo-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("deck.html");
        fs::write(&file, deck(&["a=A"])).unwrap();
        let found = changes(&file).unwrap();
        assert_eq!(found.tracking, Tracking::NoRepository);
        assert!(found.slides.is_empty());
        assert!(!in_repository(&file).unwrap());
        let _ = fs::remove_dir_all(&root);
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

    /// Applies the deck `restored` wrote, as the app does.
    fn restore(repo: &Repo, change: &Change) {
        let before = work_of(repo);
        let after = restored(&repo.deck(), change).unwrap();
        fs::write(repo.deck(), after).unwrap();
        finish_restore(&repo.deck(), change, &before).unwrap();
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
        restore(&repo, &slide("a"));
        assert_eq!(
            fs::read_to_string(repo.0.join("talk/assets/a.png")).unwrap(),
            "old"
        );
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

    #[test]
    fn matches_the_line_endings_of_the_deck() {
        assert_eq!(matching_endings("a\r\nb\n", "x\ny"), "a\nb\n");
        assert_eq!(matching_endings("a\r\nb\n", "x\r\ny"), "a\r\nb\r\n");
    }
}
