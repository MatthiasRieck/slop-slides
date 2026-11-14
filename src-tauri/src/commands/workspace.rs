//! Commands for the app's windows and the folder each has open.

use tauri::{AppHandle, State, Window};

use super::{focus, workspace_root};
use crate::error::{self, Result};
use crate::files;
use crate::screens;
use crate::watcher::WorkspaceWatcher;
use crate::windows;
use crate::workspace::{self, OpenWorkspace};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    path: String,
    name: String,
}

/// Opens a folder as the window's workspace: the file tree shows it, `slop://` serves from
/// it, and the watcher reports its changes. Other windows may have the folder open too, each
/// with another of its decks; one that has it open without a deck is shown instead: two
/// windows on the folder's own chat would share (and overwrite) it.
#[tauri::command]
pub fn open_workspace(
    app: AppHandle,
    window: Window,
    open: State<OpenWorkspace>,
    watcher: State<WorkspaceWatcher>,
    path: String,
) -> Result<WorkspaceInfo> {
    let root = workspace::root(&path)?;
    if let Some(other) = open.window_with(&root, window.label()) {
        focus(&app, &other);
        return Err(error::Error::msg(format!(
            "{} is already open in another window.",
            workspace::display_name(&root)
        )));
    }
    open.set(window.label(), Some(root.clone()));
    watcher.watch(app, window.label(), root.clone())?;
    workspace::remember(&files::app_home()?, &root)?;
    Ok(WorkspaceInfo {
        name: workspace::display_name(&root),
        path: root.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn close_workspace(
    window: Window,
    open: State<OpenWorkspace>,
    watcher: State<WorkspaceWatcher>,
) {
    watcher.stop(window.label());
    open.set(window.label(), None);
}

/// The folder waiting to be opened in this window (see [`windows::open_folder`]), once.
#[tauri::command]
pub fn take_pending_folder(
    window: Window,
    pending: State<windows::PendingFolders>,
) -> Option<String> {
    pending
        .take(window.label())
        .map(|root| root.to_string_lossy().into_owned())
}

/// Opens another app window on the start screen. Off the main thread: building a window from
/// a command on it deadlocks on Windows, leaving a blank window that cannot be closed.
#[tauri::command(async)]
pub fn new_window(app: AppHandle) -> Result<()> {
    windows::open_new(&app)
}

/// The attached screens, for choosing where to present.
#[tauri::command]
pub fn list_screens(app: AppHandle) -> Result<Vec<screens::Screen>> {
    screens::list_named(&app)
}

/// A screenshot of each attached screen, for telling them apart in the picker. `grabbed` hears
/// when the screens are captured, which is well before the screenshots are ready.
#[tauri::command]
pub async fn screen_previews(
    app: AppHandle,
    grabbed: tauri::ipc::Channel<()>,
) -> Vec<Option<String>> {
    screens::previews(&app, grabbed).await
}

/// Moves the show window to the `audience` screen and opens the presenter view on `presenter`.
/// Off the main thread, which building a window from a command needs on Windows.
#[tauri::command(async)]
pub fn present_on(
    app: AppHandle,
    window: Window,
    audience: usize,
    presenter: Option<usize>,
) -> Result<()> {
    screens::present(&app, &window, audience, presenter)
}

/// Opens the presenter view in a window of its own beside the show, which stays where it is.
/// Off the main thread, which building a window from a command needs on Windows.
#[tauri::command(async)]
pub fn present_in_windows(app: AppHandle) -> Result<()> {
    screens::present_in_windows(&app)
}

/// Closes the presenter view window when the show ends.
#[tauri::command]
pub fn close_presenter_view(app: AppHandle) {
    screens::close_presenter_view(&app);
}

#[tauri::command(async)]
pub fn recent_workspaces() -> Result<Vec<workspace::RecentWorkspace>> {
    Ok(workspace::recent(&files::app_home()?))
}

#[tauri::command]
pub fn forget_workspace(path: String) -> Result<()> {
    workspace::forget(&files::app_home()?, &path)
}

/// The decks opened before, newest first, for the start screen.
#[tauri::command(async)]
pub fn recent_decks() -> Result<Vec<workspace::RecentDeck>> {
    Ok(workspace::recent_decks(&files::app_home()?))
}

#[tauri::command]
pub fn forget_deck(path: String) -> Result<()> {
    workspace::forget_deck(&files::app_home()?, &path)
}

/// `~/Documents/SlopSlide`, where decks lived before workspaces.
#[tauri::command]
pub fn library_folder(app: AppHandle) -> Result<String> {
    Ok(files::library_root(&app)?.to_string_lossy().into_owned())
}

/// One folder of the open workspace (`""` for its root). Off the main thread: the start of
/// every HTML file in the folder is read to tell decks from other pages.
#[tauri::command(async)]
pub fn list_dir(window: Window, path: String) -> Result<Vec<workspace::Entry>> {
    workspace::list_dir(&workspace_root(&window)?, &path)
}

/// A file of the open workspace, with the viewer it opens in. Off the main thread: the file is
/// read whole to tell what it is.
#[tauri::command(async)]
pub fn open_file(window: Window, path: String) -> Result<workspace::OpenedFile> {
    workspace::open_file(&workspace_root(&window)?, &path)
}
