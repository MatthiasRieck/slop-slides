//! Slide images for the agent's render_slide tool (see mcp.rs). The tool runs in a process of
//! its own, started by the agent's CLI, while only the app has a webview. So the tool leaves a
//! request in the session's inbox and waits for the answer there, and the app serves the inbox
//! while a turn runs: it opens the deck in a hidden window, in its print state
//! (`?static&print`, see protocol.rs), and has the page's helper (`assets/render.js`) show each
//! slide and report what overflows on it before capturing it, as video.rs captures frames.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::mpsc;

use crate::error::{Error, Result};
use crate::{deck, html, pdf, protocol, video};

/// The most slides one call renders; every image costs the agent context.
pub const MAX_SLIDES: usize = 6;
/// Longest wait for an answer. Below the 60 seconds Codex gives an MCP tool by default, so the
/// agent hears why rather than a bare timeout.
pub const WAIT: Duration = Duration::from_secs(50);
/// Longest side of an image, in pixels: legible body text, and few tokens for the agent.
const IMAGE_SIDE: u32 = 1280;
const REQUESTS: &str = "render-requests";
const RESULTS: &str = "render-results";
const POLL: Duration = Duration::from_millis(100);
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

pub type Answer = std::result::Result<Vec<Rendered>, String>;

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

/// Writes `value` to `dir`/`name`.json in one step, so the reader never sees half of it.
fn put<T: Serialize>(dir: &Path, name: &str, value: &T) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let temp = dir.join(format!("{name}.tmp"));
    std::fs::write(
        &temp,
        serde_json::to_vec(value).map_err(|e| Error::msg(e.to_string()))?,
    )?;
    std::fs::rename(temp, dir.join(format!("{name}.json")))?;
    Ok(())
}

/// Asks the app serving `session` for `slides` of the deck `path` and waits for its answer.
pub fn ask(
    session: &Path,
    path: &str,
    slides: Vec<String>,
    wait: Duration,
) -> Result<Vec<Rendered>> {
    let name = uuid::Uuid::new_v4().to_string();
    let request = Request {
        path: path.into(),
        slides,
    };
    put(&session.join(REQUESTS), &name, &request)?;
    let result = session.join(RESULTS).join(format!("{name}.json"));
    let deadline = Instant::now() + wait;
    while Instant::now() < deadline {
        if let Ok(raw) = std::fs::read(&result) {
            let _ = std::fs::remove_file(&result);
            let answer: Answer = serde_json::from_slice(&raw)
                .map_err(|e| Error::msg(format!("unreadable render: {e}")))?;
            return answer.map_err(Error::msg);
        }
        std::thread::sleep(POLL.min(wait));
    }
    let _ = std::fs::remove_file(session.join(REQUESTS).join(format!("{name}.json")));
    Err(Error::msg(
        "The app did not render the slides in time. It only renders while a turn is running.",
    ))
}

/// Drains the inbox, oldest first, skipping what cannot be read.
pub fn take_requests(session: &Path) -> Vec<(String, Request)> {
    let Ok(entries) = std::fs::read_dir(session.join(REQUESTS)) else {
        return Vec::new();
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
        .map(|p| {
            let made = std::fs::metadata(&p).and_then(|m| m.modified());
            (made.unwrap_or(std::time::UNIX_EPOCH), p)
        })
        .collect();
    files.sort();
    let mut requests = Vec::new();
    for (_, file) in files {
        let request = std::fs::read(&file)
            .ok()
            .and_then(|raw| serde_json::from_slice(&raw).ok());
        let _ = std::fs::remove_file(&file);
        let name = file.file_stem().and_then(|name| name.to_str());
        if let (Some(name), Some(request)) = (name, request) {
            requests.push((name.to_string(), request));
        }
    }
    requests
}

pub fn answer(session: &Path, name: &str, answer: &Answer) -> Result<()> {
    put(&session.join(RESULTS), name, answer)
}

/// Forgets requests and answers a previous turn left behind.
fn clear(session: &Path) {
    let _ = std::fs::remove_dir_all(session.join(REQUESTS));
    let _ = std::fs::remove_dir_all(session.join(RESULTS));
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

/// Stops serving the inbox when dropped, with the turn.
pub struct Serving(Arc<AtomicBool>);

impl Drop for Serving {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

/// Serves the inbox of `session` for a turn in workspace `dir`, one request at a time.
pub fn start(app: AppHandle, dir: PathBuf, session: PathBuf) -> Serving {
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    tauri::async_runtime::spawn(async move {
        clear(&session);
        while !stopped.load(Ordering::Relaxed) {
            for (name, request) in take_requests(&session) {
                let rendered = serve(&app, &dir, &request).await;
                let _ = answer(&session, &name, &rendered.map_err(|e| e.to_string()));
            }
            tokio::time::sleep(POLL).await;
        }
        clear(&session);
    });
    Serving(stop)
}

/// The tool checked the request, but anything may write to the inbox: check it again.
async fn serve(app: &AppHandle, dir: &Path, request: &Request) -> Result<Vec<Rendered>> {
    check_slides(&request.slides)?;
    let file = crate::workspace::resolve(dir, &request.path)?;
    render(app, &file, &request.slides).await
}

/// Images of `slides` of the deck `file`.
pub(crate) async fn render(
    app: &AppHandle,
    file: &Path,
    slides: &[String],
) -> Result<Vec<Rendered>> {
    let canvas = html::slide_size(&deck::read_html(file)?).pixels();
    let (window, signals) = open(app, file)?;
    let mut helper = pdf::Helper {
        window: &window,
        signals,
        task: TASK,
    };
    let rendered = capture_slides(&mut helper, slides, image_width(canvas)).await;
    let _ = window.destroy();
    rendered
}

/// A window out of sight showing the deck `file` (in the open workspace), with its helper
/// (`assets/render.js`) answering on the returned channel: first `ready`, with how many
/// slides there are, then where each slide it is asked to [`show`] is.
pub(crate) fn open(
    app: &AppHandle,
    file: &Path,
) -> Result<(WebviewWindow, mpsc::UnboundedReceiver<Url>)> {
    let canvas = html::slide_size(&deck::read_html(file)?).pixels();
    let url = protocol::file_url(file, "static&print")
        .parse()
        .map_err(|e| Error::msg(format!("cannot open the deck for rendering: {e}")))?;

    let (window_width, window_height) = pdf::window_size(canvas, pdf::screen_area(app));
    let (signal_tx, signals) = mpsc::unbounded_channel::<Url>();
    let label = format!("slide-render-{}", uuid::Uuid::new_v4().simple());
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::CustomProtocol(url))
        .title("Slide render")
        .inner_size(window_width, window_height)
        // No title bar: WebKit would inset the page under it, and captures would be off.
        .decorations(false);
    let window = pdf::out_of_sight(builder)
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = webview.eval(RENDER_JS);
            }
        })
        .on_navigation(move |url| {
            if url.path() != SIGNAL_PATH {
                return true;
            }
            let _ = signal_tx.send(url.clone());
            false
        })
        .build()
        .map_err(|e| Error::msg(format!("cannot open the deck for rendering: {e}")))?;
    Ok((window, signals))
}

/// Shows the slide `id` in a window from [`open`]: its answer (`rect`, `view`, `overflow`),
/// or None if the deck has no such slide.
pub(crate) async fn show(
    helper: &mut pdf::Helper<'_>,
    id: &str,
) -> Result<Option<HashMap<String, String>>> {
    let script = format!("window.__slopRender.show({})", pdf::js_string(id));
    let shown = helper.run(&script, "shown").await?;
    if shown.contains_key("missing") {
        return Ok(None);
    }
    pdf::check_view(&shown)?;
    Ok(Some(shown))
}

async fn capture_slides(
    helper: &mut pdf::Helper<'_>,
    slides: &[String],
    width: u32,
) -> Result<Vec<Rendered>> {
    let ready = helper.answer("ready").await?;
    if ready.get("slides").is_none_or(|n| n == "0") {
        return Err(Error::msg("this file has no slides to render"));
    }
    let mut rendered = Vec::new();
    for id in slides {
        let Some(shown) = show(helper, id).await? else {
            rendered.push(Rendered {
                id: id.clone(),
                png: None,
                overflow: Vec::new(),
            });
            continue;
        };
        let (rect, viewport) = pdf::geometry(&shown)?;
        let png = video::capture(helper.window, rect, viewport, width).await?;
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
                        }
                    );
                    answer(&dir, &name, &Ok(vec![slide("a", &[])])).unwrap();
                    return;
                }
                std::thread::sleep(Duration::from_millis(5));
            })
        };
        let rendered = ask(&dir, "talk/deck.html", vec!["a".into()], WAIT).unwrap();
        app.join().unwrap();
        assert_eq!(rendered, [slide("a", &[])]);
        assert_eq!(
            std::fs::read_dir(dir.join(RESULTS)).unwrap().count(),
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
        let error = ask(&dir, "deck.html", vec!["a".into()], WAIT).unwrap_err();
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
            Duration::from_millis(20),
        )
        .unwrap_err();
        assert!(error.to_string().contains("did not render"), "{error}");
        assert!(take_requests(&dir).is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn takes_requests_oldest_first_and_once_skipping_the_unreadable() {
        let dir = session();
        let inbox = dir.join(REQUESTS);
        let request = |path: &str| Request {
            path: path.into(),
            slides: vec!["a".into()],
        };
        put(&inbox, "first", &request("a.html")).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        put(&inbox, "second", &request("b.html")).unwrap();
        std::fs::write(inbox.join("broken.json"), "{").unwrap();
        std::fs::write(inbox.join("half.tmp"), "{").unwrap();
        let taken: Vec<String> = take_requests(&dir).into_iter().map(|(n, _)| n).collect();
        assert_eq!(taken, ["first", "second"]);
        assert!(take_requests(&dir).is_empty());
        assert!(inbox.join("half.tmp").exists(), "still being written");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn clearing_forgets_what_a_turn_left_behind() {
        let dir = session();
        let request = Request {
            path: "a.html".into(),
            slides: Vec::new(),
        };
        put(&dir.join(REQUESTS), "old", &request).unwrap();
        answer(&dir, "old", &Err("stale".into())).unwrap();
        clear(&dir);
        assert!(take_requests(&dir).is_empty());
        assert!(!dir.join(RESULTS).exists());
        std::fs::remove_dir_all(dir).unwrap();
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
