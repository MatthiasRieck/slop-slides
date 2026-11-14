//! Media attached to decks: the files in the `assets/` folder next to a deck (or at the root of
//! a workspace without one), referenced from its slides as `assets/<file>`. New files get
//! slugged names that never replace one that is there.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::deck::{self, folder, resolve_in_deck};
use crate::error::{Error, Result};
use crate::html;
use crate::workspace;

/// What assets added for `id` belong to, in the workspace `root`: the workspace itself when
/// `id` is its folder, else the deck file `id` names.
pub fn target(root: &Path, id: &str) -> Result<PathBuf> {
    let path = PathBuf::from(id);
    if !workspace::inside(root, &path) {
        return Err(Error::msg("asset target outside workspace"));
    }
    if path == root || path.canonicalize()? == root.canonicalize()? {
        Ok(root.into())
    } else {
        deck::deck_file(id)
    }
}

/// The `assets/` folder of `target`, a deck file or a folder.
fn assets_dir(target: &Path) -> PathBuf {
    let dir = if target.is_dir() {
        target
    } else {
        folder(target)
    };
    dir.join("assets")
}

pub fn mime_for(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

pub fn import_assets(file: &Path, paths: Vec<String>) -> Result<Vec<String>> {
    let assets = assets_dir(file);
    fs::create_dir_all(&assets)?;
    let mut imported = Vec::new();
    for source in paths {
        let source = PathBuf::from(source);
        if !source.is_file() {
            continue;
        }
        let dest = free_asset_path(&assets, &source);
        fs::copy(&source, &dest)?;
        imported.push(asset_ref(&dest));
    }
    Ok(imported)
}

/// Takes back a file attached to a chat message that was never sent: removes `reference`
/// (`assets/<file>`, as [`import_assets`] and [`save_asset`] gave it) from the assets of
/// `target`, a deck file or a folder, unless a deck there uses it. Returns whether the file is
/// gone; an `assets/` folder left empty goes with it.
pub fn discard_asset(target: &Path, reference: &str) -> Result<bool> {
    let name = reference
        .strip_prefix("assets/")
        .filter(|name| !name.is_empty() && !name.contains(['/', '\\']) && *name != "..")
        .ok_or_else(|| Error::msg("not an attached file"))?;
    let assets = assets_dir(target);
    let file = assets.join(name);
    if !file.is_file() || used_by_a_deck(&assets, reference) {
        return Ok(false);
    }
    fs::remove_file(&file)?;
    // Only an empty folder goes: the attachment made it.
    let _ = fs::remove_dir(&assets);
    Ok(true)
}

/// Whether an HTML file beside the `assets` folder names `reference`.
fn used_by_a_deck(assets: &Path, reference: &str) -> bool {
    let Some(entries) = assets.parent().and_then(|dir| fs::read_dir(dir).ok()) else {
        return false;
    };
    entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "html"))
        .any(|path| fs::read_to_string(path).is_ok_and(|text| text.contains(reference)))
}

/// `markup` copied from the deck (or folder) `from`, for pasting into `to`: the `assets/…`
/// files it references are copied into `to`'s assets and the references point at the copies.
/// Nothing changes between decks sharing a folder; a file `to` already has with the same name
/// and contents is used as it is, and references to missing files are left alone.
pub fn bring_assets(markup: &str, from: &Path, to: &Path) -> Result<String> {
    let dir = |p: &Path| if p.is_dir() { p } else { folder(p) }.to_path_buf();
    let (from, to) = (dir(from), dir(to));
    let same = |a: &Path, b: &Path| match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    };
    if same(&from, &to) {
        return Ok(markup.to_string());
    }
    let assets = to.join("assets");
    let mut brought: HashMap<String, String> = HashMap::new();
    let mut out = String::with_capacity(markup.len());
    let mut at = 0;
    for (range, rel) in html::asset_refs(markup) {
        let new_ref = match brought.get(rel) {
            Some(new_ref) => new_ref.clone(),
            None => {
                let Some(source) = resolve_in_deck(&from, rel).ok().filter(|p| p.is_file()) else {
                    continue;
                };
                let bytes = fs::read(&source)?;
                let new_ref = asset_ref(&same_or_new_asset(&assets, &source, &bytes)?);
                brought.insert(rel.to_string(), new_ref.clone());
                new_ref
            }
        };
        out.push_str(&markup[at..range.start]);
        out.push_str(&new_ref);
        at = range.end;
    }
    out.push_str(&markup[at..]);
    Ok(out)
}

/// Writes pasted file contents (base64) into `assets/`, named after `name`; returns its ref.
pub fn save_asset(file: &Path, name: &str, data: &str) -> Result<String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|e| Error::msg(format!("invalid pasted data: {e}")))?;
    write_asset(file, name, &bytes)
}

/// Writes `bytes` into `assets/`, named after `name` (without overwriting); returns its ref.
pub fn write_asset(file: &Path, name: &str, bytes: &[u8]) -> Result<String> {
    let assets = assets_dir(file);
    fs::create_dir_all(&assets)?;
    // Only the file name counts; a pasted name must not reach outside `assets/`.
    let name = Path::new(name).file_name().unwrap_or_default();
    let dest = free_asset_path(&assets, Path::new(name));
    fs::write(&dest, bytes)?;
    Ok(asset_ref(&dest))
}

/// A path in `assets` for a file named like `source`: slugged, lowercase extension, unused.
fn free_asset_path(assets: &Path, source: &Path) -> PathBuf {
    asset_paths(assets, source)
        .find(|p| !p.exists())
        .expect("unbounded")
}

/// Paths in `assets` for a file named like `source`, in the order they are taken: slugged,
/// lowercase extension, then numbered.
fn asset_paths<'a>(assets: &'a Path, source: &Path) -> impl Iterator<Item = PathBuf> + 'a {
    let stem = html::slugify(&source.file_stem().unwrap_or_default().to_string_lossy());
    let stem = if stem.is_empty() {
        "asset".to_string()
    } else {
        stem
    };
    let ext = source
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    std::iter::once(assets.join(format!("{stem}{ext}")))
        .chain((2..).map(move |n| assets.join(format!("{stem}-{n}{ext}"))))
}

/// The asset in `assets` holding `bytes` under a name like `source`'s, writing it unless
/// an earlier copy is there.
fn same_or_new_asset(assets: &Path, source: &Path, bytes: &[u8]) -> Result<PathBuf> {
    fs::create_dir_all(assets)?;
    for path in asset_paths(assets, source) {
        match fs::read(&path) {
            Ok(existing) if existing == bytes => return Ok(path),
            Ok(_) => continue,
            Err(_) if path.exists() => continue,
            Err(_) => {
                fs::write(&path, bytes)?;
                return Ok(path);
            }
        }
    }
    unreachable!("unbounded")
}

fn asset_ref(path: &Path) -> String {
    format!("assets/{}", path.file_name().unwrap().to_string_lossy())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deck::DECK_FILE;
    use crate::test_support::TempDir;

    /// A throwaway workspace folder, removed when dropped.
    struct TempWorkspace(TempDir);

    impl TempWorkspace {
        fn new() -> Self {
            TempWorkspace(TempDir::new("assets"))
        }

        /// `<name>/deck.html`, a deck with one slide.
        fn deck(&self, name: &str) -> PathBuf {
            let dir = self.0.join(name);
            fs::create_dir_all(&dir).unwrap();
            let file = dir.join(DECK_FILE);
            fs::write(
                &file,
                "<main class=\"deck\">\n    <section class=\"slide\" id=\"a\">A</section>\n</main>",
            )
            .unwrap();
            file
        }
    }

    /// Two decks in their own folders of `dir`: `from` with `assets/Photo.PNG`.
    fn two_decks(dir: &TempWorkspace) -> (PathBuf, PathBuf) {
        let (from, to) = (dir.deck("from"), dir.deck("to"));
        fs::create_dir_all(folder(&from).join("assets")).unwrap();
        fs::write(folder(&from).join("assets/Photo.PNG"), b"photo").unwrap();
        (from, to)
    }

    #[test]
    fn copied_markup_brings_its_assets_into_another_deck() {
        let dir = TempWorkspace::new();
        let (from, to) = two_decks(&dir);
        let markup = r#"<img src="assets/Photo.PNG?v=2"><div style="background: url('./assets/Photo.PNG')"></div><img src="assets/gone.png"><a href="https://x.dev/assets/y.png">y</a>"#;
        let out = bring_assets(markup, &from, &to).unwrap();
        assert_eq!(
            out,
            r#"<img src="assets/photo.png?v=2"><div style="background: url('assets/photo.png')"></div><img src="assets/gone.png"><a href="https://x.dev/assets/y.png">y</a>"#
        );
        let assets = folder(&to).join("assets");
        assert_eq!(fs::read(assets.join("photo.png")).unwrap(), b"photo");

        // Pasting it again reuses the copy; another image of the same name gets its own.
        assert_eq!(bring_assets(markup, &from, &to).unwrap(), out);
        assert!(!assets.join("photo-2.png").exists());
        fs::write(folder(&from).join("assets/Photo.PNG"), b"another").unwrap();
        let next = bring_assets(r#"<img src="assets/Photo.PNG">"#, &from, &to).unwrap();
        assert_eq!(next, r#"<img src="assets/photo-2.png">"#);
    }

    #[test]
    fn markup_pasted_within_its_folder_is_left_alone() {
        let dir = TempWorkspace::new();
        let (from, _) = two_decks(&dir);
        let markup = r#"<img src="assets/Photo.PNG">"#;
        assert_eq!(bring_assets(markup, &from, &from).unwrap(), markup);
        assert_eq!(bring_assets(markup, &from, folder(&from)).unwrap(), markup);
        assert_eq!(
            fs::read_dir(folder(&from).join("assets")).unwrap().count(),
            1,
            "nothing is copied"
        );
    }

    #[test]
    fn mime_types() {
        assert_eq!(mime_for("deck.html"), "text/html; charset=utf-8");
        assert_eq!(mime_for("assets/PHOTO.JPG"), "image/jpeg");
        assert_eq!(mime_for("assets/a.jpeg"), "image/jpeg");
        assert_eq!(mime_for("assets/logo.svg"), "image/svg+xml");
        assert_eq!(mime_for("assets/font.woff2"), "font/woff2");
        assert_eq!(mime_for("assets/clip.webm"), "video/webm");
        assert_eq!(mime_for("assets/data.json"), "application/json");
        assert_eq!(mime_for("assets/x.tar.gz"), "application/octet-stream");
        assert_eq!(mime_for("assets/no-extension"), "application/octet-stream");
        assert_eq!(mime_for(""), "application/octet-stream");
    }

    #[test]
    fn an_unsent_attachment_is_discarded_unless_a_deck_uses_it() {
        let dir = TempWorkspace::new();
        let deck = dir.deck("talk");
        let assets = folder(&deck).join("assets");
        let wrong = write_asset(&deck, "wrong.pdf", b"pdf").unwrap();
        let used = write_asset(&deck, "photo.png", b"png").unwrap();
        fs::write(
            &deck,
            "<main class=\"deck\"><section class=\"slide\" id=\"a\"><img src=\"assets/photo.png\"></section></main>",
        )
        .unwrap();

        // A file the deck shows stays, whoever attached it.
        assert!(!discard_asset(&deck, &used).unwrap());
        assert!(assets.join("photo.png").is_file());
        assert!(discard_asset(&deck, &wrong).unwrap());
        assert!(!assets.join("wrong.pdf").exists());
        // Gone already: nothing to do.
        assert!(!discard_asset(&deck, &wrong).unwrap());
        assert!(assets.is_dir());

        // Only files of the assets folder, by their name.
        fs::write(folder(&deck).join("notes.md"), "notes").unwrap();
        for outside in [
            "notes.md",
            "assets/../notes.md",
            "assets/",
            "assets/..",
            "/etc/hosts",
        ] {
            assert!(discard_asset(&deck, outside).is_err(), "{outside}");
        }
        assert!(folder(&deck).join("notes.md").is_file());

        // The folder an attachment made goes with its last file.
        let empty = TempWorkspace::new();
        let pasted = write_asset(&empty.0, "pasted.png", b"png").unwrap();
        assert!(discard_asset(&empty.0, &pasted).unwrap());
        assert!(!empty.0.join("assets").exists());
    }

    #[test]
    fn imports_assets_with_slugged_unique_names() {
        let dir = TempWorkspace::new();
        let deck = dir.deck("talk");
        let src = dir.0.join("src");
        fs::create_dir_all(&src).unwrap();
        let photo = src.join("My Photo.PNG");
        fs::write(&photo, "png").unwrap();
        let nameless = src.join("日本.jpg");
        fs::write(&nameless, "jpg").unwrap();
        let no_ext = src.join("README");
        fs::write(&no_ext, "txt").unwrap();
        let path = |p: &PathBuf| p.to_string_lossy().into_owned();

        let imported = import_assets(
            &deck,
            vec![
                path(&photo),
                path(&photo),
                path(&nameless),
                path(&no_ext),
                path(&src.join("does-not-exist.png")),
                path(&src),
            ],
        )
        .unwrap();
        assert_eq!(
            imported,
            [
                "assets/my-photo.png",
                "assets/my-photo-2.png",
                "assets/asset.jpg",
                "assets/readme"
            ]
        );
        assert_eq!(
            fs::read_to_string(folder(&deck).join("assets/my-photo-2.png")).unwrap(),
            "png"
        );
        assert!(import_assets(&deck, vec![]).unwrap().is_empty());
    }

    #[test]
    fn saves_pasted_assets_with_unique_names() {
        let dir = TempWorkspace::new();
        let deck = dir.deck("talk");
        let assets = folder(&deck).join("assets");
        // "aGk=" is "hi".
        assert_eq!(
            save_asset(&deck, "Screen Shot.PNG", "aGk=").unwrap(),
            "assets/screen-shot.png"
        );
        assert_eq!(
            save_asset(&deck, "Screen Shot.PNG", "aGk=").unwrap(),
            "assets/screen-shot-2.png"
        );
        assert_eq!(
            fs::read_to_string(assets.join("screen-shot-2.png")).unwrap(),
            "hi"
        );
        assert_eq!(
            save_asset(&deck, "../../evil.png", "aGk=").unwrap(),
            "assets/evil.png"
        );
        assert_eq!(save_asset(&deck, "", "aGk=").unwrap(), "assets/asset");
        assert!(save_asset(&deck, "x.png", "not base64!").is_err());
        assert!(!assets.join("x.png").exists());
    }

    #[test]
    fn workspace_assets_without_a_deck() {
        let dir = TempWorkspace::new();
        assert_eq!(
            save_asset(&dir.0, "photo.png", "aGk=").unwrap(),
            "assets/photo.png"
        );
        assert_eq!(fs::read(dir.0.join("assets/photo.png")).unwrap(), b"hi");
    }

    #[test]
    fn assets_go_to_the_workspace_or_one_of_its_decks() {
        let dir = TempWorkspace::new();
        let root = dir.0.join("work");
        let deck = {
            fs::create_dir_all(&root).unwrap();
            let file = root.join("talk.html");
            fs::write(&file, "<main></main>").unwrap();
            file
        };
        let id = |p: &Path| p.to_string_lossy().into_owned();
        assert_eq!(target(&root, &id(&root)).unwrap(), root);
        assert_eq!(target(&root, &id(&root.join("."))).unwrap(), root);
        assert_eq!(target(&root, &id(&deck)).unwrap(), deck);
        let outside = dir.deck("other");
        let err = target(&root, &id(&outside)).unwrap_err().to_string();
        assert!(err.contains("outside workspace"), "{err}");
        assert!(target(&root, &id(&root.join("missing.html"))).is_err());
    }
}
