//! Exports for the agent's export_deck tool (see mcp.rs): the deck as a standalone HTML file,
//! a PDF, a PowerPoint file, an MP4 video or a folder of slide images, as the Export menu makes
//! them. A standalone HTML file needs no webview, so the tool writes it itself. The others are
//! made by the app, like render_slide's images (see render.rs): the tool leaves a request in
//! the session's inbox and waits for the answer there, and the app serves the inbox while a
//! turn runs.

use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::error::{Error, Result};
use crate::inbox::{Inbox, Serving};
use crate::{capture, deck, export_window, html, pdf, render, video};

/// Longest wait for an export: a long video with narration to say takes a while.
pub const WAIT: Duration = Duration::from_secs(60 * 60);
/// Where export requests and their answers go in a session.
static INBOX: Inbox = Inbox {
    requests: "export-requests",
    results: "export-results",
};
/// The folder next to the deck that exports go to unless the agent names another place.
pub const FOLDER: &str = "exports";
/// What the hidden window is for, as its errors name it.
const TASK: &str = "exporting";

/// What a deck is exported as: the choices of the Export menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Html,
    Pdf,
    Pptx,
    Video,
    Images,
}

impl Format {
    pub const ALL: [Format; 5] = [
        Format::Html,
        Format::Pdf,
        Format::Pptx,
        Format::Video,
        Format::Images,
    ];

    /// The name the tool takes.
    pub fn name(self) -> &'static str {
        match self {
            Format::Html => "html",
            Format::Pdf => "pdf",
            Format::Pptx => "pptx",
            Format::Video => "video",
            Format::Images => "images",
        }
    }

    pub fn parse(name: &str) -> Result<Format> {
        Format::ALL
            .into_iter()
            .find(|f| f.name().eq_ignore_ascii_case(name.trim()))
            .ok_or_else(|| {
                let names: Vec<&str> = Format::ALL.iter().map(|f| f.name()).collect();
                Error::msg(format!("format is one of {}", names.join(", ")))
            })
    }

    /// The exported file's extension; None for slide images, which go in a folder.
    pub fn extension(self) -> Option<&'static str> {
        match self {
            Format::Html => Some("html"),
            Format::Pdf => Some("pdf"),
            Format::Pptx => Some("pptx"),
            Format::Video => Some("mp4"),
            Format::Images => None,
        }
    }

    /// What the export is, in words.
    pub fn label(self) -> &'static str {
        match self {
            Format::Html => "a standalone HTML file",
            Format::Pdf => "a PDF",
            Format::Pptx => "a PowerPoint file",
            Format::Video => "an MP4 video",
            Format::Images => "slide images",
        }
    }
}

/// An export the app is asked to make.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct Request {
    /// The deck file, relative to the workspace root.
    pub path: String,
    pub format: Format,
    /// Where it goes, relative to the workspace root: a file, or a folder for slide images.
    pub dest: String,
    /// How a video is made; the narration timeline's defaults when left out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video: Option<video::Options>,
}

/// What the export made, in words, or why it failed.
#[cfg(test)]
pub type Answer = crate::inbox::Answer<String>;

/// `rel` as workspace-relative parts, refusing anything that could leave the workspace.
fn parts(rel: &str) -> Result<Vec<String>> {
    let parts: Vec<String> = Path::new(rel)
        .components()
        .filter(|c| !matches!(c, Component::CurDir))
        .map(|c| match c {
            Component::Normal(part) => Ok(part.to_string_lossy().into_owned()),
            _ => Err(Error::msg(format!("invalid path: {rel}"))),
        })
        .collect::<Result<_>>()?;
    if parts.is_empty() {
        return Err(Error::msg(format!("invalid path: {rel}")));
    }
    Ok(parts)
}

/// Where the export of the deck `deck_rel` (titled `title`) as `format` goes, relative to the
/// workspace `root`: `dest` when given, with the format's extension added when it has none;
/// otherwise in the `exports` folder next to the deck, named after the deck's title. Its folder
/// is made. An existing file (or a folder of images that is not empty) is only replaced with
/// `overwrite`, and never the deck itself.
pub fn destination(
    root: &Path,
    deck_rel: &str,
    title: &str,
    format: Format,
    dest: Option<&str>,
    overwrite: bool,
) -> Result<String> {
    let mut parts = match dest.map(str::trim).filter(|d| !d.is_empty()) {
        Some(dest) => parts(dest)?,
        None => {
            let mut parts = parts(deck_rel)?;
            parts.pop();
            let name = crate::files::safe_file_name(title);
            parts.push(FOLDER.into());
            parts.push(if name.is_empty() {
                "presentation".into()
            } else {
                name
            });
            parts
        }
    };
    if let Some(ext) = format.extension() {
        let last = parts.last_mut().expect("parts are never empty");
        match Path::new(last.as_str()).extension() {
            None => last.push_str(&format!(".{ext}")),
            Some(found) if found.eq_ignore_ascii_case(ext) => {}
            Some(found) => {
                return Err(Error::msg(format!(
                    "{} export is a .{ext} file, not .{}",
                    format.label(),
                    found.to_string_lossy()
                )))
            }
        }
    }
    let rel = parts.join("/");
    let path = root.join(&rel);
    let parent = path.parent().unwrap_or(root);
    std::fs::create_dir_all(parent)?;
    if !crate::workspace::inside(root, parent) {
        return Err(Error::msg(format!("path outside workspace: {rel}")));
    }
    let deck_file = root.join(deck_rel).canonicalize().ok();
    if path.exists() && path.canonicalize().ok() == deck_file {
        return Err(Error::msg(format!(
            "{rel} is the deck itself; export it somewhere else"
        )));
    }
    match format {
        Format::Images if path.is_file() => {
            return Err(Error::msg(format!(
                "{rel} is a file; slide images go in a folder"
            )))
        }
        Format::Images => {
            let full = std::fs::read_dir(&path).is_ok_and(|mut d| d.next().is_some());
            if full && !overwrite {
                return Err(Error::msg(format!(
                    "{rel} is a folder that is not empty; pick another, or call again with overwrite: true to write the images into it"
                )));
            }
        }
        _ if path.is_dir() => return Err(Error::msg(format!("{rel} is a folder"))),
        _ if path.exists() && !overwrite => {
            return Err(Error::msg(format!(
                "{rel} exists; pick another name, or call again with overwrite: true to replace it"
            )))
        }
        _ => {}
    }
    Ok(rel)
}

/// Asks the app serving `session` for `request` and waits for its answer.
pub fn ask(session: &Path, request: &Request, wait: Duration) -> Result<String> {
    INBOX.ask(
        session,
        request,
        wait,
        "unreadable export answer",
        "The app did not finish the export in time. It only exports while a turn is running.",
    )
}

/// Drains the inbox, oldest first, skipping what cannot be read.
#[cfg(test)]
pub fn take_requests(session: &Path) -> Vec<(String, Request)> {
    INBOX.take(session)
}

#[cfg(test)]
pub fn answer(session: &Path, name: &str, answer: &Answer) -> Result<()> {
    INBOX.answer(session, name, answer)
}

/// Serves the inbox of `session` for a turn in workspace `dir`, one export at a time.
pub fn start(app: AppHandle, dir: PathBuf, session: PathBuf) -> Serving {
    INBOX.start(app, dir, session, |app, dir, request: Request| async move {
        serve(&app, &dir, &request).await
    })
}

/// Makes the export `request` asks for. Anything may write to the inbox, so its paths are
/// checked again: the destination must be in the workspace, its folder there already.
async fn serve(app: &AppHandle, dir: &Path, request: &Request) -> Result<String> {
    let file = PathBuf::from(crate::workspace::open_file(dir, &request.path)?.absolute);
    let dest = dir.join(parts(&request.dest)?.join("/"));
    if !dest
        .parent()
        .is_some_and(|parent| crate::workspace::inside(dir, parent))
    {
        return Err(Error::msg(format!(
            "path outside workspace: {}",
            request.dest
        )));
    }
    make(app, &file, request, &dest).await
}

/// Exports the deck `file` as `request` asks, to `dest`; what it made, in words.
async fn make(app: &AppHandle, file: &Path, request: &Request, dest: &Path) -> Result<String> {
    let made = match request.format {
        Format::Html => {
            deck::export(file, dest)?;
            None
        }
        Format::Pdf => {
            pdf::export(app, file, dest).await?;
            None
        }
        Format::Pptx => {
            crate::pptx::export(app, file, dest).await?;
            None
        }
        Format::Video => {
            let options = request
                .video
                .unwrap_or(crate::narration::timeline::DEFAULTS);
            video::export(app, file, dest, options, |_| {}).await?;
            None
        }
        Format::Images => Some(images(app, file, dest).await?),
    };
    Ok(report(request, made, dest))
}

/// What an export made, for the agent: the file and its size, or how many images.
pub fn report(request: &Request, images: Option<usize>, dest: &Path) -> String {
    let what = format!(
        "Exported {} as {} to {}",
        request.path,
        request.format.label(),
        request.dest
    );
    match images {
        Some(n) => format!("{what}/ ({n} image{}).", if n == 1 { "" } else { "s" }),
        None => match std::fs::metadata(dest) {
            Ok(meta) => format!("{what} ({}).", size(meta.len())),
            Err(_) => format!("{what}."),
        },
    }
}

/// A file size in words.
fn size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    let b = bytes as f64;
    if b < KB {
        format!("{bytes} bytes")
    } else if b < KB * KB {
        format!("{:.1} KB", b / KB)
    } else {
        format!("{:.1} MB", b / KB / KB)
    }
}

/// Saves every slide of the deck `file`, hidden ones too as the Export menu does, as
/// `slide-NN.png` in `dir`, the slides' canvas width, every animation finished. Images of an
/// earlier export there are replaced. How many it saved.
async fn images(app: &AppHandle, file: &Path, dir: &Path) -> Result<usize> {
    let deck = deck::load(file)?;
    let ids: Vec<String> = deck.slides.iter().map(|s| s.id.clone()).collect();
    if ids.is_empty() {
        return Err(Error::msg("this deck has no slides to export"));
    }
    std::fs::create_dir_all(dir)?;
    remove_old_images(dir);
    let (canvas, _) = html::slide_size(&deck::read_html(file)?).pixels();
    let width = capture::slide_image_width(Some(canvas));
    let (window, signals) = render::open(app, file, false)?;
    let mut helper = export_window::Helper {
        window: &window,
        signals,
        task: TASK,
    };
    let saved = async {
        helper.answer("ready").await?;
        for (i, id) in ids.iter().enumerate() {
            let shown = render::show(&mut helper, id, None)
                .await?
                .ok_or_else(|| Error::msg(format!("the deck has no slide `{id}`")))?;
            let (rect, viewport) = export_window::geometry(&shown)?;
            let png = export_window::capture(helper.window, rect, viewport, width).await?;
            std::fs::write(dir.join(crate::files::slide_image_name(i, ids.len())), png)?;
        }
        Ok(ids.len())
    }
    .await;
    let _ = window.destroy();
    saved
}

/// Removes the `slide-NN.png` images an earlier export left in `dir`, so a deck with fewer
/// slides leaves none of its old ones behind.
fn remove_old_images(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for path in entries.flatten().map(|e| e.path()) {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let number = name
            .strip_prefix("slide-")
            .and_then(|rest| rest.strip_suffix(".png"));
        if number.is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())) {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    fn workspace() -> TempDir {
        let ws = TempDir::canonical("export");
        std::fs::create_dir_all(ws.join("talk")).unwrap();
        std::fs::write(ws.join("talk/deck.html"), "<main class=\"deck\"></main>").unwrap();
        ws
    }

    fn request(format: Format) -> Request {
        Request {
            path: "talk/deck.html".into(),
            format,
            dest: "talk/exports/Talk.pdf".into(),
            video: None,
        }
    }

    #[test]
    fn formats_are_the_export_menu_choices() {
        for format in Format::ALL {
            assert_eq!(Format::parse(format.name()).unwrap(), format);
            let json = serde_json::to_string(&format).unwrap();
            assert_eq!(json, format!("\"{}\"", format.name()));
        }
        assert_eq!(Format::parse(" PDF ").unwrap(), Format::Pdf);
        let error = Format::parse("gif").unwrap_err().to_string();
        assert_eq!(error, "format is one of html, pdf, pptx, video, images");
        assert_eq!(Format::Video.extension(), Some("mp4"));
        assert_eq!(Format::Images.extension(), None);
    }

    #[test]
    fn exports_go_next_to_the_deck_named_after_its_title() {
        let ws = workspace();
        let dest = |format| destination(&ws, "talk/deck.html", "Q3: Plans?", format, None, false);
        assert_eq!(dest(Format::Pdf).unwrap(), "talk/exports/Q3 Plans.pdf");
        assert_eq!(dest(Format::Pptx).unwrap(), "talk/exports/Q3 Plans.pptx");
        assert_eq!(dest(Format::Video).unwrap(), "talk/exports/Q3 Plans.mp4");
        assert_eq!(dest(Format::Html).unwrap(), "talk/exports/Q3 Plans.html");
        assert_eq!(dest(Format::Images).unwrap(), "talk/exports/Q3 Plans");
        assert!(ws.join("talk/exports").is_dir(), "its folder is made");
        let untitled = destination(&ws, "deck.html", "", Format::Pdf, None, false);
        assert_eq!(untitled.unwrap(), "exports/presentation.pdf");
    }

    #[test]
    fn a_named_destination_gets_the_formats_extension() {
        let ws = workspace();
        let dest =
            |format, dest| destination(&ws, "talk/deck.html", "T", format, Some(dest), false);
        assert_eq!(dest(Format::Pdf, "out/handout").unwrap(), "out/handout.pdf");
        assert_eq!(
            dest(Format::Pdf, "./out/handout.PDF").unwrap(),
            "out/handout.PDF"
        );
        assert_eq!(dest(Format::Images, "out/pics").unwrap(), "out/pics");
        let wrong = dest(Format::Video, "out/talk.mov").unwrap_err().to_string();
        assert_eq!(wrong, "an MP4 video export is a .mp4 file, not .mov");
    }

    #[test]
    fn a_destination_stays_in_the_workspace() {
        let ws = workspace();
        for dest in ["../out.pdf", "/tmp/out.pdf", "talk/../../out.pdf", "."] {
            let found = destination(&ws, "talk/deck.html", "T", Format::Pdf, Some(dest), false);
            assert!(found.is_err(), "{dest} was allowed");
        }
        #[cfg(unix)]
        {
            let outside = TempDir::canonical("export");
            std::os::unix::fs::symlink(&outside, ws.join("link")).unwrap();
            let found = destination(
                &ws,
                "talk/deck.html",
                "T",
                Format::Pdf,
                Some("link/a.pdf"),
                false,
            );
            assert!(found.unwrap_err().to_string().contains("outside workspace"));
        }
    }

    #[test]
    fn an_existing_export_is_replaced_only_when_asked() {
        let ws = workspace();
        std::fs::write(ws.join("talk.pdf"), "old").unwrap();
        let dest = |overwrite| {
            destination(
                &ws,
                "talk/deck.html",
                "T",
                Format::Pdf,
                Some("talk.pdf"),
                overwrite,
            )
        };
        assert!(dest(false)
            .unwrap_err()
            .to_string()
            .contains("overwrite: true"));
        assert_eq!(dest(true).unwrap(), "talk.pdf");
        std::fs::create_dir_all(ws.join("dir.pdf")).unwrap();
        let folder = destination(
            &ws,
            "talk/deck.html",
            "T",
            Format::Pdf,
            Some("dir.pdf"),
            true,
        );
        assert!(folder.is_err(), "a folder is not replaced by a file");
    }

    #[test]
    fn the_deck_itself_is_never_overwritten() {
        let ws = workspace();
        let found = destination(
            &ws,
            "talk/deck.html",
            "T",
            Format::Html,
            Some("talk/deck.html"),
            true,
        );
        assert!(found.unwrap_err().to_string().contains("the deck itself"));
    }

    #[test]
    fn images_go_in_an_empty_folder_unless_asked() {
        let ws = workspace();
        let dest = |rel, overwrite| {
            destination(
                &ws,
                "talk/deck.html",
                "T",
                Format::Images,
                Some(rel),
                overwrite,
            )
        };
        std::fs::create_dir_all(ws.join("empty")).unwrap();
        assert_eq!(dest("empty", false).unwrap(), "empty");
        assert!(dest("talk", false).is_err());
        assert_eq!(dest("talk", true).unwrap(), "talk");
        assert!(
            dest("talk/deck.html", true).is_err(),
            "a file is not a folder"
        );
    }

    #[test]
    fn old_slide_images_are_removed_and_nothing_else() {
        let ws = TempDir::canonical("export");
        for name in [
            "slide-01.png",
            "slide-12.png",
            "slide-.png",
            "slide-a.png",
            "notes.png",
        ] {
            std::fs::write(ws.join(name), "x").unwrap();
        }
        remove_old_images(&ws);
        let mut left: Vec<String> = std::fs::read_dir(&ws)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, ["notes.png", "slide-.png", "slide-a.png"]);
    }

    #[test]
    fn video_options_travel_with_the_request() {
        let mut sent = request(Format::Video);
        sent.video = Some(video::Options {
            fps: 60,
            ..crate::narration::timeline::DEFAULTS
        });
        let json = serde_json::to_string(&sent).unwrap();
        assert_eq!(serde_json::from_str::<Request>(&json).unwrap(), sent);
        let plain: Request =
            serde_json::from_str(r#"{"path":"deck.html","format":"pdf","dest":"deck.pdf"}"#)
                .unwrap();
        assert_eq!(plain.video, None);
    }

    #[test]
    fn reports_what_it_made() {
        let ws = TempDir::canonical("export");
        let file = ws.join("a.pdf");
        std::fs::write(&file, vec![0u8; 2048]).unwrap();
        let pdf = request(Format::Pdf);
        assert_eq!(
            report(&pdf, None, &file),
            "Exported talk/deck.html as a PDF to talk/exports/Talk.pdf (2.0 KB)."
        );
        let mut images = request(Format::Images);
        images.dest = "out".into();
        assert_eq!(
            report(&images, Some(1), &ws),
            "Exported talk/deck.html as slide images to out/ (1 image)."
        );
        assert_eq!(size(10), "10 bytes");
        assert_eq!(size(3 * 1024 * 1024), "3.0 MB");
    }
}
