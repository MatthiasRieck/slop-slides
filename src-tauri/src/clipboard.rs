//! The system clipboard for the slide editor: copying elements, and pasting elements, images
//! and text from anywhere. The slide preview cannot reach the clipboard itself (it has no
//! editable focus to paste into), so the app does it here.
//!
//! A copied element goes onto the clipboard as HTML behind [`ELEMENT_MARKER`], copied slides
//! behind [`SLIDE_MARKER`], each with its text as plain text for other apps. Their headers name
//! the deck they came from, so pasting them into another deck (in another window, say) brings
//! the `assets/…` files they show along. Pasted images are saved into the deck's `assets/`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use crate::capture;
use crate::deck;
use crate::error::{Error, Result};
use crate::find;
use crate::html;

/// Starts the HTML of an element copied in the slide editor; the editor's own JSON header
/// follows, with the deck it came from added (see [`with_source`]).
pub const ELEMENT_MARKER: &str = "<!--slopslides:";

/// Starts the HTML of the slides copied from the slide rail; a JSON header follows naming the
/// deck they came from (`{"deck": <deck file>, "slides": [<id>, …]}`), then the slides' markup,
/// one after the other in deck order.
pub const SLIDE_MARKER: &str = "<!--slopslides-slide:";

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
    /// Slides copied from the slide rail; they go in as new slides (see [`read_slides`]).
    Slide,
    Nothing,
}

/// The slides copied from the slide rail.
#[derive(Debug, Clone, PartialEq)]
pub struct CopiedSlides {
    /// The deck file they came from, if the header names one.
    pub deck: Option<PathBuf>,
    /// The markup of each slide, in the order they were in the deck.
    pub slides: Vec<String>,
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
/// next to `target` (a deck file or folder). An element or slides copied here win, then image
/// files, then an image, then text. An element from another deck brings its assets along.
pub fn paste(contents: Contents, target: &Path) -> Result<Pasted> {
    let html = contents.html.as_deref();
    if let Some(element) = html.and_then(|h| copied(h, ELEMENT_MARKER)) {
        return Ok(Pasted::Element {
            html: localized_element(element, target)?,
        });
    }
    if html.and_then(|h| copied(h, SLIDE_MARKER)).is_some() {
        return Ok(Pasted::Slide);
    }
    let files: Vec<String> = contents
        .files
        .iter()
        .filter(|f| is_image(f))
        .map(|f| f.to_string_lossy().into_owned())
        .collect();
    if !files.is_empty() {
        let images = crate::assets::import_assets(target, files)?;
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
        let src = crate::assets::write_asset(target, &format!("pasted-image.{ext}"), &bytes)?;
        return Ok(Pasted::Images { images: vec![src] });
    }
    match contents.text {
        Some(text) if !text.trim().is_empty() => Ok(Pasted::Text { text }),
        _ => Ok(Pasted::Nothing),
    }
}

/// What was copied here behind `marker`, from the clipboard's HTML: from the marker on, without
/// the document the system may have wrapped it in (macOS puts it in `<html>…<body>…</body></html>`).
fn copied<'a>(html: &'a str, marker: &str) -> Option<&'a str> {
    let start = html.find(marker)?;
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

/// The JSON header of `clip` (which starts with `marker`) and where what was copied starts.
fn split_header(clip: &str, marker: &str) -> Option<(serde_json::Value, usize)> {
    let rest = clip.strip_prefix(marker)?;
    let end = rest.find("-->")?;
    let header = serde_json::from_str(&rest[..end]).ok()?;
    Some((header, marker.len() + end + 3))
}

/// A header as JSON that cannot end the comment it is in: `>` only appears inside JSON
/// strings, where `\u003e` stands for it.
fn header_json(header: &serde_json::Value) -> String {
    header.to_string().replace('>', "\\u003e")
}

/// The deck file a header names, when it is one.
fn source_deck(header: &serde_json::Value) -> Option<PathBuf> {
    header["deck"]
        .as_str()
        .and_then(|deck| deck::deck_file(deck).ok())
}

/// An element copied in the slide editor with the deck file it came from added to its header.
pub fn with_source(html: &str, deck: &Path) -> String {
    match split_header(html, ELEMENT_MARKER) {
        Some((serde_json::Value::Object(mut header), at)) => {
            header.insert("deck".into(), deck.to_string_lossy().into_owned().into());
            let header = header_json(&serde_json::Value::Object(header));
            format!("{ELEMENT_MARKER}{header}-->{}", &html[at..])
        }
        _ => html.to_string(),
    }
}

/// A copied element as it pastes into `target`: with the assets it shows brought along from
/// the deck it came from.
fn localized_element(element: &str, target: &Path) -> Result<String> {
    let Some((header, at)) = split_header(element, ELEMENT_MARKER) else {
        return Ok(element.to_string());
    };
    let Some(source) = source_deck(&header) else {
        return Ok(element.to_string());
    };
    let markup = crate::assets::bring_assets(&element[at..], &source, target)?;
    Ok(format!("{}{markup}", &element[..at]))
}

/// The `slides` of the deck `file` (whose source is `source`) as they go on the clipboard:
/// their HTML behind [`SLIDE_MARKER`], in the order given, and their text, a blank line
/// between one slide's and the next's.
pub fn slides_clip(file: &Path, source: &str, slides: &[String]) -> Result<(String, String)> {
    if slides.is_empty() {
        return Err(Error::msg("There is no slide to copy."));
    }
    let markup = slides
        .iter()
        .map(|slide| html::slide_markup(source, slide).map_err(Error::Message))
        .collect::<Result<Vec<_>>>()?;
    let header = serde_json::json!({ "deck": file.to_string_lossy(), "slides": slides });
    let text: Vec<String> = markup.iter().map(|m| find::plain_text(m)).collect();
    Ok((
        format!(
            "{SLIDE_MARKER}{}-->{}",
            header_json(&header),
            markup.join("\n")
        ),
        text.join("\n\n"),
    ))
}

/// The slides copied from the slide rail in the clipboard's HTML, if it holds any: what is
/// behind the marker, one entry per slide found in it.
pub fn copied_slides(html: &str) -> Option<CopiedSlides> {
    let clip = copied(html, SLIDE_MARKER)?;
    let (header, at) = split_header(clip, SLIDE_MARKER)?;
    let markup = &clip[at..];
    Some(CopiedSlides {
        deck: source_deck(&header),
        slides: html::find_slides(markup)
            .into_iter()
            .map(|slide| markup[slide.range].to_string())
            .collect(),
    })
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
    capture::rgba_png(width as u32, height as u32, rgba)
        .map_err(|e| Error::msg(format!("could not encode the copied image: {e}")))
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

/// Puts the `slides` of the deck `file` on the system clipboard, in the order given.
pub fn copy_slides(file: &Path, slides: &[String]) -> Result<()> {
    let (html, text) = slides_clip(file, &deck::read_html(file)?, slides)?;
    write(&html, &text)
}

/// The slides copied from the slide rail on the system clipboard, if it holds any.
pub fn read_slides() -> Result<Option<CopiedSlides>> {
    Ok(with_clipboard(|c| c.get().html().ok())?
        .as_deref()
        .and_then(copied_slides))
}

/// The system clipboard's plain text; empty when it holds none.
pub fn read_text() -> Result<String> {
    with_clipboard(|c| c.get_text().unwrap_or_default())
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
    use crate::test_support::TempDir;
    use std::fs;

    fn workspace() -> TempDir {
        let dir = TempDir::new("clipboard");
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
    fn a_copied_element_names_the_deck_it_came_from() {
        let dir = workspace();
        let deck = dir.join("talk/deck.html");
        let html = format!("{ELEMENT_MARKER}{{\"slide\":\"a\",\"look\":{{\"fontFamily\":\"a\\u003eb\"}}}}--><p>Hi</p>");
        let sourced = with_source(&html, &deck);
        let (header, at) = split_header(&sourced, ELEMENT_MARKER).unwrap();
        assert_eq!(header["deck"], deck.to_string_lossy().as_ref());
        assert_eq!(header["slide"], "a");
        assert_eq!(header["look"]["fontFamily"], "a>b");
        assert_eq!(&sourced[at..], "<p>Hi</p>");
        assert!(
            !sourced[..at - 3].contains('>'),
            "the header cannot end the comment"
        );
        assert_eq!(with_source("<p>Hi</p>", &deck), "<p>Hi</p>");
    }

    #[test]
    fn an_element_from_another_deck_brings_its_images_along() {
        let dir = workspace();
        fs::create_dir_all(dir.join("other/assets")).unwrap();
        fs::write(dir.join("other/deck.html"), "<main class=\"deck\"></main>").unwrap();
        fs::write(dir.join("other/assets/logo.svg"), "<svg/>").unwrap();
        let copied = with_source(
            &format!("{ELEMENT_MARKER}{{\"slide\":\"a\"}}--><img src=\"assets/logo.svg\">"),
            &dir.join("other/deck.html"),
        );
        let pasted = paste(
            Contents {
                html: Some(copied.clone()),
                ..Default::default()
            },
            &dir.join("talk/deck.html"),
        )
        .unwrap();
        assert_eq!(pasted, Pasted::Element { html: copied });
        assert_eq!(
            fs::read(dir.join("talk/assets/logo.svg")).unwrap(),
            b"<svg/>"
        );
        // The deck it came from may be gone by now; its references stay as they are.
        fs::remove_dir_all(dir.join("other")).unwrap();
        let orphan = with_source(
            &format!("{ELEMENT_MARKER}{{}}--><img src=\"assets/x.png\">"),
            &dir.join("other/deck.html"),
        );
        let pasted = paste(
            Contents {
                html: Some(orphan.clone()),
                ..Default::default()
            },
            &dir.join("talk/deck.html"),
        )
        .unwrap();
        assert_eq!(pasted, Pasted::Element { html: orphan });
    }

    #[test]
    fn a_copied_slide_round_trips_through_the_clipboard_html() {
        let dir = workspace();
        let deck = dir.join("talk/deck.html");
        let source = "<main class=\"deck\">\n  <section class=\"slide\" id=\"a\"><h1>Hi &gt; there</h1></section>\n</main>";
        let (html, text) = slides_clip(&deck, source, &["a".into()]).unwrap();
        assert!(html.starts_with(SLIDE_MARKER));
        assert_eq!(text, "Hi > there");
        let markup = "<section class=\"slide\" id=\"a\"><h1>Hi &gt; there</h1></section>";
        let expected = CopiedSlides {
            deck: Some(deck.clone()),
            slides: vec![markup.into()],
        };
        assert_eq!(copied_slides(&html), Some(expected.clone()));
        let wrapped = format!("<html><head></head><body>{html}</body></html>");
        assert_eq!(copied_slides(&wrapped), Some(expected));
        assert!(slides_clip(&deck, source, &["missing".into()]).is_err());
        assert!(slides_clip(&deck, source, &[]).is_err());

        // Pasting it while editing a slide leaves it to the slide rail.
        let pasted = paste(
            Contents {
                html: Some(html),
                text: Some(text),
                ..Default::default()
            },
            &deck,
        )
        .unwrap();
        assert_eq!(pasted, Pasted::Slide);
    }

    #[test]
    fn several_copied_slides_stay_apart_and_in_the_order_given() {
        let dir = workspace();
        let deck = dir.join("talk/deck.html");
        let source = concat!(
            "<main class=\"deck\">\n",
            "  <section class=\"slide\" id=\"a\"><h1>One</h1></section>\n",
            "  <section class=\"slide\" id=\"b\"><section><p>Nested</p></section></section>\n",
            "  <section class=\"slide\" id=\"c\"><h1>Three</h1></section>\n",
            "</main>"
        );
        let picked = ["a".to_string(), "c".to_string(), "b".to_string()];
        let (html, text) = slides_clip(&deck, source, &picked).unwrap();
        assert_eq!(text, "One\n\nThree\n\nNested");
        let (header, _) = split_header(&html, SLIDE_MARKER).unwrap();
        assert_eq!(header["slides"], serde_json::json!(["a", "c", "b"]));
        let copied = copied_slides(&format!("<html><body>{html}</body></html>")).unwrap();
        assert_eq!(copied.deck, Some(deck.clone()));
        assert_eq!(
            copied.slides,
            [
                "<section class=\"slide\" id=\"a\"><h1>One</h1></section>",
                "<section class=\"slide\" id=\"c\"><h1>Three</h1></section>",
                "<section class=\"slide\" id=\"b\"><section><p>Nested</p></section></section>",
            ]
        );
        // One missing slide copies none of them.
        assert!(slides_clip(&deck, source, &["a".into(), "gone".into()]).is_err());
    }

    #[test]
    fn a_copied_slide_from_a_gone_deck_has_no_source() {
        let html = format!("{SLIDE_MARKER}{{\"deck\":\"/nowhere/deck.html\"}}--><section class=\"slide\"></section>");
        assert_eq!(
            copied_slides(&html),
            Some(CopiedSlides {
                deck: None,
                slides: vec!["<section class=\"slide\"></section>".into()]
            })
        );
        assert_eq!(copied_slides("<p>Hi</p>"), None);
        assert_eq!(
            copied_slides(&format!("{SLIDE_MARKER}not json--><p></p>")),
            None
        );
        // Behind the marker but no slide: nothing to paste, which the paste says.
        assert_eq!(
            copied_slides(&format!("{SLIDE_MARKER}{{}}--><p>x</p>")),
            Some(CopiedSlides {
                deck: None,
                slides: Vec::new()
            })
        );
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
