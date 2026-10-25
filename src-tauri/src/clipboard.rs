//! The system clipboard for the slide editor: copying elements, and pasting elements, images
//! and text from anywhere. The slide preview cannot reach the clipboard itself (it has no
//! editable focus to paste into), so the app does it here.
//!
//! A copied element goes onto the clipboard as HTML behind [`ELEMENT_MARKER`], with its text
//! as plain text for other apps. Pasted images are saved into the deck's `assets/`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use crate::deck;
use crate::error::{Error, Result};

/// Starts the HTML of an element copied in the slide editor; the editor's own header follows.
pub const ELEMENT_MARKER: &str = "<!--slopslides:";

/// Image files that can go on a slide.
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"];

/// What a paste brings in.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Pasted {
    /// An element copied in the slide editor: the HTML as it was copied, marker and all.
    Element {
        html: String,
    },
    /// Images, saved into the deck's assets: their `assets/…` refs.
    Images {
        images: Vec<String>,
    },
    Text {
        text: String,
    },
    Nothing,
}

/// What the clipboard holds, in the forms a paste can use.
#[derive(Default)]
pub struct Contents {
    pub html: Option<String>,
    pub files: Vec<PathBuf>,
    /// An encoded image as it was copied (PNG or JPEG), with its file extension.
    pub encoded: Option<(Vec<u8>, &'static str)>,
    /// Raw RGBA pixels: width, height, bytes.
    pub pixels: Option<(usize, usize, Vec<u8>)>,
    pub text: Option<String>,
}

/// Turns the clipboard's contents into what goes on the slide, saving images into the assets
/// next to `target` (a deck file or folder). An element copied here wins, then image files,
/// then an image, then text.
pub fn paste(contents: Contents, target: &Path) -> Result<Pasted> {
    if let Some(html) = contents.html.as_deref().and_then(copied_element) {
        return Ok(Pasted::Element {
            html: html.to_string(),
        });
    }
    let files: Vec<String> = contents
        .files
        .iter()
        .filter(|f| is_image(f))
        .map(|f| f.to_string_lossy().into_owned())
        .collect();
    if !files.is_empty() {
        let images = deck::import_assets(target, files)?;
        if !images.is_empty() {
            return Ok(Pasted::Images { images });
        }
    }
    // Copied files come with their icon as an image, which is not what was meant.
    let copied_files = !contents.files.is_empty();
    let image = match (contents.encoded, contents.pixels) {
        _ if copied_files => None,
        (Some((bytes, ext)), _) => Some((bytes, ext)),
        (None, Some((w, h, rgba))) => Some((encode_png(w, h, &rgba)?, "png")),
        _ => None,
    };
    if let Some((bytes, ext)) = image {
        let src = deck::write_asset(target, &format!("pasted-image.{ext}"), &bytes)?;
        return Ok(Pasted::Images { images: vec![src] });
    }
    match contents.text {
        Some(text) if !text.trim().is_empty() => Ok(Pasted::Text { text }),
        _ => Ok(Pasted::Nothing),
    }
}

/// The element copied in the slide editor, from the clipboard's HTML: from the marker on, without
/// the document the system may have wrapped it in (macOS puts it in `<html>…<body>…</body></html>`).
fn copied_element(html: &str) -> Option<&str> {
    let start = html.find(ELEMENT_MARKER)?;
    // Only at the start, or as the first thing in a wrapping body.
    let before = html[..start].trim();
    if !before.is_empty() && !before.ends_with("<body>") {
        return None;
    }
    let element = &html[start..];
    let element = match element.rfind("</body>") {
        Some(end) => &element[..end],
        None => element,
    };
    Some(element.trim_end())
}

fn is_image(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .is_some_and(|e| IMAGE_EXTENSIONS.contains(&e.as_str()))
}

fn encode_png(width: usize, height: usize, rgba: &[u8]) -> Result<Vec<u8>> {
    if width == 0 || height == 0 || rgba.len() != width * height * 4 {
        return Err(Error::msg("the copied image is empty or malformed"));
    }
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width as u32, height as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let fail =
        |e: png::EncodingError| Error::msg(format!("could not encode the copied image: {e}"));
    let mut writer = encoder.write_header().map_err(fail)?;
    writer.write_image_data(rgba).map_err(fail)?;
    writer.finish().map_err(fail)?;
    Ok(out)
}

// One clipboard for the app's lifetime: on Linux, what it copied is only offered while it lives.
static CLIPBOARD: Mutex<Option<arboard::Clipboard>> = Mutex::new(None);

fn with_clipboard<T>(f: impl FnOnce(&mut arboard::Clipboard) -> T) -> Result<T> {
    let mut slot = CLIPBOARD.lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_none() {
        let clipboard = arboard::Clipboard::new()
            .map_err(|e| Error::msg(format!("could not open the clipboard: {e}")))?;
        *slot = Some(clipboard);
    }
    Ok(f(slot.as_mut().expect("just set")))
}

/// Puts a copied element on the system clipboard: `html` for pasting it back, `text` for other apps.
pub fn write(html: &str, text: &str) -> Result<()> {
    with_clipboard(|c| c.set_html(html, Some(text)))?
        .map_err(|e| Error::msg(format!("could not copy: {e}")))
}

/// What the system clipboard holds now.
pub fn read() -> Result<Contents> {
    with_clipboard(|c| Contents {
        html: c.get().html().ok(),
        files: c.get().file_list().unwrap_or_default(),
        encoded: encoded_image(),
        pixels: c
            .get_image()
            .ok()
            .map(|i| (i.width, i.height, i.bytes.into_owned())),
        text: c.get_text().ok(),
    })
}

/// The PNG or JPEG a browser or screenshot put on the clipboard, as is; arboard only reads
/// TIFF on macOS, which not every app offers.
#[cfg(target_os = "macos")]
fn encoded_image() -> Option<(Vec<u8>, &'static str)> {
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::NSString;
    let pasteboard = NSPasteboard::generalPasteboard();
    [("public.png", "png"), ("public.jpeg", "jpg")]
        .into_iter()
        .find_map(|(kind, ext)| {
            let data = pasteboard.dataForType(&NSString::from_str(kind))?;
            Some((data.to_vec(), ext))
        })
}

#[cfg(not(target_os = "macos"))]
fn encoded_image() -> Option<(Vec<u8>, &'static str)> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn workspace() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("slop-clipboard-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("talk")).unwrap();
        fs::write(dir.join("talk/deck.html"), "<main class=\"deck\"></main>").unwrap();
        dir
    }

    #[test]
    fn an_element_copied_here_wins_over_everything_else() {
        let dir = workspace();
        let html = format!("{ELEMENT_MARKER}{{\"slide\":\"a\"}}--><p>Hi</p>");
        let pasted = paste(
            Contents {
                html: Some(format!("  {html}")),
                pixels: Some((1, 1, vec![0; 4])),
                text: Some("Hi".into()),
                ..Default::default()
            },
            &dir.join("talk/deck.html"),
        )
        .unwrap();
        assert_eq!(pasted, Pasted::Element { html });
        assert!(!dir.join("talk/assets").exists());
    }

    #[test]
    fn an_element_copied_here_is_found_in_the_document_macos_wraps_it_in() {
        let dir = workspace();
        // A shape has no text, so without the element there is nothing to paste.
        let html =
            format!("{ELEMENT_MARKER}{{\"slide\":\"a\"}}--><div data-added=\"shape\"></div>");
        let wrapped = format!(
            r#"<html><head><meta http-equiv="content-type" content="text/html; charset=utf-8"></head><body>{html}</body></html>"#
        );
        let pasted = paste(
            Contents {
                html: Some(wrapped),
                text: Some(String::new()),
                ..Default::default()
            },
            &dir.join("talk/deck.html"),
        )
        .unwrap();
        assert_eq!(pasted, Pasted::Element { html });
    }

    #[test]
    fn the_marker_inside_other_html_is_not_an_element() {
        let dir = workspace();
        let html = format!("<p>See {ELEMENT_MARKER}{{}}--><b>x</b></p>");
        let pasted = paste(
            Contents {
                html: Some(html),
                text: Some("See x".into()),
                ..Default::default()
            },
            &dir.join("talk/deck.html"),
        )
        .unwrap();
        assert_eq!(
            pasted,
            Pasted::Text {
                text: "See x".into()
            }
        );
    }

    #[test]
    fn html_from_elsewhere_is_pasted_as_its_text() {
        let dir = workspace();
        let pasted = paste(
            Contents {
                html: Some("<b>Bold</b> words".into()),
                text: Some("Bold words".into()),
                ..Default::default()
            },
            &dir.join("talk/deck.html"),
        )
        .unwrap();
        assert_eq!(
            pasted,
            Pasted::Text {
                text: "Bold words".into()
            }
        );
    }

    #[test]
    fn copied_image_files_are_imported_into_the_assets() {
        let dir = workspace();
        fs::write(dir.join("Photo One.JPG"), b"jpg").unwrap();
        fs::write(dir.join("notes.txt"), b"txt").unwrap();
        let pasted = paste(
            Contents {
                files: vec![
                    dir.join("Photo One.JPG"),
                    dir.join("notes.txt"),
                    dir.join("gone.png"),
                ],
                text: Some("Photo One.JPG".into()),
                ..Default::default()
            },
            &dir.join("talk/deck.html"),
        )
        .unwrap();
        assert_eq!(
            pasted,
            Pasted::Images {
                images: vec!["assets/photo-one.jpg".into()]
            }
        );
        assert_eq!(
            fs::read(dir.join("talk/assets/photo-one.jpg")).unwrap(),
            b"jpg"
        );
    }

    #[test]
    fn other_files_paste_their_names_as_text_not_their_icon() {
        let dir = workspace();
        fs::write(dir.join("notes.txt"), b"txt").unwrap();
        let pasted = paste(
            Contents {
                files: vec![dir.join("notes.txt")],
                pixels: Some((1, 1, vec![0; 4])),
                text: Some("notes.txt".into()),
                ..Default::default()
            },
            &dir.join("talk/deck.html"),
        )
        .unwrap();
        assert_eq!(
            pasted,
            Pasted::Text {
                text: "notes.txt".into()
            }
        );
    }

    #[test]
    fn an_encoded_image_is_saved_as_is() {
        let dir = workspace();
        let pasted = paste(
            Contents {
                encoded: Some((b"\x89PNG data".to_vec(), "png")),
                pixels: Some((1, 1, vec![0; 4])),
                ..Default::default()
            },
            &dir.join("talk/deck.html"),
        )
        .unwrap();
        assert_eq!(
            pasted,
            Pasted::Images {
                images: vec!["assets/pasted-image.png".into()]
            }
        );
        assert_eq!(
            fs::read(dir.join("talk/assets/pasted-image.png")).unwrap(),
            b"\x89PNG data"
        );
    }

    #[test]
    fn raw_pixels_are_saved_as_a_png_next_to_earlier_pastes() {
        let dir = workspace();
        let target = dir.join("talk/deck.html");
        let pixels = || Contents {
            pixels: Some((2, 1, vec![255, 0, 0, 255, 0, 0, 255, 128])),
            ..Default::default()
        };
        paste(pixels(), &target).unwrap();
        let pasted = paste(pixels(), &target).unwrap();
        assert_eq!(
            pasted,
            Pasted::Images {
                images: vec!["assets/pasted-image-2.png".into()]
            }
        );
        let png = fs::read(dir.join("talk/assets/pasted-image-2.png")).unwrap();
        let decoder = png::Decoder::new(std::io::Cursor::new(png));
        let info = decoder.read_info().unwrap();
        assert_eq!((info.info().width, info.info().height), (2, 1));
    }

    #[test]
    fn malformed_pixels_are_an_error() {
        let dir = workspace();
        let contents = Contents {
            pixels: Some((2, 2, vec![0; 4])),
            ..Default::default()
        };
        assert!(paste(contents, &dir.join("talk/deck.html")).is_err());
    }

    #[test]
    fn blank_or_missing_text_pastes_nothing() {
        let dir = workspace();
        let target = dir.join("talk/deck.html");
        assert_eq!(
            paste(Contents::default(), &target).unwrap(),
            Pasted::Nothing
        );
        let blank = Contents {
            text: Some(" \n ".into()),
            ..Default::default()
        };
        assert_eq!(paste(blank, &target).unwrap(), Pasted::Nothing);
    }
}
