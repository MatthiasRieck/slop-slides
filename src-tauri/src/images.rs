//! Native actions for images displayed inside sandboxed slide frames.
use crate::{
    deck,
    error::{Error, Result},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub fn local_path(dir: &Path, source: &str) -> Result<PathBuf> {
    let path = deck::resolve_in_deck(dir, source)?.canonicalize()?;
    if !path.starts_with(dir.canonicalize()?) || !deck::mime_for(source).starts_with("image/") {
        return Err(Error::msg("Not an image inside this deck"));
    }
    Ok(path)
}

fn embedded(source: &str) -> Result<(Vec<u8>, &'static str)> {
    let (meta, data) = source
        .split_once(',')
        .ok_or_else(|| Error::msg("Invalid image data"))?;
    let mime = meta
        .strip_prefix("data:")
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("");
    let ext = match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/avif" => "avif",
        "image/svg+xml" => "svg",
        _ => return Err(Error::msg("Unsupported image format")),
    };
    let bytes = if meta.split(';').any(|part| part == "base64") {
        STANDARD
            .decode(data)
            .map_err(|e| Error::msg(e.to_string()))?
    } else {
        percent_encoding::percent_decode_str(data).collect()
    };
    Ok((bytes, ext))
}

pub fn save(dir: &Path, source: &str, dest: &Path) -> Result<()> {
    let bytes = if source.starts_with("data:") {
        embedded(source)?.0
    } else {
        fs::read(local_path(dir, source)?)?
    };
    fs::write(dest, bytes)?;
    Ok(())
}

pub fn open_path(dir: &Path, source: &str, cache: &Path) -> Result<PathBuf> {
    if !source.starts_with("data:") {
        return local_path(dir, source);
    }
    let (bytes, ext) = embedded(source)?;
    fs::create_dir_all(cache)?;
    let path = cache.join(format!("image-{}.{}", uuid::Uuid::new_v4(), ext));
    fs::write(&path, bytes)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decodes_embedded_images_and_rejects_other_data() {
        assert_eq!(
            embedded("data:image/png;base64,aGVsbG8=").unwrap(),
            (b"hello".to_vec(), "png")
        );
        assert_eq!(
            embedded("data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E").unwrap(),
            (b"<svg/>".to_vec(), "svg")
        );
        assert!(embedded("data:text/html;base64,aGVsbG8=").is_err());
        assert!(embedded("data:image/png;base64,!").is_err());
    }
    #[test]
    fn saves_original_bytes_and_limits_opening_to_deck_images() {
        let dir = std::env::temp_dir().join(format!("slop-images-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("assets")).unwrap();
        fs::write(dir.join("assets/photo.png"), b"original").unwrap();
        fs::write(dir.join("deck.html"), b"html").unwrap();
        save(&dir, "assets/photo.png", &dir.join("saved.png")).unwrap();
        assert_eq!(fs::read(dir.join("saved.png")).unwrap(), b"original");
        assert!(local_path(&dir, "../outside.png").is_err());
        assert!(local_path(&dir, "deck.html").is_err());
        let path = open_path(&dir, "data:image/png;base64,aGk=", &dir.join("cache")).unwrap();
        assert_eq!(fs::read(path).unwrap(), b"hi");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn failed_source_does_not_overwrite_an_existing_download() {
        let dir = std::env::temp_dir().join(format!("slop-images-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("download.png");
        fs::write(&dest, b"keep this file").unwrap();
        for source in ["missing.png", "data:image/png;base64,!", "../outside.png"] {
            assert!(save(&dir, source, &dest).is_err());
            assert_eq!(fs::read(&dest).unwrap(), b"keep this file");
        }
        fs::write(dir.join("photo.png"), b"original").unwrap();
        assert!(save(&dir, "photo.png", &dir.join("missing-folder/out.png")).is_err());
        assert_eq!(fs::read(dir.join("photo.png")).unwrap(), b"original");
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_image_symlinks_that_escape_the_deck() {
        let root = std::env::temp_dir().join(format!("slop-images-{}", uuid::Uuid::new_v4()));
        let dir = root.join("deck");
        fs::create_dir_all(dir.join("assets")).unwrap();
        let outside = root.join("outside.png");
        fs::write(&outside, b"outside deck").unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("assets/link.png")).unwrap();
        assert!(local_path(&dir, "assets/link.png").is_err());
        assert!(save(&dir, "assets/link.png", &root.join("download.png")).is_err());
        assert!(!root.join("download.png").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
