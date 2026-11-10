//! The Tauri commands the frontend invokes, by domain. Each parses its arguments, calls the
//! domain function that does the work, and returns its result; the frontend invokes them by
//! function name.

pub mod chat;
pub mod clipboard;
pub mod deck;
pub mod export;
pub mod git;
pub mod history;
pub mod narration;
pub mod templates;
pub mod voice;
pub mod workspace;

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{Manager, Window};

use crate::error::{self, Result};
use crate::files;
use crate::history::Change;
use crate::sessions::Sessions;
use crate::workspace::OpenWorkspace;

/// All sessions, under the app's home folder.
fn sessions() -> Result<Sessions> {
    Ok(Sessions::new(&files::app_home()?))
}

/// Runs `f`, a change to deck `id`'s file, and adds it to the deck's history (see
/// [`crate::history`]).
fn changing<T>(id: &str, change: Change, f: impl FnOnce(&Path) -> Result<T>) -> Result<T> {
    let file = crate::deck::deck_file(id)?;
    crate::history::change(&files::app_home()?, &file, change, || f(&file))
}

/// The current session of the window's workspace, starting one if it has none.
fn session(window: &Window) -> Result<PathBuf> {
    sessions()?.current_or_start(&workspace_root(window)?)
}

/// The current session of the window's workspace, if it has one.
fn current_session(window: &Window) -> Result<Option<PathBuf>> {
    Ok(sessions()?.current(&workspace_root(window)?))
}

/// The folder the window has open.
fn workspace_root(window: &Window) -> Result<PathBuf> {
    window
        .state::<OpenWorkspace>()
        .get(window.label())
        .ok_or_else(|| error::Error::msg("No folder is open."))
}

/// A deck with a slide just added to it, and that slide's id.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedSlide {
    deck: crate::deck::Deck,
    slide: String,
}

#[cfg(test)]
mod command_thread_tests {
    /// The attribute on the command `name` in the command modules.
    fn command_attribute(name: &str) -> &'static str {
        let sources = [
            include_str!("chat.rs"),
            include_str!("clipboard.rs"),
            include_str!("deck.rs"),
            include_str!("export.rs"),
            include_str!("git.rs"),
            include_str!("history.rs"),
            include_str!("narration.rs"),
            include_str!("templates.rs"),
            include_str!("voice.rs"),
            include_str!("workspace.rs"),
        ];
        let (source, at) = sources
            .iter()
            .find_map(|source| Some((source, source.find(&format!("\npub fn {name}("))?)))
            .unwrap_or_else(|| panic!("no command {name}"));
        source[..at]
            .lines()
            .rev()
            .find(|line| line.starts_with("#[tauri::command"))
            .unwrap()
    }

    #[test]
    fn commands_that_open_windows_run_off_the_main_thread() {
        // A synchronous command runs on the main thread, where building a window deadlocks on
        // Windows: Ctrl+N left a blank window that could not be closed.
        for name in ["new_window", "present_on"] {
            assert_eq!(
                command_attribute(name),
                "#[tauri::command(async)]",
                "{name}"
            );
        }
    }
}
