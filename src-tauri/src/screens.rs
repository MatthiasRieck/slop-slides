//! Screens for presenting. With several attached, the show goes on one of them and the
//! presenter view (notes, next slide, timers) in a window of its own on another; the frontend
//! lets the user pick (see `ScreenPicker`). On any number of screens the show can also run in
//! windows instead ([`present_in_windows`]): the slides in the app window and the presenter
//! view in a window beside it, so a call can share the slides' window alone. The presenter view is the same frontend loaded
//! with `?presenter`: it renders from what the show window sends it and never opens a
//! workspace itself (slides are served to any window while a workspace has them open).
//!
//! The picker shows a screenshot of each screen, to tell them apart by what is on them. They
//! are only ever held in the picker: nothing is written to disk. On Linux it goes without (see
//! [`shots`]).
//!
//! A window moved to another screen for a show goes back where it was when the show ends
//! ([`restore`]), and while any window presents, the display does not go to sleep ([`awake`]).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{
    ipc::Channel, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Monitor,
    PhysicalPosition, PhysicalSize, Position, Size, WebviewUrl, WebviewWindowBuilder, Window,
    WindowEvent,
};

use crate::error::{Error, Result};

/// How long the picker waits for screenshots. It goes on without them after this: a system may
/// be asking the user for permission, and presenting must not depend on that.
const PREVIEW_TIMEOUT: Duration = Duration::from_secs(3);

/// Labels of presenter view windows start with this; the capabilities grant them what the app
/// windows get. Each gets a label of its own: destroying a window only queues that, so a label
/// stays taken for a moment after, and the next show may be starting already.
pub const LABEL_PREFIX: &str = "presenter-";

/// What the show hears when the presenter view asks to end it (see `usePresenterFeed`).
const EXIT_EVENT: &str = "presenter:exit";

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

/// The attached screens, in the order [`in_order`] gives them, named as tauri names them.
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

/// Gives each screen the name the system has for the monitor at its position, as tauri's mean
/// little to a person ("Monitor #41057"). A screen no name is found for keeps its own.
fn with_names(mut screens: Vec<Screen>, names: &[((i32, i32), String)]) -> Vec<Screen> {
    for screen in &mut screens {
        let position = (screen.x.round() as i32, screen.y.round() as i32);
        let name = names.iter().find(|(at, _)| *at == position);
        if let Some((_, name)) = name.filter(|(_, name)| !name.is_empty()) {
            screen.name.clone_from(name);
        }
    }
    screens
}

/// [`list`] with the names the system settings show, for the picker. Must run on the main thread,
/// as commands that aren't async do: macOS only tells them there.
pub fn list_named(app: &AppHandle) -> Result<Vec<Screen>> {
    Ok(with_names(list(app)?, &shots::names()))
}

#[cfg(any(target_os = "macos", windows))]
mod shots {
    use base64::Engine;

    use crate::capture::{self, Image};
    use crate::error::Result;

    /// Widest screenshot in the picker, in pixels: enough for a sharp tile on a high density
    /// screen.
    const PREVIEW_WIDTH: u32 = 640;

    /// Each monitor's position on the desktop and the name the system has for it.
    pub fn names() -> Vec<((i32, i32), String)> {
        let monitors = xcap::Monitor::all().unwrap_or_default();
        monitors
            .iter()
            .filter_map(|m| Some(((m.x().ok()?, m.y().ok()?), m.friendly_name().ok()?)))
            .collect()
    }

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

        /// Reads the real monitors: run by hand with `--ignored --nocapture`.
        #[test]
        #[ignore]
        fn names_the_attached_monitors() {
            let names = names();
            println!("{names:?}");
            assert!(!names.is_empty());
            assert!(names.iter().all(|(_, name)| !name.is_empty()));
        }

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
    pub fn names() -> Vec<((i32, i32), String)> {
        Vec::new()
    }

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
/// and opens the presenter view full screen on `presenter`, if given. Where the window was is
/// kept, for [`restore`] to put it back there when the show ends.
pub fn present(
    app: &AppHandle,
    window: &Window,
    audience: usize,
    presenter: Option<usize>,
) -> Result<()> {
    let screens = list(app)?;
    validate(screens.len(), audience, presenter)?;
    if let Some(geometry) = geometry_of(window) {
        lock(&PLACES).remember(window.label(), geometry);
    }
    window
        .set_position(origin(&screens[audience], LAID_OUT_IN_POINTS))
        .map_err(|e| Error::msg(format!("cannot move the show: {e}")))?;
    close_presenter_view(app);
    let Some(presenter) = presenter else {
        return Ok(());
    };
    open_presenter_view(app, Some(&screens[presenter]))
}

/// Opens the presenter view in an ordinary window, leaving the show window where it is and as
/// it is: on one screen, the slides' window can be shared in a call and the presenter keeps the
/// notes to themselves.
pub fn present_in_windows(app: &AppHandle) -> Result<()> {
    close_presenter_view(app);
    open_presenter_view(app, None)
}

/// How a presenter view window starts: full screen on `screen`, or else an ordinary window.
fn presenter_window_size(screen: Option<&Screen>) -> (f64, f64) {
    match screen {
        Some(_) => (1000.0, 640.0),
        // Room for the slide, the next one and the notes, while the show's window stays in view.
        None => (1100.0, 720.0),
    }
}

/// Opens a presenter view window: full screen on `screen` if given, else an ordinary window in
/// the middle of the screen. Closing it ends the show, as Escape in it does.
fn open_presenter_view(app: &AppHandle, screen: Option<&Screen>) -> Result<()> {
    let open = |e: tauri::Error| Error::msg(format!("cannot open the presenter view: {e}"));
    let (width, height) = presenter_window_size(screen);
    // Hidden until it is on its screen, so it does not flash up on another.
    let mut builder = WebviewWindowBuilder::new(
        app,
        format!("{LABEL_PREFIX}{}", uuid::Uuid::new_v4().simple()),
        WebviewUrl::App("index.html?presenter".into()),
    )
    .title("Presenter view")
    .inner_size(width, height)
    .visible(false);
    if screen.is_none() {
        builder = builder.center();
    }
    let view = builder.build().map_err(open)?;
    let events = app.clone();
    view.on_window_event(move |event| {
        // Closing by the user only: the show destroys it when it ends, which asks nothing.
        if let WindowEvent::CloseRequested { .. } = event {
            let _ = events.emit(EXIT_EVENT, ());
        }
    });
    if let Some(screen) = screen {
        view.set_position(origin(screen, LAID_OUT_IN_POINTS))
            .map_err(open)?;
    }
    view.show().map_err(open)?;
    if screen.is_some() {
        view.set_fullscreen(true).map_err(open)?;
    }
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

/// A window's place on the desktop and its size, in the desktop's units (see [`on_desktop`]),
/// and whether it filled its screen.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Geometry {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    maximized: bool,
}

/// Where each window a show moved was before, by the window's label.
struct Places(Vec<(String, Geometry)>);

impl Places {
    /// Keeps where the window `label` is before its show moves it. Where it was first counts: a
    /// show placed twice (StrictMode runs effects twice in dev) is already on its screen the
    /// second time.
    fn remember(&mut self, label: &str, geometry: Geometry) {
        if !self.0.iter().any(|(l, _)| l == label) {
            self.0.push((label.to_string(), geometry));
        }
    }

    /// Where the window `label` was before its show, once.
    fn take(&mut self, label: &str) -> Option<Geometry> {
        let at = self.0.iter().position(|(l, _)| l == label)?;
        Some(self.0.swap_remove(at).1)
    }
}

static PLACES: Mutex<Places> = Mutex::new(Places(Vec::new()));

/// The lock on `mutex`, also after a panic while it was held: what it guards stays usable.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// Where `window` is now, unless it is full screen (then it is on its show's screen already).
fn geometry_of(window: &Window) -> Option<Geometry> {
    if window.is_fullscreen().unwrap_or(false) {
        return None;
    }
    let position = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    let scale = window.scale_factor().ok()?;
    let (x, y, width, height) = on_desktop(
        (position.x, position.y),
        (size.width, size.height),
        scale,
        LAID_OUT_IN_POINTS,
    );
    Some(Geometry {
        x,
        y,
        width,
        height,
        maximized: window.is_maximized().unwrap_or(false),
    })
}

/// The size to give a window to have it `geometry`'s size, in the desktop's units as `origin`
/// takes a position.
fn size_of(geometry: &Geometry, points: bool) -> Size {
    if points {
        LogicalSize::new(geometry.width, geometry.height).into()
    } else {
        PhysicalSize::new(geometry.width as u32, geometry.height as u32).into()
    }
}

/// How long [`restore`] waits for the window to have left full screen, which the system
/// animates after the frontend asked.
const UNFULLSCREEN_TIMEOUT: Duration = Duration::from_secs(2);

/// Puts `window` back where it was before its show moved it to another screen, as it was
/// (maximized or not). Nothing for a show that moved nothing. Waits for the window to have left
/// full screen first: a window still on its way out of it ignores a move. Off the main thread.
pub fn restore(window: &Window) -> Result<()> {
    let Some(geometry) = lock(&PLACES).take(window.label()) else {
        return Ok(());
    };
    let started = Instant::now();
    while window.is_fullscreen().unwrap_or(false) && started.elapsed() < UNFULLSCREEN_TIMEOUT {
        std::thread::sleep(Duration::from_millis(50));
    }
    let back = |e: tauri::Error| Error::msg(format!("cannot move the window back: {e}"));
    let screen = Screen {
        index: 0,
        name: String::new(),
        x: geometry.x,
        y: geometry.y,
        width: geometry.width,
        height: geometry.height,
        pixel_width: 0,
        pixel_height: 0,
        primary: false,
    };
    window
        .set_position(origin(&screen, LAID_OUT_IN_POINTS))
        .map_err(back)?;
    if geometry.maximized {
        window.maximize().map_err(back)?;
    } else {
        window
            .set_size(size_of(&geometry, LAID_OUT_IN_POINTS))
            .map_err(back)?;
    }
    Ok(())
}

/// Forgets what a closed window's show had: where it was, and its hold on the display.
pub fn window_closed(label: &str) {
    lock(&PLACES).take(label);
    awake::keep(label, false);
}

/// The display kept awake while a show runs: a talk can stay on one slide for minutes, longer
/// than the display waits before it dims. Each window presenting holds it; it is let go once
/// none does.
pub mod awake {
    use std::sync::Mutex;

    use super::lock;

    /// Keeping the system's display on, or no longer.
    pub trait Power {
        /// Keeps the display on; false where that cannot be done.
        fn hold(&mut self) -> bool;
        fn let_go(&mut self);
    }

    /// The windows presenting, and whether the display is held for them.
    pub struct Awake<P: Power> {
        power: P,
        holders: Vec<String>,
        held: bool,
    }

    impl<P: Power> Awake<P> {
        pub const fn new(power: P) -> Self {
            Self {
                power,
                holders: Vec::new(),
                held: false,
            }
        }

        /// The window `label` presents (`on`) or no longer does; the display is held while any does.
        pub fn keep(&mut self, label: &str, on: bool) {
            if on {
                if !self.holders.iter().any(|l| l == label) {
                    self.holders.push(label.to_string());
                }
            } else {
                self.holders.retain(|l| l != label);
            }
            let wanted = !self.holders.is_empty();
            if wanted && !self.held {
                self.held = self.power.hold();
            } else if !wanted && self.held {
                self.power.let_go();
                self.held = false;
            }
        }
    }

    static AWAKE: Mutex<Awake<System>> = Mutex::new(Awake::new(System::new()));

    /// The window `label` presents, or no longer does. On Windows the hold belongs to the
    /// thread that asks for it, so this runs on the main thread, which lasts as long as the app.
    pub fn keep(label: &str, on: bool) {
        lock(&AWAKE).keep(label, on);
    }

    /// macOS: an assertion that keeps the display from sleeping while the user is idle.
    #[cfg(target_os = "macos")]
    pub struct System {
        assertion: Option<u32>,
    }

    #[cfg(target_os = "macos")]
    mod iokit {
        use std::ffi::{c_char, c_void};

        pub const UTF8: u32 = 0x0800_0100;
        pub const LEVEL_ON: u32 = 255;

        #[link(name = "CoreFoundation", kind = "framework")]
        extern "C" {
            pub fn CFStringCreateWithCString(
                alloc: *const c_void,
                text: *const c_char,
                encoding: u32,
            ) -> *const c_void;
            pub fn CFRelease(object: *const c_void);
        }

        #[link(name = "IOKit", kind = "framework")]
        extern "C" {
            pub fn IOPMAssertionCreateWithName(
                kind: *const c_void,
                level: u32,
                name: *const c_void,
                id: *mut u32,
            ) -> i32;
            pub fn IOPMAssertionRelease(id: u32) -> i32;
        }

        /// A CFString of `text`, released when dropped.
        pub struct CfString(pub *const c_void);

        impl CfString {
            pub fn new(text: &std::ffi::CStr) -> Self {
                // SAFETY: a valid C string, copied by CoreFoundation.
                Self(unsafe { CFStringCreateWithCString(std::ptr::null(), text.as_ptr(), UTF8) })
            }
        }

        impl Drop for CfString {
            fn drop(&mut self) {
                if !self.0.is_null() {
                    // SAFETY: created above and not released elsewhere.
                    unsafe { CFRelease(self.0) };
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    impl System {
        pub const fn new() -> Self {
            Self { assertion: None }
        }
    }

    #[cfg(target_os = "macos")]
    impl Power for System {
        fn hold(&mut self) -> bool {
            let kind = iokit::CfString::new(c"PreventUserIdleDisplaySleep");
            let name = iokit::CfString::new(c"SlopSlide is presenting");
            if kind.0.is_null() || name.0.is_null() {
                return false;
            }
            let mut id = 0u32;
            // SAFETY: valid CFStrings and a place for the id; 0 is success.
            let done = unsafe {
                iokit::IOPMAssertionCreateWithName(kind.0, iokit::LEVEL_ON, name.0, &mut id)
            };
            if done != 0 {
                return false;
            }
            self.assertion = Some(id);
            true
        }

        fn let_go(&mut self) {
            if let Some(id) = self.assertion.take() {
                // SAFETY: an assertion this created and has not released.
                unsafe { iokit::IOPMAssertionRelease(id) };
            }
        }
    }

    /// Windows: the thread's execution state, which keeps the display on while it is set.
    #[cfg(windows)]
    pub struct System;

    #[cfg(windows)]
    mod kernel32 {
        pub const CONTINUOUS: u32 = 0x8000_0000;
        pub const DISPLAY_REQUIRED: u32 = 0x0000_0002;
        pub const SYSTEM_REQUIRED: u32 = 0x0000_0001;

        #[link(name = "kernel32")]
        extern "system" {
            pub fn SetThreadExecutionState(flags: u32) -> u32;
        }
    }

    #[cfg(windows)]
    impl System {
        pub const fn new() -> Self {
            Self
        }
    }

    #[cfg(windows)]
    impl Power for System {
        fn hold(&mut self) -> bool {
            use kernel32::*;
            // SAFETY: only sets flags; 0 means it failed.
            unsafe { SetThreadExecutionState(CONTINUOUS | DISPLAY_REQUIRED | SYSTEM_REQUIRED) != 0 }
        }

        fn let_go(&mut self) {
            // SAFETY: as above, back to the system's own idea of idle.
            unsafe { kernel32::SetThreadExecutionState(kernel32::CONTINUOUS) };
        }
    }

    /// Elsewhere the display is left to the system.
    #[cfg(not(any(target_os = "macos", windows)))]
    pub struct System;

    #[cfg(not(any(target_os = "macos", windows)))]
    impl System {
        pub const fn new() -> Self {
            Self
        }
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    impl Power for System {
        fn hold(&mut self) -> bool {
            false
        }

        fn let_go(&mut self) {}
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// What was asked of the system, in order.
        #[derive(Default)]
        struct Fake {
            asked: Vec<&'static str>,
            refuse: bool,
        }

        impl Power for Fake {
            fn hold(&mut self) -> bool {
                self.asked.push("hold");
                !self.refuse
            }
            fn let_go(&mut self) {
                self.asked.push("let go");
            }
        }

        #[test]
        fn the_display_is_held_while_any_window_presents_and_let_go_after() {
            let mut awake = Awake::new(Fake::default());
            awake.keep("main", true);
            // A second hold of the same show, and another window's show, ask nothing more.
            awake.keep("main", true);
            awake.keep("other", true);
            awake.keep("main", false);
            assert_eq!(awake.power.asked, ["hold"]);
            awake.keep("other", false);
            assert_eq!(awake.power.asked, ["hold", "let go"]);
            // Letting go of a show that has gone already asks nothing.
            awake.keep("other", false);
            awake.keep("main", true);
            assert_eq!(awake.power.asked, ["hold", "let go", "hold"]);
        }

        #[test]
        fn a_hold_the_system_refused_is_not_let_go_and_is_asked_for_again() {
            let mut awake = Awake::new(Fake {
                refuse: true,
                ..Fake::default()
            });
            awake.keep("main", true);
            awake.keep("main", false);
            assert_eq!(awake.power.asked, ["hold"]);
            awake.power.refuse = false;
            awake.keep("main", true);
            awake.keep("main", false);
            assert_eq!(awake.power.asked, ["hold", "hold", "let go"]);
        }

        /// Holds the real display for a moment: run by hand with `--ignored`, then check
        /// `pmset -g assertions` (macOS) while it sleeps.
        #[test]
        #[ignore]
        fn holds_the_real_display() {
            let mut system = System::new();
            assert!(system.hold() || cfg!(not(any(target_os = "macos", windows))));
            std::thread::sleep(std::time::Duration::from_secs(5));
            system.let_go();
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
    fn a_presenter_view_in_a_window_leaves_room_for_the_notes() {
        let at = screen(0.0, 0.0, "laptop");
        assert_eq!(presenter_window_size(Some(&at)), (1000.0, 640.0));
        let (width, height) = presenter_window_size(None);
        assert!(width > 1000.0 && height > 640.0);
    }

    #[test]
    fn the_display_is_held_on_the_main_thread_and_the_window_put_back_off_it() {
        // On Windows a hold on the display lasts as long as the thread that took it; putting
        // the window back waits for it to leave full screen, which must not hold up input.
        let commands = include_str!("commands/workspace.rs");
        assert!(commands.contains("#[tauri::command]\npub fn keep_awake("));
        assert!(commands.contains("#[tauri::command(async)]\npub fn restore_show_window("));
    }

    #[test]
    fn closing_the_presenter_view_ends_the_show_as_the_frontend_listens_for() {
        let presenter = include_str!("../../src/components/presenter/usePresenterFeed.ts");
        assert!(presenter.contains(&format!("\"{EXIT_EVENT}\"")));
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
    fn the_systems_names_go_to_the_screen_at_their_position() {
        let screens = in_order(vec![
            screen(0.0, 0.0, "Monitor #41057"),
            screen(1512.0, -20.0, "Monitor #41349"),
            screen(3000.0, 0.0, "Monitor #1"),
            screen(4000.0, 0.0, "Monitor #2"),
        ]);
        let names = [
            ((1512, -20), "DELL U3421WE".to_string()),
            ((0, 0), "Built-in Retina Display".to_string()),
            ((4000, 0), String::new()),
        ];
        let named = with_names(screens, &names);
        let names: Vec<&str> = named.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "Built-in Retina Display",
                "DELL U3421WE",
                "Monitor #1",
                "Monitor #2"
            ]
        );
    }

    fn geometry(x: f64, maximized: bool) -> Geometry {
        Geometry {
            x,
            y: 20.0,
            width: 1200.0,
            height: 800.0,
            maximized,
        }
    }

    #[test]
    fn a_window_goes_back_where_it_was_before_its_first_move_once() {
        let mut places = Places(Vec::new());
        places.remember("main", geometry(10.0, false));
        // Placed again by the same show, already on its screen: where it was first counts.
        places.remember("main", geometry(3000.0, false));
        places.remember("other", geometry(50.0, true));
        assert_eq!(places.take("main"), Some(geometry(10.0, false)));
        assert_eq!(places.take("main"), None, "only once");
        assert_eq!(places.take("other"), Some(geometry(50.0, true)));
        assert_eq!(places.take("never moved"), None);
    }

    #[test]
    fn a_window_gets_its_size_back_in_the_desktops_units() {
        let at = geometry(10.0, false);
        assert_eq!(
            size_of(&at, true),
            Size::Logical(LogicalSize::new(1200.0, 800.0))
        );
        assert_eq!(
            size_of(&at, false),
            Size::Physical(PhysicalSize::new(1200, 800))
        );
        // A Retina window kept in points comes back at the same size in points.
        let (_, _, width, height) = on_desktop((0, 0), (2400, 1600), 2.0, true);
        assert_eq!((width, height), (1200.0, 800.0));
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
