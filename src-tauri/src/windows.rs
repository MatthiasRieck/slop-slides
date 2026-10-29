//! App windows. Each window has a workspace of its own (see [`OpenWorkspace`]), so several
//! folders can be open side by side; File › New Window (⌘N, Ctrl+N elsewhere) opens another.

use tauri::{AppHandle, LogicalPosition, Manager, WebviewWindowBuilder, Window};

use crate::agent::AgentManager;
use crate::error::{Error, Result};
use crate::watcher::WorkspaceWatcher;
use crate::workspace::OpenWorkspace;

/// Labels of the windows [`open_new`] opens start with this; the capabilities grant them
/// what the first window (`main`) gets.
pub const LABEL_PREFIX: &str = "window-";

/// Id of the File › New Window menu item.
pub const NEW_WINDOW_MENU: &str = "new-window";

/// How far a new window sits down and right of the one it was opened from.
const CASCADE: f64 = 28.0;

/// Whether `label` is an app window (not, say, the hidden one a PDF export prints from).
pub fn is_app_window(label: &str) -> bool {
    label == "main" || label.starts_with(LABEL_PREFIX)
}

/// Opens another app window, configured like the first, on the start screen.
pub fn open_new(app: &AppHandle) -> Result<()> {
    let mut config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| Error::msg("no window configuration"))?;
    config.label = format!("{LABEL_PREFIX}{}", uuid::Uuid::new_v4().simple());
    let mut builder = WebviewWindowBuilder::from_config(app, &config)
        .map_err(|e| Error::msg(format!("cannot open a window: {e}")))?;
    if let Some(at) = cascaded_position(app) {
        builder = builder.position(at.x, at.y);
    }
    builder
        .build()
        .map_err(|e| Error::msg(format!("cannot open a window: {e}")))?;
    Ok(())
}

/// Just down and right of the focused app window, so the new one does not hide it exactly.
fn cascaded_position(app: &AppHandle) -> Option<LogicalPosition<f64>> {
    let window = app
        .webview_windows()
        .into_values()
        .filter(|w| is_app_window(w.label()))
        .find(|w| w.is_focused().unwrap_or(false))?;
    let scale = window.scale_factor().ok()?;
    let at = window.outer_position().ok()?.to_logical::<f64>(scale);
    Some(LogicalPosition::new(at.x + CASCADE, at.y + CASCADE))
}

/// A closed window lets go of its workspace: its folder is no longer served or watched, and
/// an agent still working there stops.
pub fn closed(window: &Window) {
    let label = window.label();
    let open = window.state::<OpenWorkspace>();
    if let Some(root) = open.get(label) {
        window
            .state::<AgentManager>()
            .interrupt(&root.to_string_lossy());
    }
    open.set(label, None);
    window.state::<WorkspaceWatcher>().stop(label);
}

/// The app menu with File › New Window added (macOS shows a menu bar for the app; the other
/// systems get Ctrl+N from the frontend instead).
#[cfg(target_os = "macos")]
pub fn menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};
    let menu = Menu::default(app)?;
    let new_window = MenuItem::with_id(
        app,
        NEW_WINDOW_MENU,
        "New Window",
        true,
        Some("CmdOrCtrl+N"),
    )?;
    for item in menu.items()? {
        if let MenuItemKind::Submenu(submenu) = item {
            if submenu.text()? == "File" {
                submenu.prepend(&new_window)?;
            }
        }
    }
    Ok(menu)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_windows_are_the_first_and_the_new_ones() {
        assert!(is_app_window("main"));
        assert!(is_app_window(&format!("{LABEL_PREFIX}1234")));
        assert!(!is_app_window("pdf-export-1234"));
    }

    #[test]
    fn the_capabilities_cover_every_app_window() {
        let capabilities: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let windows: Vec<&str> = capabilities["windows"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|w| w.as_str())
            .collect();
        assert!(windows.contains(&"main"));
        assert!(windows.contains(&format!("{LABEL_PREFIX}*").as_str()));
    }
}
