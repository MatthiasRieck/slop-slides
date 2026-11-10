//! The speech-to-text model: which file it is, where it lives (`~/.slopslides/models/`, shared
//! by every workspace) and downloading it once, checked against its checksum.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use super::DOWNLOAD_EVENT;
use crate::error::{Error, Result};

/// A speech-to-text model file and where it comes from.
pub struct Model {
    pub file: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
    /// Its alignment heads, for timing words (see [`super::timing`]).
    pub dtw: whisper_rs::DtwModelPreset,
}

/// Whisper small, multilingual, 5-bit quantized: about 190 MB, good on dictation in any of
/// Whisper's languages and fast on a laptop CPU (and the GPU, on macOS). Pinned to a commit
/// so the checksum stays valid.
pub const MODEL: Model = Model {
    file: "ggml-small-q5_1.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small-q5_1.bin",
    sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
    bytes: 190_085_487,
    dtw: whisper_rs::DtwModelPreset::Small,
};

/// `~/.slopslides/models`, where the downloaded speech-to-text model lives.
fn models_dir(home: &Path) -> PathBuf {
    home.join("models")
}

pub fn model_path(home: &Path) -> PathBuf {
    models_dir(home).join(MODEL.file)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    received: u64,
    total: u64,
}

/// Downloads `model` to `dest`, reporting progress as [`DOWNLOAD_EVENT`]; a failed or damaged
/// download leaves nothing behind.
pub(super) async fn download(app: &AppHandle, model: &Model, dest: &Path) -> Result<()> {
    let dir = dest.parent().expect("model path has a folder");
    fs::create_dir_all(dir)?;
    let part = dest.with_extension("part");
    let result = fetch(app, model, &part).await;
    if result.is_err() {
        let _ = fs::remove_file(&part);
    }
    let hash = result?;
    finish_download(&part, dest, &hash, model.sha256)
}

/// Streams the model to `part`; returns its SHA-256, hex.
async fn fetch(app: &AppHandle, model: &Model, part: &Path) -> Result<String> {
    let mut reported = 0u64;
    fetch_to(model.url, part, |received, total| {
        let total = total.unwrap_or(model.bytes);
        // About every half percent, so the progress bar moves without flooding the frontend.
        if received - reported >= total / 200 || received == total {
            reported = received;
            let _ = app.emit(DOWNLOAD_EVENT, DownloadProgress { received, total });
        }
    })
    .await
}

/// Streams `url` to `part`, calling `progress` with the bytes received so far (and the
/// download's size, when the server says) after each chunk; returns its SHA-256, hex.
async fn fetch_to(
    url: &str,
    part: &Path,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<String> {
    let failed =
        |e: reqwest::Error| Error::msg(format!("Downloading the speech model failed: {e}"));
    let response = reqwest::get(url)
        .await
        .and_then(|r| r.error_for_status())
        .map_err(failed)?;
    let total = response.content_length();
    let mut file = fs::File::create(part)?;
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    let mut body = response.bytes_stream();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(failed)?;
        file.write_all(&chunk)?;
        hasher.update(&chunk);
        received += chunk.len() as u64;
        progress(received, total);
    }
    file.sync_all()?;
    Ok(format!("{:x}", hasher.finalize()))
}

/// Moves a finished download into place if its checksum matches; otherwise deletes it.
fn finish_download(part: &Path, dest: &Path, hash: &str, expected: &str) -> Result<()> {
    if !hash.eq_ignore_ascii_case(expected) {
        let _ = fs::remove_file(part);
        return Err(Error::msg(
            "The downloaded speech model is damaged (checksum mismatch). Try again.",
        ));
    }
    fs::rename(part, dest)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("slopslide-voice-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_model_lives_in_the_app_home_models_folder() {
        let home = Path::new("/home/me/.slopslides");
        assert_eq!(
            model_path(home),
            Path::new("/home/me/.slopslides/models/ggml-small-q5_1.bin")
        );
    }

    #[test]
    fn the_model_url_is_pinned_to_a_commit_and_names_the_file() {
        assert!(MODEL.url.starts_with("https://"));
        assert!(MODEL.url.ends_with(MODEL.file));
        assert!(!MODEL.url.contains("/resolve/main/"));
        assert_eq!(MODEL.sha256.len(), 64);
    }

    #[test]
    fn a_download_with_the_right_checksum_moves_into_place() {
        let dir = temp_dir();
        let (part, dest) = (dir.join("m.part"), dir.join("m.bin"));
        fs::write(&part, b"hello").unwrap();
        let hash = format!("{:x}", Sha256::digest(b"hello"));
        finish_download(&part, &dest, &hash, &hash.to_uppercase()).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"hello");
        assert!(!part.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_damaged_download_is_deleted() {
        let dir = temp_dir();
        let (part, dest) = (dir.join("m.part"), dir.join("m.bin"));
        fs::write(&part, b"hello").unwrap();
        let err = finish_download(&part, &dest, "abc", MODEL.sha256).unwrap_err();
        assert!(err.to_string().contains("checksum"));
        assert!(!part.exists());
        assert!(!dest.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn hashes_as_lowercase_hex() {
        assert_eq!(
            format!("{:x}", Sha256::digest(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
