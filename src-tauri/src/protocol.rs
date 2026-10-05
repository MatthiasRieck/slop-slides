//! `slop://` URI scheme. Serves deck files to the editor's slide iframes as
//! `slop://localhost/<deck-id>/<path>` (`http://slop.localhost/...` on Windows), so the
//! deck's relative `assets/…` references resolve exactly as they do when the file is opened
//! in a browser.

use std::borrow::Cow;
use std::path::Path;

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
    let (deck_id, rel) = split_path(raw_path)?;
    let dir = deck::deck_dir(app, &deck_id).map_err(|_| StatusCode::NOT_FOUND)?;
    read_in_deck(&dir, &rel)
}

/// `/<deck-id>/<path>`, percent-decoded.
fn split_path(raw_path: &str) -> Result<(String, String), StatusCode> {
    let path = percent_decode_str(raw_path)
        .decode_utf8()
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let (deck_id, rel) = path
        .trim_start_matches('/')
        .split_once('/')
        .ok_or(StatusCode::NOT_FOUND)?;
    Ok((deck_id.to_string(), rel.to_string()))
}

fn read_in_deck(dir: &Path, rel: &str) -> Result<(&'static str, Vec<u8>), StatusCode> {
    let file = deck::resolve_in_deck(dir, rel).map_err(|_| StatusCode::FORBIDDEN)?;
    let bytes = std::fs::read(&file).map_err(|_| StatusCode::NOT_FOUND)?;
    Ok((deck::mime_for(rel), bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(raw: &str) -> Result<(String, String), StatusCode> {
        split_path(raw)
    }

    #[test]
    fn splits_deck_id_and_path() {
        assert_eq!(
            split("/talk/deck.html"),
            Ok(("talk".into(), "deck.html".into()))
        );
        assert_eq!(
            split("/talk/assets/sub/a.png"),
            Ok(("talk".into(), "assets/sub/a.png".into()))
        );
        assert_eq!(
            split("talk/deck.html"),
            Ok(("talk".into(), "deck.html".into()))
        );
    }

    #[test]
    fn percent_decodes_like_the_frontend_encodes() {
        // src/lib/utils.ts encodes each segment with encodeURIComponent.
        assert_eq!(
            split("/my%20deck/assets/caf%C3%A9%20photo.png"),
            Ok(("my deck".into(), "assets/café photo.png".into()))
        );
        assert_eq!(
            split("/a%2Fb/deck.html"),
            Ok(("a".into(), "b/deck.html".into())),
            "an encoded slash still splits; deck_dir then rejects odd ids"
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
    fn serves_files_inside_the_deck_only() {
        let dir = std::env::temp_dir().join(format!("slopslide-proto-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("deck.html"), "<html>").unwrap();
        std::fs::write(dir.join("assets/a.svg"), "<svg/>").unwrap();

        assert_eq!(
            read_in_deck(&dir, "deck.html"),
            Ok(("text/html; charset=utf-8", b"<html>".to_vec()))
        );
        assert_eq!(
            read_in_deck(&dir, "assets/a.svg"),
            Ok(("image/svg+xml", b"<svg/>".to_vec()))
        );
        assert_eq!(
            read_in_deck(&dir, "assets/missing.png"),
            Err(StatusCode::NOT_FOUND)
        );
        assert_eq!(read_in_deck(&dir, "assets"), Err(StatusCode::NOT_FOUND));
        assert_eq!(
            read_in_deck(&dir, "../outside.txt"),
            Err(StatusCode::FORBIDDEN)
        );
        assert_eq!(read_in_deck(&dir, "/etc/hosts"), Err(StatusCode::FORBIDDEN));
        assert_eq!(read_in_deck(&dir, ""), Err(StatusCode::FORBIDDEN));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
