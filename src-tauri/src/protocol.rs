//! `slop://` URI scheme. Serves deck files to the editor's slide iframes as
//! `slop://localhost/<deck-id>/<path>` (`http://slop.localhost/...` on Windows), so the
//! deck's relative `assets/…` references resolve exactly as they do when the file is opened
//! in a browser.

use std::borrow::Cow;

use percent_encoding::percent_decode_str;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::AppHandle;

use crate::deck;

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
    let path = percent_decode_str(raw_path)
        .decode_utf8()
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let (deck_id, rel) = path
        .trim_start_matches('/')
        .split_once('/')
        .ok_or(StatusCode::NOT_FOUND)?;
    let dir = deck::deck_dir(app, deck_id).map_err(|_| StatusCode::NOT_FOUND)?;
    let file = deck::resolve_in_deck(&dir, rel).map_err(|_| StatusCode::FORBIDDEN)?;
    let bytes = std::fs::read(&file).map_err(|_| StatusCode::NOT_FOUND)?;
    Ok((deck::mime_for(rel), bytes))
}
