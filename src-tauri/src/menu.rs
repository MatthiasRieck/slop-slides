//! The menu bar, built from the app's command table (src/lib/commands.json), which the command
//! palette and the shortcut help read too, so the three always list the same commands under the
//! same names and keys.
//!
//! A command chosen in the menu bar goes to the frontend of the focused window as a
//! [`MENU_EVENT`], which runs it (src/hooks/useCommandMenu.ts); the frontend tells the menu bar
//! which commands can run and which are on with [`set_menu_state`]. The system's own items (Cut,
//! Copy, Paste and Select All for text fields, Hide, Quit, the window items) stay native. File ›
//! New Window opens a window here, even with no window open.
//!
//! On macOS the menu bar belongs to the app and shows the keys; the page sees every key first,
//! and the frontend does not run a choice that is the echo of a key it already handled. On
//! Windows and Linux each app window has a menu bar of its own; its items name their keys without
//! taking them, so the page alone acts on a key there.

use std::collections::HashSet;
use std::sync::OnceLock;

use serde::Deserialize;
use tauri::menu::{
    AboutMetadata, CheckMenuItem, IsMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem,
    Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::error::{Error, Result};
use crate::windows;

/// The command table, as the frontend has it.
const TABLE: &str = include_str!("../../src/lib/commands.json");

/// The event a chosen command goes to the frontend in, with the command's id.
pub const MENU_EVENT: &str = "menu-command";

/// File › New Window, which the backend opens itself.
pub const NEW_WINDOW: &str = "window.new";

/// The systems whose menu bars differ.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Mac,
    Windows,
    Linux,
}

/// The system this build runs on.
pub const PLATFORM: Platform = if cfg!(target_os = "macos") {
    Platform::Mac
} else if cfg!(windows) {
    Platform::Windows
} else {
    Platform::Linux
};

#[derive(Deserialize)]
struct Table {
    menus: Vec<TableMenu>,
}

#[derive(Deserialize)]
struct TableMenu {
    title: String,
    items: Vec<Entry>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Entry {
    /// "-"
    Separator(String),
    Native {
        native: String,
    },
    Command(TableCommand),
}

#[derive(Deserialize)]
struct TableCommand {
    id: String,
    title: String,
    #[serde(default)]
    titles: Titles,
    keys: Option<String>,
    #[serde(default)]
    check: bool,
}

#[derive(Deserialize, Default)]
struct Titles {
    macos: Option<String>,
    windows: Option<String>,
    linux: Option<String>,
}

/// An item the system provides, with its own action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Native {
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Fullscreen,
    Minimize,
    Maximize,
    BringAllToFront,
}

impl Native {
    fn parse(name: &str) -> Option<Native> {
        Some(match name {
            "about" => Native::About,
            "services" => Native::Services,
            "hide" => Native::Hide,
            "hideOthers" => Native::HideOthers,
            "showAll" => Native::ShowAll,
            "quit" => Native::Quit,
            "cut" => Native::Cut,
            "copy" => Native::Copy,
            "paste" => Native::Paste,
            "selectAll" => Native::SelectAll,
            "fullscreen" => Native::Fullscreen,
            "minimize" => Native::Minimize,
            "maximize" => Native::Maximize,
            "bringAllToFront" => Native::BringAllToFront,
            _ => return None,
        })
    }

    /// Whether the system has it. Linux's clipboard items need a library the app does not
    /// bring (text fields have the keys and their own menu there), and GTK has no Minimize.
    fn on(self, platform: Platform) -> bool {
        match self {
            Native::About | Native::Quit | Native::Maximize => true,
            Native::Cut | Native::Copy | Native::Paste | Native::SelectAll | Native::Minimize => {
                platform != Platform::Linux
            }
            Native::Services
            | Native::Hide
            | Native::HideOthers
            | Native::ShowAll
            | Native::Fullscreen
            | Native::BringAllToFront => platform == Platform::Mac,
        }
    }
}

/// An item of a menu, as built.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Item {
    Command {
        id: String,
        title: String,
        /// The keys the menu bar shows and takes (macOS only).
        accelerator: Option<String>,
        check: bool,
    },
    Native(Native),
    Separator,
}

/// A menu of the bar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuSpec {
    /// Set for the menus the system knows by id: the Window and Help menus.
    pub id: Option<&'static str>,
    pub title: String,
    pub items: Vec<Item>,
}

/// The menu bar `table` describes, for `platform`. macOS has the app menu first; elsewhere its
/// commands (Settings…) and Quit end the File menu, and About ends the Help menu. Items the
/// system lacks are left out, and so are separators left with nothing to separate.
pub fn layout(table: &str, platform: Platform, app_name: &str) -> Result<Vec<MenuSpec>> {
    let table: Table =
        serde_json::from_str(table).map_err(|e| Error::msg(format!("the command table: {e}")))?;
    let mut menus: Vec<MenuSpec> = Vec::new();
    let mut app_commands: Vec<Item> = Vec::new();
    let mut about = false;
    let mut quit = false;
    for menu in table.menus {
        let mut items = Vec::new();
        for entry in menu.items {
            let item = match entry {
                Entry::Separator(text) if text == "-" => Item::Separator,
                Entry::Separator(text) => {
                    return Err(Error::msg(format!("\"{text}\" is not a menu item")))
                }
                Entry::Native { native } => match Native::parse(&native) {
                    Some(native) if native.on(platform) => Item::Native(native),
                    Some(_) => continue,
                    None => return Err(Error::msg(format!("no native menu item \"{native}\""))),
                },
                Entry::Command(command) => command_item(command, platform),
            };
            items.push(item);
        }
        if menu.title == "App" && platform != Platform::Mac {
            about = items.contains(&Item::Native(Native::About));
            quit = items.contains(&Item::Native(Native::Quit));
            app_commands.extend(
                items
                    .into_iter()
                    .filter(|item| matches!(item, Item::Command { .. })),
            );
            continue;
        }
        let (id, title) = match menu.title.as_str() {
            "App" => (None, app_name.to_string()),
            "Window" => (Some(WINDOW_MENU), menu.title),
            "Help" => (Some(HELP_MENU), menu.title),
            _ => (None, menu.title),
        };
        menus.push(MenuSpec { id, title, items });
    }
    if platform != Platform::Mac {
        if let Some(file) = menus.iter_mut().find(|menu| menu.title == "File") {
            file.items.push(Item::Separator);
            file.items.extend(app_commands);
            if quit {
                file.items.push(Item::Separator);
                file.items.push(Item::Native(Native::Quit));
            }
        }
        if let Some(help) = menus.iter_mut().find(|menu| menu.id == Some(HELP_MENU)) {
            if about {
                help.items.push(Item::Separator);
                help.items.push(Item::Native(Native::About));
            }
        }
    }
    for menu in &mut menus {
        menu.items = tidy(std::mem::take(&mut menu.items));
    }
    menus.retain(|menu| !menu.items.is_empty());
    Ok(menus)
}

/// The id of the Window menu, which macOS lists the windows in.
const WINDOW_MENU: &str = WINDOW_SUBMENU_ID;
/// The id of the Help menu, which macOS gives its search field.
const HELP_MENU: &str = HELP_SUBMENU_ID;

fn command_item(command: TableCommand, platform: Platform) -> Item {
    let title = match platform {
        Platform::Mac => command.titles.macos,
        Platform::Windows => command.titles.windows,
        Platform::Linux => command.titles.linux,
    }
    .unwrap_or(command.title);
    let keys = command.keys.as_deref();
    let (title, accelerator) = match (platform, keys) {
        (Platform::Mac, Some(keys)) => (title, accelerator(keys)),
        // Windows writes the keys in the menu's own column after a tab, without taking them.
        (Platform::Windows, Some(keys)) => (format!("{title}\t{}", key_label(keys)), None),
        _ => (title, None),
    };
    Item::Command {
        id: command.id,
        title,
        accelerator,
        check: command.check,
    }
}

/// `items` without separators at either end or next to each other.
fn tidy(items: Vec<Item>) -> Vec<Item> {
    let mut tidied: Vec<Item> = Vec::new();
    for item in items {
        if item == Item::Separator && matches!(tidied.last(), None | Some(Item::Separator)) {
            continue;
        }
        tidied.push(item);
    }
    if tidied.last() == Some(&Item::Separator) {
        tidied.pop();
    }
    tidied
}

/// The parts of a `formatKeys` spec: its modifiers, and its key. "mod+plus" names the + key.
fn parts(keys: &str) -> (Vec<&str>, &str) {
    let parts: Vec<&str> = keys.split('+').collect();
    let (key, modifiers) = parts.split_last().expect("split gives at least one part");
    (modifiers.to_vec(), key)
}

/// A spec's keys as a menu accelerator ("mod+shift+z" is "CmdOrCtrl+Shift+Z"); None for keys
/// without ⌘ or Ctrl, which a menu must not take from typing.
pub fn accelerator(keys: &str) -> Option<String> {
    let (modifiers, key) = parts(keys);
    if !modifiers.iter().any(|m| *m == "mod" || *m == "ctrl") {
        return None;
    }
    let mut out: Vec<String> = Vec::new();
    for (name, accel) in [
        ("ctrl", "Ctrl"),
        ("alt", "Alt"),
        ("shift", "Shift"),
        ("mod", "CmdOrCtrl"),
    ] {
        if modifiers.contains(&name) {
            out.push(accel.to_string());
        }
    }
    out.push(match key {
        // ⌘+ is the = key, as every app's Zoom In has it.
        "plus" => "=".to_string(),
        "enter" => "Enter".to_string(),
        "backspace" => "Backspace".to_string(),
        "up" => "Up".to_string(),
        "down" => "Down".to_string(),
        "left" => "Left".to_string(),
        "right" => "Right".to_string(),
        other => other.to_uppercase(),
    });
    Some(out.join("+"))
}

/// A spec's keys as Windows writes them in a menu: "Ctrl+Shift+Z".
pub fn key_label(keys: &str) -> String {
    let (modifiers, key) = parts(keys);
    let mut out: Vec<String> = Vec::new();
    if modifiers.contains(&"mod") || modifiers.contains(&"ctrl") {
        out.push("Ctrl".into());
    }
    if modifiers.contains(&"alt") {
        out.push("Alt".into());
    }
    if modifiers.contains(&"shift") {
        out.push("Shift".into());
    }
    out.push(match key {
        "plus" => "+".to_string(),
        "enter" => "Enter".to_string(),
        "backspace" => "Backspace".to_string(),
        "up" => "Up".to_string(),
        "down" => "Down".to_string(),
        other => other.to_uppercase(),
    });
    out.join("+")
}

/// The ids of the table's commands.
fn command_ids() -> &'static HashSet<String> {
    static IDS: OnceLock<HashSet<String>> = OnceLock::new();
    IDS.get_or_init(|| {
        layout(TABLE, PLATFORM, "")
            .map(|menus| {
                menus
                    .into_iter()
                    .flat_map(|menu| menu.items)
                    .filter_map(|item| match item {
                        Item::Command { id, .. } => Some(id),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default()
    })
}

/// The menu bar for this system.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let info = app.package_info();
    let specs = layout(TABLE, PLATFORM, &info.name)
        .map_err(|e| tauri::Error::Io(std::io::Error::other(e.to_string())))?;
    let about = AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        authors: app.config().bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };
    let menu = Menu::new(app)?;
    for spec in specs {
        let submenu = match spec.id {
            Some(id) => Submenu::with_id(app, id, &spec.title, true)?,
            None => Submenu::new(app, &spec.title, true)?,
        };
        for item in spec.items {
            let built: Box<dyn IsMenuItem<R>> = match item {
                Item::Separator => Box::new(PredefinedMenuItem::separator(app)?),
                Item::Native(native) => Box::new(native_item(app, native, &about)?),
                Item::Command {
                    id,
                    title,
                    accelerator,
                    check: true,
                } => Box::new(CheckMenuItem::with_id(
                    app,
                    id,
                    title,
                    true,
                    false,
                    accelerator,
                )?),
                Item::Command {
                    id,
                    title,
                    accelerator,
                    ..
                } => Box::new(MenuItem::with_id(app, id, title, true, accelerator)?),
            };
            submenu.append(built.as_ref())?;
        }
        menu.append(&submenu)?;
    }
    Ok(menu)
}

fn native_item<R: Runtime>(
    app: &AppHandle<R>,
    native: Native,
    about: &AboutMetadata,
) -> tauri::Result<PredefinedMenuItem<R>> {
    match native {
        Native::About => PredefinedMenuItem::about(app, None, Some(about.clone())),
        Native::Services => PredefinedMenuItem::services(app, None),
        Native::Hide => PredefinedMenuItem::hide(app, None),
        Native::HideOthers => PredefinedMenuItem::hide_others(app, None),
        Native::ShowAll => PredefinedMenuItem::show_all(app, None),
        Native::Quit => PredefinedMenuItem::quit(app, None),
        Native::Cut => PredefinedMenuItem::cut(app, None),
        Native::Copy => PredefinedMenuItem::copy(app, None),
        Native::Paste => PredefinedMenuItem::paste(app, None),
        Native::SelectAll => PredefinedMenuItem::select_all(app, None),
        Native::Fullscreen => PredefinedMenuItem::fullscreen(app, None),
        Native::Minimize => PredefinedMenuItem::minimize(app, None),
        Native::Maximize => PredefinedMenuItem::maximize(app, None),
        Native::BringAllToFront => PredefinedMenuItem::bring_all_to_front(app, None),
    }
}

/// Gives an app window its own menu bar (Windows and Linux, where a menu bar is the window's).
#[cfg(not(target_os = "macos"))]
pub fn attach<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let menu = build(window.app_handle());
    if let Err(e) = menu.and_then(|menu| window.set_menu(menu).map(|_| ())) {
        eprintln!("cannot give the window its menu bar: {e}");
    }
}

/// Where a command chosen in the menu bar goes, of the app windows (label, focused): the focused
/// one; with none focused, nowhere.
pub fn target(windows: &[(String, bool)]) -> Option<&str> {
    windows
        .iter()
        .find(|(_, focused)| *focused)
        .map(|(label, _)| label.as_str())
}

/// What a menu choice asks for.
#[derive(Debug, PartialEq, Eq)]
pub enum Route<'a> {
    /// A new window, opened here.
    NewWindow,
    /// A command for the frontend of this window.
    Window(&'a str),
    /// No window to run it in: the app has none open, so it opens one.
    OpenWindow,
    /// Nothing: the system's own items act by themselves, and a command with no window focused waits.
    Nothing,
}

/// Where the menu choice `id` goes, with the app windows as they are.
pub fn route<'a>(id: &str, windows: &'a [(String, bool)]) -> Route<'a> {
    if id == NEW_WINDOW {
        return Route::NewWindow;
    }
    if !command_ids().contains(id) {
        return Route::Nothing;
    }
    match target(windows) {
        Some(label) => Route::Window(label),
        None if windows.is_empty() => Route::OpenWindow,
        None => Route::Nothing,
    }
}

/// Does what the menu choice `id` asks for (see [`route`]).
pub fn on_event(app: &AppHandle, id: &str) {
    let windows: Vec<(String, bool)> = app
        .webview_windows()
        .into_values()
        .filter(|window| windows::is_app_window(window.label()))
        .map(|window| {
            let focused = window.is_focused().unwrap_or(false);
            (window.label().to_string(), focused)
        })
        .collect();
    let result = match route(id, &windows) {
        Route::NewWindow | Route::OpenWindow => windows::open_new(app),
        Route::Window(label) => app
            .emit_to(label, MENU_EVENT, id)
            .map_err(|e| Error::msg(e.to_string())),
        Route::Nothing => Ok(()),
    };
    if let Err(e) = result {
        eprintln!("{e}");
    }
}

/// What the frontend says about the commands: those that cannot run now, and those that are on.
#[derive(Debug, Deserialize, Default)]
pub struct MenuState {
    pub disabled: Vec<String>,
    pub checked: Vec<String>,
}

/// What a command's item shows: whether it can be chosen, and whether it is checked.
pub fn item_state(state: &MenuState, id: &str) -> (bool, bool) {
    (
        !state.disabled.iter().any(|other| other == id),
        state.checked.iter().any(|other| other == id),
    )
}

/// Takes the frontend's word on which commands can run and which are on. On macOS the menu bar
/// is the app's and shows the focused window's state, so a window that is not focused is not
/// heard; elsewhere each window has its own menu bar.
#[tauri::command]
pub fn set_menu_state<R: Runtime>(
    app: AppHandle<R>,
    window: tauri::WebviewWindow<R>,
    state: MenuState,
) -> Result<()> {
    let menu = if PLATFORM == Platform::Mac {
        if !window.is_focused().unwrap_or(false) {
            return Ok(());
        }
        app.menu()
    } else {
        window.menu()
    };
    let Some(menu) = menu else { return Ok(()) };
    let items = menu.items().map_err(|e| Error::msg(e.to_string()))?;
    apply(&items, &state).map_err(|e| Error::msg(e.to_string()))
}

fn apply<R: Runtime>(items: &[MenuItemKind<R>], state: &MenuState) -> tauri::Result<()> {
    for item in items {
        match item {
            MenuItemKind::Submenu(submenu) => apply(&submenu.items()?, state)?,
            MenuItemKind::MenuItem(item) if command_ids().contains(item.id().as_ref()) => {
                item.set_enabled(item_state(state, item.id().as_ref()).0)?;
            }
            MenuItemKind::Check(item) if command_ids().contains(item.id().as_ref()) => {
                let (enabled, checked) = item_state(state, item.id().as_ref());
                item.set_enabled(enabled)?;
                item.set_checked(checked)?;
            }
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn titles(menus: &[MenuSpec]) -> Vec<&str> {
        menus.iter().map(|menu| menu.title.as_str()).collect()
    }

    fn menu<'a>(menus: &'a [MenuSpec], title: &str) -> &'a MenuSpec {
        menus.iter().find(|menu| menu.title == title).unwrap()
    }

    fn command_ids_of(menu: &MenuSpec) -> Vec<&str> {
        menu.items
            .iter()
            .filter_map(|item| match item {
                Item::Command { id, .. } => Some(id.as_str()),
                _ => None,
            })
            .collect()
    }

    fn command<'a>(menus: &'a [MenuSpec], wanted: &str) -> &'a Item {
        menus
            .iter()
            .flat_map(|menu| &menu.items)
            .find(|item| matches!(item, Item::Command { id, .. } if id == wanted))
            .unwrap()
    }

    const SMALL: &str = r#"{ "menus": [
        { "title": "App", "items": [{ "native": "about" }, "-", { "id": "app.settings", "title": "Settings…", "keys": "mod+," }, "-", { "native": "hide" }, "-", { "native": "quit" }] },
        { "title": "File", "items": [{ "id": "a", "title": "Show in folder", "titles": { "macos": "Show in Finder" } }, "-", "-", { "id": "b", "title": "Sidebar", "keys": "mod+\\", "check": true }, "-"] },
        { "title": "Edit", "items": [{ "id": "undo", "title": "Undo", "keys": "mod+z" }, "-", { "native": "cut" }, { "native": "copy" }] },
        { "title": "Window", "items": [{ "native": "minimize" }, "-", { "native": "bringAllToFront" }] },
        { "title": "Help", "items": [{ "id": "help", "title": "Keyboard shortcuts…", "keys": "mod+/" }] }
    ] }"#;

    #[test]
    fn macos_has_the_app_menu_first_with_the_keys_taken_by_the_menu_bar() {
        let menus = layout(SMALL, Platform::Mac, "SlopSlide").unwrap();
        assert_eq!(
            titles(&menus),
            ["SlopSlide", "File", "Edit", "Window", "Help"]
        );
        assert_eq!(
            menus[0].items,
            [
                Item::Native(Native::About),
                Item::Separator,
                Item::Command {
                    id: "app.settings".into(),
                    title: "Settings…".into(),
                    accelerator: Some("CmdOrCtrl+,".into()),
                    check: false
                },
                Item::Separator,
                Item::Native(Native::Hide),
                Item::Separator,
                Item::Native(Native::Quit),
            ]
        );
        // Named for the system, separators tidied, a check item for what is on or off.
        assert_eq!(
            menu(&menus, "File").items,
            [
                Item::Command {
                    id: "a".into(),
                    title: "Show in Finder".into(),
                    accelerator: None,
                    check: false
                },
                Item::Separator,
                Item::Command {
                    id: "b".into(),
                    title: "Sidebar".into(),
                    accelerator: Some("CmdOrCtrl+\\".into()),
                    check: true
                },
            ]
        );
        assert_eq!(menu(&menus, "Window").id, Some(WINDOW_MENU));
        assert_eq!(menu(&menus, "Help").id, Some(HELP_MENU));
        assert!(menu(&menus, "Window")
            .items
            .contains(&Item::Native(Native::BringAllToFront)));
    }

    #[test]
    fn windows_ends_file_with_settings_and_exit_and_help_with_about_and_writes_keys_without_taking_them(
    ) {
        let menus = layout(SMALL, Platform::Windows, "SlopSlide").unwrap();
        assert_eq!(titles(&menus), ["File", "Edit", "Window", "Help"]);
        let file = menu(&menus, "File");
        assert_eq!(command_ids_of(file), ["a", "b", "app.settings"]);
        assert_eq!(file.items.last(), Some(&Item::Native(Native::Quit)));
        assert_eq!(
            command(&menus, "app.settings"),
            &Item::Command {
                id: "app.settings".into(),
                title: "Settings…\tCtrl+,".into(),
                accelerator: None,
                check: false
            }
        );
        let help = menu(&menus, "Help");
        assert_eq!(help.items.last(), Some(&Item::Native(Native::About)));
        assert!(!menus
            .iter()
            .flat_map(|m| &m.items)
            .any(|item| matches!(item, Item::Native(Native::Hide | Native::BringAllToFront))));
        // The clipboard items stay native, so they work in text fields.
        assert!(menu(&menus, "Edit")
            .items
            .contains(&Item::Native(Native::Copy)));
    }

    #[test]
    fn linux_names_no_keys_and_leaves_out_what_gtk_lacks() {
        let menus = layout(SMALL, Platform::Linux, "SlopSlide").unwrap();
        // Window had only Minimize and Bring All to Front, which GTK has neither of.
        assert_eq!(titles(&menus), ["File", "Edit", "Help"]);
        assert_eq!(
            command(&menus, "undo"),
            &Item::Command {
                id: "undo".into(),
                title: "Undo".into(),
                accelerator: None,
                check: false
            }
        );
        assert_eq!(menu(&menus, "Edit").items.len(), 1);
    }

    #[test]
    fn an_unknown_native_item_is_a_mistake_in_the_table() {
        let table = r#"{ "menus": [{ "title": "File", "items": [{ "native": "teleport" }] }] }"#;
        assert!(layout(table, Platform::Mac, "SlopSlide").is_err());
    }

    #[test]
    fn the_app_table_lays_out_on_every_system() {
        for platform in [Platform::Mac, Platform::Windows, Platform::Linux] {
            let menus = layout(TABLE, platform, "SlopSlide").unwrap();
            let expected: &[&str] = match platform {
                Platform::Mac => &[
                    "SlopSlide",
                    "File",
                    "Edit",
                    "View",
                    "Insert",
                    "Format",
                    "Arrange",
                    "Slide",
                    "Present",
                    "Window",
                    "Help",
                ],
                Platform::Windows => &[
                    "File", "Edit", "View", "Insert", "Format", "Arrange", "Slide", "Present",
                    "Window", "Help",
                ],
                Platform::Linux => &[
                    "File", "Edit", "View", "Insert", "Format", "Arrange", "Slide", "Present",
                    "Window", "Help",
                ],
            };
            assert_eq!(titles(&menus), expected, "{platform:?}");
            // File › New Window, Edit's undo, the shortcuts in Help.
            assert!(command_ids_of(menu(&menus, "File")).contains(&NEW_WINDOW));
            assert_eq!(
                command_ids_of(menu(&menus, "Edit"))[..2],
                ["edit.undo", "edit.redo"]
            );
            assert!(command_ids_of(menu(&menus, "Help")).contains(&"help.palette"));
            // Every id once.
            let ids: Vec<&str> = menus.iter().flat_map(command_ids_of).collect();
            let unique: HashSet<&&str> = ids.iter().collect();
            assert_eq!(unique.len(), ids.len(), "{platform:?}");
        }
    }

    #[test]
    fn macos_takes_only_keys_with_the_command_key_and_writes_them_as_the_menu_bar_reads_them() {
        assert_eq!(
            accelerator("mod+shift+z").as_deref(),
            Some("Shift+CmdOrCtrl+Z")
        );
        assert_eq!(accelerator("mod+plus").as_deref(), Some("CmdOrCtrl+="));
        assert_eq!(
            accelerator("mod+shift+enter").as_deref(),
            Some("Shift+CmdOrCtrl+Enter")
        );
        assert_eq!(
            accelerator("mod+alt+shift+h").as_deref(),
            Some("Alt+Shift+CmdOrCtrl+H")
        );
        assert_eq!(accelerator("mod+up").as_deref(), Some("CmdOrCtrl+Up"));
        // Plain keys are typing's.
        assert_eq!(accelerator("g"), None);
        assert_eq!(accelerator("backspace"), None);
        assert_eq!(accelerator("shift+0"), None);
    }

    /// The keys the menu bar's parser (muda's `Accelerator`) knows, of those the table can use.
    const PARSED_KEYS: &[&str] = &[
        "`",
        "\\",
        "[",
        "]",
        ",",
        "=",
        "-",
        ".",
        "'",
        ";",
        "/",
        "Enter",
        "Backspace",
        "Up",
        "Down",
        "Left",
        "Right",
    ];

    #[test]
    fn every_key_of_the_table_is_one_the_menu_bar_can_take() {
        for menu in layout(TABLE, Platform::Mac, "SlopSlide").unwrap() {
            for item in menu.items {
                let Item::Command {
                    id,
                    accelerator: Some(accelerator),
                    ..
                } = item
                else {
                    continue;
                };
                let (modifiers, key) = accelerator.rsplit_once('+').unwrap();
                for modifier in modifiers.split('+') {
                    assert!(
                        ["CmdOrCtrl", "Shift", "Alt", "Ctrl"].contains(&modifier),
                        "{id}: {accelerator}"
                    );
                }
                let known = (key.len() == 1 && key.chars().all(|c| c.is_ascii_alphanumeric()))
                    || PARSED_KEYS.contains(&key);
                assert!(known, "{id}: {accelerator}");
            }
        }
    }

    #[test]
    fn windows_writes_keys_as_its_menus_do() {
        assert_eq!(key_label("mod+shift+z"), "Ctrl+Shift+Z");
        assert_eq!(key_label("mod+plus"), "Ctrl++");
        assert_eq!(key_label("mod+alt+c"), "Ctrl+Alt+C");
        assert_eq!(key_label("t"), "T");
        assert_eq!(key_label("mod+\\"), "Ctrl+\\");
    }

    #[test]
    fn a_command_goes_to_the_focused_window_and_new_window_is_opened_here() {
        let windows = vec![("main".to_string(), false), ("window-2".to_string(), true)];
        assert_eq!(route("view.sidebar", &windows), Route::Window("window-2"));
        assert_eq!(route(NEW_WINDOW, &windows), Route::NewWindow);
        assert_eq!(route(NEW_WINDOW, &[]), Route::NewWindow);
        // The system's own items, and anything else, are not the frontend's.
        assert_eq!(route("not-a-command", &windows), Route::Nothing);
    }

    #[test]
    fn with_no_window_focused_a_command_waits_and_with_none_open_a_window_opens() {
        let unfocused = vec![("main".to_string(), false)];
        assert_eq!(route("file.openFolder", &unfocused), Route::Nothing);
        assert_eq!(route("file.openFolder", &[]), Route::OpenWindow);
    }

    #[test]
    fn the_frontend_state_says_what_each_item_shows() {
        let state = MenuState {
            disabled: vec!["edit.undo".into()],
            checked: vec!["view.sidebar".into()],
        };
        assert_eq!(item_state(&state, "edit.undo"), (false, false));
        assert_eq!(item_state(&state, "view.sidebar"), (true, true));
        assert_eq!(item_state(&state, "view.rail"), (true, false));
        let parsed: MenuState =
            serde_json::from_str(r#"{ "disabled": ["a"], "checked": [] }"#).unwrap();
        assert_eq!(parsed.disabled, ["a"]);
    }
}
