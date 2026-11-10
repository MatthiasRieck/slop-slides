//! Commands that export a deck as a file of its own: HTML, images, PDF, PowerPoint, video.

use std::path::Path;

use tauri::{AppHandle, Window};

use crate::capture;
use crate::deck;
use crate::error::Result;
use crate::files;
use crate::pdf;
use crate::pptx;
use crate::video;

#[tauri::command]
pub fn export_deck(id: String, dest: String) -> Result<()> {
    deck::export(&deck::deck_file(&id)?, Path::new(&dest))
}

/// Creates `<parent>/<deck title>` (or `<deck title> 2`, …) for exported slide images.
#[tauri::command]
pub fn create_image_export_dir(id: String, parent: String) -> Result<String> {
    let deck = deck::load(&deck::deck_file(&id)?)?;
    let dir = files::create_export_dir(Path::new(&parent), &deck.title)?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Screenshots `rect` of the window (one slide, shown full size) as `<dir>/<slide-NN>.png`, at
/// most `width` pixels wide: the slides' canvas width.
#[tauri::command]
pub async fn export_slide_image(
    webview: tauri::Webview,
    dir: String,
    index: usize,
    total: usize,
    rect: capture::Rect,
    viewport: capture::Size,
    width: Option<u32>,
) -> Result<String> {
    let path = capture::save_slide_image(
        &webview,
        Path::new(&dir),
        index,
        total,
        rect,
        viewport,
        width,
    )
    .await?;
    Ok(path.to_string_lossy().into_owned())
}

/// Prints the deck to `dest` as a PDF, one page per shown slide, with selectable text.
#[tauri::command]
pub async fn export_pdf(app: AppHandle, id: String, dest: String) -> Result<()> {
    pdf::export(&app, &deck::deck_file(&id)?, Path::new(&dest)).await
}

/// Writes the deck to `dest` as a PowerPoint file, one slide per shown slide.
#[tauri::command]
pub async fn export_pptx(app: AppHandle, id: String, dest: String) -> Result<()> {
    pptx::export(&app, &deck::deck_file(&id)?, Path::new(&dest)).await
}

/// Records the deck to `dest` as an MP4, each shown slide on screen for the same time (or,
/// speaking its narration, as long as the narration timeline says), with
/// `video-export-progress` events to `window` as it goes.
#[tauri::command]
pub async fn export_video(
    app: AppHandle,
    window: Window,
    id: String,
    dest: String,
    options: video::Options,
) -> Result<()> {
    use tauri::Emitter;
    let progress = |p: video::Progress| {
        let _ = window.emit("video-export-progress", p);
    };
    video::export(
        &app,
        &deck::deck_file(&id)?,
        Path::new(&dest),
        options,
        progress,
    )
    .await
}

/// Stops the running video export; it fails with "the video export was cancelled".
#[tauri::command]
pub fn cancel_video_export() {
    video::cancel();
}
