//! The export with every slide as one picture ([`Slides::Pictures`]): it looks exactly as the
//! deck does wherever it is opened, fonts included, and nothing on a slide can be edited.

use std::collections::HashMap;
use std::path::Path;

use tauri::AppHandle;

use super::{Item, Scene, SceneSlide, ShotInfo, ShotItem};
use crate::error::{Error, Result};
use crate::export_window::{self, Helper};
use crate::render;

/// A slide's picture is asked for with this many pixels per slide pixel, so it stays sharp
/// shown large. Where a capture is of the window's own pixels (not on macOS, which draws the
/// slide again at the size asked for), it is no wider than the window shows the slide.
const PICTURE_SCALE: u32 = 2;

/// How wide the pictures of slides `canvas_width` pixels wide are, in pixels.
pub(super) fn picture_width(canvas_width: u32) -> u32 {
    canvas_width
        .saturating_mul(PICTURE_SCALE)
        .clamp(1, crate::size::MAX_PX)
}

/// A scene of the slides `ids`, each nothing but a picture over the whole `canvas`: the shot of
/// its own number.
pub(super) fn scene(ids: &[String], canvas: (u32, u32)) -> Scene {
    Scene {
        slides: ids
            .iter()
            .enumerate()
            .map(|(shot, id)| SceneSlide {
                id: id.clone(),
                items: vec![Item::Shot(ShotItem {
                    shot,
                    x: 0.0,
                    y: 0.0,
                    w: f64::from(canvas.0),
                    h: f64::from(canvas.1),
                })],
                ..SceneSlide::default()
            })
            .collect(),
        shots: ids.iter().map(|_| ShotInfo { opaque: true }).collect(),
    }
}

/// The scene of the slides `ids` of the deck `file` and a picture of each, every animation
/// finished.
pub(super) async fn read(
    app: &AppHandle,
    file: &Path,
    ids: &[String],
    canvas: (u32, u32),
) -> Result<(Scene, HashMap<usize, Vec<u8>>)> {
    if ids.is_empty() {
        return Err(Error::msg("the deck has no shown slides to export"));
    }
    let (window, signals) = render::open(app, file, false)?;
    let mut helper = Helper {
        window: &window,
        signals,
        task: super::TASK,
    };
    let width = picture_width(canvas.0);
    let shots: Result<HashMap<usize, Vec<u8>>> = async {
        helper.answer("ready").await?;
        let mut shots = HashMap::new();
        for (index, id) in ids.iter().enumerate() {
            let shown = render::show(&mut helper, id, None)
                .await?
                .ok_or_else(|| Error::msg(format!("the deck has no slide `{id}`")))?;
            let (rect, viewport) = export_window::geometry(&shown)?;
            // The fitted slide sits at a fraction of a pixel; keep its edge out of the picture.
            let rect = export_window::inside_whole_points(rect);
            let png = export_window::capture(helper.window, rect, viewport, width).await?;
            shots.insert(index, png);
        }
        Ok(shots)
    }
    .await;
    let _ = window.destroy();
    Ok((scene(ids, canvas), shots?))
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Read};

    use super::super::{package, Meta, Slides};
    use super::*;

    fn part(bytes: &[u8], name: &str) -> String {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut text = String::new();
        archive
            .by_name(name)
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        text
    }

    #[test]
    fn every_slide_is_one_picture_over_the_whole_canvas() {
        let ids = vec!["one".to_string(), "two".to_string()];
        let scene = scene(&ids, (1920, 1080));
        assert_eq!(scene.slides.len(), 2);
        assert!(scene.shots.iter().all(|s| s.opaque));
        for (index, slide) in scene.slides.iter().enumerate() {
            assert_eq!(slide.id, ids[index]);
            let [Item::Shot(shot)] = slide.items.as_slice() else {
                panic!("slide {index} is not one picture: {:?}", slide.items);
            };
            assert_eq!(shot.shot, index);
            assert_eq!((shot.x, shot.y, shot.w, shot.h), (0.0, 0.0, 1920.0, 1080.0));
        }
    }

    #[test]
    fn the_file_holds_a_picture_per_slide_with_notes_and_no_text() {
        let ids = vec!["one".to_string(), "two".to_string()];
        let shots = HashMap::from([(0, b"first".to_vec()), (1, b"second".to_vec())]);
        let meta = Meta {
            title: "Talk".into(),
            canvas: (1920, 1080),
            notes: HashMap::from([("two".to_string(), "Say this".to_string())]),
            sections: Vec::new(),
        };
        let bytes = package(&scene(&ids, meta.canvas), &meta, &shots, |_| None).unwrap();
        for number in 1..=2 {
            let slide = part(&bytes, &format!("ppt/slides/slide{number}.xml"));
            assert_eq!(slide.matches("<p:pic>").count(), 1, "{slide}");
            assert!(!slide.contains("<a:t>"), "{slide}");
            // The picture covers the slide: a widescreen slide's whole size.
            assert!(
                slide.contains("<a:off x=\"0\" y=\"0\"/><a:ext cx=\"12192000\" cy=\"6858000\"/>"),
                "{slide}"
            );
        }
        assert!(part(&bytes, "ppt/notesSlides/notesSlide2.xml").contains("Say this"));
        let mut archive = zip::ZipArchive::new(Cursor::new(&bytes)).unwrap();
        let media = (0..archive.len())
            .filter(|i| {
                archive
                    .by_index(*i)
                    .is_ok_and(|f| f.name().is_ok_and(|n| n.starts_with("ppt/media/")))
            })
            .count();
        assert_eq!(media, 2);
    }

    #[test]
    fn pictures_are_twice_the_canvas_within_the_largest_size() {
        assert_eq!(picture_width(1920), 3840);
        assert_eq!(picture_width(0), 1);
        assert_eq!(picture_width(9000), crate::size::MAX_PX);
        assert_eq!(picture_width(u32::MAX), crate::size::MAX_PX);
    }

    #[test]
    fn slides_are_elements_unless_asked() {
        assert_eq!(Slides::default(), Slides::Elements);
        for slides in Slides::ALL {
            assert_eq!(Slides::parse(slides.name()).unwrap(), slides);
            let json = serde_json::to_string(&slides).unwrap();
            assert_eq!(json, format!("\"{}\"", slides.name()));
            assert_eq!(serde_json::from_str::<Slides>(&json).unwrap(), slides);
        }
        assert_eq!(Slides::parse(" Pictures ").unwrap(), Slides::Pictures);
        assert_eq!(
            Slides::parse("images").unwrap_err().to_string(),
            "pptx_slides is one of elements, pictures"
        );
    }
}
