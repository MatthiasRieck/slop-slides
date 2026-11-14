//! Running the user's `git`, and reading what it gives back.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::error::{Error, Result};

use super::Commit;

fn command(dir: &Path, args: &[&str]) -> Command {
    // `git` is found on the PATH of the user's shell (see [`crate::env`]).
    crate::env::ready();
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
pub(super) fn git(dir: &Path, args: &[&str]) -> Option<Vec<u8>> {
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
pub(super) fn git_write(dir: &Path, args: &[&str], input: &[u8]) -> Result<Vec<u8>> {
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

/// The id of the last commit of the repository around `dir`; None without a repository or a
/// commit. What a commit holds never changes, so its files can be kept by this (see
/// `protocol/head.rs`).
pub fn head_oid(dir: &Path) -> Option<String> {
    let out = git(dir, &["rev-parse", "--verify", "--quiet", "HEAD"])?;
    let oid = String::from_utf8_lossy(&out).trim().to_string();
    (!oid.is_empty()).then_some(oid)
}

/// The last commit of the repository around `dir`.
pub(super) fn head_commit(dir: &Path) -> Option<Commit> {
    let out = git(dir, &["log", "-1", "--format=%h%x00%ct%x00%s"])?;
    let out = String::from_utf8_lossy(&out);
    let mut parts = out.trim_end().splitn(3, '\0');
    let (hash, time, subject) = (parts.next()?, parts.next()?, parts.next()?);
    Some(Commit {
        hash: hash.into(),
        subject: subject.into(),
        time: time.parse().ok()?,
    })
}

/// The branch checked out in the repository around `dir`, which it has before its first commit
/// too; None while a commit is checked out instead (a detached HEAD).
pub(super) fn current_branch(dir: &Path) -> Option<String> {
    let out = git(dir, &["symbolic-ref", "--short", "-q", "HEAD"])?;
    let name = String::from_utf8_lossy(&out).trim().to_string();
    (!name.is_empty()).then_some(name)
}

/// The files around `dir`, relative to it, that differ from the last commit.
pub(super) fn changed_files(dir: &Path) -> Vec<String> {
    let args = ["diff", "--name-only", "-z", "--relative", "HEAD", "--", "."];
    paths(git(dir, &args))
}

/// The NUL-separated paths git printed.
pub(super) fn paths(out: Option<Vec<u8>>) -> Vec<String> {
    String::from_utf8_lossy(&out.unwrap_or_default())
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(String::from)
        .collect()
}

/// The files around `dir`, relative to it, that differ from the index.
pub(super) fn unstaged_files(dir: &Path) -> Vec<String> {
    let args = ["diff", "--name-only", "-z", "--relative", "--", "."];
    paths(git(dir, &args))
}

/// What the next commit takes in: every file of it, and those around `dir`.
pub(super) fn staged_files(dir: &Path) -> (usize, usize) {
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
pub(super) fn matching_endings(text: &str, deck: &str) -> String {
    let lf = text.replace("\r\n", "\n");
    match deck.contains("\r\n") {
        true => lf.replace('\n', "\r\n"),
        false => lf,
    }
}

/// The deck as the index has it; None when it does not have it.
pub(super) fn read_index(file: &Path) -> Option<String> {
    let (dir, name) = split(file).ok()?;
    let out = git(dir, &["cat-file", "--filters", &format!(":./{name}")])?;
    Some(String::from_utf8_lossy(&out).into_owned())
}

/// The deck's folder and file name.
pub(super) fn split(file: &Path) -> Result<(&Path, &str)> {
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
pub(super) fn write_index(file: &Path, text: &str) -> Result<()> {
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

pub(super) fn in_work_tree(dir: &Path) -> bool {
    git(dir, &["rev-parse", "--is-inside-work-tree"]).is_some()
}

/// New files around `dir`, relative to it, that are not ignored.
pub(super) fn untracked(dir: &Path) -> Vec<String> {
    paths(git(dir, &["ls-files", "-o", "--exclude-standard", "-z"]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_line_endings_of_the_deck() {
        assert_eq!(matching_endings("a\r\nb\n", "x\ny"), "a\nb\n");
        assert_eq!(matching_endings("a\r\nb\n", "x\r\ny"), "a\r\nb\r\n");
    }
}
