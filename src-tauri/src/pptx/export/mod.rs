//! Writes a deck as a new `.pptx`. The page helper (`assets/pptx.js`) reads each shown slide as
//! rendered, in a hidden window, into a [`Scene`]; [`package`] turns that into a presentation of
//! native shapes, text and pictures, so it stays editable in PowerPoint.
//!
//! PowerPoint cannot draw everything a browser can. Transparent fills, linear gradients and
//! outer shadows map onto its own effects, backdrop blur is dropped, and anything else (SVG,
//! filters, masks, 3D) comes as a picture. A picture needs its transparency: [`matte`] works it
//! out from two captures of the element alone, over white and over black.

mod scene;
mod write;

use std::collections::HashMap;
use std::path::Path;

use base64::Engine as _;
use tauri::AppHandle;

use crate::capture::{self, Image};
use crate::error::{Error, Result};
use crate::export_window::{self, Helper, Page};
use crate::{deck, html};
pub(super) use scene::*;
pub(super) use write::package;

/// Where the page's helper answers; the navigation is caught, never made.
const SIGNAL_PATH: &str = "/.pptx-signal";
/// The page's helper, run once it has loaded; it starts by reporting when it is ready.
const PPTX_JS: &str = include_str!("../../../assets/pptx.js");
/// Pictures have this many pixels per slide pixel.
const SHOT_SCALE: f64 = 2.0;
const TASK: &str = "the PowerPoint export";

/// Exports the deck `file` (in the open workspace) to `dest` as a PowerPoint file.
pub async fn export(app: &AppHandle, file: &Path, dest: &Path) -> Result<()> {
    let loaded = deck::load(file)?;
    let canvas = html::slide_size(&deck::read_html(file)?).pixels();
    let (window, signals) = export_window::open(
        app,
        file,
        canvas,
        Page {
            label: "pptx-export",
            title: "PowerPoint export",
            query: "static&print",
            script: PPTX_JS,
            signal: SIGNAL_PATH,
            purpose: "export",
            out_of_sight: true,
        },
    )?;

    let mut helper = Helper {
        window: &window,
        signals,
        task: TASK,
    };
    let read = read_scene(&mut helper).await;
    let _ = window.destroy();
    let (scene, shots) = read?;

    let notes = deck_notes(&loaded);
    let sections = deck_sections(&loaded);
    let meta = Meta {
        title: loaded.title.clone(),
        canvas,
        notes,
        sections,
    };
    let folder = deck::folder(file).to_path_buf();
    let dest = dest.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = package(&scene, &meta, &shots, |src| {
            let path = deck::resolve_in_deck(&folder, src).ok()?;
            std::fs::read(path).ok()
        })?;
        std::fs::write(dest, bytes)?;
        Ok(())
    })
    .await
    .map_err(|e| Error::msg(format!("writing the PowerPoint file failed: {e}")))?
}

/// Each slide's notes; narration stands in for them where there are none, as the words go on
/// being said.
fn deck_notes(loaded: &deck::Deck) -> HashMap<String, String> {
    loaded
        .slides
        .iter()
        .filter_map(|s| {
            let text = if s.notes.is_empty() {
                &s.narration
            } else {
                &s.notes
            };
            (!text.is_empty()).then(|| (s.id.clone(), text.clone()))
        })
        .collect()
}

/// Sections with the first shown slide of each; one with none shown is left out.
fn deck_sections(loaded: &deck::Deck) -> Vec<(String, String)> {
    loaded
        .sections
        .iter()
        .enumerate()
        .filter_map(|(i, section)| {
            let end = loaded
                .sections
                .get(i + 1)
                .map_or(loaded.slides.len(), |next| next.before);
            let first = loaded
                .slides
                .get(section.before..end)?
                .iter()
                .find(|s| !s.hidden)?;
            Some((section.title.clone(), first.id.clone()))
        })
        .collect()
}

/// Reads the scene from the page and captures its pictures.
async fn read_scene(helper: &mut Helper<'_>) -> Result<(Scene, HashMap<usize, Vec<u8>>)> {
    let ready = helper.answer("ready").await?;
    let count: usize = ready
        .get("slides")
        .and_then(|n| n.parse().ok())
        .unwrap_or(0);
    if count == 0 {
        return Err(Error::msg("the deck has no shown slides to export"));
    }
    export_window::check_view(&ready)?;
    // A step for each slide: a hidden window's timers stop before a long deck is read through.
    let mut chunks: usize = 0;
    for index in 0..count {
        let scanned = helper
            .run(&format!("window.__slopPptx.scan({index})"), "scanned")
            .await?;
        chunks = scanned_chunks(&scanned, index, count)?;
    }
    if chunks == 0 {
        return Err(Error::msg("the deck did not answer with its slides"));
    }
    let mut encoded = String::new();
    for index in 0..chunks {
        let answer = helper
            .run(&format!("window.__slopPptx.chunk({index})"), "chunk")
            .await?;
        encoded.push_str(answer.get("data").map_or("", String::as_str));
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|e| Error::msg(format!("unreadable answer from the deck: {e}")))?;
    let scene: Scene = serde_json::from_slice(&bytes)
        .map_err(|e| Error::msg(format!("unreadable answer from the deck: {e}")))?;

    let mut shots = HashMap::new();
    for (index, shot) in scene.shots.iter().enumerate() {
        let png = if shot.opaque {
            capture_shot(helper, index, None).await?
        } else {
            let white = capture_shot(helper, index, Some("#ffffff")).await?;
            let black = capture_shot(helper, index, Some("#000000")).await?;
            capture::encode_png(&matte(
                &capture::decode_png(&white)?,
                &capture::decode_png(&black)?,
            )?)?
        };
        shots.insert(index, png);
    }
    Ok((scene, shots))
}

/// What the helper said of reading slide `index` of `count`: the pieces its answer comes in,
/// which it tells after the last slide (0 before). An error if it read another slide, could not
/// read this one, or no longer has `count` slides.
pub(super) fn scanned_chunks(
    answer: &HashMap<String, String>,
    index: usize,
    count: usize,
) -> Result<usize> {
    let number = |key: &str| answer.get(key).and_then(|n| n.parse::<usize>().ok());
    if number("scanned") != Some(index) {
        return Err(Error::msg(format!(
            "the deck answered out of turn while slide {} was read",
            index + 1
        )));
    }
    if let Some(error) = answer.get("error") {
        return Err(Error::msg(format!(
            "slide {} could not be read: {error}",
            index + 1
        )));
    }
    if number("slides") != Some(count) {
        return Err(Error::msg("the deck's slides changed during the export"));
    }
    Ok(number("chunks").unwrap_or(0))
}

async fn capture_shot(
    helper: &mut Helper<'_>,
    index: usize,
    paper: Option<&str>,
) -> Result<Vec<u8>> {
    let paper = paper.map_or("null".to_string(), |p| format!("\"{p}\""));
    let shown = helper
        .run(
            &format!("window.__slopPptx.isolate({index}, {paper})"),
            "isolated",
        )
        .await?;
    let (rect, viewport) = export_window::geometry(&shown)?;
    let scale: f64 = shown
        .get("scale")
        .and_then(|s| s.parse().ok())
        .filter(|s: &f64| *s > 0.0)
        .unwrap_or(1.0);
    let pixels = (rect.width / scale * SHOT_SCALE)
        .round()
        .clamp(1.0, f64::from(crate::size::MAX_PX)) as u32;
    export_window::capture(helper.window, rect, viewport, pixels).await
}

/// The picture with its transparency, from the same picture over white and over black. A pixel
/// lets through as much as it differs between the two; its colour is what it adds over black.
pub(super) fn matte(white: &Image, black: &Image) -> Result<Image> {
    if (white.width, white.height) != (black.width, black.height) {
        return Err(Error::msg("the two captures differ in size"));
    }
    let mut rgba = Vec::with_capacity(white.rgba.len());
    for (w, b) in white.rgba.chunks_exact(4).zip(black.rgba.chunks_exact(4)) {
        let through: i32 = (0..3)
            .map(|i| i32::from(w[i]) - i32::from(b[i]))
            .sum::<i32>()
            / 3;
        let alpha = (255 - through).clamp(0, 255);
        for channel in &b[..3] {
            rgba.push(if alpha == 0 {
                0
            } else {
                ((i32::from(*channel) * 255 + alpha / 2) / alpha).min(255) as u8
            });
        }
        rgba.push(alpha as u8);
    }
    Ok(Image {
        width: white.width,
        height: white.height,
        rgba,
    })
}
