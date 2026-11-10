//! Slide images for the agent's render_slide tool (see mcp.rs). The tool runs in a process of
//! its own, started by the agent's CLI, while only the app has a webview. So the tool leaves a
//! request in the session's inbox and waits for the answer there, and the app serves the inbox
//! while a turn runs: it opens the deck in a hidden window, in its print state
//! (`?static&print`, see protocol.rs), and has the page's helper (`assets/render.js`) show each
//! slide and report what overflows on it before capturing it, as video.rs captures frames.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Url, WebviewWindow};
use tokio::sync::mpsc;

use crate::error::{Error, Result};
use crate::export_window::{self, Helper, Page};
use crate::inbox::{Inbox, Serving};
use crate::{deck, html};

/// The most slides one call renders; every image costs the agent context.
pub const MAX_SLIDES: usize = 6;
/// Longest wait for an answer. Below the 60 seconds Codex gives an MCP tool by default, so the
/// agent hears why rather than a bare timeout.
pub const WAIT: Duration = Duration::from_secs(50);
/// Longest side of an image, in pixels: legible body text, and few tokens for the agent.
const IMAGE_SIDE: u32 = 1280;
/// Where render requests and their answers go in a session.
static INBOX: Inbox = Inbox {
    requests: "render-requests",
    results: "render-results",
};
/// Where the page's helper answers; the navigation is caught, never made.
const SIGNAL_PATH: &str = "/.render-signal";
/// The page's helper, run once it has loaded; it starts by reporting when it is ready.
const RENDER_JS: &str = concat!(
    include_str!("../assets/overflow.js"),
    include_str!("../assets/render.js"),
);
/// What the hidden window is for, as its errors name it.
pub(crate) const TASK: &str = "rendering";

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct Request {
    /// The deck file, relative to the workspace root.
    pub path: String,
    pub slides: Vec<String>,
    /// Seconds after each slide shows to render it at, with its animations where they are
    /// then, as a video export frames it; None for every animation finished.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<f64>,
}

/// The latest moment a render may be asked for, in seconds after the slide shows: a slide shows
/// at most this long.
pub const LATEST: f64 = html::MAX_DURATION;

/// Checks a render's `at`, when given.
pub fn check_at(at: Option<f64>) -> Result<()> {
    match at {
        Some(at) if !(0.0..=LATEST).contains(&at) => Err(Error::msg(format!(
            "at is seconds after the slide shows, 0 to {LATEST}"
        ))),
        _ => Ok(()),
    }
}

/// One requested slide.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct Rendered {
    pub id: String,
    /// The image as base64 PNG; none when the deck has no such slide.
    pub png: Option<String>,
    /// What runs past the slide or is cut off, in words.
    pub overflow: Vec<String>,
}

impl Rendered {
    /// What the agent reads next to the image.
    pub fn report(&self) -> String {
        if self.png.is_none() {
            return format!("The deck has no slide `{}`.", self.id);
        }
        if self.overflow.is_empty() {
            return format!(
                "slide `{}`: nothing runs past the slide or is cut off.",
                self.id
            );
        }
        let found: Vec<String> = self.overflow.iter().map(|o| format!("- {o}")).collect();
        format!("slide `{}` overflows:\n{}", self.id, found.join("\n"))
    }
}

#[cfg(test)]
pub type Answer = crate::inbox::Answer<Vec<Rendered>>;

pub fn check_slides(slides: &[String]) -> Result<()> {
    if slides.is_empty() {
        return Err(Error::msg(
            "slides is required: name the slide ids to render",
        ));
    }
    if slides.len() > MAX_SLIDES {
        return Err(Error::msg(format!(
            "at most {MAX_SLIDES} slides per call; render the rest in another call"
        )));
    }
    Ok(())
}

/// Asks the app serving `session` for `slides` of the deck `path` and waits for its answer.
pub fn ask(
    session: &Path,
    path: &str,
    slides: Vec<String>,
    at: Option<f64>,
    wait: Duration,
) -> Result<Vec<Rendered>> {
    let request = Request {
        path: path.into(),
        slides,
        at,
    };
    INBOX.ask(
        session,
        &request,
        wait,
        "unreadable render",
        "The app did not render the slides in time. It only renders while a turn is running.",
    )
}

/// Drains the inbox, oldest first, skipping what cannot be read.
#[cfg(test)]
pub fn take_requests(session: &Path) -> Vec<(String, Request)> {
    INBOX.take(session)
}

#[cfg(test)]
pub fn answer(session: &Path, name: &str, answer: &Answer) -> Result<()> {
    INBOX.answer(session, name, answer)
}

/// The image's width for slides of `canvas`: the slide's own, shrunk so neither side passes
/// [`IMAGE_SIDE`].
fn image_width((width, height): (u32, u32)) -> u32 {
    let scale = (f64::from(IMAGE_SIDE) / f64::from(width.max(height).max(1))).min(1.0);
    ((f64::from(width) * scale).round() as u32).max(1)
}

/// The overflow the helper reported, as JSON.
fn parse_overflow(json: Option<&String>) -> Vec<String> {
    json.and_then(|json| serde_json::from_str(json).ok())
        .unwrap_or_default()
}

/// Serves the inbox of `session` for a turn in workspace `dir`, one request at a time.
pub fn start(app: AppHandle, dir: PathBuf, session: PathBuf) -> Serving {
    INBOX.start(app, dir, session, |app, dir, request: Request| async move {
        serve(&app, &dir, &request).await
    })
}

/// The tool checked the request, but anything may write to the inbox: check it again.
async fn serve(app: &AppHandle, dir: &Path, request: &Request) -> Result<Vec<Rendered>> {
    check_slides(&request.slides)?;
    check_at(request.at)?;
    let file = crate::workspace::resolve(dir, &request.path)?;
    render(app, &file, &request.slides, request.at).await
}

/// Images of `slides` of the deck `file`: `at` seconds after each shows, or with every
/// animation finished for None.
pub(crate) async fn render(
    app: &AppHandle,
    file: &Path,
    slides: &[String],
    at: Option<f64>,
) -> Result<Vec<Rendered>> {
    let canvas = html::slide_size(&deck::read_html(file)?).pixels();
    let (window, signals) = open(app, file, at.is_some())?;
    let mut helper = Helper {
        window: &window,
        signals,
        task: TASK,
    };
    let rendered = capture_slides(&mut helper, slides, at, image_width(canvas)).await;
    let _ = window.destroy();
    rendered
}

/// A window out of sight showing the deck `file` (in the open workspace), with its helper
/// (`assets/render.js`) answering on the returned channel: first `ready`, with how many
/// slides there are, then where each slide it is asked to [`show`] is.
pub(crate) fn open(
    app: &AppHandle,
    file: &Path,
    moving: bool,
) -> Result<(WebviewWindow, mpsc::UnboundedReceiver<Url>)> {
    let canvas = html::slide_size(&deck::read_html(file)?).pixels();
    export_window::open(
        app,
        file,
        canvas,
        Page {
            label: "slide-render",
            title: "Slide render",
            // Still, every animation shows its last frame; moving, the helper holds them where
            // asked.
            query: if moving { "print" } else { "static&print" },
            script: RENDER_JS,
            signal: SIGNAL_PATH,
            purpose: "rendering",
            out_of_sight: true,
        },
    )
}

/// Shows the slide `id` in a window from [`open`]: its answer (`rect`, `view`, `overflow`),
/// or None if the deck has no such slide.
pub(crate) async fn show(
    helper: &mut Helper<'_>,
    id: &str,
    at: Option<f64>,
) -> Result<Option<HashMap<String, String>>> {
    let at = at.map_or_else(|| "null".to_string(), |at| at.to_string());
    let script = format!(
        "window.__slopRender.show({}, {at})",
        export_window::js_string(id)
    );
    let shown = helper.run(&script, "shown").await?;
    if shown.contains_key("missing") {
        return Ok(None);
    }
    export_window::check_view(&shown)?;
    Ok(Some(shown))
}

async fn capture_slides(
    helper: &mut Helper<'_>,
    slides: &[String],
    at: Option<f64>,
    width: u32,
) -> Result<Vec<Rendered>> {
    let ready = helper.answer("ready").await?;
    if ready.get("slides").map_or(true, |n| n == "0") {
        return Err(Error::msg("this file has no slides to render"));
    }
    let mut rendered = Vec::new();
    for id in slides {
        let Some(shown) = show(helper, id, at).await? else {
            rendered.push(Rendered {
                id: id.clone(),
                png: None,
                overflow: Vec::new(),
            });
            continue;
        };
        let (rect, viewport) = export_window::geometry(&shown)?;
        let png = export_window::capture(helper.window, rect, viewport, width).await?;
        rendered.push(Rendered {
            id: id.clone(),
            png: Some(base64::engine::general_purpose::STANDARD.encode(png)),
            overflow: parse_overflow(shown.get("overflow")),
        });
    }
    Ok(rendered)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("slopslide-render-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn slide(id: &str, overflow: &[&str]) -> Rendered {
        Rendered {
            id: id.into(),
            png: Some("cG5n".into()),
            overflow: overflow.iter().map(|o| o.to_string()).collect(),
        }
    }

    #[test]
    fn a_request_reaches_the_app_and_its_answer_comes_back() {
        let dir = session();
        let app = {
            let dir = dir.clone();
            std::thread::spawn(move || loop {
                if let Some((name, request)) = take_requests(&dir).pop() {
                    assert_eq!(
                        request,
                        Request {
                            path: "talk/deck.html".into(),
                            slides: vec!["a".into()],
                            at: Some(2.5),
                        }
                    );
                    answer(&dir, &name, &Ok(vec![slide("a", &[])])).unwrap();
                    return;
                }
                std::thread::sleep(Duration::from_millis(5));
            })
        };
        let rendered = ask(&dir, "talk/deck.html", vec!["a".into()], Some(2.5), WAIT).unwrap();
        app.join().unwrap();
        assert_eq!(rendered, [slide("a", &[])]);
        assert_eq!(
            std::fs::read_dir(dir.join(INBOX.results)).unwrap().count(),
            0,
            "the answer is read once"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_failed_render_comes_back_as_its_error() {
        let dir = session();
        let app = {
            let dir = dir.clone();
            std::thread::spawn(move || loop {
                if let Some((name, _)) = take_requests(&dir).pop() {
                    answer(&dir, &name, &Err("no slides to render".into())).unwrap();
                    return;
                }
                std::thread::sleep(Duration::from_millis(5));
            })
        };
        let error = ask(&dir, "deck.html", vec!["a".into()], None, WAIT).unwrap_err();
        app.join().unwrap();
        assert_eq!(error.to_string(), "no slides to render");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn without_an_app_the_request_times_out_and_is_withdrawn() {
        let dir = session();
        let error = ask(
            &dir,
            "deck.html",
            vec!["a".into()],
            None,
            Duration::from_millis(20),
        )
        .unwrap_err();
        assert!(error.to_string().contains("did not render"), "{error}");
        assert!(take_requests(&dir).is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_render_moment_is_seconds_a_slide_can_show() {
        assert!(check_at(None).is_ok());
        assert!(check_at(Some(0.0)).is_ok());
        assert!(check_at(Some(LATEST)).is_ok());
        assert!(check_at(Some(-0.1)).is_err());
        assert!(check_at(Some(LATEST + 1.0)).is_err());
        assert!(check_at(Some(f64::NAN)).is_err());
        // Requests from before the moment read as every animation finished.
        let old: Request = serde_json::from_str(r#"{"path":"a.html","slides":["a"]}"#).unwrap();
        assert_eq!(old.at, None);
    }

    #[test]
    fn limits_how_many_slides_a_call_renders() {
        let slides = |n: usize| vec!["a".to_string(); n];
        assert!(check_slides(&slides(1)).is_ok());
        assert!(check_slides(&slides(MAX_SLIDES)).is_ok());
        assert!(check_slides(&slides(0)).is_err());
        assert!(check_slides(&slides(MAX_SLIDES + 1)).is_err());
    }

    #[test]
    fn images_fit_the_longest_side_and_never_grow() {
        assert_eq!(image_width((1920, 1080)), 1280);
        assert_eq!(image_width((1080, 1350)), 1024);
        assert_eq!(image_width((816, 1056)), 816);
        assert_eq!(image_width((0, 0)), 1);
    }

    #[test]
    fn reads_the_overflow_the_page_reported() {
        let found = r#"["<p> \"Hi\" runs past the bottom edge by 12px"]"#.to_string();
        assert_eq!(
            parse_overflow(Some(&found)),
            [r#"<p> "Hi" runs past the bottom edge by 12px"#]
        );
        assert!(parse_overflow(None).is_empty());
        assert!(parse_overflow(Some(&"not json".to_string())).is_empty());
    }

    #[test]
    fn reports_each_slide_in_words() {
        assert_eq!(
            slide("a", &[]).report(),
            "slide `a`: nothing runs past the slide or is cut off."
        );
        assert_eq!(
            slide("a", &["<p> is cut off by its own box"]).report(),
            "slide `a` overflows:\n- <p> is cut off by its own box"
        );
        let missing = Rendered {
            id: "b".into(),
            png: None,
            overflow: Vec::new(),
        };
        assert_eq!(missing.report(), "The deck has no slide `b`.");
    }
}
