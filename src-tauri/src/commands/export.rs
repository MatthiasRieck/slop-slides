//! Commands that export a deck as a file of its own: a web page, images, PDF, PowerPoint,
//! video. Each but the web page and the video is a job the window names: `export-progress`
//! events say how far it has got ("slide 4 of 20"), and `cancel_export` stops it, leaving no
//! file behind. Several can run at once; one video at a time.

use std::path::Path;

use tauri::{AppHandle, Emitter, Window};

use crate::deck;
use crate::error::{Error, Result};
use crate::export_job::{self, Job};
use crate::export_scope::{self, Scope, WebPage};
use crate::files;
use crate::pdf;
use crate::pptx;
use crate::slide_images;
use crate::video;

/// The export `id` the window follows, its progress going to `window`.
fn job(window: &Window, id: String) -> Job {
    let window = window.clone();
    Job::start(id, move |progress| {
        let _ = window.emit(export_job::PROGRESS_EVENT, progress);
    })
}

/// Writes the deck to `dest` as one web page that stands on its own, with the slides and the
/// author's own material (notes, narration scripts, review marks) `options` asks for. The deck
/// file is only read. Off the main thread: a deck with large images makes a large page.
#[tauri::command(async)]
pub fn export_deck(id: String, dest: String, options: Option<WebPage>) -> Result<()> {
    export_scope::web_page(
        &deck::deck_file(&id)?,
        Path::new(&dest),
        &options.unwrap_or_default(),
    )
}

/// Saves an image of each slide `options` names. One slide goes to the file `dest`; several to
/// a new folder inside the folder `dest`, named after the deck. What it saved: the file or
/// the folder, and how many images. A failed or cancelled export leaves nothing behind.
#[tauri::command]
pub async fn export_slide_images(
    app: AppHandle,
    window: Window,
    id: String,
    dest: String,
    job_id: String,
    options: slide_images::Options,
) -> Result<SavedImages> {
    let file = deck::deck_file(&id)?;
    let job = job(&window, job_id);
    let single = options.scope.slides.as_ref().is_some_and(|s| s.len() == 1);
    if single {
        let dest = Path::new(&dest);
        let saved = slide_images::save(
            &app,
            &file,
            slide_images::Target::File(dest),
            &options,
            &job,
        )
        .await?;
        return Ok(SavedImages {
            path: dest.to_string_lossy().into_owned(),
            count: saved.len(),
        });
    }
    let deck = deck::load(&file)?;
    let dir = files::create_export_dir(Path::new(&dest), &deck.title)?;
    let saved = slide_images::save(
        &app,
        &file,
        slide_images::Target::Folder(&dir),
        &options,
        &job,
    )
    .await;
    match saved {
        Ok(saved) => Ok(SavedImages {
            path: dir.to_string_lossy().into_owned(),
            count: saved.len(),
        }),
        Err(error) => {
            // The folder is the export's own: nothing else is in it.
            let _ = std::fs::remove_dir_all(&dir);
            Err(error)
        }
    }
}

/// Where slide images were saved: one image's file, or the folder of several.
#[derive(Debug, serde::Serialize)]
pub struct SavedImages {
    pub path: String,
    pub count: usize,
}

/// Prints the slides `options` names to `dest` as a PDF, a page each (and a page of notes
/// after each slide that has them, when asked), with selectable text.
#[tauri::command]
pub async fn export_pdf(
    app: AppHandle,
    window: Window,
    id: String,
    dest: String,
    job_id: String,
    options: pdf::Options,
) -> Result<()> {
    let job = job(&window, job_id);
    pdf::export(
        &app,
        &deck::deck_file(&id)?,
        Path::new(&dest),
        &options,
        &job,
    )
    .await
}

/// Writes the slides `scope` names to `dest` as a PowerPoint file; what the file does not keep
/// of the deck comes back, for the user to check.
#[tauri::command]
pub async fn export_pptx(
    app: AppHandle,
    window: Window,
    id: String,
    dest: String,
    job_id: String,
    scope: Scope,
) -> Result<pptx::Exported> {
    let job = job(&window, job_id);
    pptx::export(&app, &deck::deck_file(&id)?, Path::new(&dest), &scope, &job).await
}

/// Stops the export `job_id`, which then fails with "the export was cancelled" before it
/// writes anything. One that has ended is left alone.
#[tauri::command]
pub fn cancel_export(job_id: String) {
    export_job::cancel(&job_id);
}

/// Records the slides `output` names to `dest` as an MP4, each on screen for the same time (or,
/// speaking its narration, as long as the narration timeline says), with captions beside it
/// when asked, and `video-export-progress` events to `window` as it goes.
#[tauri::command]
pub async fn export_video(
    app: AppHandle,
    window: Window,
    id: String,
    dest: String,
    options: video::Options,
    output: Option<video::Output>,
) -> Result<()> {
    let progress = |p: video::Progress| {
        let _ = window.emit("video-export-progress", p);
    };
    let output = output.unwrap_or_default();
    if output.scope.slides.as_ref().is_some_and(Vec::is_empty) {
        return Err(Error::msg("there are no slides to record"));
    }
    video::export(
        &app,
        &deck::deck_file(&id)?,
        Path::new(&dest),
        options,
        &output,
        progress,
    )
    .await
}

/// Stops the running video export; it fails with "the video export was cancelled".
#[tauri::command]
pub fn cancel_video_export() {
    video::cancel();
}
