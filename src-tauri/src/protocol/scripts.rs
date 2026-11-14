//! The app's own scripts for a deck page: the pasteboard and the slide editor. A page that
//! wants them gets `<script src>` tags, and the scripts come from a path of their own that
//! carries their version, so the webview fetches and compiles each once for all the pages that
//! use it instead of getting a copy inlined into every page. They never become part of a deck.

use std::sync::LazyLock;

use sha2::{Digest, Sha256};

/// First path segment of the app's scripts: `/.app/<version>/<name>`.
pub(super) const PREFIX: &str = ".app";

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Script {
    pub name: &'static str,
    pub source: &'static str,
}

pub(super) const PASTEBOARD: Script = Script {
    name: "pasteboard.js",
    source: include_str!("../../assets/pasteboard.js"),
};

/// Overflow detection, then the slide editor that builds on it. The editor's source is the files
/// of `assets/editor/`, which build.rs joins in the order of their names.
pub(super) const EDITOR: Script = Script {
    name: "editor.js",
    source: concat!(
        include_str!("../../assets/overflow.js"),
        include_str!(concat!(env!("OUT_DIR"), "/editor.js")),
    ),
};

const ALL: [&Script; 2] = [&PASTEBOARD, &EDITOR];

/// What the scripts of this build are, as a few hex digits: it changes when any of them does.
/// It is the version in their addresses and the build's part of every entity tag.
pub(super) fn version() -> &'static str {
    static VERSION: LazyLock<String> = LazyLock::new(|| {
        let mut hasher = Sha256::new();
        hasher.update(env!("CARGO_PKG_VERSION"));
        for script in ALL {
            hasher.update(script.source);
        }
        hasher.finalize()[..8]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    });
    &VERSION
}

/// The scripts the stage or the show asked for, in the order they run: the editor needs the
/// pasteboard.
pub(super) fn for_query(query: Option<&str>) -> Vec<&'static Script> {
    let editor = super::has_param(query, "edit");
    let mut scripts = Vec::new();
    if editor || super::has_param(query, "pan") || super::has_param(query, "show") {
        scripts.push(&PASTEBOARD);
    }
    if editor {
        scripts.push(&EDITOR);
    }
    scripts
}

/// The tags that load `scripts` from `origin` (scheme and host). They are plain scripts, not
/// deferred or asynchronous ones: each runs where it stands, in order, while the page is still
/// being read, exactly as when its source was inlined there. The pasteboard and the editor start
/// by finding the slide the player has just shown, so they must run after it and before the
/// page's `load`.
pub(super) fn tags(scripts: &[&Script], origin: &str) -> String {
    scripts
        .iter()
        .map(|script| {
            format!(
                "<script src=\"{origin}/{PREFIX}/{}/{}\"></script>\n",
                version(),
                script.name
            )
        })
        .collect()
}

/// The script at `<version>/<name>`. One of another build is not found: its address promised
/// that build's source for good.
pub(super) fn read(rel: &str) -> Option<&'static str> {
    let (asked, name) = rel.split_once('/')?;
    if asked != version() {
        return None;
    }
    ALL.iter()
        .find(|script| script.name == name)
        .map(|script| script.source)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::*;

    #[test]
    fn scripts_only_on_request() {
        assert_eq!(
            for_query(Some("embed&slide=a&edit=abc")),
            [&PASTEBOARD, &EDITOR],
            "the editor builds on the pasteboard"
        );
        assert_eq!(for_query(Some("edit&pan")), [&PASTEBOARD, &EDITOR]);
        assert_eq!(for_query(Some("embed&slide=a&pan")), [&PASTEBOARD]);
        assert_eq!(for_query(Some("v=1&show")), [&PASTEBOARD]);
        assert!(for_query(Some("v=1&shown")).is_empty());
        assert_eq!(for_query(Some("pan=1")), [&PASTEBOARD]);
        assert!(for_query(Some("embed&slide=edit&static")).is_empty());
        assert!(for_query(Some("embed&slide=pan")).is_empty());
        assert!(for_query(Some("editor&panel")).is_empty());
        assert!(for_query(None).is_empty());
    }

    #[test]
    fn tags_load_the_scripts_in_order_by_their_versioned_address() {
        let tags = tags(&[&PASTEBOARD, &EDITOR], "slop://localhost");
        let version = version();
        assert_eq!(
            tags,
            format!(
                "<script src=\"slop://localhost/.app/{version}/pasteboard.js\"></script>\n\
                 <script src=\"slop://localhost/.app/{version}/editor.js\"></script>\n"
            )
        );
        assert!(
            !tags.contains("defer") && !tags.contains("async") && !tags.contains("module"),
            "they run where they stand, as the inlined ones did"
        );
        assert!(version.len() == 16 && version.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn serves_the_scripts_of_this_build_only() {
        let at = |name: &str| read(&format!("{}/{name}", version()));
        assert_eq!(at("pasteboard.js"), Some(PASTEBOARD.source));
        assert_eq!(at("editor.js"), Some(EDITOR.source));
        assert_eq!(at("other.js"), None);
        assert_eq!(read("0000000000000000/editor.js"), None);
        assert_eq!(read("editor.js"), None);
    }

    #[test]
    fn embeds_the_editor_parts_after_overflow_in_the_order_of_their_names() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/editor");
        let mut parts: Vec<PathBuf> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "js"))
            .collect();
        parts.sort();
        assert!(parts.len() > 1, "the editor comes in parts");
        let joined: String = parts
            .iter()
            .map(|p| std::fs::read_to_string(p).unwrap())
            .collect();
        let editor = EDITOR
            .source
            .strip_prefix(include_str!("../../assets/overflow.js"))
            .expect("overflow detection comes first");
        assert_eq!(editor, joined);
        let first = std::fs::read_to_string(&parts[0]).unwrap();
        let last = std::fs::read_to_string(parts.last().unwrap()).unwrap();
        assert!(first.starts_with("/* SlopSlide slide editor."));
        assert!(
            first.trim_end().ends_with("(function () {"),
            "the first part opens the closure"
        );
        assert!(
            last.trim_end().ends_with("})();"),
            "the last part closes it"
        );
        assert!(editor.starts_with(&first) && editor.ends_with(&last));
    }
}
