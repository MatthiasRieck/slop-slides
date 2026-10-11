//! Locate bundled native helpers, with a source-tree fallback for development.
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub fn helper(app: &AppHandle, relative: &str) -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    // Tauri can reject resource_dir() when a development target directory is
    // symlinked. That must not prevent the existing source-tree fallback.
    let bundled = app.path().resource_dir().ok();
    let development = cfg!(debug_assertions).then(|| Path::new(env!("CARGO_MANIFEST_DIR")));
    find(bundled.as_deref(), development, relative)
}

fn find(bundled: Option<&Path>, development: Option<&Path>, relative: &str) -> Option<PathBuf> {
    bundled
        .into_iter()
        .chain(development)
        .map(|root| root.join(relative))
        .find(|path| path.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_fallback_survives_resource_lookup_failure() {
        let root = std::env::temp_dir().join(format!("slopslide-runtime-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        for relative in [
            "speech-runtime/slopslide-speech",
            "video-runtime/slopslide-video",
        ] {
            let path = root.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "helper").unwrap();
            assert_eq!(find(None, Some(&root), relative), Some(path.clone()));
            assert_eq!(
                find(Some(&root.join("missing")), Some(&root), relative),
                Some(path)
            );
            assert_eq!(find(None, None, relative), None);
            assert_eq!(find(Some(&root.join("missing")), None, relative), None);
        }
        let bundled = root.join("bundled");
        std::fs::create_dir_all(&bundled).unwrap();
        std::fs::write(bundled.join("helper"), "bundled").unwrap();
        std::fs::write(root.join("helper"), "development").unwrap();
        assert_eq!(
            find(Some(&bundled), Some(&root), "helper"),
            Some(bundled.join("helper"))
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
