//! Version control: what changed in a deck since its last commit, slide by slide, and the files
//! of that commit for the before and after comparison (see [`crate::protocol`]). Reads through
//! the user's `git`, like a terminal would; nothing here changes the repository.
//!
//! Slides are matched by id, and then by content: slides get their ids when a deck opens, so a
//! slide committed without one is still the same slide. What is left is added or removed.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

use crate::deck;
use crate::error::{Error, Result};
use crate::html;
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
}

/// `git <args>` in `dir`: its output, or None when it failed or git is not there. Optional locks
/// are off because the user's own git may be running in the repository at the same time.
fn git(dir: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(dir)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let output = command.output().ok()?;
    output.status.success().then_some(output.stdout)
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

/// What changed in the deck `file` since the last commit.
pub fn changes(file: &Path) -> Result<DeckChanges> {
    let source = deck::read_html(file)?;
    let dir = file
        .parent()
        .ok_or_else(|| Error::msg("the deck is not in a folder"))?;
    let name = file
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let slides = snapshots(&source);
    if git(dir, &["rev-parse", "--is-inside-work-tree"]).is_none() {
        return Ok(uncompared(Tracking::NoRepository, &slides));
    }
    let (Some(commit), Some(committed)) = (head_commit(dir), read_at_head(file)) else {
        return Ok(uncompared(Tracking::NotCommitted, &slides));
    };
    let committed = String::from_utf8_lossy(&committed);
    let assets: Vec<String> = changed_files(dir)
        .into_iter()
        .filter(|path| path != name)
        .collect();
    let old = snapshots(&committed);
    Ok(DeckChanges {
        tracking: Tracking::Committed,
        commit: Some(commit),
        styles_changed: shell(&committed) != shell(&source)
            || assets.iter().any(|a| strip_slides(&source).contains(a)),
        old_size: Some(html::slide_size(&committed).into()),
        slides: compare(&old, &slides, &assets),
    })
}

fn uncompared(tracking: Tracking, slides: &[Snapshot]) -> DeckChanges {
    DeckChanges {
        tracking,
        commit: None,
        styles_changed: false,
        old_size: None,
        slides: match tracking {
            Tracking::NoRepository => Vec::new(),
            _ => compare(&[], slides, &[]),
        },
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
        });
    }

    let mut list = removed.remove(&None).unwrap_or_default();
    for (index, slide) in new.iter().enumerate() {
        list.push(change(
            slide,
            matches[index].map(|i| &old[i]),
            kept[index],
            assets,
        ));
        list.extend(removed.remove(&Some(index)).unwrap_or_default());
    }
    list
}

fn change(
    slide: &Snapshot,
    old: Option<&Snapshot>,
    in_place: bool,
    assets: &[String],
) -> SlideChange {
    let Some(old) = old else {
        return SlideChange {
            key: slide.id.clone(),
            status: SlideStatus::Added,
            id: Some(slide.id.clone()),
            old_id: None,
            details: Vec::new(),
        };
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
    SlideChange {
        key: slide.id.clone(),
        status,
        id: Some(slide.id.clone()),
        old_id: Some(old.id.clone()),
        details,
    }
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
    fn a_changed_slide_counts_as_modified_even_when_it_moved() {
        let old = deck(&["a=A", "b=B"]);
        let new = deck(&["b=Bee", "a=A"]);
        assert_eq!(statuses(&old, &new)[0], (Modified, "b".into()));
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
        let _ = fs::remove_dir_all(&root);
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
}
