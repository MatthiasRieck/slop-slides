//! `slop://` URI scheme. Serves deck files to the slide iframes as
//! `slop://localhost/<deck-id>/<path>` (`http://slop.localhost/...` on Windows),
//! so relative links such as `../theme.css` and `../assets/x.png` resolve.

use std::borrow::Cow;

use percent_encoding::percent_decode_str;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::AppHandle;

use crate::deck;

const STAGE_CSS: &str = include_str!("../assets/stage.css");
const STAGE_JS: &str = include_str!("../assets/stage.js");

pub fn handle(app: &AppHandle, request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    match serve(app, request.uri().path()) {
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
    let path = percent_decode_str(raw_path).decode_utf8().map_err(|_| StatusCode::BAD_REQUEST)?;
    let path = path.trim_start_matches('/');
    let (deck_id, rel) = path.split_once('/').ok_or(StatusCode::NOT_FOUND)?;
    let dir = deck::deck_dir(app, deck_id).map_err(|_| StatusCode::NOT_FOUND)?;
    let file = deck::resolve_in_deck(&dir, rel).map_err(|_| StatusCode::FORBIDDEN)?;
    let bytes = std::fs::read(&file).map_err(|_| StatusCode::NOT_FOUND)?;
    let mime = mime_for(rel);
    if mime.starts_with("text/html") {
        return Ok((mime, inject_stage(&String::from_utf8_lossy(&bytes)).into_bytes()));
    }
    Ok((mime, bytes))
}

/// Places the app's stage styles and key forwarding ahead of the deck's own `<head>` content.
fn inject_stage(html: &str) -> String {
    let snippet = format!("<style data-slopslide>{STAGE_CSS}</style><script data-slopslide>{STAGE_JS}</script>");
    let lower = html.to_ascii_lowercase();
    let insert_at = lower
        .find("<head")
        .and_then(|start| lower[start..].find('>').map(|end| start + end + 1))
        .or_else(|| lower.find("<html").and_then(|start| lower[start..].find('>').map(|end| start + end + 1)))
        .unwrap_or(0);
    let mut out = String::with_capacity(html.len() + snippet.len());
    out.push_str(&html[..insert_at]);
    out.push_str(&snippet);
    out.push_str(&html[insert_at..]);
    out
}

fn mime_for(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injects_after_head_tag() {
        let out = inject_stage("<!DOCTYPE html><html><HEAD lang=x><title>t</title></head></html>");
        let head = out.find("<HEAD lang=x>").unwrap();
        let style = out.find("<style data-slopslide>").unwrap();
        assert!(style > head && style < out.find("<title>").unwrap());
    }

    #[test]
    fn injects_without_head() {
        assert!(inject_stage("<p>hi</p>").starts_with("<style data-slopslide>"));
    }
}
