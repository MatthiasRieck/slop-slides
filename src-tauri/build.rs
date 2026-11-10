use std::path::{Path, PathBuf};
use std::{env, fs};

/// The slide editor's source: the `.js` files of `assets/editor/`, in the order of their names.
/// They are one script cut into parts (the first opens its closure, the last closes it), so the
/// file names are the one place that order is defined; the tests and the browser preview read
/// the folder the same way.
const EDITOR_DIR: &str = "assets/editor";

fn main() {
    write_editor();
    tauri_build::build()
}

/// Joins the editor's parts into `$OUT_DIR/editor.js`, which `protocol.rs` embeds.
fn write_editor() {
    println!("cargo:rerun-if-changed={EDITOR_DIR}");
    let parts = editor_parts(Path::new(EDITOR_DIR));
    assert!(!parts.is_empty(), "no editor parts in {EDITOR_DIR}");
    let mut script = String::new();
    for part in &parts {
        println!("cargo:rerun-if-changed={}", part.display());
        let text =
            fs::read_to_string(part).unwrap_or_else(|e| panic!("reading {}: {e}", part.display()));
        script.push_str(&text);
    }
    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR")).join("editor.js");
    fs::write(&out, script).unwrap_or_else(|e| panic!("writing {}: {e}", out.display()));
}

/// The `.js` files in `dir`, sorted by name.
fn editor_parts(dir: &Path) -> Vec<PathBuf> {
    let mut parts: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("reading {}: {e}", dir.display()))
        .map(|entry| entry.expect("editor part").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "js"))
        .collect();
    parts.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
    parts
}
