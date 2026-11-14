//! The hidden windows the exports and slide renders drive (pdf.rs, video.rs, render.rs,
//! pptx/export.rs): each loads the deck in a state of the runtime's (see protocol.rs), runs a
//! helper script of its own in the page, and hears the helper's answers as navigations to its
//! signal path, which are caught, never made. Slides are captured from the window as the
//! platform allows.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::mpsc;

use crate::capture::{Rect, Size};
use crate::error::{Error, Result};
use crate::export_scope::{self, Scope, Served};
use crate::protocol;

/// Longest wait for the deck to load, or for a step of the helper.
pub(crate) const TIMEOUT: Duration = Duration::from_secs(60);
/// Where a Linux export window goes: far off every screen.
const OFFSCREEN: f64 = -32_000.0;

/// What a hidden window shows and how its helper answers.
pub(crate) struct Page {
    /// The start of the window's label, which a unique suffix follows.
    pub label: &'static str,
    pub title: &'static str,
    /// The deck's state, as protocol.rs takes it: `print` or `static&print`.
    pub query: &'static str,
    /// The page's helper, run once the page has loaded; it starts by reporting when it is
    /// ready.
    pub script: &'static str,
    /// Where the helper answers.
    pub signal: &'static str,
    /// What the window is for, as "cannot open the deck for …" names it.
    pub purpose: &'static str,
    /// Kept out of sight (see [`out_of_sight`]) rather than only hidden, so that WebKitGTK lays
    /// it out.
    pub out_of_sight: bool,
}

/// A hidden window and what comes with it: the channel its helper's answers come in on, and,
/// for a window shown only some of the deck's slides, what keeps it shown them. Keep the last
/// for as long as the window is open.
pub(crate) type Opened = (WebviewWindow, mpsc::UnboundedReceiver<Url>, Option<Served>);

/// A hidden window showing the deck `file` (in the open workspace), its slides `canvas` pixels,
/// as `page` says, with the helper's answers coming in on the returned channel. With a `scope`
/// the window is shown only its slides, every one of them shown (see export_scope.rs);
/// without, the deck as it is.
pub(crate) fn open(
    app: &AppHandle,
    file: &Path,
    canvas: (u32, u32),
    page: Page,
    scope: Option<&Scope>,
) -> Result<Opened> {
    let cannot_open = |e: &dyn std::fmt::Display| {
        Error::msg(format!("cannot open the deck for {}: {e}", page.purpose))
    };
    let served = scope.map(export_scope::serve);
    let query = match &served {
        Some(served) => format!("{}&{}", page.query, served.query()),
        None => page.query.to_string(),
    };
    let url = protocol::file_url(file, &query)
        .parse()
        .map_err(|e| cannot_open(&e))?;
    let (window_width, window_height) = window_size(canvas, screen_area(app));
    let (signal_tx, signals) = mpsc::unbounded_channel::<Url>();
    let label = format!("{}-{}", page.label, uuid::Uuid::new_v4().simple());
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::CustomProtocol(url))
        .title(page.title)
        .inner_size(window_width, window_height)
        // No title bar: WebKit would inset the page under it, and captures would be off.
        .decorations(false);
    let builder = if page.out_of_sight {
        out_of_sight(builder)
    } else {
        builder.visible(false).focused(false).skip_taskbar(true)
    };
    let (script, signal) = (page.script, page.signal);
    let window = builder
        .on_page_load(move |webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = webview.eval(script);
            }
        })
        .on_navigation(move |url| {
            if url.path() != signal {
                return true;
            }
            let _ = signal_tx.send(url.clone());
            false
        })
        .build()
        .map_err(|e| cannot_open(&e))?;
    Ok((window, signals, served))
}

/// The room on screen for a window, in logical pixels: the main screen's work area.
fn screen_area(app: &AppHandle) -> Option<(f64, f64)> {
    let monitor = app.primary_monitor().ok()??;
    let area = monitor
        .work_area()
        .size
        .to_logical::<f64>(monitor.scale_factor());
    Some((area.width, area.height))
}

/// The hidden window's size: the slides', shrunk to fit well inside `screen` if given. macOS
/// keeps windows on screen, and a window cut down to fit would show part of the page.
fn window_size(slide: (u32, u32), screen: Option<(f64, f64)>) -> (f64, f64) {
    let (w, h) = (f64::from(slide.0), f64::from(slide.1));
    let scale = screen
        .filter(|(sw, sh)| *sw >= 1.0 && *sh >= 1.0)
        .map_or(1.0, |(sw, sh)| (0.8 * sw / w).min(0.8 * sh / h).min(1.0));
    ((w * scale).floor().max(1.0), (h * scale).floor().max(1.0))
}

/// `builder`'s window kept out of sight. WebKitGTK lays out a webview only once its window is
/// shown, and a hidden one stays 0×0 with nothing to read or capture; on Linux the window is
/// shown instead, far off screen. The other engines lay out hidden windows.
fn out_of_sight<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    let builder = builder.focused(false).skip_taskbar(true);
    if cfg!(target_os = "linux") {
        builder.visible(true).position(OFFSCREEN, OFFSCREEN)
    } else {
        builder.visible(false)
    }
}

/// A hidden window's page helper and its answers.
pub(crate) struct Helper<'a> {
    pub window: &'a WebviewWindow,
    pub signals: mpsc::UnboundedReceiver<Url>,
    /// What the window is for, as the errors name it ("printing").
    pub task: &'static str,
}

impl Helper<'_> {
    /// Runs `script` in the page, then waits for the answer named `step`.
    pub async fn run(&mut self, script: &str, step: &str) -> Result<HashMap<String, String>> {
        self.window
            .eval(script)
            .map_err(|e| Error::msg(format!("cannot reach the deck: {e}")))?;
        self.answer(step).await
    }

    /// The next answer, which must be the one named `step`, as its query parameters.
    pub async fn answer(&mut self, step: &str) -> Result<HashMap<String, String>> {
        let url = tokio::time::timeout(TIMEOUT, self.signals.recv())
            .await
            .map_err(|_| {
                Error::msg(format!(
                    "the deck took too long to get ready for {}",
                    self.task
                ))
            })?
            .ok_or_else(|| Error::msg(format!("the deck was closed during {}", self.task)))?;
        let answer = parse_answer(&url);
        if !answer.contains_key(step) {
            return Err(Error::msg(format!(
                "unexpected answer from the deck: {url}"
            )));
        }
        Ok(answer)
    }
}

/// The query parameters of a helper's answer (`/.pdf-signal?shown=0&rect=…`).
fn parse_answer(url: &Url) -> HashMap<String, String> {
    url.query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect()
}

/// Whether the page has a viewport to lay the slides out in; with none, every element has no
/// size and the slides would come out empty: WebKitGTK does that
/// to a hidden window (see [`out_of_sight`]).
pub(crate) fn check_view(ready: &HashMap<String, String>) -> Result<()> {
    let view: Vec<f64> = ready
        .get("view")
        .map(|v| v.split(',').filter_map(|n| n.trim().parse().ok()).collect())
        .unwrap_or_default();
    match view[..] {
        [width, height] if width < 1.0 || height < 1.0 => Err(Error::msg(format!(
            "the export window was not laid out ({width}×{height} pixels)"
        ))),
        _ => Ok(()),
    }
}

/// Where a shown slide is: `rect=x,y,w,h` and `view=w,h`, in CSS pixels.
pub(crate) fn geometry(answer: &HashMap<String, String>) -> Result<(Rect, Size)> {
    let numbers = |key: &str, n: usize| -> Option<Vec<f64>> {
        let values: Vec<f64> = answer
            .get(key)?
            .split(',')
            .map(|v| v.trim().parse().ok())
            .collect::<Option<_>>()?;
        (values.len() == n).then_some(values)
    };
    match (numbers("rect", 4), numbers("view", 2)) {
        (Some(r), Some(v)) => Ok((
            Rect {
                x: r[0],
                y: r[1],
                width: r[2],
                height: r[3],
            },
            Size {
                width: v[0],
                height: v[1],
            },
        )),
        _ => Err(Error::msg("the deck did not say where its slide is")),
    }
}

/// `rect` shrunk to the whole points inside it. The slide sits at a fraction of a point (the
/// player centres and scales it), and a capture from its exact edge would blend in a hairline
/// of the black page around it; the image is stretched over the slide, so the lost edge (under
/// a pixel) does not show.
pub(crate) fn inside_whole_points(rect: Rect) -> Rect {
    let (left, top) = (rect.x.ceil(), rect.y.ceil());
    let (right, bottom) = (
        (rect.x + rect.width).floor(),
        (rect.y + rect.height).floor(),
    );
    Rect {
        x: left,
        y: top,
        width: (right - left).max(1.0),
        height: (bottom - top).max(1.0),
    }
}

/// `text` as a JavaScript string literal.
pub(crate) fn js_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into())
}

/// A PNG of `rect` of the window, `width` pixels wide.
pub(crate) async fn capture(
    window: &WebviewWindow,
    rect: Rect,
    viewport: Size,
    width: u32,
) -> Result<Vec<u8>> {
    #[cfg(target_os = "macos")]
    return crate::capture::render_region(window.as_ref(), rect, viewport, width).await;
    #[cfg(not(target_os = "macos"))]
    return crate::capture::snapshot(window.as_ref(), rect, viewport, width).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn a_window_with_no_viewport_is_an_error() {
        let err = check_view(&answer(&[("slides", "2"), ("view", "0,0")]))
            .unwrap_err()
            .to_string();
        assert!(err.contains("not laid out"), "{err}");
        assert!(check_view(&answer(&[("view", "1536,864")])).is_ok());
        // An older helper that does not report the view.
        assert!(check_view(&answer(&[("slides", "2")])).is_ok());
    }

    #[test]
    fn the_window_fits_well_inside_the_screen() {
        assert_eq!(window_size((1920, 1080), None), (1920.0, 1080.0));
        assert_eq!(
            window_size((1920, 1080), Some((3008.0, 1667.0))),
            (1920.0, 1080.0)
        );
        // A 1440×875 work area: 80% of its height bounds a 16:9 slide.
        assert_eq!(
            window_size((1920, 1080), Some((1440.0, 875.0))),
            (1152.0, 648.0)
        );
        assert_eq!(
            window_size((1080, 1350), Some((1920.0, 1050.0))),
            (672.0, 840.0)
        );
        assert_eq!(
            window_size((1920, 1080), Some((0.0, 0.0))),
            (1920.0, 1080.0)
        );
    }

    #[test]
    fn reads_answers_and_slide_geometry() {
        let url: Url = "slop://localhost/.pdf-signal?shown=2&rect=0,12.5,1920,1080&view=1920,1105"
            .parse()
            .unwrap();
        let answer = parse_answer(&url);
        assert_eq!(answer["shown"], "2");
        let (rect, view) = geometry(&answer).unwrap();
        assert_eq!(
            rect,
            Rect {
                x: 0.0,
                y: 12.5,
                width: 1920.0,
                height: 1080.0
            }
        );
        assert_eq!(
            view,
            Size {
                width: 1920.0,
                height: 1105.0
            }
        );
        let ready = parse_answer(
            &"http://slop.localhost/.pdf-signal?ready&slides=7"
                .parse()
                .unwrap(),
        );
        assert_eq!(ready["slides"], "7");
        assert!(ready.contains_key("ready"));
    }

    #[test]
    fn captures_only_whole_points_inside_the_slide() {
        let rect = |x, y, width, height| Rect {
            x,
            y,
            width,
            height,
        };
        // As the player showed an A4 slide: 0.09 px down, its bottom edge mid-pixel.
        assert_eq!(
            inside_whole_points(rect(0.0, 0.09375, 1877.0, 1055.8125)),
            rect(0.0, 1.0, 1877.0, 1054.0)
        );
        assert_eq!(
            inside_whole_points(rect(28.2777, 0.0, 1820.4443, 1024.0)),
            rect(29.0, 0.0, 1819.0, 1024.0)
        );
        assert_eq!(inside_whole_points(rect(10.0, 10.0, 0.5, 0.5)).width, 1.0);
    }

    #[test]
    fn rejects_answers_without_geometry() {
        let answer =
            |q: &str| parse_answer(&format!("slop://localhost/.pdf-signal?{q}").parse().unwrap());
        assert!(geometry(&answer("shown=0")).is_err());
        assert!(geometry(&answer("shown=0&rect=1,2,3&view=4,5")).is_err());
        assert!(geometry(&answer("shown=0&rect=1,2,x,4&view=4,5")).is_err());
    }

    #[test]
    fn quotes_javascript_strings() {
        assert_eq!(
            js_string("data:image/png;base64,AB+/="),
            "\"data:image/png;base64,AB+/=\""
        );
        assert_eq!(js_string("a\"b\\"), "\"a\\\"b\\\\\"");
    }
}
