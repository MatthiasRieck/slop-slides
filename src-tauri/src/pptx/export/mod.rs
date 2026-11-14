//! Writes a deck as a new `.pptx`. The page helper (`assets/pptx.js`) reads each shown slide as
//! rendered, in a hidden window, into a [`Scene`]; [`package`] turns that into a presentation of
//! native shapes, text and pictures, so it stays editable in PowerPoint.
//!
//! PowerPoint cannot draw everything a browser can. Transparent fills, linear gradients and
//! outer shadows map onto its own effects, an SVG's shapes, lines and text become freeforms,
//! lines and text boxes, backdrop blur is dropped, and anything else (filters, masks, 3D, an
//! SVG using those) comes as a picture. A picture needs its transparency: [`matte`] works it
//! out from two captures of the element alone, over white and over black.

mod report;
mod scene;
mod write;

use std::collections::HashMap;
use std::path::Path;

use base64::Engine as _;
use serde::Serialize;
use tauri::AppHandle;

use super::Change;
use crate::capture::{self, Image};
use crate::error::{Error, Result};
use crate::export_job::Job;
use crate::export_scope::Scope;
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

/// What [`export`] made.
#[derive(Debug, Default, PartialEq, Serialize)]
pub struct Exported {
    /// What the file does not keep of the deck, for the user to check; empty when it has all.
    pub changes: Vec<Change>,
}

/// Exports the slides of `scope` of the deck `file` (in the open workspace) to `dest` as a
/// PowerPoint file, telling `job` how far it has got; what the file does not keep comes back.
/// A cancelled export stops before anything is written.
pub async fn export(
    app: &AppHandle,
    file: &Path,
    dest: &Path,
    scope: &Scope,
    job: &Job,
) -> Result<Exported> {
    let loaded = deck::load(file)?;
    let source = deck::read_html(file)?;
    let canvas = html::slide_size(&source).pixels();
    let (window, signals, _served) = export_window::open(
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
        Some(scope),
    )?;

    let mut helper = Helper {
        window: &window,
        signals,
        task: TASK,
    };
    let read = read_scene(&mut helper, job).await;
    let _ = window.destroy();
    let (scene, shots) = read?;

    let changes = report::changes(&scene, &loaded, &source);
    let notes = deck_notes(&loaded);
    let sections = deck_sections(&loaded, scope);
    let meta = Meta {
        title: loaded.title.clone(),
        canvas,
        notes,
        sections,
    };
    let folder = deck::folder(file).to_path_buf();
    let dest = dest.to_path_buf();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        package(&scene, &meta, &shots, |src| {
            let path = deck::resolve_in_deck(&folder, src).ok()?;
            std::fs::read(path).ok()
        })
    })
    .await
    .map_err(|e| Error::msg(format!("writing the PowerPoint file failed: {e}")))??;
    // Nothing is written yet: the last moment a cancelled export leaves nothing behind.
    job.check()?;
    std::fs::write(dest, bytes)?;
    Ok(Exported { changes })
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

/// Sections with the first exported slide of each; one with none exported is left out.
fn deck_sections(loaded: &deck::Deck, scope: &Scope) -> Vec<(String, String)> {
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
                .find(|s| scope.holds(&s.id, s.hidden))?;
            Some((section.title.clone(), first.id.clone()))
        })
        .collect()
}

/// Reads the scene from the page and captures its pictures, a step of `job` for each slide.
async fn read_scene(
    helper: &mut Helper<'_>,
    job: &Job,
) -> Result<(Scene, HashMap<usize, Vec<u8>>)> {
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
        job.step(index, count)?;
        let scanned = helper
            .run(&format!("window.__slopPptx.scan({index})"), "scanned")
            .await?;
        chunks = scanned
            .get("chunks")
            .and_then(|n| n.parse().ok())
            .unwrap_or(0);
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

    job.step(count, count)?;
    let mut shots = HashMap::new();
    for (index, shot) in scene.shots.iter().enumerate() {
        job.check()?;
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
