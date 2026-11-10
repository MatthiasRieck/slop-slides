//! The deck's references to its attached files in `assets/`.

use std::ops::Range;

/// Quoted deck-relative `assets/…` references in document order: the byte range of each
/// reference (including a leading `./`) and the path without query or fragment.
pub fn asset_refs(html: &str) -> Vec<(Range<usize>, &str)> {
    let mut refs = Vec::new();
    let mut at = 0;
    for (pos, _) in html.match_indices("assets/") {
        if pos < at {
            continue;
        }
        let mut start = pos;
        if html[..pos].ends_with("./") {
            start -= 2;
        }
        if !html[..start].ends_with(['"', '\'', '(']) {
            continue;
        }
        let end = html[pos..]
            .find(|c: char| matches!(c, '"' | '\'' | ')' | '?' | '#') || c.is_whitespace())
            .map_or(html.len(), |e| pos + e);
        refs.push((start..end, &html[pos..end]));
        at = end;
    }
    refs
}

/// Replaces deck-relative `assets/…` references with data URIs so the file stands alone.
pub fn inline_assets(
    html: &str,
    mut load: impl FnMut(&str) -> Option<(String, Vec<u8>)>,
) -> String {
    use base64::Engine;
    let mut out = String::with_capacity(html.len());
    let mut at = 0;
    for (range, path) in asset_refs(html) {
        let Some((mime, bytes)) = load(path) else {
            continue;
        };
        out.push_str(&html[at..range.start]);
        out.push_str(&format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ));
        at = range.end;
    }
    out.push_str(&html[at..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inlines_referenced_assets() {
        let html = r#"<img src="assets/a.png"><div style="background:url('./assets/b.jpg')"></div> see assets/a.png"#;
        let out = inline_assets(html, |p| Some(("image/png".into(), p.as_bytes().to_vec())));
        assert!(out.contains(r#"src="data:image/png;base64,"#));
        assert!(out.contains("url('data:image/png;base64,"));
        assert!(
            out.ends_with("see assets/a.png"),
            "bare text is not a reference"
        );
    }

    #[test]
    fn inlines_cropped_css_backgrounds() {
        // Crops are CSS backgrounds with offsets; the same image can back several crops.
        let html = r#"<style>
#title .hero { background: url("assets/photo.png") 0 -1459px / 1920px auto no-repeat; }
#closing .photo { background-image: url("assets/photo.png"); background-position: -619px -1032px; }
</style>"#;
        let out = inline_assets(html, |p| {
            (p == "assets/photo.png").then(|| ("image/png".into(), b"ok".to_vec()))
        });
        assert_eq!(
            out.matches(r#"url("data:image/png;base64,b2s=")"#).count(),
            2,
            "{out}"
        );
        assert!(out.contains(") 0 -1459px / 1920px auto no-repeat;"));
        assert!(out.contains("background-position: -619px -1032px;"));
        assert!(!out.contains("assets/"));
    }

    #[test]
    fn inline_assets_stops_at_query_and_fragment() {
        let html = r##"<img src="assets/a.png?v=2"><use href="assets/icons.svg#star"/>"##;
        let mut seen = Vec::new();
        let out = inline_assets(html, |p| {
            seen.push(p.to_string());
            Some(("x/y".into(), vec![1, 2, 3]))
        });
        assert_eq!(seen, ["assets/a.png", "assets/icons.svg"]);
        assert_eq!(
            out,
            r##"<img src="data:x/y;base64,AQID?v=2"><use href="data:x/y;base64,AQID#star"/>"##
        );
    }

    #[test]
    fn inline_assets_leaves_unloadable_and_unquoted_references() {
        let html =
            r#"<img src="assets/missing.png"><a href=assets/x.png>x</a><img src='assets/ok.png'>"#;
        let out = inline_assets(html, |p| {
            (p == "assets/ok.png").then(|| ("image/png".into(), b"ok".to_vec()))
        });
        assert_eq!(
            out,
            r#"<img src="assets/missing.png"><a href=assets/x.png>x</a><img src='data:image/png;base64,b2s='>"#
        );
    }

    #[test]
    fn inline_assets_ignores_lookalike_paths() {
        let html =
            r#"<img src="myassets/a.png"><img src="/assets/a.png"><img src="../assets/a.png">"#;
        let out = inline_assets(html, |_| Some(("image/png".into(), vec![0])));
        assert_eq!(
            out, html,
            "only deck-relative assets/ references are inlined"
        );
    }
}
