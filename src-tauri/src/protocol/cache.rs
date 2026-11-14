//! What a response says about keeping it: how long the webview may reuse it, the tag it asks
//! again by, and which part of a file it wanted.
//!
//! Whether a webview's cache honours any of this for a custom scheme is up to the platform, so
//! every answer here is right whether it does or not: nothing is called unchanging that could
//! change under the same address.

use std::fs::Metadata;
use std::ops::Range;
use std::time::UNIX_EPOCH;

/// Where a served resource comes from, which decides whether its address names its content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Origin {
    /// The app's own scripts, whose address carries the build's version of them.
    App,
    /// A file as of a commit.
    Commit,
    /// Anything that can change in place: the workspace's files, templates, session files.
    Live,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CachePolicy {
    /// The address names the content: keep it for good and never ask again.
    Immutable,
    /// Keep it, but ask each time whether it changed (answered with 304 when it did not).
    Revalidate,
    /// Nothing to ask again by: never keep it.
    NoStore,
}

impl CachePolicy {
    pub fn header(self) -> &'static str {
        match self {
            CachePolicy::Immutable => "public, max-age=31536000, immutable",
            CachePolicy::Revalidate => "no-cache",
            CachePolicy::NoStore => "no-store",
        }
    }
}

/// How a response may be kept. A `v=` in the query pins a file of a commit, which the frontend
/// asks for by the commit's hash. It pins nothing else: for a workspace file `v` is whatever
/// made the frame load again (a counter that starts over with the app, or a hash that leaves
/// out the other slides and the assets), so those are asked about each time instead, by `tag`.
pub(super) fn cache_policy(origin: Origin, query: Option<&str>, tagged: bool) -> CachePolicy {
    let versioned = super::param(query, "v").is_some_and(|v| !v.is_empty());
    match origin {
        Origin::App => CachePolicy::Immutable,
        Origin::Commit if versioned => CachePolicy::Immutable,
        _ if tagged => CachePolicy::Revalidate,
        _ => CachePolicy::NoStore,
    }
}

/// The entity tag of a file as it is on disk: when it was last written and how long it is.
/// `build` goes in because what is served is made from the file by this build of the app.
pub(super) fn file_tag(build: &str, meta: &Metadata) -> Option<String> {
    let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some(format!(
        "\"{build}-{:x}-{:x}\"",
        modified.as_nanos(),
        meta.len()
    ))
}

/// The entity tag of something named by `version` (a commit, the build itself).
pub(super) fn version_tag(build: &str, version: &str) -> String {
    format!("\"{build}-{version}\"")
}

/// Whether an `If-None-Match` header names `tag`, so the webview's copy is still good.
pub(super) fn matches(if_none_match: Option<&str>, tag: &str) -> bool {
    if_none_match.is_some_and(|header| {
        header
            .split(',')
            .map(|candidate| candidate.trim().trim_start_matches("W/"))
            .any(|candidate| candidate == "*" || candidate == tag)
    })
}

/// What a `Range` header asks for of `len` bytes.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Ranged {
    /// These bytes.
    Part(Range<u64>),
    /// Nothing that is there: answered with 416.
    Unsatisfiable,
    /// No single range of bytes (none asked for, several, or another unit): the whole file.
    Whole,
}

/// Reads `bytes=<first>-<last>`, `bytes=<first>-` and `bytes=-<last n>`.
pub(super) fn parse_range(header: Option<&str>, len: u64) -> Ranged {
    let Some(spec) = header.and_then(|h| h.trim().strip_prefix("bytes=")) else {
        return Ranged::Whole;
    };
    let Some((first, last)) = spec.split_once('-') else {
        return Ranged::Whole;
    };
    let (first, last) = (first.trim(), last.trim());
    if spec.contains(',') {
        return Ranged::Whole;
    }
    let range = match (first.parse::<u64>(), last.parse::<u64>()) {
        (Ok(first), Ok(last)) if first <= last => first..last.saturating_add(1).min(len),
        (Ok(first), Err(_)) if last.is_empty() => first..len,
        (Err(_), Ok(suffix)) if first.is_empty() => len.saturating_sub(suffix)..len,
        _ => return Ranged::Whole,
    };
    if range.start >= range.end {
        return Ranged::Unsatisfiable;
    }
    Ranged::Part(range)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_content_named_by_its_address_is_kept_for_good() {
        use CachePolicy::*;
        assert_eq!(cache_policy(Origin::App, None, false), Immutable);
        assert_eq!(
            cache_policy(Origin::Commit, Some("embed&slide=a&v=abc123&static"), true),
            Immutable
        );
        assert_eq!(
            cache_policy(Origin::Commit, None, true),
            Revalidate,
            "a committed asset is asked for without a version"
        );
        assert_eq!(cache_policy(Origin::Commit, Some("v="), true), Revalidate);
        assert_eq!(
            cache_policy(Origin::Live, Some("embed&slide=a&v=1f.2e.0"), true),
            Revalidate,
            "a frame's version is no promise about the file"
        );
        assert_eq!(cache_policy(Origin::Live, Some("v=3"), true), Revalidate);
        assert_eq!(cache_policy(Origin::Live, None, true), Revalidate);
        assert_eq!(cache_policy(Origin::Live, Some("v=3"), false), NoStore);
        assert_eq!(
            cache_policy(Origin::Live, Some("vv=3&nv=1"), false),
            NoStore
        );
    }

    #[test]
    fn policies_have_their_headers() {
        assert_eq!(
            CachePolicy::Immutable.header(),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(CachePolicy::Revalidate.header(), "no-cache");
        assert_eq!(CachePolicy::NoStore.header(), "no-store");
    }

    #[test]
    fn a_file_tag_follows_the_file_and_the_build() {
        let dir = crate::test_support::TempDir::new("tag");
        let file = dir.join("a.png");
        std::fs::write(&file, "one").unwrap();
        let first = file_tag("b1", &std::fs::metadata(&file).unwrap()).unwrap();
        assert!(
            first.starts_with("\"b1-") && first.ends_with("-3\""),
            "{first}"
        );
        assert_eq!(
            file_tag("b1", &std::fs::metadata(&file).unwrap()).unwrap(),
            first
        );
        assert_ne!(
            file_tag("b2", &std::fs::metadata(&file).unwrap()).unwrap(),
            first
        );
        std::fs::write(&file, "longer").unwrap();
        assert_ne!(
            file_tag("b1", &std::fs::metadata(&file).unwrap()).unwrap(),
            first
        );
    }

    #[test]
    fn matches_any_of_the_tags_asked_about() {
        assert!(matches(Some("\"a\""), "\"a\""));
        assert!(matches(Some("\"x\", W/\"a\""), "\"a\""));
        assert!(matches(Some("*"), "\"a\""));
        assert!(!matches(Some("\"b\""), "\"a\""));
        assert!(!matches(None, "\"a\""));
    }

    #[test]
    fn reads_single_byte_ranges() {
        use Ranged::*;
        assert_eq!(parse_range(Some("bytes=0-3"), 10), Part(0..4));
        assert_eq!(parse_range(Some("bytes=4-"), 10), Part(4..10));
        assert_eq!(parse_range(Some("bytes=-3"), 10), Part(7..10));
        assert_eq!(parse_range(Some("bytes=-30"), 10), Part(0..10));
        assert_eq!(parse_range(Some("bytes=8-99"), 10), Part(8..10));
        assert_eq!(parse_range(Some("bytes=0-0"), 10), Part(0..1));
        assert_eq!(parse_range(Some("bytes=10-"), 10), Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=12-14"), 10), Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=-0"), 10), Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=0-"), 0), Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=5-2"), 10), Whole);
        assert_eq!(parse_range(Some("bytes=0-1,4-5"), 10), Whole);
        assert_eq!(parse_range(Some("items=0-1"), 10), Whole);
        assert_eq!(parse_range(Some("bytes=a-b"), 10), Whole);
        assert_eq!(parse_range(None, 10), Whole);
    }
}
