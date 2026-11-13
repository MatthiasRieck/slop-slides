//! Commands for the system clipboard.

use tauri::Window;

use super::{changing, workspace_root};
use crate::assets;
use crate::clipboard;
use crate::deck::{self, RailEdit};
use crate::error::Result;
use crate::history::{Change, Source};

/// Puts an element copied in the slide editor of deck `id` on the system clipboard.
#[tauri::command]
pub fn copy_to_clipboard(html: String, text: String, id: Option<String>) -> Result<()> {
    let html = match id {
        Some(id) => clipboard::with_source(&html, &deck::deck_file(&id)?),
        None => html,
    };
    clipboard::write(&html, &text)
}

/// Puts the `slides` of deck `id` on the system clipboard, in the order given, to paste into
/// any deck.
#[tauri::command]
pub fn copy_slides(id: String, slides: Vec<String>) -> Result<()> {
    clipboard::copy_slides(&deck::deck_file(&id)?, &slides)
}

/// Inserts the slides on the system clipboard into deck `id` after `after`, one after the
/// other, with the assets they show; None when the clipboard holds no slides.
#[tauri::command]
pub fn paste_slides(id: String, after: Option<String>) -> Result<Option<RailEdit>> {
    let Some(copied) = clipboard::read_slides()? else {
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
    clipboard::read_text()
}

/// What pasting into deck `id` brings in; pasted images are saved into its assets.
#[tauri::command]
pub fn paste_from_clipboard(window: Window, id: String) -> Result<clipboard::Pasted> {
    let target = assets::target(&workspace_root(&window)?, &id)?;
    clipboard::paste(clipboard::read()?, &target)
}
