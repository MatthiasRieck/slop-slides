//! Screens for presenting. With several attached, the show goes on one of them and the
//! presenter view (notes, next slide, timers) in a window of its own on another; the frontend
//! lets the user pick (see `ScreenPicker`). The presenter view is the same frontend loaded
//! with `?presenter`: it renders from what the show window sends it and never opens a
//! workspace itself (slides are served to any window while a workspace has them open).
//!
//! The picker shows a screenshot of each screen, to tell them apart by what is on them. They
//! are only ever held in the picker: nothing is written to disk. On Linux it goes without (see
//! [`shots`]).

use std::time::Duration;

use serde::Serialize;
use tauri::{
    ipc::Channel, AppHandle, LogicalPosition, Manager, Monitor, PhysicalPosition, Position,
    WebviewUrl, WebviewWindowBuilder, Window,
};

use crate::error::{Error, Result};

/// How long the picker waits for screenshots. It goes on without them after this: a system may
/// be asking the user for permission, and presenting must not depend on that.
const PREVIEW_TIMEOUT: Duration = Duration::from_secs(3);

/// Labels of presenter view windows start with this; the capabilities grant them what the app
/// windows get. Each gets a label of its own: destroying a window only queues that, so a label
/// stays taken for a moment after, and the next show may be starting already.
pub const LABEL_PREFIX: &str = "presenter-";

/// Whether the system lays out screens in points, each screen with its own scale, rather than
/// in the physical pixels of one desktop.
const LAID_OUT_IN_POINTS: bool = cfg!(target_os = "macos");

/// A screen, where it sits on the desktop the system arranges them on.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Screen {
    /// Position in [`list`]'s order, which `present` takes.
    pub index: usize,
    pub name: String,
    /// Position and size in the units of the desktop (see [`on_desktop`]).
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// The screen's resolution.
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub primary: bool,
}

/// A monitor's position and size in one unit for all screens, so they can be compared. Tauri
/// reports physical pixels, but where the system lays out screens in points, each screen's
/// numbers are those points times its own scale: undoing that gives the real arrangement.
fn on_desktop(
    position: (i32, i32),
    size: (u32, u32),
    scale: f64,
    points: bool,
) -> (f64, f64, f64, f64) {
    let unit = if points { scale } else { 1.0 };
    (
        f64::from(position.0) / unit,
        f64::from(position.1) / unit,
        f64::from(size.0) / unit,
        f64::from(size.1) / unit,
    )
}

fn describe(monitor: &Monitor, primary: Option<&Monitor>) -> Screen {
    let position = monitor.position();
    let size = monitor.size();
    let (x, y, width, height) = on_desktop(
        (position.x, position.y),
        (size.width, size.height),
        monitor.scale_factor(),
        LAID_OUT_IN_POINTS,
    );
    Screen {
        index: 0,
        name: monitor.name().cloned().unwrap_or_default(),
        x,
        y,
        width,
        height,
        pixel_width: size.width,
        pixel_height: size.height,
        primary: primary.is_some_and(|p| p.position() == position && p.size() == size),
    }
}

/// Puts screens left to right then top to bottom, as they sit, and numbers them.
fn in_order(mut screens: Vec<Screen>) -> Vec<Screen> {
    screens.sort_by(|a, b| a.x.total_cmp(&b.x).then(a.y.total_cmp(&b.y)));
    for (index, screen) in screens.iter_mut().enumerate() {
        screen.index = index;
        if screen.name.is_empty() {
            screen.name = format!("Screen {}", index + 1);
        }
    }
    screens
}

/// The attached screens, in the order [`in_order`] gives them.
pub fn list(app: &AppHandle) -> Result<Vec<Screen>> {
    let primary = app.primary_monitor().ok().flatten();
    let monitors = app
        .available_monitors()
        .map_err(|e| Error::msg(format!("cannot list the screens: {e}")))?;
    Ok(in_order(
        monitors
            .iter()
            .map(|m| describe(m, primary.as_ref()))
            .collect(),
    ))
}

#[cfg(any(target_os = "macos", windows))]
mod shots {
    use base64::Engine;

    use crate::capture::{self, Image};
    use crate::error::Result;

    /// Widest screenshot in the picker, in pixels: enough for a sharp tile on a high density
    /// screen.
    const PREVIEW_WIDTH: u32 = 640;

    /// Screenshots of the attached monitors as PNG data URLs, in the order [`super::in_order`]
    /// gives the screens, with `None` for one that could not be taken. `grabbed` is called once
    /// the screens are captured and only shrinking and encoding are left: what is drawn on them
    /// from then on is not in the screenshots.
    pub fn capture_all(grabbed: impl FnOnce()) -> Vec<Option<String>> {
        let Ok(mut monitors) = xcap::Monitor::all() else {
            return Vec::new();
        };
        monitors.sort_by_key(|m| (m.x().unwrap_or(0), m.y().unwrap_or(0)));
        let shots: Vec<_> = monitors.iter().map(|m| m.capture_image().ok()).collect();
        grabbed();
        shots.into_iter().map(|shot| preview(shot?).ok()).collect()
    }

    fn preview(shot: xcap::image::RgbaImage) -> Result<String> {
        let image = Image {
            width: shot.width(),
            height: shot.height(),
            rgba: shot.into_raw(),
        };
        let png = capture::encode_png(&capture::downscale(&image, PREVIEW_WIDTH))?;
        let data = base64::engine::general_purpose::STANDARD.encode(png);
        Ok(format!("data:image/png;base64,{data}"))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// Takes real screenshots: run by hand with `--ignored`, on a machine with a screen.
        #[test]
        #[ignore]
        fn captures_the_attached_monitors() {
            let mut grabbed = 0;
            let shots = capture_all(|| grabbed += 1);
            assert!(!shots.is_empty());
            assert_eq!(grabbed, 1);
            for shot in &shots {
                let shot = shot.as_deref().expect("a screenshot of each monitor");
                println!("{}", shot.len());
                let data = shot.strip_prefix("data:image/png;base64,").unwrap();
                let png = base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .unwrap();
                let image = capture::decode_png(&png).unwrap();
                println!("{}x{}", image.width, image.height);
                assert!(image.width <= PREVIEW_WIDTH);
                assert!(
                    image.rgba.chunks(4).any(|p| p[..3] != [0, 0, 0]),
                    "not all black"
                );
            }
        }
    }
}

/// No screenshots on Linux: xcap always builds PipeWire bindings, for recording video, and those
/// don't compile against the PipeWire of Ubuntu 22.04, which the Linux builds are made on.
#[cfg(not(any(target_os = "macos", windows)))]
mod shots {
    pub fn capture_all(_grabbed: impl FnOnce()) -> Vec<Option<String>> {
        Vec::new()
    }
}

/// One entry per screen. Shots of another number of monitors than there are screens (one was
/// just plugged in, or the capture failed) can't be told apart, so none are used: a shot on
/// the wrong screen would be worse than none.
fn for_screens(count: usize, shots: Vec<Option<String>>) -> Vec<Option<String>> {
    if shots.len() == count {
        shots
    } else {
        vec![None; count]
    }
}

/// What each screen in [`list`] shows now, as far as the system lets us see it. Never fails:
/// the picker works without screenshots.
pub async fn previews(app: &AppHandle, grabbed: Channel<()>) -> Vec<Option<String>> {
    let count = list(app).map_or(0, |screens| screens.len());
    let shots = tokio::time::timeout(
        PREVIEW_TIMEOUT,
        tauri::async_runtime::spawn_blocking(move || {
            shots::capture_all(|| {
                let _ = grabbed.send(());
            })
        }),
    )
    .await;
    match shots {
        Ok(Ok(shots)) => for_screens(count, shots),
        _ => vec![None; count],
    }
}

/// Where a window goes to be on `screen`. Points have to be passed as such: a physical position
/// would be divided by the scale of the screen the window is on now, not the one it goes to.
fn origin(screen: &Screen, points: bool) -> Position {
    if points {
        LogicalPosition::new(screen.x, screen.y).into()
    } else {
        // Whole pixels: they were converted from whole pixels.
        PhysicalPosition::new(screen.x as i32, screen.y as i32).into()
    }
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
    window
        .set_position(origin(&screens[audience], LAID_OUT_IN_POINTS))
        .map_err(|e| Error::msg(format!("cannot move the show: {e}")))?;
    close_presenter_view(app);
    let Some(presenter) = presenter else {
        return Ok(());
    };
    let open = |e: tauri::Error| Error::msg(format!("cannot open the presenter view: {e}"));
    // Hidden until it is on its screen, so it does not flash up on another.
    let view = WebviewWindowBuilder::new(
        app,
        format!("{LABEL_PREFIX}{}", uuid::Uuid::new_v4().simple()),
        WebviewUrl::App("index.html?presenter".into()),
    )
    .title("Presenter view")
    .inner_size(1000.0, 640.0)
    .visible(false)
    .build()
    .map_err(open)?;
    view.set_position(origin(&screens[presenter], LAID_OUT_IN_POINTS))
        .map_err(open)?;
    view.show().map_err(open)?;
    view.set_fullscreen(true).map_err(open)?;
    Ok(())
}

/// Closes the presenter view windows there are.
pub fn close_presenter_view(app: &AppHandle) {
    for (label, view) in app.webview_windows() {
        if label.starts_with(LABEL_PREFIX) {
            let _ = view.destroy();
        }
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
        assert!(windows.iter().any(|w| *w == format!("{LABEL_PREFIX}*")));
        assert!(!crate::windows::is_app_window(&format!("{LABEL_PREFIX}1")));
    }

    fn screen(x: f64, y: f64, name: &str) -> Screen {
        Screen {
            index: 9,
            name: name.into(),
            x,
            y,
            width: 100.0,
            height: 100.0,
            pixel_width: 100,
            pixel_height: 100,
            primary: false,
        }
    }

    #[test]
    fn points_undo_each_screens_own_scale() {
        // A Retina laptop with an ultrawide to its right, as macOS reports them: they touch.
        let laptop = on_desktop((0, 0), (3024, 1964), 2.0, true);
        let wide = on_desktop((1512, 0), (3440, 1440), 1.0, true);
        assert_eq!(laptop, (0.0, 0.0, 1512.0, 982.0));
        assert_eq!(wide, (1512.0, 0.0, 3440.0, 1440.0));
        assert_eq!(laptop.0 + laptop.2, wide.0, "side by side, not overlapping");
        // A second Retina screen there has its position scaled too.
        let retina = on_desktop((3024, -200), (3024, 1964), 2.0, true);
        assert_eq!(retina, (1512.0, -100.0, 1512.0, 982.0));
    }

    #[test]
    fn physical_pixels_are_the_desktop_already() {
        let screen = on_desktop((3840, -100), (1920, 1080), 2.0, false);
        assert_eq!(screen, (3840.0, -100.0, 1920.0, 1080.0));
    }

    #[test]
    fn a_window_is_sent_to_a_screen_in_the_desktops_units() {
        let at = screen(1512.0, -20.0, "wide");
        assert_eq!(
            origin(&at, true),
            Position::Logical(LogicalPosition::new(1512.0, -20.0))
        );
        assert_eq!(
            origin(&at, false),
            Position::Physical(PhysicalPosition::new(1512, -20))
        );
    }

    #[test]
    fn screenshots_are_only_used_when_each_has_its_screen() {
        let shots = vec![Some("a".to_string()), None];
        assert_eq!(for_screens(2, shots.clone()), shots);
        assert_eq!(for_screens(3, shots), vec![None, None, None]);
        assert_eq!(for_screens(2, Vec::new()), vec![None, None]);
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    #[test]
    fn the_picker_goes_without_screenshots_where_they_cant_be_taken() {
        let shots = shots::capture_all(|| panic!("nothing was captured"));
        assert_eq!(for_screens(2, shots), vec![None, None]);
    }

    #[test]
    fn screens_go_left_to_right_and_get_their_numbers() {
        let screens = in_order(vec![
            screen(100.0, 0.0, "right"),
            screen(-100.0, 0.0, ""),
            screen(0.0, 100.0, "below"),
            screen(0.0, 0.0, "above"),
        ]);
        let names: Vec<&str> = screens.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["Screen 1", "above", "below", "right"]);
        assert!(screens.iter().enumerate().all(|(i, s)| s.index == i));
    }
}
