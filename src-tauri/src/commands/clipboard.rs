//! Commands for the system clipboard.

use std::sync::{Mutex, MutexGuard};

use tauri::Window;

use super::{changing, workspace_root};
use crate::assets;
use crate::clipboard;
use crate::deck::{self, RailEdit};
use crate::error::Result;
use crate::history::{Change, Source};

/// One clipboard command at a time. Copying slides and pasting pictures run off the main thread
/// (they read and write whole files), where commands no longer queue up behind each other: a
/// paste pressed while a copy is still gathering its slides waits for it here, instead of
/// pasting what was on the clipboard before.
static IN_TURN: Mutex<()> = Mutex::new(());

fn in_turn() -> MutexGuard<'static, ()> {
    IN_TURN.lock().unwrap_or_else(|e| e.into_inner())
}

/// Puts an element copied in the slide editor of deck `id` on the system clipboard.
#[tauri::command]
pub fn copy_to_clipboard(html: String, text: String, id: Option<String>) -> Result<()> {
    let _turn = in_turn();
    let html = match id {
        Some(id) => clipboard::with_source(&html, &deck::deck_file(&id)?),
        None => html,
    };
    clipboard::write(&html, &text)
}

/// Puts the `slides` of deck `id` on the system clipboard, in the order given, to paste into
/// any deck. Off the main thread: the slides' pictures go along, read from their files.
#[tauri::command(async)]
pub fn copy_slides(id: String, slides: Vec<String>) -> Result<()> {
    let _turn = in_turn();
    clipboard::copy_slides(&deck::deck_file(&id)?, &slides)
}

/// Inserts the slides on the system clipboard into deck `id` after `after`, one after the
/// other, with the assets they show; None when the clipboard holds no slides.
#[tauri::command]
pub fn paste_slides(id: String, after: Option<String>) -> Result<Option<RailEdit>> {
    let copied = {
        let _turn = in_turn();
        clipboard::read_slides()?
    };
    let Some(copied) = copied else {
        return Ok(None);
    };
    changing(&id, Change::new(Source::Rail, "Paste slides"), |file| {
        deck::paste_slides(file, after, copied.deck.as_deref(), &copied.slides)
    })
    .map(Some)
}

/// The clipboard's plain text, for pasting into text on a slide without its formatting.
#[tauri::command]
pub fn read_clipboard_text() -> Result<String> {
    let _turn = in_turn();
    clipboard::read_text()
}

/// What pasting into deck `id` brings in; pasted images are saved into its assets. Off the main
/// thread: a picture is read from the clipboard and written to a file.
#[tauri::command(async)]
pub fn paste_from_clipboard(window: Window, id: String) -> Result<clipboard::Pasted> {
    let _turn = in_turn();
    let target = assets::target(&workspace_root(&window)?, &id)?;
    clipboard::paste(clipboard::read()?, &target)
}
