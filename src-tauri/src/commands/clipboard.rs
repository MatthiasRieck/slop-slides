//! Commands for the system clipboard.

use tauri::Window;

use super::{changing, workspace_root, CreatedSlide};
use crate::assets;
use crate::clipboard;
use crate::deck;
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

/// Puts slide `slide` of deck `id` on the system clipboard, to paste into any deck.
#[tauri::command]
pub fn copy_slide(id: String, slide: String) -> Result<()> {
    clipboard::copy_slide(&deck::deck_file(&id)?, &slide)
}

/// Inserts the slide on the system clipboard into deck `id` after `after`, with the assets
/// it shows; None when the clipboard holds no slide.
#[tauri::command]
pub fn paste_slide(id: String, after: Option<String>) -> Result<Option<CreatedSlide>> {
    let Some(copied) = clipboard::read_slide()? else {
        return Ok(None);
    };
    let (deck, slide) = changing(&id, Change::new(Source::Rail, "Paste slide"), |file| {
        deck::paste_slide(file, after, copied.deck.as_deref(), &copied.markup)
    })?;
    Ok(Some(CreatedSlide { deck, slide }))
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
