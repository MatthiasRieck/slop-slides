use std::path::{Path, PathBuf};
use std::process::Command;
use std::{env, fs};

/// The slide editor's source: the `.js` files of `assets/editor/`, in the order of their names.
/// They are one script cut into parts (the first opens its closure, the last closes it), so the
/// file names are the one place that order is defined; the tests and the browser preview read
/// the folder the same way.
const EDITOR_DIR: &str = "assets/editor";

fn main() {
    write_editor();
    link_clang_runtime();
    tauri_build::build()
}

/// Links clang's runtime library into the macOS app. whisper.cpp's Metal code asks which macOS
/// it runs on (`@available`), which the C compiler turns into a call into that library. A C
/// program gets the library from its compiler; a Rust program is linked without it, and the copy
/// of the function Rust's standard library carries does not survive the release build's
/// link-time optimization, so the app as it ships would not link.
fn link_clang_runtime() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let dir = clang_runtime_dir().expect(
        "clang's runtime library was not found (`clang --print-runtime-dir`); \
         install the Xcode command line tools",
    );
    println!("cargo:rustc-link-search=native={}", dir.display());
    println!("cargo:rustc-link-lib=static={CLANG_RUNTIME}");
}

/// The part of clang's runtime library built for macOS, `libclang_rt.osx.a`.
const CLANG_RUNTIME: &str = "clang_rt.osx";

/// The folder holding clang's runtime libraries, if clang has one with the macOS library in it.
fn clang_runtime_dir() -> Option<PathBuf> {
    let output = Command::new("clang")
        .arg("--print-runtime-dir")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let dir = PathBuf::from(String::from_utf8(output.stdout).ok()?.trim());
    dir.join(format!("lib{CLANG_RUNTIME}.a"))
        .is_file()
        .then_some(dir)
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
