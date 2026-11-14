//! Commands for the Files tab: what it does to the files of the window's folder (see
//! [`crate::file_ops`]).

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, State, Window};
use tauri_plugin_opener::OpenerExt;

use super::workspace_root;
use crate::error::{Error, Result};
use crate::file_ops::{self, SearchResults, TextPreview};
use crate::files;
use crate::workspace::OpenWorkspace;

/// The decks open in the app's windows, this one's included: they are not renamed or removed
/// under the window showing them.
fn open_decks(app: &AppHandle, open: &OpenWorkspace) -> Vec<PathBuf> {
    app.webview_windows()
        .keys()
        .filter_map(|label| open.deck(label))
        .collect()
}

/// The files and folders of the open workspace whose name, or whose deck's title, holds `query`.
#[tauri::command(async)]
pub fn search_files(window: Window, query: String) -> Result<SearchResults> {
    file_ops::search(&workspace_root(&window)?, &query)
}

/// Renames a file or folder of the open workspace where it is; its new workspace-relative path.
#[tauri::command(async)]
pub fn rename_entry(
    app: AppHandle,
    window: Window,
    open: State<OpenWorkspace>,
    path: String,
    name: String,
) -> Result<String> {
    file_ops::rename(
        &workspace_root(&window)?,
        &path,
        &name,
        &open_decks(&app, &open),
        &files::app_home()?,
    )
}

/// Makes a folder in the folder `parent` of the open workspace; its workspace-relative path.
#[tauri::command(async)]
pub fn create_folder(window: Window, parent: String) -> Result<String> {
    file_ops::create_folder(&workspace_root(&window)?, &parent)
}

/// Moves a file or folder of the open workspace to the system's trash.
#[tauri::command(async)]
pub fn trash_entry(
    app: AppHandle,
    window: Window,
    open: State<OpenWorkspace>,
    path: String,
) -> Result<()> {
    let to_trash = |path: &Path| {
        trash::delete(path)
            .map_err(|error| Error::msg(format!("Could not move it to the trash: {error}")))
    };
    file_ops::trash(
        &workspace_root(&window)?,
        &path,
        &open_decks(&app, &open),
        to_trash,
    )
}

/// The start of a text file of the open workspace, for the viewer.
#[tauri::command(async)]
pub fn read_text_file(window: Window, path: String) -> Result<TextPreview> {
    file_ops::read_text(
        &workspace_root(&window)?,
        &path,
        file_ops::TEXT_PREVIEW_BYTES,
    )
}

/// Opens a file of the open workspace in the app the system opens it in.
#[tauri::command(async)]
pub fn open_in_default_app(app: AppHandle, window: Window, path: String) -> Result<()> {
    let file = file_ops::openable(&workspace_root(&window)?, &path)?;
    app.opener()
        .open_path(file.to_string_lossy(), None::<&str>)
        .map_err(|error| Error::msg(format!("Could not open it: {error}")))
}
