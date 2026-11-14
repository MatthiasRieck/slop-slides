//! Commands for a deck's undo history.

use serde::Serialize;
use tauri::State;

use super::changing;
use crate::agent::AgentManager;
use crate::deck::{self, Deck};
use crate::error::{self, Result};
use crate::files;
use crate::history::{self, Change, Source};

/// What undo and redo would do in deck `id`. A change made outside the app since is noticed
/// first, unless the agent is working: its unfinished edits would become an entry.
#[tauri::command(async)]
pub fn deck_history(agent: State<AgentManager>, id: String) -> Result<history::Status> {
    let file = deck::deck_file(&id)?;
    history::status(&files::app_home()?, &file, !agent.works_on(&file))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStep {
    deck: Deck,
    #[serde(flatten)]
    step: history::Step,
}

/// Undoes (`back`) or redoes the newest change of deck `id`, whatever made it.
fn step_history(agent: &AgentManager, id: &str, back: bool) -> Result<HistoryStep> {
    if agent.works_on(&deck::deck_file(id)?) {
        return Err(error::Error::msg(
            "The agent is still working on the deck; stop it or wait for it to finish first.",
        ));
    }
    let (home, file) = (files::app_home()?, deck::deck_file(id)?);
    let step = if back {
        history::undo(&home, &file)?
    } else {
        history::redo(&home, &file)?
    };
    Ok(HistoryStep {
        deck: deck::load(&file)?,
        step,
    })
}

#[tauri::command(async)]
pub fn undo_deck(agent: State<AgentManager>, id: String) -> Result<HistoryStep> {
    step_history(&agent, &id, true)
}

#[tauri::command(async)]
pub fn redo_deck(agent: State<AgentManager>, id: String) -> Result<HistoryStep> {
    step_history(&agent, &id, false)
}

/// Puts `slides` back as they were at version `since` of deck `id`'s history, as one change.
#[tauri::command(async)]
pub fn restore_slides(id: String, since: String, slides: Vec<String>) -> Result<Deck> {
    let version = history::version(&files::app_home()?, &deck::deck_file(&id)?, &since)?;
    changing(&id, Change::new(Source::Edit, "Discard edits"), |file| {
        deck::restore_slides(file, &version, &slides)
    })
}

/// Every version kept of deck `id`, the newest first, for going back to one. As for
/// [`deck_history`], a change made outside the app is noticed first unless the agent is working.
#[tauri::command(async)]
pub fn deck_versions(agent: State<AgentManager>, id: String) -> Result<history::Versions> {
    let file = deck::deck_file(&id)?;
    history::versions(&files::app_home()?, &file, !agent.works_on(&file))
}

/// Puts deck `id` back as it was at `version` of its history, as one change that undo takes back.
#[tauri::command(async)]
pub fn restore_version(
    agent: State<AgentManager>,
    id: String,
    version: String,
) -> Result<HistoryStep> {
    let file = deck::deck_file(&id)?;
    if agent.works_on(&file) {
        return Err(error::Error::msg(
            "The agent is still working on the deck; stop it or wait for it to finish first.",
        ));
    }
    let step = history::restore(&files::app_home()?, &file, &version)?;
    crate::watcher::own_writes().note(&file);
    Ok(HistoryStep {
        deck: deck::load(&file)?,
        step,
    })
}
