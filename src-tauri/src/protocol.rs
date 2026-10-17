//! `slop://` URI scheme. Serves files of the open workspace (decks, the pages the viewer
//! shows, their assets) by their absolute path, as `slop://localhost/.file/<absolute path>`
//! (`http://slop.localhost/...` on Windows), so a deck's relative `assets/…` references
//! resolve exactly as they do when the file is opened in a browser. Files outside the open
//! workspace are refused. Templates (see [`templates`]) are served as
//! `slop://localhost/.template/<template-id>/<path>`, for the layout and style previews, and
//! files in a deck's session (sketches the chat shows) by their absolute path, as
//! `slop://localhost/.session/<absolute path>`.
//!
//! With `?pan` in the query, a deck is served with the pasteboard (`assets/pasteboard.js`)
//! added, so the stage can pan and zoom around the slide. With `?edit`, it also gets the slide
//! editor (`assets/editor.js`), which builds on the pasteboard, so the stage can edit text and
//! move elements in place. With `?show`, the presenter's whole-deck player gets the pasteboard
//! too, to zoom and pan the slide being shown. None of them ever becomes part of the deck file
//! or an export.

use std::borrow::Cow;
use std::path::{Path, PathBuf};

use percent_encoding::percent_decode_str;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager};

use crate::deck;
use crate::sessions::Sessions;
use crate::templates;
use crate::workspace::OpenWorkspace;

/// First path segment of workspace files, followed by their absolute path.
const FILE_PREFIX: &str = ".file";
/// First path segment of template files: `/.template/<template-id>/deck.html`.
const TEMPLATE_PREFIX: &str = ".template";
/// First path segment of session files, followed by their absolute path.
const SESSION_PREFIX: &str = ".session";

const PASTEBOARD_JS: &str = include_str!("../assets/pasteboard.js");
const EDITOR_JS: &str = include_str!("../assets/editor.js");

pub fn handle(app: &AppHandle, request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let uri = request.uri();
    let served = serve(app, uri.path()).map(|(mime, body)| {
        let scripts = stage_scripts(uri.query());
        if !scripts.is_empty() && mime.starts_with("text/html") {
            let html = String::from_utf8_lossy(&body);
            (mime, with_scripts(&html, &scripts).into_bytes())
        } else {
            (mime, body)
        }
    });
    match served {
        Ok((mime, body)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Cow::Owned(body))
            .unwrap(),
        Err(status) => Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "text/plain")
            .body(Cow::Borrowed(&b""[..]))
            .unwrap(),
    }
}

fn serve(app: &AppHandle, raw_path: &str) -> Result<(&'static str, Vec<u8>), StatusCode> {
    let (prefix, rel) = split_path(raw_path)?;
    if prefix == FILE_PREFIX {
        return read_in_workspace(&app.state::<OpenWorkspace>(), &rel);
    }
    if prefix == TEMPLATE_PREFIX {
        let (template, rel) = rel.split_once('/').ok_or(StatusCode::NOT_FOUND)?;
        let root = templates::user_root().map_err(|_| StatusCode::NOT_FOUND)?;
        return templates::read_file(&root, template, rel).ok_or(StatusCode::NOT_FOUND);
    }
    if prefix == SESSION_PREFIX {
        let home = deck::app_home().map_err(|_| StatusCode::NOT_FOUND)?;
        return read_in_session(&Sessions::new(&home), &rel);
    }
    Err(StatusCode::NOT_FOUND)
}

/// `/<prefix>/<path>`, percent-decoded.
fn split_path(raw_path: &str) -> Result<(String, String), StatusCode> {
    let path = percent_decode_str(raw_path)
        .decode_utf8()
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let (prefix, rel) = path
        .trim_start_matches('/')
        .split_once('/')
        .ok_or(StatusCode::NOT_FOUND)?;
    Ok((prefix.to_string(), rel.to_string()))
}

/// Whether the query string has the parameter `name` (`name` or `name=<value>`).
fn has_param(query: Option<&str>, name: &str) -> bool {
    query.is_some_and(|q| {
        q.split('&')
            .any(|p| p == name || p.strip_prefix(name).is_some_and(|v| v.starts_with('=')))
    })
}

/// The scripts the stage or the show asked for, in the order they run: the editor needs the
/// pasteboard.
fn stage_scripts(query: Option<&str>) -> Vec<&'static str> {
    let editor = has_param(query, "edit");
    let mut scripts = Vec::new();
    if editor || has_param(query, "pan") || has_param(query, "show") {
        scripts.push(PASTEBOARD_JS);
    }
    if editor {
        scripts.push(EDITOR_JS);
    }
    scripts
}

/// Adds `scripts` after everything else in `<body>`, so they run after the player.
fn with_scripts(html: &str, scripts: &[&str]) -> String {
    let tags: String = scripts
        .iter()
        .map(|js| format!("<script>\n{js}</script>\n"))
        .collect();
    let at = html
        .to_ascii_lowercase()
        .rfind("</body")
        .unwrap_or(html.len());
    format!("{}{tags}{}", &html[..at], &html[at..])
}

/// An absolute path sent without its leading `/` (`C:/…` on Windows).
fn absolute(path: &str) -> PathBuf {
    match cfg!(windows) {
        true => PathBuf::from(path),
        false => Path::new("/").join(path),
    }
}

/// A file of the open workspace, by its absolute path without the leading `/`.
fn read_in_workspace(
    workspace: &OpenWorkspace,
    path: &str,
) -> Result<(&'static str, Vec<u8>), StatusCode> {
    let file = absolute(path);
    if !workspace.contains(&file) {
        return Err(StatusCode::FORBIDDEN);
    }
    if file.is_dir() {
        return Err(StatusCode::NOT_FOUND);
    }
    let bytes = std::fs::read(&file).map_err(|_| StatusCode::NOT_FOUND)?;
    Ok((deck::mime_for(path), bytes))
}

/// A session file, by its absolute path without the leading `/` (`C:/…` on Windows).
fn read_in_session(sessions: &Sessions, path: &str) -> Result<(&'static str, Vec<u8>), StatusCode> {
    let file = absolute(path);
    if !sessions.contains(&file) {
        return Err(StatusCode::FORBIDDEN);
    }
    let bytes = std::fs::read(&file).map_err(|_| StatusCode::NOT_FOUND)?;
    Ok((deck::mime_for(path), bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(raw: &str) -> Result<(String, String), StatusCode> {
        split_path(raw)
    }

    #[test]
    fn splits_prefix_and_path() {
        assert_eq!(
            split("/.file/Users/me/talk/deck.html"),
            Ok((".file".into(), "Users/me/talk/deck.html".into()))
        );
        assert_eq!(
            split("/.template/swiss/assets/a.png"),
            Ok((".template".into(), "swiss/assets/a.png".into()))
        );
        assert_eq!(
            split(".session/x/1.png"),
            Ok((".session".into(), "x/1.png".into()))
        );
    }

    #[test]
    fn percent_decodes_like_the_frontend_encodes() {
        // src/lib/utils.ts encodes each segment with encodeURIComponent.
        assert_eq!(
            split("/.file/my%20talks/assets/caf%C3%A9%20photo.png"),
            Ok((".file".into(), "my talks/assets/café photo.png".into()))
        );
    }

    #[test]
    fn rejects_malformed_paths() {
        assert_eq!(split("/talk"), Err(StatusCode::NOT_FOUND));
        assert_eq!(split("/"), Err(StatusCode::NOT_FOUND));
        assert_eq!(split(""), Err(StatusCode::NOT_FOUND));
        assert_eq!(split("/talk/%FF"), Err(StatusCode::BAD_REQUEST));
    }

    #[test]
    fn scripts_only_on_request() {
        assert_eq!(
            stage_scripts(Some("embed&slide=a&edit=abc")),
            [PASTEBOARD_JS, EDITOR_JS],
            "the editor builds on the pasteboard"
        );
        assert_eq!(stage_scripts(Some("edit&pan")), [PASTEBOARD_JS, EDITOR_JS]);
        assert_eq!(stage_scripts(Some("embed&slide=a&pan")), [PASTEBOARD_JS]);
        assert_eq!(stage_scripts(Some("v=1&show")), [PASTEBOARD_JS]);
        assert!(stage_scripts(Some("v=1&shown")).is_empty());
        assert_eq!(stage_scripts(Some("pan=1")), [PASTEBOARD_JS]);
        assert!(stage_scripts(Some("embed&slide=edit&static")).is_empty());
        assert!(stage_scripts(Some("embed&slide=pan")).is_empty());
        assert!(stage_scripts(Some("editor&panel")).is_empty());
        assert!(stage_scripts(None).is_empty());
    }

    #[test]
    fn adds_the_scripts_at_the_end_of_the_body_in_order() {
        let html = "<html><body><main class=\"deck\"></main><script>player</script></BODY></html>";
        let out = with_scripts(html, &[PASTEBOARD_JS, EDITOR_JS]);
        let pasteboard = out.find(PASTEBOARD_JS).expect("pasteboard inlined");
        let editor = out.find(EDITOR_JS).expect("editor inlined");
        assert!(out.find("player").unwrap() < pasteboard);
        assert!(pasteboard < editor);
        assert!(editor < out.find("</BODY>").unwrap());
        assert!(with_scripts("<p>no body", &[EDITOR_JS]).starts_with("<p>no body<script>"));
    }

    /// As the frontend sends it: the absolute path without its leading slash.
    fn url_path(path: &Path) -> String {
        let path = path.to_string_lossy().replace('\\', "/");
        path.trim_start_matches('/').to_string()
    }

    #[test]
    fn serves_files_inside_the_open_workspace_only() {
        let root = std::env::temp_dir().join(format!("slopslide-proto-{}", uuid::Uuid::new_v4()));
        let ws = root.join("ws");
        std::fs::create_dir_all(ws.join("talk/assets")).unwrap();
        std::fs::write(ws.join("talk/q3.html"), "<html>").unwrap();
        std::fs::write(ws.join("talk/assets/a.svg"), "<svg/>").unwrap();
        std::fs::write(root.join("secret.txt"), "x").unwrap();
        let open = OpenWorkspace::default();
        let read = |path: PathBuf| read_in_workspace(&open, &url_path(&path));

        assert_eq!(
            read(ws.join("talk/q3.html")),
            Err(StatusCode::FORBIDDEN),
            "nothing is served without a workspace"
        );
        open.set(Some(ws.clone()));
        assert_eq!(
            read(ws.join("talk/q3.html")),
            Ok(("text/html; charset=utf-8", b"<html>".to_vec()))
        );
        assert_eq!(
            read(ws.join("talk/assets/a.svg")),
            Ok(("image/svg+xml", b"<svg/>".to_vec()))
        );
        assert_eq!(read(ws.join("talk/assets")), Err(StatusCode::NOT_FOUND));
        assert_eq!(
            read(ws.join("talk/missing.png")),
            Err(StatusCode::FORBIDDEN),
            "a missing file is not known to be inside"
        );
        assert_eq!(read(root.join("secret.txt")), Err(StatusCode::FORBIDDEN));
        assert_eq!(
            read(ws.join("talk/../../secret.txt")),
            Err(StatusCode::FORBIDDEN)
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn serves_files_inside_sessions_only() {
        let root = std::env::temp_dir().join(format!("slopslide-proto-{}", uuid::Uuid::new_v4()));
        let deck = root.join("deck");
        std::fs::create_dir_all(&deck).unwrap();
        std::fs::write(deck.join("deck.html"), "<html>").unwrap();
        let sessions = Sessions::new(&root.join("home"));
        let session = sessions.start(&deck.join("deck.html")).unwrap();
        std::fs::create_dir_all(session.join("sketches")).unwrap();
        std::fs::write(session.join("sketches/1.png"), "png").unwrap();

        assert_eq!(
            read_in_session(&sessions, &url_path(&session.join("sketches/1.png"))),
            Ok(("image/png", b"png".to_vec()))
        );
        assert_eq!(
            read_in_session(&sessions, &url_path(&deck.join("deck.html"))),
            Err(StatusCode::FORBIDDEN),
            "only session files"
        );
        assert_eq!(
            read_in_session(&sessions, &url_path(&session.join("../../deck/deck.html"))),
            Err(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            read_in_session(&sessions, &url_path(&session.join("sketches/missing.png"))),
            Err(StatusCode::FORBIDDEN),
            "a missing file is not known to be inside"
        );

        let _ = std::fs::remove_dir_all(&root);
    }
}
