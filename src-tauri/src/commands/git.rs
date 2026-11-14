//! Commands for the git repository a deck is in. Off the main thread: they run git.

use serde::Serialize;

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

/// What discarding changes did: the deck as it is now, and how many files around it (images,
/// say) went back to the last version with it. Undo takes the deck's part back, not the files'.
#[derive(Debug, Serialize)]
pub struct Discarded {
    #[serde(flatten)]
    pub edit: RailEdit,
    pub files: usize,
}

/// How the deck's history labels what these commands change; the frontend's Undo names them too
/// (see src/changesStore.ts).
const DISCARD_LABEL: &str = "Discard changes";
const DISCARD_ALL_LABEL: &str = "Discard all changes";

/// Puts a change back as it was committed, in the deck and the index; the slide list's undo
/// takes the deck's part back.
#[tauri::command(async)]
pub fn restore_change(id: String, change: git::Change) -> Result<Discarded> {
    let file = deck::deck_file(&id)?;
    let before = deck::read_html(&file)?;
    let source = git::restored(&file, &change)?;
    let slide = match &change {
        git::Change::Slide { id, .. } => id.as_deref(),
        git::Change::Move { id, .. } => Some(id.as_str()),
        git::Change::Styles => None,
    };
    let edit = changing(&id, Change::new(Source::Deck, DISCARD_LABEL), |file| {
        deck::restore(file, slide, source)
    })?;
    let files = git::finish_restore(&file, &change, &before)?;
    Ok(Discarded { edit, files })
}

/// Puts the whole deck back as it was committed, as one change the slide list's undo takes back.
#[tauri::command(async)]
pub fn restore_all_changes(id: String) -> Result<Discarded> {
    let file = deck::deck_file(&id)?;
    let before = deck::read_html(&file)?;
    let source = git::restored_all(&file)?;
    let edit = changing(&id, Change::new(Source::Deck, DISCARD_ALL_LABEL), |file| {
        deck::restore(file, None, source)
    })?;
    let files = git::finish_restore_all(&file, &before)?;
    Ok(Discarded { edit, files })
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
