//! Device server: the whole app on a phone or tablet in the same network, e.g. to review
//! slides with a pen. "Use on another device" starts a small HTTP server and shows its address
//! as a QR code. A device that opens it gets the same UI the window has, talking to this
//! backend over HTTP instead of Tauri IPC (src/lib/platform.ts):
//!
//! ```text
//! /s/<token>/                 the app (index.html, told where its backend is)
//! /s/<token>/<file>           the app's other files (the built frontend)
//! /s/<token>/api/<command>    POST, JSON arguments → JSON result, or the error as text
//! /s/<token>/events           server-sent events: the window's `agent-event`, `deck-changed`
//!                             and `chat-changed` events, as {"event": name, "payload": …}
//! /s/<token>/deck/<id>/<path> deck files, as the `slop://` protocol serves them
//! /s/<token>/upload/<id>      POST ?name=<file name>, the file as the body → its asset path
//! /s/<token>/export/<id>      the exported deck as a download
//! ```
//!
//! The random token in every path is the only credential: whoever has the address can use
//! the app, so it is only valid while sharing is on, and changes each time it is turned on.
//! Keeping it in the path (not a cookie) lets the sandboxed slide iframes load their assets
//! with plain relative URLs.
//!
//! Devices cannot screenshot a slide with their marks (the slide is a cross-origin frame), so
//! for a sketch the window draws the slide and the marks and takes the native screenshot
//! (`remote-capture` event, answered with `remote_capture_done`).

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{header, HeaderValue, Method, StatusCode, Uri};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::Router;
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Listener, Manager};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, oneshot, watch};

use crate::error::{Error, Result};
use crate::{agent::AgentManager, deck, protocol, watcher::DeckWatcher};

/// Window events that devices get too.
pub const FORWARDED_EVENTS: [&str; 3] = ["agent-event", "deck-changed", "chat-changed"];
/// Tried first, so the address stays the same between sessions when it can.
const PREFERRED_PORT: u16 = 47_419;
/// Largest upload (an attached photo or video).
const MAX_UPLOAD: usize = 256 * 1024 * 1024;
/// How long a device waits for the window to screenshot its sketch.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(20);

pub struct RemoteServer {
    events: broadcast::Sender<String>,
    running: Mutex<Option<Running>>,
    captures: Mutex<HashMap<String, oneshot::Sender<std::result::Result<String, String>>>>,
}

impl Default for RemoteServer {
    fn default() -> Self {
        Self {
            events: broadcast::channel(1024).0,
            running: Mutex::default(),
            captures: Mutex::default(),
        }
    }
}

struct Running {
    url: String,
    qr_svg: String,
    stop: watch::Sender<bool>,
}

/// What the window shows while sharing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub url: String,
    pub qr_svg: String,
    /// Devices connected right now.
    pub devices: usize,
}

impl RemoteServer {
    fn info(&self) -> Option<RemoteInfo> {
        let running = self.running.lock().unwrap();
        running.as_ref().map(|r| RemoteInfo {
            url: r.url.clone(),
            qr_svg: r.qr_svg.clone(),
            devices: self.events.receiver_count(),
        })
    }
}

/// Passes the window's events on to connected devices.
pub fn forward_events(app: &AppHandle) {
    for name in FORWARDED_EVENTS {
        let handle = app.clone();
        app.listen_any(name, move |event| {
            let server = handle.state::<RemoteServer>();
            // No receivers (no device connected) is not an error worth reporting.
            let _ = server.events.send(envelope(name, event.payload()));
        });
    }
}

/// One server-sent event: the event's name and its payload (already JSON).
fn envelope(name: &str, payload: &str) -> String {
    let payload = if payload.is_empty() { "null" } else { payload };
    format!(
        "{{\"event\":{},\"payload\":{payload}}}",
        serde_json::to_string(name).expect("string")
    )
}

/// Starts sharing, or returns how it is already shared.
pub async fn start(app: &AppHandle) -> Result<RemoteInfo> {
    let server = app.state::<RemoteServer>();
    if let Some(info) = server.info() {
        return Ok(info);
    }
    let ip = local_ip_address::local_ip()
        .map_err(|e| Error::msg(format!("No network to share the app on: {e}")))?;
    let listener = match TcpListener::bind((Ipv4Addr::UNSPECIFIED, PREFERRED_PORT)).await {
        Ok(listener) => listener,
        Err(_) => TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).await?,
    };
    let port = listener.local_addr()?.port();
    let token = uuid::Uuid::new_v4().simple().to_string();
    let url = device_url(ip, port, &token);
    let qr_svg = qr_svg(&url)?;
    let (stop, stopped) = watch::channel(false);
    let router = router(Ctx {
        app: app.clone(),
        token: token.into(),
        stopped: stopped.clone(),
    });
    {
        let mut running = server.running.lock().unwrap();
        if running.is_some() {
            // Started concurrently; that one wins.
            drop(running);
            return server.info().ok_or_else(|| Error::msg("sharing stopped"));
        }
        *running = Some(Running { url, qr_svg, stop });
    }
    tauri::async_runtime::spawn(async move {
        let shutdown = async move {
            let mut stopped = stopped;
            let _ = stopped.wait_for(|s| *s).await;
        };
        if let Err(e) = axum::serve(listener, router)
            .with_graceful_shutdown(shutdown)
            .await
        {
            log::warn!("device server failed: {e}");
        }
    });
    server.info().ok_or_else(|| Error::msg("sharing stopped"))
}

/// Stops sharing; connected devices lose access.
pub fn stop(app: &AppHandle) {
    if let Some(running) = app.state::<RemoteServer>().running.lock().unwrap().take() {
        let _ = running.stop.send(true);
    }
}

pub fn status(app: &AppHandle) -> Option<RemoteInfo> {
    app.state::<RemoteServer>().info()
}

/// The window's answer to a `remote-capture` request.
pub fn capture_done(app: &AppHandle, request: &str, result: std::result::Result<String, String>) {
    let sender = app
        .state::<RemoteServer>()
        .captures
        .lock()
        .unwrap()
        .remove(request);
    if let Some(sender) = sender {
        let _ = sender.send(result);
    }
}

/// Has the window screenshot `slide` of deck `id` with `strokes` (review marks) drawn on top;
/// returns the deck-relative image path.
async fn capture(app: &AppHandle, id: String, slide: String, strokes: Value) -> Result<String> {
    let server = app.state::<RemoteServer>();
    let request = uuid::Uuid::new_v4().simple().to_string();
    let (tx, rx) = oneshot::channel();
    server.captures.lock().unwrap().insert(request.clone(), tx);
    let payload = serde_json::json!({
        "request": request,
        "deckId": id,
        "slide": slide,
        "strokes": strokes,
    });
    if let Err(e) = app.emit("remote-capture", payload) {
        server.captures.lock().unwrap().remove(&request);
        return Err(Error::msg(format!("cannot reach the window: {e}")));
    }
    let answer = tokio::time::timeout(CAPTURE_TIMEOUT, rx).await;
    server.captures.lock().unwrap().remove(&request);
    match answer {
        Ok(Ok(Ok(path))) => Ok(path),
        Ok(Ok(Err(message))) => Err(Error::msg(message)),
        _ => Err(Error::msg(
            "The SlopSlide window did not take the screenshot.",
        )),
    }
}

fn device_url(ip: IpAddr, port: u16, token: &str) -> String {
    let host = match ip {
        IpAddr::V4(ip) => ip.to_string(),
        IpAddr::V6(ip) => format!("[{ip}]"),
    };
    format!("http://{host}:{port}/s/{token}/")
}

fn qr_svg(url: &str) -> Result<String> {
    use qrcode::render::svg;
    let code = qrcode::QrCode::new(url.as_bytes())
        .map_err(|e| Error::msg(format!("cannot make a QR code: {e}")))?;
    Ok(code
        .render::<svg::Color>()
        .min_dimensions(240, 240)
        .dark_color(svg::Color("#000000"))
        .light_color(svg::Color("#ffffff"))
        .build())
}

#[derive(Clone)]
struct Ctx {
    app: AppHandle,
    token: Arc<str>,
    stopped: watch::Receiver<bool>,
}

fn router(ctx: Ctx) -> Router {
    Router::new()
        .fallback(handle)
        .layer(DefaultBodyLimit::max(MAX_UPLOAD))
        .with_state(ctx)
}

#[derive(Debug, PartialEq)]
enum Route<'a> {
    /// `/s/<token>` without the slash: relative URLs need it.
    AddSlash,
    Index,
    Api(&'a str),
    Events,
    Deck(&'a str),
    Upload(&'a str),
    Export(&'a str),
    AppFile(&'a str),
}

/// What `path` asks for; None unless it is under `/s/<token>`.
fn route<'a>(path: &'a str, token: &str) -> Option<Route<'a>> {
    let rest = path.strip_prefix("/s/")?.strip_prefix(token)?;
    if rest.is_empty() {
        return Some(Route::AddSlash);
    }
    let rest = rest.strip_prefix('/')?;
    Some(match rest {
        "" | "index.html" => Route::Index,
        "events" => Route::Events,
        _ => {
            if let Some(command) = rest.strip_prefix("api/") {
                Route::Api(command)
            } else if let Some(file) = rest.strip_prefix("deck/") {
                Route::Deck(file)
            } else if let Some(id) = rest.strip_prefix("upload/") {
                Route::Upload(id)
            } else if let Some(id) = rest.strip_prefix("export/") {
                Route::Export(id)
            } else {
                Route::AppFile(rest)
            }
        }
    })
}

async fn handle(State(ctx): State<Ctx>, method: Method, uri: Uri, body: Bytes) -> Response {
    let Some(route) = route(uri.path(), &ctx.token) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let post = matches!(route, Route::Api(_) | Route::Upload(_));
    let allowed = if post {
        method == Method::POST
    } else {
        method == Method::GET || method == Method::HEAD
    };
    if !allowed {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let app = &ctx.app;
    match route {
        Route::AddSlash => Response::builder()
            .status(StatusCode::PERMANENT_REDIRECT)
            .header(header::LOCATION, format!("{}/", uri.path()))
            .body(Body::empty())
            .unwrap(),
        Route::Index => match app.asset_resolver().get("index.html".into()) {
            Some(asset) => {
                let html = String::from_utf8_lossy(&asset.bytes);
                let html = with_remote_config(&html, &format!("/s/{}", ctx.token));
                file_response("text/html; charset=utf-8", html.into_bytes())
            }
            None => missing_frontend(),
        },
        Route::AppFile(path) => {
            let path = percent_decode_str(path).decode_utf8_lossy();
            match app.asset_resolver().get(path.to_string()) {
                Some(asset) => file_response(&asset.mime_type, asset.bytes),
                None => StatusCode::NOT_FOUND.into_response(),
            }
        }
        Route::Deck(file) => match protocol::respond(app, &format!("/{file}"), uri.query()) {
            Ok((mime, body)) => file_response(mime, body),
            Err(status) => status.into_response(),
        },
        Route::Api(command) => {
            let args: Value = if body.is_empty() {
                Value::Null
            } else {
                match serde_json::from_slice(&body) {
                    Ok(args) => args,
                    Err(e) => return error_response(format!("invalid arguments: {e}")),
                }
            };
            match dispatch(app, command, &args).await {
                Ok(value) => axum::Json(value).into_response(),
                Err(e) => error_response(e.to_string()),
            }
        }
        Route::Events => events(&ctx).into_response(),
        Route::Upload(id) => {
            let name = query_param(uri.query(), "name").unwrap_or_default();
            let saved = deck::deck_dir(app, &decode(id))
                .and_then(|dir| deck::save_asset(&dir, &name, &body));
            match saved {
                Ok(path) => axum::Json(path).into_response(),
                Err(e) => error_response(e.to_string()),
            }
        }
        Route::Export(id) => {
            let id = decode(id);
            let exported = deck::deck_dir(app, &id).and_then(|dir| {
                let title = deck::load(&dir, &id)?.title;
                Ok((deck::export_file_name(&title), deck::export_html(&dir)?))
            });
            match exported {
                Ok((name, html)) => Response::builder()
                    .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                    .header(header::CONTENT_DISPOSITION, attachment(&name))
                    .header(header::CACHE_CONTROL, "no-store")
                    .body(Body::from(html))
                    .unwrap(),
                Err(e) => error_response(e.to_string()),
            }
        }
    }
}

fn events(
    ctx: &Ctx,
) -> Sse<impl futures_util::Stream<Item = std::result::Result<Event, std::convert::Infallible>>> {
    let receiver = ctx.app.state::<RemoteServer>().events.subscribe();
    let stream = futures_util::stream::unfold(
        (receiver, ctx.stopped.clone()),
        |(mut receiver, mut stopped)| async move {
            let data = tokio::select! {
                // Ends the stream, so stopping the server does not wait for devices.
                _ = stopped.wait_for(|s| *s) => return None,
                message = receiver.recv() => match message {
                    Ok(data) => data,
                    // Too slow to keep up: tell the device to reload what it shows.
                    Err(broadcast::error::RecvError::Lagged(_)) => envelope("resync", "null"),
                    Err(broadcast::error::RecvError::Closed) => return None,
                },
            };
            Some((Ok(Event::default().data(data)), (receiver, stopped)))
        },
    );
    Sse::new(stream).keep_alive(KeepAlive::default())
}

fn file_response(mime: &str, body: Vec<u8>) -> Response {
    Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(body))
        .unwrap()
}

/// Command errors are plain text, as the window gets them from Tauri.
fn error_response(message: String) -> Response {
    (
        StatusCode::BAD_REQUEST,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        message,
    )
        .into_response()
}

fn missing_frontend() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "The app's frontend is not built. Run `pnpm build`, then reload.",
    )
        .into_response()
}

/// Tells the app it runs on a device, and where its backend is, before any of it loads.
fn with_remote_config(html: &str, base: &str) -> String {
    let config = serde_json::json!({ "base": base });
    let script = format!("<script>window.__SLOPSLIDE_REMOTE__ = {config};</script>");
    match html.to_ascii_lowercase().find("<head>") {
        Some(at) => format!("{}{script}{}", &html[..at + 6], &html[at + 6..]),
        None => format!("{script}{html}"),
    }
}

fn decode(segment: &str) -> String {
    percent_decode_str(segment).decode_utf8_lossy().into_owned()
}

/// The percent-decoded value of `name` in a query string.
fn query_param(query: Option<&str>, name: &str) -> Option<String> {
    query?.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        (key == name).then(|| decode(&value.replace('+', " ")))
    })
}

/// `Content-Disposition` for a download named `name`, safe for any title.
fn attachment(name: &str) -> HeaderValue {
    let ascii: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let encoded = utf8_percent_encode(name, NON_ALPHANUMERIC);
    HeaderValue::from_str(&format!(
        "attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}"
    ))
    .expect("ascii header")
}

fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|e| Error::msg(format!("invalid argument `{key}`: {e}")))
}

fn json<T: Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(|e| Error::msg(e.to_string()))
}

/// Runs a command for a device. The same commands the window has, minus those that only make
/// sense on the computer itself (file paths and dialogs, native screenshots, sharing).
async fn dispatch(app: &AppHandle, command: &str, args: &Value) -> Result<Value> {
    use crate as c;
    let app = app.clone();
    let agent = || app.state::<AgentManager>();
    let watcher = || app.state::<DeckWatcher>();
    match command {
        "list_decks" => json(c::list_decks(app.clone())?),
        "create_deck" => json(c::create_deck(app.clone(), watcher(), arg(args, "title")?)?),
        "open_deck" => json(c::open_deck(
            app.clone(),
            agent(),
            watcher(),
            arg(args, "id")?,
        )?),
        "close_deck" => {
            c::close_deck(watcher(), arg(args, "id")?);
            Ok(Value::Null)
        }
        "load_deck" => json(c::load_deck(app.clone(), arg(args, "id")?)?),
        "rename_deck" => json(c::rename_deck(
            app.clone(),
            arg(args, "id")?,
            arg(args, "title")?,
        )?),
        "save_review" => json(c::save_review(
            app.clone(),
            arg(args, "id")?,
            arg(args, "review")?,
        )?),
        "delete_deck" => json(c::delete_deck(
            app.clone(),
            agent(),
            watcher(),
            arg(args, "id")?,
        )?),
        "reorder_slides" => json(c::reorder_slides(
            app.clone(),
            arg(args, "id")?,
            arg(args, "slides")?,
        )?),
        "add_slide" => json(c::add_slide(
            app.clone(),
            arg(args, "id")?,
            arg(args, "after")?,
        )?),
        "duplicate_slide" => json(c::duplicate_slide(
            app.clone(),
            arg(args, "id")?,
            arg(args, "slide")?,
        )?),
        "set_slide_hidden" => json(c::set_slide_hidden(
            app.clone(),
            arg(args, "id")?,
            arg(args, "slide")?,
            arg(args, "hidden")?,
        )?),
        "add_section" => json(c::add_section(
            app.clone(),
            arg(args, "id")?,
            arg(args, "before")?,
            arg(args, "title")?,
        )?),
        "rename_section" => json(c::rename_section(
            app.clone(),
            arg(args, "id")?,
            arg(args, "index")?,
            arg(args, "title")?,
        )?),
        "delete_section" => json(c::delete_section(
            app.clone(),
            arg(args, "id")?,
            arg(args, "index")?,
        )?),
        "delete_slide" => json(c::delete_slide(
            app.clone(),
            arg(args, "id")?,
            arg(args, "slide")?,
        )?),
        "update_slide" => json(c::update_slide(
            app.clone(),
            arg(args, "id")?,
            arg(args, "slide")?,
            arg(args, "markup")?,
            arg(args, "base")?,
        )?),
        "save_deck_source" => json(c::save_deck_source(
            app.clone(),
            agent(),
            arg(args, "id")?,
            arg(args, "source")?,
            arg(args, "base")?,
        )?),
        "lint_deck" => json(c::lint_deck(app.clone(), arg(args, "id")?)?),
        "load_chat" => json(c::load_chat(app.clone(), arg(args, "id")?)?),
        "save_chat" => json(c::save_chat(
            app.clone(),
            arg(args, "id")?,
            arg(args, "chat")?,
            arg(args, "origin")?,
        )?),
        "reset_chat" => json(c::reset_chat(
            app.clone(),
            agent(),
            arg(args, "id")?,
            arg(args, "origin")?,
        )?),
        "send_message" => json(c::send_message(app.clone(), agent(), arg(args, "args")?)?),
        "interrupt_agent" => {
            c::interrupt_agent(agent(), arg(args, "id")?);
            Ok(Value::Null)
        }
        "agent_running" => json(c::agent_running(agent(), arg(args, "id")?)),
        "list_providers" => json(c::list_providers().await),
        "capture_remote_sketch" => json(
            capture(
                &app,
                arg(args, "id")?,
                arg(args, "slide")?,
                arg(args, "strokes")?,
            )
            .await?,
        ),
        _ => Err(Error::msg(format!(
            "`{command}` is not available on other devices"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123abcd";

    #[test]
    fn routes_only_under_the_token() {
        let r = |path: &'static str| route(path, TOKEN);
        assert_eq!(r("/s/0123abcd"), Some(Route::AddSlash));
        assert_eq!(r("/s/0123abcd/"), Some(Route::Index));
        assert_eq!(r("/s/0123abcd/index.html"), Some(Route::Index));
        assert_eq!(r("/s/0123abcd/events"), Some(Route::Events));
        assert_eq!(
            r("/s/0123abcd/api/list_decks"),
            Some(Route::Api("list_decks"))
        );
        assert_eq!(
            r("/s/0123abcd/deck/talk/assets/a.png"),
            Some(Route::Deck("talk/assets/a.png"))
        );
        assert_eq!(r("/s/0123abcd/upload/talk"), Some(Route::Upload("talk")));
        assert_eq!(r("/s/0123abcd/export/talk"), Some(Route::Export("talk")));
        assert_eq!(
            r("/s/0123abcd/assets/index-x1.js"),
            Some(Route::AppFile("assets/index-x1.js"))
        );
    }

    #[test]
    fn rejects_wrong_or_partial_tokens() {
        let r = |path: &'static str| route(path, TOKEN);
        assert_eq!(r("/"), None);
        assert_eq!(r("/index.html"), None);
        assert_eq!(r("/s/"), None);
        assert_eq!(r("/s/wrong/"), None);
        assert_eq!(r("/s/0123abc/"), None, "a prefix of the token");
        assert_eq!(r("/s/0123abcde/"), None, "the token plus more");
        assert_eq!(r("/s/0123abcdapi/list_decks"), None);
        assert_eq!(r("/x/0123abcd/"), None);
    }

    #[test]
    fn envelopes_carry_name_and_raw_payload() {
        let message = envelope("deck-changed", r#"{"deckId":"a","paths":["deck.html"]}"#);
        let parsed: Value = serde_json::from_str(&message).unwrap();
        assert_eq!(parsed["event"], "deck-changed");
        assert_eq!(parsed["payload"]["paths"][0], "deck.html");
        let empty: Value = serde_json::from_str(&envelope("resync", "")).unwrap();
        assert_eq!(empty["payload"], Value::Null);
    }

    #[test]
    fn injects_the_config_first_in_head() {
        let html = "<!doctype html><html><HEAD><script type=\"module\" src=\"./a.js\"></script></HEAD></html>";
        let out = with_remote_config(html, "/s/tok");
        let config = out
            .find("window.__SLOPSLIDE_REMOTE__ = {\"base\":\"/s/tok\"};")
            .expect("config injected");
        assert!(out.find("<HEAD>").unwrap() < config);
        assert!(config < out.find("./a.js").unwrap(), "before the app runs");
        assert!(with_remote_config("<p>x", "/s/t").starts_with("<script>"));
    }

    #[test]
    fn reads_query_params() {
        let q = Some("name=IMG%200042.HEIC&x=1&flag");
        assert_eq!(query_param(q, "name").as_deref(), Some("IMG 0042.HEIC"));
        assert_eq!(query_param(q, "x").as_deref(), Some("1"));
        assert_eq!(query_param(q, "flag").as_deref(), Some(""));
        assert_eq!(
            query_param(Some("name=a+b"), "name").as_deref(),
            Some("a b")
        );
        assert_eq!(query_param(q, "missing"), None);
        assert_eq!(query_param(None, "name"), None);
    }

    #[test]
    fn device_urls_and_qr_codes() {
        let v4 = device_url("192.168.1.20".parse().unwrap(), 47_419, "tok");
        assert_eq!(v4, "http://192.168.1.20:47419/s/tok/");
        let v6 = device_url("fe80::1".parse().unwrap(), 80, "tok");
        assert_eq!(v6, "http://[fe80::1]:80/s/tok/");
        let svg = qr_svg(&v4).unwrap();
        assert!(svg.contains("<svg") && svg.contains("#000000"));
    }

    #[test]
    fn download_names_survive_any_title() {
        assert_eq!(
            attachment("Q3 Plans.html"),
            "attachment; filename=\"Q3 Plans.html\"; filename*=UTF-8''Q3%20Plans%2Ehtml"
        );
        let header = attachment("Café \"talk\".html");
        let text = header.to_str().unwrap();
        assert!(text.starts_with("attachment; filename=\"Caf_ _talk_.html\";"));
        assert!(text.ends_with("filename*=UTF-8''Caf%C3%A9%20%22talk%22%2Ehtml"));
    }

    #[test]
    fn reads_typed_arguments() {
        let args = serde_json::json!({ "id": "talk", "after": null, "index": 2 });
        assert_eq!(arg::<String>(&args, "id").unwrap(), "talk");
        assert_eq!(arg::<Option<String>>(&args, "after").unwrap(), None);
        assert_eq!(
            arg::<Option<String>>(&args, "missing").unwrap(),
            None,
            "an absent optional argument is None, as with Tauri"
        );
        assert_eq!(arg::<usize>(&args, "index").unwrap(), 2);
        let err = arg::<String>(&args, "missing").unwrap_err().to_string();
        assert!(err.contains("`missing`"), "{err}");
    }
}
