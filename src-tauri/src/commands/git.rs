//! Commands for the git repository a deck is in. Off the main thread: they run git.

use super::changing;
use crate::deck::{self, RailEdit};
use crate::error::Result;
use crate::git;
use crate::history::{Change, Source};

/// Whether the deck is in a git repository. Off the main thread: it runs git.
#[tauri::command(async)]
pub fn deck_in_repository(id: String) -> Result<bool> {
    git::in_repository(&deck::deck_file(&id)?)
}

/// What changed in the deck since the last commit. Off the main thread: it runs git.
#[tauri::command(async)]
pub fn deck_changes(id: String) -> Result<git::DeckChanges> {
    git::changes(&deck::deck_file(&id)?)
}

#[tauri::command(async)]
pub fn stage_change(id: String, change: git::Change) -> Result<()> {
    git::stage(&deck::deck_file(&id)?, &change)
}

#[tauri::command(async)]
pub fn unstage_change(id: String, change: git::Change) -> Result<()> {
    git::unstage(&deck::deck_file(&id)?, &change)
}

/// Puts a change back as it was committed, in the deck and the index; the slide list's undo
/// takes the deck's part back.
#[tauri::command(async)]
pub fn restore_change(id: String, change: git::Change) -> Result<RailEdit> {
    let file = deck::deck_file(&id)?;
    let before = deck::read_html(&file)?;
    let source = git::restored(&file, &change)?;
    let slide = match &change {
        git::Change::Slide { id, .. } => id.as_deref(),
        git::Change::Move { id, .. } => Some(id.as_str()),
        git::Change::Styles => None,
    };
    let edit = changing(&id, Change::new(Source::Deck, "Restore from git"), |file| {
        deck::restore(file, slide, source)
    })?;
    git::finish_restore(&file, &change, &before)?;
    Ok(edit)
}

#[tauri::command(async)]
pub fn stage_all(id: String) -> Result<()> {
    git::stage_all(&deck::deck_file(&id)?)
}

#[tauri::command(async)]
pub fn unstage_all(id: String) -> Result<()> {
    git::unstage_all(&deck::deck_file(&id)?)
}

#[tauri::command(async)]
pub fn commit_changes(id: String, message: String) -> Result<()> {
    git::commit(&deck::deck_file(&id)?, &message)
}
