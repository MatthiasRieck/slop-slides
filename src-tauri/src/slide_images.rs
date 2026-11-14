//! Slide images, as the Export menu and the agent's export tool save them: each slide of the
//! export's scope shown whole in a hidden window, every animation finished, captured as a PNG
//! or a JPEG once or twice the slides' canvas width. They are named after the slide's number in
//! the deck (`slide-04.png`), so a range keeps its numbers. An export that fails or is
//! cancelled takes away every image it saved.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::capture::{self, Image};
use crate::error::{Error, Result};
use crate::export_job::Job;
use crate::export_scope::Scope;
use crate::export_window::{self, Helper};
use crate::{deck, html, render};

/// How good a JPEG is, out of 100: no visible blocks on text, a third of the PNG's size.
const JPEG_QUALITY: u8 = 90;

/// The file each slide image is.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    /// Lossless, transparent where the slide is; what slides are usually wanted as.
    #[default]
    Png,
    /// Smaller, for mail and the web.
    Jpeg,
}

impl Format {
    pub fn extension(self) -> &'static str {
        match self {
            Format::Png => "png",
            Format::Jpeg => "jpg",
        }
    }
}

/// How the images are made.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    /// The slides that get an image.
    #[serde(flatten)]
    pub scope: Scope,
    pub format: Format,
    /// Pixels per slide pixel: 1 for the canvas size, 2 for sharp on high-density screens.
    pub scale: Option<u32>,
}

impl Options {
    /// How wide each image is for slides `canvas` pixels wide.
    pub fn width(&self, canvas: u32) -> u32 {
        capture::slide_image_width(Some(canvas.saturating_mul(self.scale.unwrap_or(1))))
    }

    pub fn check(&self) -> Result<()> {
        match self.scale {
            None | Some(1) | Some(2) => Ok(()),
            Some(scale) => Err(Error::msg(format!("unsupported image scale: {scale}"))),
        }
    }
}

/// The slides of `scope` of `loaded` with their number in the deck, from 1.
pub fn numbered<'a>(loaded: &'a deck::Deck, scope: &Scope) -> Vec<(usize, &'a deck::Slide)> {
    loaded
        .slides
        .iter()
        .enumerate()
        .filter(|(_, slide)| scope.holds(&slide.id, slide.hidden))
        .map(|(index, slide)| (index + 1, slide))
        .collect()
}

/// What the image of slide `number` of a deck of `total` slides is called: `slide-04.png`,
/// with enough digits that the files sort in slide order.
pub fn file_name(number: usize, total: usize, format: Format) -> String {
    Path::new(&crate::files::slide_image_name(
        number.saturating_sub(1),
        total,
    ))
    .with_extension(format.extension())
    .to_string_lossy()
    .into_owned()
}

/// The captured `png` as `format`: as it is, or a JPEG over white (JPEG has no transparency).
pub fn encode(png: Vec<u8>, format: Format) -> Result<Vec<u8>> {
    match format {
        Format::Png => Ok(png),
        Format::Jpeg => jpeg(&capture::decode_png(&png)?),
    }
}

fn jpeg(image: &Image) -> Result<Vec<u8>> {
    use image::ImageEncoder as _;
    let rgb: Vec<u8> = image
        .rgba
        .chunks_exact(4)
        .flat_map(|px| {
            let alpha = u16::from(px[3]);
            let over_white = |c: u8| ((u16::from(c) * alpha + 255 * (255 - alpha)) / 255) as u8;
            [over_white(px[0]), over_white(px[1]), over_white(px[2])]
        })
        .collect();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY)
        .write_image(
            &rgb,
            image.width,
            image.height,
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| Error::msg(format!("cannot write the JPEG: {e}")))?;
    Ok(out)
}

/// Where the images go.
pub enum Target<'a> {
    /// One file: the export is of one slide.
    File(&'a Path),
    /// A folder that is there already, each image named by [`file_name`].
    Folder(&'a Path),
}

/// Saves an image of each slide of `options` of the deck `file` (in the open workspace) to
/// `target`, a step of `job` for each. The images saved come back; on a failure or a cancel,
/// none is left.
pub async fn save(
    app: &AppHandle,
    file: &Path,
    target: Target<'_>,
    options: &Options,
    job: &Job,
) -> Result<Vec<PathBuf>> {
    options.check()?;
    let loaded = deck::load(file)?;
    let slides = numbered(&loaded, &options.scope);
    if slides.is_empty() {
        return Err(Error::msg("there are no slides to save as images"));
    }
    if matches!(target, Target::File(_)) && slides.len() != 1 {
        return Err(Error::msg("images of several slides go in a folder"));
    }
    let (canvas, _) = html::slide_size(&deck::read_html(file)?).pixels();
    let width = options.width(canvas);
    let shots: Vec<Shot> = slides
        .iter()
        .map(|(number, slide)| Shot {
            id: slide.id.clone(),
            number: *number,
            path: match &target {
                Target::File(dest) => dest.to_path_buf(),
                Target::Folder(dir) => {
                    dir.join(file_name(*number, loaded.slides.len(), options.format))
                }
            },
        })
        .collect();
    let mut saved = Vec::new();
    let made = capture_all(app, file, &shots, width, job, |shot, png| {
        // Written as each is made: nothing is held for a deck of many large images.
        let bytes = encode(png, options.format)?;
        job.check()?;
        std::fs::write(&shot.path, bytes)?;
        saved.push(shot.path.clone());
        Ok(())
    })
    .await;
    match made {
        Ok(()) => Ok(saved),
        Err(error) => {
            for path in &saved {
                let _ = std::fs::remove_file(path);
            }
            Err(error)
        }
    }
}

/// One slide to capture: its id, its number in the deck, and where its image goes.
struct Shot {
    id: String,
    number: usize,
    path: PathBuf,
}

/// Shows each of `shots` in a hidden window and hands its capture, `width` pixels wide, to
/// `keep`, a step of `job` for each.
async fn capture_all(
    app: &AppHandle,
    file: &Path,
    shots: &[Shot],
    width: u32,
    job: &Job,
    mut keep: impl FnMut(&Shot, Vec<u8>) -> Result<()>,
) -> Result<()> {
    let (window, signals, _) = render::open(app, file, false)?;
    let mut helper = Helper {
        window: &window,
        signals,
        task: render::TASK,
    };
    let captured = async {
        helper.answer("ready").await?;
        for (done, shot) in shots.iter().enumerate() {
            job.step(done, shots.len())?;
            let shown = render::show(&mut helper, &shot.id, None)
                .await?
                .ok_or_else(|| {
                    Error::msg(format!("slide {} is no longer in the deck", shot.number))
                })?;
            let (rect, viewport) = export_window::geometry(&shown)?;
            // The fitted slide sits at a fraction of a pixel; keep its edge out of the image.
            let rect = export_window::inside_whole_points(rect);
            let png = export_window::capture(helper.window, rect, viewport, width).await?;
            keep(shot, png)?;
        }
        job.step(shots.len(), shots.len())
    }
    .await;
    let _ = window.destroy();
    captured
}

#[cfg(test)]
mod tests {
    use super::*;

    const DECK: &str = r#"<!DOCTYPE html><html><head><title>T</title></head><body><main class="deck">
<section class="slide" id="a"><h1>A</h1></section>
<section class="slide" id="b" data-hidden><h1>B</h1></section>
<section class="slide" id="c"><h1>C</h1></section>
</main></body></html>"#;

    #[test]
    fn images_are_named_by_their_number_in_the_deck() {
        assert_eq!(file_name(4, 20, Format::Png), "slide-04.png");
        assert_eq!(file_name(4, 120, Format::Jpeg), "slide-004.jpg");
        assert_eq!(file_name(1, 1, Format::Png), "slide-01.png");
    }

    #[test]
    fn the_scope_picks_slides_keeping_their_numbers() {
        let dir = crate::test_support::TempDir::new("slide-images");
        let file = dir.write("deck.html", DECK);
        let loaded = deck::load(&file).unwrap();
        let numbers = |scope: &Scope| -> Vec<usize> {
            numbered(&loaded, scope).iter().map(|(n, _)| *n).collect()
        };
        assert_eq!(
            numbers(&Scope::default()),
            [1, 3],
            "hidden slides are left out"
        );
        assert_eq!(numbers(&Scope::everything()), [1, 2, 3]);
        let one = Scope {
            slides: Some(vec!["c".into()]),
            include_hidden: false,
        };
        assert_eq!(numbers(&one), [3]);
    }

    #[test]
    fn options_come_from_the_frontend_and_set_the_width() {
        let options: Options =
            serde_json::from_str(r#"{"slides":["a"],"format":"jpeg","scale":2}"#).unwrap();
        assert_eq!(options.format, Format::Jpeg);
        assert_eq!(options.width(1920), 3840);
        assert!(options.check().is_ok());
        let plain: Options = serde_json::from_str("{}").unwrap();
        assert_eq!(plain.format, Format::Png);
        assert_eq!(plain.width(1920), 1920);
        let odd = Options {
            scale: Some(3),
            ..Options::default()
        };
        assert_eq!(
            odd.check().unwrap_err().to_string(),
            "unsupported image scale: 3"
        );
    }

    #[test]
    fn a_jpeg_is_the_capture_over_white() {
        let image = Image {
            width: 2,
            height: 1,
            rgba: vec![255, 0, 0, 255, 0, 0, 0, 0],
        };
        let png = capture::encode_png(&image).unwrap();
        assert_eq!(encode(png.clone(), Format::Png).unwrap(), png);
        let jpeg = encode(png, Format::Jpeg).unwrap();
        assert_eq!(&jpeg[..3], [0xFF, 0xD8, 0xFF], "a JPEG");
        let decoded = image::load_from_memory_with_format(&jpeg, image::ImageFormat::Jpeg)
            .unwrap()
            .to_rgb8();
        assert_eq!(decoded.dimensions(), (2, 1));
        let [r, g, b] = decoded.get_pixel(1, 0).0;
        assert!(r > 200 && g > 200 && b > 200, "transparent became white");
    }
}
