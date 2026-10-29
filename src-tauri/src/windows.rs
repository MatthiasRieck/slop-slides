//! App windows. Each window has a workspace of its own (see [`OpenWorkspace`]), so several
//! folders can be open side by side; File › New Window (⌘N, Ctrl+N elsewhere) opens another,
//! and so does opening the app again (on macOS: a double-click in Finder, a click on its Dock
//! icon). On macOS, folders opened with the app from Finder (dropped on its icon, Open With)
//! open in a window too: see `open_folder`.

use std::collections::HashMap;
#[cfg(any(target_os = "macos", test))]
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

#[cfg(target_os = "macos")]
use tauri::Emitter;
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

#[cfg(target_os = "macos")]
/// Tells the windows a folder is waiting to be opened in one of them; each asks for its own
/// with `take_pending_folder`.
pub const PENDING_EVENT: &str = "folder-pending";

/// Folders waiting to be opened, by the label of the window they open in. The window takes
/// its folder once its frontend is up, which for a new window is after it is built. Only
/// macOS opens folders from outside the app; elsewhere none are ever waiting.
#[derive(Default)]
pub struct PendingFolders(Mutex<HashMap<String, PathBuf>>);

impl PendingFolders {
    pub fn take(&self, window: &str) -> Option<PathBuf> {
        self.0.lock().unwrap().remove(window)
    }
}

#[cfg(any(target_os = "macos", test))]
impl PendingFolders {
    fn insert(&self, window: &str, root: PathBuf) {
        self.0.lock().unwrap().insert(window.to_string(), root);
    }

    fn window_with(&self, root: &Path) -> Option<String> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .find(|(_, pending)| same_folder(pending, root))
            .map(|(window, _)| window.clone())
    }

    fn has(&self, window: &str) -> bool {
        self.0.lock().unwrap().contains_key(window)
    }
}

#[cfg(any(target_os = "macos", test))]
fn same_folder(a: &Path, b: &Path) -> bool {
    let resolve = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    resolve(a) == resolve(b)
}

/// Where a folder opened from outside the app goes.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, PartialEq)]
enum Target {
    /// The window that has it open (or is about to): brought to the front.
    Focus(String),
    /// A window on the start screen: it opens the folder.
    Use(String),
    /// A new window.
    New,
}

/// Where `root` goes, given the app windows (`windows`, in the order to prefer them).
#[cfg(any(target_os = "macos", test))]
fn target(
    open: &OpenWorkspace,
    pending: &PendingFolders,
    windows: &[String],
    root: &Path,
) -> Target {
    if let Some(window) = open
        .window_with(root, "")
        .or_else(|| pending.window_with(root))
    {
        return Target::Focus(window);
    }
    // Before the first window is up (the app was started by opening a folder), it is `main`.
    if windows.is_empty() {
        return Target::Use("main".into());
    }
    windows
        .iter()
        .find(|w| open.get(w).is_none() && !pending.has(w))
        .map_or(Target::New, |w| Target::Use(w.clone()))
}

/// Opens `root`, a folder opened with the app from outside it, in a window: the one that has
/// it open already, else one on the start screen, else a new one.
#[cfg(target_os = "macos")]
pub fn open_folder(app: &AppHandle, root: PathBuf) -> Result<()> {
    let mut windows: Vec<String> = app
        .webview_windows()
        .into_keys()
        .filter(|label| is_app_window(label))
        .collect();
    // The first window first, then the others in the order they were opened.
    windows.sort_by_key(|label| (label != "main", label.clone()));
    let pending = app.state::<PendingFolders>();
    match target(&app.state::<OpenWorkspace>(), &pending, &windows, &root) {
        Target::Focus(window) => focus(app, &window),
        Target::Use(window) => {
            pending.insert(&window, root);
            focus(app, &window);
        }
        Target::New => {
            let label = new_label();
            pending.insert(&label, root);
            if let Err(e) = build(app, &label) {
                pending.take(&label);
                return Err(e);
            }
        }
    }
    let _ = app.emit(PENDING_EVENT, ());
    Ok(())
}

#[cfg(target_os = "macos")]
fn focus(app: &AppHandle, window: &str) {
    if let Some(window) = app.get_webview_window(window) {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// How far a new window sits down and right of the one it was opened from.
const CASCADE: f64 = 28.0;

/// Whether `label` is an app window (not, say, the hidden one a PDF export prints from).
pub fn is_app_window(label: &str) -> bool {
    label == "main" || label.starts_with(LABEL_PREFIX)
}

fn new_label() -> String {
    format!("{LABEL_PREFIX}{}", uuid::Uuid::new_v4().simple())
}

/// Opens another app window, configured like the first, on the start screen.
pub fn open_new(app: &AppHandle) -> Result<()> {
    build(app, &new_label())
}

/// Builds an app window labeled `label`, configured like the first.
fn build(app: &AppHandle, label: &str) -> Result<()> {
    let mut config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| Error::msg("no window configuration"))?;
    config.label = label.to_string();
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
    window.state::<PendingFolders>().take(label);
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

    fn temp_dirs(names: &[&str]) -> Vec<PathBuf> {
        let root = std::env::temp_dir().join(format!("slopslide-windows-{}", uuid::Uuid::new_v4()));
        names
            .iter()
            .map(|name| {
                let dir = root.join(name);
                std::fs::create_dir_all(&dir).unwrap();
                dir
            })
            .collect()
    }

    #[test]
    fn a_folder_from_finder_goes_where_it_is_open_else_to_a_free_window_else_a_new_one() {
        let dirs = temp_dirs(&["a", "b", "c"]);
        let (open, pending) = (OpenWorkspace::default(), PendingFolders::default());
        let windows = vec!["main".to_string(), "window-2".to_string()];
        open.set("main", Some(dirs[0].clone()));
        assert_eq!(
            target(&open, &pending, &windows, &dirs[0]),
            Target::Focus("main".into())
        );
        assert_eq!(
            target(&open, &pending, &windows, &dirs[1]),
            Target::Use("window-2".into()),
            "the window on the start screen takes it"
        );
        pending.insert("window-2", dirs[1].clone());
        assert_eq!(
            target(&open, &pending, &windows, &dirs[1]),
            Target::Focus("window-2".into()),
            "opened twice before the window took it"
        );
        assert_eq!(target(&open, &pending, &windows, &dirs[2]), Target::New);
        assert_eq!(pending.take("window-2"), Some(dirs[1].clone()));
        assert_eq!(pending.take("window-2"), None, "taken once");
    }

    #[test]
    fn a_folder_opened_while_the_app_starts_goes_to_the_first_window() {
        let dirs = temp_dirs(&["a"]);
        let (open, pending) = (OpenWorkspace::default(), PendingFolders::default());
        assert_eq!(
            target(&open, &pending, &[], &dirs[0]),
            Target::Use("main".into())
        );
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
