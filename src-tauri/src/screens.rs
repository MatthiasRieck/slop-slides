//! Screens for presenting. With several attached, the show goes on one of them and the
//! presenter view (notes, next slide, timers) in a window of its own on another; the frontend
//! lets the user pick (see `ScreenPicker`). The presenter view is the same frontend loaded
//! with `?presenter`: it renders from what the show window sends it and never opens a
//! workspace itself (slides are served to any window while a workspace has them open).

use serde::Serialize;
use tauri::{
    AppHandle, Manager, Monitor, PhysicalPosition, WebviewUrl, WebviewWindowBuilder, Window,
};

use crate::error::{Error, Result};

/// Label of the presenter view window.
pub const PRESENTER_LABEL: &str = "presenter";

/// A screen, in physical pixels on the desktop the system arranges them on.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Screen {
    /// Position in [`list`]'s order, which `present` takes.
    pub index: usize,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub primary: bool,
}

fn describe(index: usize, monitor: &Monitor, primary: Option<&Monitor>) -> Screen {
    let position = monitor.position();
    let size = monitor.size();
    Screen {
        index,
        name: monitor
            .name()
            .cloned()
            .unwrap_or_else(|| format!("Screen {}", index + 1)),
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        scale: monitor.scale_factor(),
        primary: primary.is_some_and(|p| p.position() == position && p.size() == size),
    }
}

/// The attached screens, left to right then top to bottom, so the order matches how they sit.
pub fn list(app: &AppHandle) -> Result<Vec<Screen>> {
    let primary = app.primary_monitor().ok().flatten();
    let mut monitors = app
        .available_monitors()
        .map_err(|e| Error::msg(format!("cannot list the screens: {e}")))?;
    monitors.sort_by_key(|m| (m.position().x, m.position().y));
    Ok(monitors
        .iter()
        .enumerate()
        .map(|(index, m)| describe(index, m, primary.as_ref()))
        .collect())
}

/// Checks that the show and the presenter view go on different, existing screens.
fn validate(count: usize, audience: usize, presenter: Option<usize>) -> Result<()> {
    if audience >= count || presenter.is_some_and(|p| p >= count) {
        return Err(Error::msg("that screen is no longer attached"));
    }
    if presenter == Some(audience) {
        return Err(Error::msg(
            "the show and the presenter view need different screens",
        ));
    }
    Ok(())
}

/// Moves the show window to `audience` (the frontend makes it full screen once it is there)
/// and opens the presenter view full screen on `presenter`, if given.
pub fn present(
    app: &AppHandle,
    window: &Window,
    audience: usize,
    presenter: Option<usize>,
) -> Result<()> {
    let screens = list(app)?;
    validate(screens.len(), audience, presenter)?;
    let at = &screens[audience];
    window
        .set_position(PhysicalPosition::new(at.x, at.y))
        .map_err(|e| Error::msg(format!("cannot move the show: {e}")))?;
    close_presenter_view(app);
    if let Some(index) = presenter {
        let at = &screens[index];
        let scale = at.scale;
        let view = WebviewWindowBuilder::new(
            app,
            PRESENTER_LABEL,
            WebviewUrl::App("index.html?presenter".into()),
        )
        .title("Presenter view")
        .position(f64::from(at.x) / scale, f64::from(at.y) / scale)
        .inner_size(1000.0, 640.0)
        .build()
        .map_err(|e| Error::msg(format!("cannot open the presenter view: {e}")))?;
        let _ = view.set_fullscreen(true);
    }
    Ok(())
}

/// Closes the presenter view window, if open.
pub fn close_presenter_view(app: &AppHandle) {
    if let Some(view) = app.get_webview_window(PRESENTER_LABEL) {
        let _ = view.destroy();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_show_and_the_presenter_view_go_on_different_screens_that_exist() {
        assert!(validate(2, 0, Some(1)).is_ok());
        assert!(validate(2, 1, None).is_ok());
        assert!(validate(2, 0, Some(0)).is_err(), "same screen");
        assert!(validate(2, 2, None).is_err(), "unplugged since the picker");
        assert!(validate(2, 0, Some(5)).is_err());
    }

    #[test]
    fn the_presenter_window_has_the_capabilities_of_the_app_windows() {
        let capabilities: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let windows = capabilities["windows"].as_array().unwrap();
        assert!(windows.iter().any(|w| w == PRESENTER_LABEL));
    }
}
