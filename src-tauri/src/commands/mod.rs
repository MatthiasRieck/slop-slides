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

/// Runs `f`, a change to deck `id`'s file whose result goes back to the frontend, and adds it to
/// the deck's history (see [`crate::history`]). The frontend has the deck as it is now, so the
/// watcher need not report the write back (see [`crate::watcher::OwnWrites`]).
///
/// The deck commands run off the main thread, which used to put them in order; the deck's lock,
/// which [`crate::history::change`] holds for the whole change, does that now for each deck.
fn changing<T>(id: &str, change: Change, f: impl FnOnce(&Path) -> Result<T>) -> Result<T> {
    let file = crate::deck::deck_file(id)?;
    let result = crate::history::change(&files::app_home()?, &file, change, || f(&file))?;
    crate::watcher::own_writes().note(&file);
    Ok(result)
}

/// Like [`changing`], for a change that gives the frontend nothing back: it hears of the write
/// from the watcher, as of anyone's, and brings its deck and history up to date then.
fn saving(id: &str, change: Change, f: impl FnOnce(&Path) -> Result<()>) -> Result<()> {
    let file = crate::deck::deck_file(id)?;
    crate::history::change(&files::app_home()?, &file, change, || f(&file))
}

/// Runs `f`, which reads deck `id`'s file, once no change to that deck is under way: what it
/// reads is the deck after every change asked for before it, never one half made. `f` must not
/// take the deck's lock again (see [`crate::deck_lock::hold`]).
fn reading<T>(id: &str, f: impl FnOnce(&Path) -> Result<T>) -> Result<T> {
    let file = crate::deck::deck_file(id)?;
    let _held = crate::deck_lock::hold(&file);
    f(&file)
}

/// The current session of the window's chat, starting one if it has none.
fn session(window: &Window) -> Result<PathBuf> {
    sessions()?.current_or_start(&chat_subject(window)?)
}

/// The current session of the window's chat, if it has one.
fn current_session(window: &Window) -> Result<Option<PathBuf>> {
    Ok(sessions()?.current(&chat_subject(window)?))
}

/// What the window's chat is about: the deck it has open, or its folder.
fn chat_subject(window: &Window) -> Result<PathBuf> {
    window
        .state::<OpenWorkspace>()
        .chat(window.label())
        .ok_or_else(|| error::Error::msg("No folder is open."))
}

/// Brings the app window `label` to the front.
fn focus(app: &tauri::AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
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
    fn commands_that_only_read_or_copy_files_run_off_the_main_thread() {
        // The main thread routes input; none of these depends on running before or after
        // another command.
        for name in [
            "load_chat",
            "session_provider",
            "list_chat_threads",
            "list_dir",
            "open_file",
            "recent_workspaces",
            "recent_decks",
            "list_templates",
            "create_template",
            "copy_slides",
            "paste_from_clipboard",
        ] {
            assert_eq!(
                command_attribute(name),
                "#[tauri::command(async)]",
                "{name}"
            );
        }
    }

    #[test]
    fn commands_that_change_which_conversation_is_current_keep_their_order() {
        // Commands on the main thread run in the order they were sent. A chat saved after the
        // reset sent behind it would land in the new conversation.
        for name in [
            "save_chat",
            "reset_chat",
            "select_chat_thread",
            "move_chat_to_deck",
            "rewind_chat",
            "open_workspace",
            "close_workspace",
        ] {
            assert_eq!(command_attribute(name), "#[tauri::command]", "{name}");
        }
    }

    #[test]
    fn deck_commands_that_read_or_write_files_run_off_the_main_thread() {
        // A synchronous command runs on the main thread: one save of one slide of a big deck,
        // and what the frontend asks for after it, held up input for a fifth of a second.
        let commands = [
            // commands/deck.rs
            "create_deck",
            "open_deck",
            "load_deck",
            "save_review",
            "save_comments",
            "rename_deck",
            "reorder_slides",
            "add_slide",
            "duplicate_slides",
            "set_slides_hidden",
            "set_slide_narration",
            "set_slide_notes",
            "set_slide_time",
            "set_slide_timing",
            "set_slide_size",
            "set_slide_locked",
            "set_slides_locked",
            "add_section",
            "rename_section",
            "delete_section",
            "delete_slides",
            "slide_source",
            "update_slide",
            "save_deck_source",
            "import_assets",
            "save_asset",
            "find_in_deck",
            "replace_in_deck",
            "replace_match_in_deck",
            "lint_deck",
            // commands/history.rs
            "deck_history",
            "undo_deck",
            "redo_deck",
            "restore_slides",
            // commands/narration.rs
            "delete_recorded_narration",
            "narration_audio",
            "narration_words",
            "narration_wav",
            "set_narration_voice",
            "set_narration_provider",
            "set_narration_language",
        ];
        for name in commands {
            assert_eq!(
                command_attribute(name),
                "#[tauri::command(async)]",
                "{name}"
            );
        }
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
