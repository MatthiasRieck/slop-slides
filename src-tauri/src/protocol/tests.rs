use super::*;
use crate::test_support::TempDir;

/// What a request that found `found` is given whole, as a plain GET gets it.
fn read(found: Result<Found, StatusCode>) -> Result<(&'static str, Vec<u8>), StatusCode> {
    let found = found?;
    Ok((found.mime, found.read()?))
}

fn read_in_workspace(
    workspace: &OpenWorkspace,
    path: &str,
) -> Result<(&'static str, Vec<u8>), StatusCode> {
    read(find_in_workspace(workspace, path))
}

fn read_at_head(
    workspace: &OpenWorkspace,
    path: &str,
) -> Result<(&'static str, Vec<u8>), StatusCode> {
    read(find_at_head(workspace, path))
}

fn read_in_session(sessions: &Sessions, path: &str) -> Result<(&'static str, Vec<u8>), StatusCode> {
    read(find_in_session(sessions, path))
}

fn headers(pairs: &[(header::HeaderName, &str)]) -> HeaderMap {
    pairs
        .iter()
        .map(|(name, value)| (name.clone(), value.parse().unwrap()))
        .collect()
}

fn said(answer: &Answer, name: header::HeaderName) -> Option<&str> {
    answer.headers().get(name).map(|v| v.to_str().unwrap())
}

#[test]
fn plain_paths_have_no_way_up() {
    assert!(is_plain_path(Path::new("/a/b/deck.html")));
    assert!(!is_plain_path(Path::new("/a/../b/deck.html")));
}

fn split(raw: &str) -> Result<(String, String), StatusCode> {
    split_path(raw)
}

#[test]
fn file_urls_match_the_frontend_and_round_trip() {
    let url = file_url(
        Path::new("/Users/me/my talks/café/deck.html"),
        "static&print",
    );
    let expected = match cfg!(windows) {
        true => "http://slop.localhost",
        false => "slop://localhost",
    };
    assert_eq!(
        url,
        format!("{expected}/.file/Users/me/my%20talks/caf%C3%A9/deck.html?static&print")
    );
    let path = url
        .split_once("localhost")
        .unwrap()
        .1
        .split('?')
        .next()
        .unwrap();
    assert_eq!(
        split(path),
        Ok((".file".into(), "Users/me/my talks/café/deck.html".into()))
    );
}

#[test]
fn file_urls_take_windows_paths() {
    let url = file_url(Path::new(r"C:\Users\me\deck (1).html"), "print");
    assert!(
        url.ends_with("/.file/C%3A/Users/me/deck%20(1).html?print"),
        "{url}"
    );
}

#[test]
fn file_urls_take_canonical_windows_paths() {
    let url = file_url(Path::new(r"\\?\C:\my talks\café\deck.html"), "static&print");
    assert!(
        url.ends_with("/.file/C%3A/my%20talks/caf%C3%A9/deck.html?static&print"),
        "{url}"
    );
}

#[test]
fn file_urls_preserve_windows_network_roots() {
    for path in [
        r"\\server\share\my talk\deck.html",
        r"\\?\UNC\server\share\my talk\deck.html",
    ] {
        let url = file_url(Path::new(path), "print");
        let raw = url
            .split_once("localhost")
            .unwrap()
            .1
            .split('?')
            .next()
            .unwrap();
        assert_eq!(
            split(raw),
            Ok((".file".into(), "//server/share/my talk/deck.html".into())),
            "{url}"
        );
    }
}

#[cfg(windows)]
#[test]
fn serves_a_file_url_from_a_canonical_windows_workspace() {
    let root = TempDir::new("canonical");
    std::fs::create_dir_all(root.join("my talk")).unwrap();
    let file = root.join("my talk/deck.html");
    std::fs::write(&file, "<html>canonical deck</html>").unwrap();
    let open = OpenWorkspace::default();
    open.set("main", Some(root.canonicalize().unwrap()));
    let url = file_url(&file.canonicalize().unwrap(), "static&print");
    let raw = url
        .split_once("localhost")
        .unwrap()
        .1
        .split('?')
        .next()
        .unwrap();
    let (_, path) = split(raw).unwrap();
    let served = read_in_workspace(&open, &path);
    assert_eq!(
        served,
        Ok((
            "text/html; charset=utf-8",
            b"<html>canonical deck</html>".to_vec()
        ))
    );
}

#[test]
fn print_brings_a_deck_runtime_up_to_date() {
    let bare = b"<html><head></head><body><main class=\"deck\"></main></body></html>".to_vec();
    let printed = String::from_utf8(page_for(Some("static&print"), bare.clone())).unwrap();
    assert!(printed.contains("slopslide:runtime-css"));
    assert!(printed.contains("print-color-adjust: exact"));
    assert!(printed.contains("slopslide:runtime-js"));

    assert_eq!(page_for(Some("static"), bare.clone()), bare);
    assert_eq!(page_for(None, bare.clone()), bare);
}

#[test]
fn only_pages_are_made_ready_for_a_frame() {
    let root = TempDir::new("proto");
    std::fs::write(root.join("a.png"), [1, 2, 3]).unwrap();
    let image = Found::file(root.join("a.png"), "image/png").unwrap();
    let answer = respond(image, Some("print&edit&embed&slide=a"), &HeaderMap::new());
    assert_eq!(answer.body().as_ref(), [1, 2, 3]);
}

const THREE: &str = r#"<!DOCTYPE html><html><head><style>.slide { color: red }</style></head><body>
<main class="deck">
  <section class="slide" id="a"><img src="assets/a.png"></section>
  <section class="slide"><img src="assets/b.png"></section>
  <section class="slide" id="c d"><img src="assets/c.png"></section>
</main>
</body></html>"#;

#[test]
fn a_preview_gets_its_slide_alone() {
    let page = |query: &str| String::from_utf8(page_for(Some(query), THREE.into())).unwrap();
    let pictures = |page: &str| -> Vec<&str> {
        ["a", "b", "c"]
            .into_iter()
            .filter(|name| page.contains(&format!("assets/{name}.png")))
            .collect()
    };
    for (query, shown) in [
        ("embed&slide=a&v=1&static", "a"),
        ("embed&slide=%232&v=1", "b"),
        ("embed&slide=c%20d&v=1&static&pan", "c"),
        ("embed&slide=c+d", "c"),
        ("embed&slide=nope", "a"),
    ] {
        let single = page(query);
        assert_eq!(pictures(&single), [shown], "{query}");
        assert_eq!(
            html::find_slides(&single).len(),
            3,
            "{query}: the other slides keep their place"
        );
        assert!(single.contains("<style>.slide { color: red }</style>"));
    }
    assert_eq!(
        pictures(&page("v=1&show")),
        ["a", "b", "c"],
        "the show plays the whole deck"
    );
    assert_eq!(page("slide=a&v=1"), THREE, "only a preview is cut down");
    assert_eq!(page("embed&v=1"), THREE);
    assert_eq!(page("static&print&v=1").matches("assets/").count(), 3);
}

#[test]
fn the_editor_gets_the_ids_of_the_other_slides_and_a_thumbnail_does_not() {
    let deck = THREE.replace(
        "<img src=\"assets/b.png\">",
        "<img id=\"el-7\" src=\"assets/b.png\">",
    );
    let page = |query: &str| String::from_utf8(page_for(Some(query), deck.clone().into())).unwrap();
    let edited = page("embed&slide=a&v=1&static&pan&edit=0");
    assert!(edited.contains("<section class=\"slide\"><i id=\"el-7\"></i></section>"));
    assert!(!edited.contains("assets/b.png"));
    let thumbnail = page("embed&slide=a&v=1&static");
    assert!(thumbnail.contains("<section class=\"slide\"></section>"));
    assert!(!thumbnail.contains("el-7"));
}

#[test]
fn a_preview_of_one_slide_can_be_printed_and_edited() {
    let page = String::from_utf8(page_for(
        Some("embed&slide=c%20d&v=1&static&print&edit=0"),
        THREE.into(),
    ))
    .unwrap();
    assert!(page.contains("assets/c.png") && !page.contains("assets/a.png"));
    assert!(page.contains("slopslide:runtime-js"));
    let editor = page.find("/editor.js\"></script>").expect("the editor");
    assert!(page.find("slopslide:runtime-js").unwrap() < editor);
    assert!(editor < page.rfind("</body>").unwrap());
}

#[test]
fn reads_query_parameters_as_the_page_does() {
    assert_eq!(
        param(Some("embed&slide=a&v=1"), "slide").as_deref(),
        Some("a")
    );
    assert_eq!(param(Some("slide=%232"), "slide").as_deref(), Some("#2"));
    assert_eq!(
        param(Some("slide=caf%C3%A9+au"), "slide").as_deref(),
        Some("café au")
    );
    assert_eq!(param(Some("slide&v=1"), "slide").as_deref(), Some(""));
    assert_eq!(param(Some("slide="), "slide").as_deref(), Some(""));
    assert_eq!(param(Some("slides=a&v=2"), "slide"), None);
    assert_eq!(
        param(Some("slides=a&slide=b"), "slide").as_deref(),
        Some("b")
    );
    assert_eq!(param(None, "slide"), None);
}

#[test]
fn splits_prefix_and_path() {
    assert_eq!(
        split("/.file/Users/me/talk/deck.html"),
        Ok((".file".into(), "Users/me/talk/deck.html".into()))
    );
    assert_eq!(
        split("/.template/swiss/assets/a.png"),
        Ok((".template".into(), "swiss/assets/a.png".into()))
    );
    assert_eq!(
        split(".session/x/1.png"),
        Ok((".session".into(), "x/1.png".into()))
    );
}

#[test]
fn percent_decodes_like_the_frontend_encodes() {
    // src/lib/utils.ts encodes each segment with encodeURIComponent.
    assert_eq!(
        split("/.file/my%20talks/assets/caf%C3%A9%20photo.png"),
        Ok((".file".into(), "my talks/assets/café photo.png".into()))
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
fn adds_the_script_tags_at_the_end_of_the_body() {
    let html = "<html><body><main class=\"deck\"></main><script>player</script></BODY></html>";
    let out = with_scripts(html, "<script src=\"a.js\"></script>\n");
    assert_eq!(
        out,
        "<html><body><main class=\"deck\"></main><script>player</script><script src=\"a.js\"></script>\n</BODY></html>"
    );
    assert_eq!(
        with_scripts("<p>no body", "<script src=\"a.js\"></script>"),
        "<p>no body<script src=\"a.js\"></script>"
    );
    assert_eq!(
        with_scripts("<body>é</body> </body>", "+"),
        "<body>é</body> +</body>",
        "the last end of a body counts, and other letters are left alone"
    );
}

#[test]
fn a_page_loads_the_apps_scripts_instead_of_carrying_them() {
    let html = "<html><body><main class=\"deck\"></main><script>player</script></body></html>";
    let page = String::from_utf8(page_for(Some("embed&slide=a&edit=0"), html.into())).unwrap();
    let pasteboard = page.find("/pasteboard.js\"></script>").expect("pasteboard");
    let editor = page.find("/editor.js\"></script>").expect("editor");
    assert!(
        page.find("player").unwrap() < pasteboard,
        "after the player"
    );
    assert!(pasteboard < editor, "the editor builds on the pasteboard");
    assert!(editor < page.find("</body>").unwrap());
    assert!(
        page.len() < html.len() + 300,
        "the scripts' source stays out of the page"
    );

    // Each tag's address is one the protocol answers, with the script, for good.
    let address = page[..pasteboard + "/pasteboard.js".len()]
        .rsplit_once("src=\"")
        .unwrap()
        .1;
    let path = address.strip_prefix(origin()).expect("an absolute address");
    let (prefix, rel) = split(path).unwrap();
    assert_eq!(prefix, scripts::PREFIX);
    let answer = respond(find_script(&rel).unwrap(), None, &HeaderMap::new());
    assert_eq!(answer.status(), StatusCode::OK);
    assert_eq!(
        answer.body().as_ref(),
        scripts::PASTEBOARD.source.as_bytes()
    );
    assert_eq!(
        said(&answer, header::CONTENT_TYPE),
        Some("text/javascript; charset=utf-8")
    );
    assert_eq!(
        said(&answer, header::CACHE_CONTROL),
        Some("public, max-age=31536000, immutable")
    );
    assert_eq!(
        find_script("old-build/pasteboard.js").unwrap_err(),
        StatusCode::NOT_FOUND
    );
}

#[test]
fn answers_not_modified_while_a_file_is_as_it_was() {
    let root = TempDir::new("proto");
    let file = root.join("a.png");
    std::fs::write(&file, "image").unwrap();
    let get =
        |asked: &HeaderMap| respond(Found::file(file.clone(), "image/png").unwrap(), None, asked);

    let first = get(&HeaderMap::new());
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(first.body().as_ref(), b"image");
    assert_eq!(said(&first, header::CACHE_CONTROL), Some("no-cache"));
    assert_eq!(said(&first, header::ACCEPT_RANGES), Some("bytes"));
    let tag = said(&first, header::ETAG)
        .expect("a tag to ask again by")
        .to_string();

    let again = get(&headers(&[(header::IF_NONE_MATCH, &tag)]));
    assert_eq!(again.status(), StatusCode::NOT_MODIFIED);
    assert!(again.body().is_empty());
    assert_eq!(said(&again, header::ETAG), Some(tag.as_str()));
    assert_eq!(said(&again, header::CACHE_CONTROL), Some("no-cache"));

    std::fs::write(&file, "another image").unwrap();
    let changed = get(&headers(&[(header::IF_NONE_MATCH, &tag)]));
    assert_eq!(changed.status(), StatusCode::OK);
    assert_eq!(changed.body().as_ref(), b"another image");
    assert_ne!(said(&changed, header::ETAG), Some(tag.as_str()));
}

#[test]
fn a_versioned_frame_is_still_asked_about() {
    // The frame's `v` leaves out the other slides, whose count the page shows (a slide
    // number), so the page is checked against the file each time rather than kept for good.
    let root = TempDir::new("proto");
    let file = root.join("deck.html");
    std::fs::write(&file, THREE).unwrap();
    let query = Some("embed&slide=a&v=abc.def.0&static");
    let get = |asked: &HeaderMap| {
        let found = Found::file(file.clone(), "text/html; charset=utf-8").unwrap();
        respond(found, query, asked)
    };
    let first = get(&HeaderMap::new());
    assert_eq!(said(&first, header::CACHE_CONTROL), Some("no-cache"));
    assert_eq!(
        said(&first, header::ACCEPT_RANGES),
        None,
        "a page comes whole"
    );
    let tag = said(&first, header::ETAG).unwrap().to_string();
    assert_eq!(
        get(&headers(&[(header::IF_NONE_MATCH, &tag)])).status(),
        StatusCode::NOT_MODIFIED
    );
    std::fs::write(
        &file,
        THREE.replace("</main>", "<section class=\"slide\"></section></main>"),
    )
    .unwrap();
    let grown = get(&headers(&[(header::IF_NONE_MATCH, &tag)]));
    assert_eq!(grown.status(), StatusCode::OK);
    assert_eq!(
        html::find_slides(&String::from_utf8_lossy(grown.body())).len(),
        4
    );
}

#[test]
fn serves_the_part_of_a_file_asked_for() {
    let root = TempDir::new("proto");
    let file = root.join("talk.mp3");
    std::fs::write(&file, b"0123456789").unwrap();
    let get = |asked: &[(header::HeaderName, &str)]| {
        respond(
            Found::file(file.clone(), "audio/mpeg").unwrap(),
            None,
            &headers(asked),
        )
    };

    let part = get(&[(header::RANGE, "bytes=2-5")]);
    assert_eq!(part.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(part.body().as_ref(), b"2345");
    assert_eq!(said(&part, header::CONTENT_RANGE), Some("bytes 2-5/10"));
    assert_eq!(said(&part, header::ACCEPT_RANGES), Some("bytes"));
    assert_eq!(said(&part, header::CONTENT_TYPE), Some("audio/mpeg"));

    let rest = get(&[(header::RANGE, "bytes=7-")]);
    assert_eq!(rest.body().as_ref(), b"789");
    assert_eq!(said(&rest, header::CONTENT_RANGE), Some("bytes 7-9/10"));
    let end = get(&[(header::RANGE, "bytes=-4")]);
    assert_eq!(end.body().as_ref(), b"6789");

    let past = get(&[(header::RANGE, "bytes=10-20")]);
    assert_eq!(past.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(said(&past, header::CONTENT_RANGE), Some("bytes */10"));

    let whole = get(&[]);
    assert_eq!(whole.status(), StatusCode::OK);
    assert_eq!(whole.body().as_ref(), b"0123456789");
    let tag = said(&whole, header::ETAG).unwrap().to_string();
    let same = get(&[(header::RANGE, "bytes=0-1"), (header::IF_RANGE, &tag)]);
    assert_eq!(same.status(), StatusCode::PARTIAL_CONTENT);
    let other = get(&[
        (header::RANGE, "bytes=0-1"),
        (header::IF_RANGE, "\"older\""),
    ]);
    assert_eq!(
        other.status(),
        StatusCode::OK,
        "a part of another version is no use"
    );
    assert_eq!(other.body().as_ref(), b"0123456789");

    // Bytes the app holds are served in parts the same way.
    let held = Found {
        mime: "audio/mpeg",
        body: Body::Shared(Arc::from(&b"0123456789"[..])),
        origin: Origin::Commit,
        tag: None,
    };
    let part = respond(held, None, &headers(&[(header::RANGE, "bytes=8-")]));
    assert_eq!(part.body().as_ref(), b"89");
}

/// As the frontend sends it: the absolute path without its leading slash.
fn url_path(path: &Path) -> String {
    let path = path.to_string_lossy().replace('\\', "/");
    path.trim_start_matches('/').to_string()
}

#[test]
fn serves_files_inside_the_open_workspace_only() {
    let root = TempDir::new("proto");
    let ws = root.join("ws");
    std::fs::create_dir_all(ws.join("talk/assets")).unwrap();
    std::fs::write(ws.join("talk/q3.html"), "<html>").unwrap();
    std::fs::write(ws.join("talk/assets/a.svg"), "<svg/>").unwrap();
    std::fs::write(root.join("secret.txt"), "x").unwrap();
    let open = OpenWorkspace::default();
    let read = |path: PathBuf| read_in_workspace(&open, &url_path(&path));

    assert_eq!(
        read(ws.join("talk/q3.html")),
        Err(StatusCode::FORBIDDEN),
        "nothing is served without a workspace"
    );
    open.set("main", Some(ws.clone()));
    assert_eq!(
        read(ws.join("talk/q3.html")),
        Ok(("text/html; charset=utf-8", b"<html>".to_vec()))
    );
    assert_eq!(
        read(ws.join("talk/assets/a.svg")),
        Ok(("image/svg+xml", b"<svg/>".to_vec()))
    );
    assert_eq!(read(ws.join("talk/assets")), Err(StatusCode::NOT_FOUND));
    assert_eq!(
        read(ws.join("talk/missing.png")),
        Err(StatusCode::FORBIDDEN),
        "a missing file is not known to be inside"
    );
    assert_eq!(read(root.join("secret.txt")), Err(StatusCode::FORBIDDEN));
    assert_eq!(
        read(ws.join("talk/../../secret.txt")),
        Err(StatusCode::FORBIDDEN)
    );
}

/// A repository in `root` with everything in it committed.
fn commit_all(root: &Path) {
    for args in [
        &["init", "-q"][..],
        &["add", "-A"],
        &[
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@x.y",
            "commit",
            "-qm",
            "1",
        ],
    ] {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .unwrap()
            .status;
        assert!(status.success());
    }
}

#[test]
fn serves_committed_files_inside_the_open_workspace_only() {
    let root = TempDir::new("proto");
    let ws = root.join("ws");
    std::fs::create_dir_all(ws.join("assets")).unwrap();
    std::fs::write(ws.join("deck.html"), "old").unwrap();
    std::fs::write(ws.join("assets/gone.png"), "image").unwrap();
    std::fs::write(root.join("secret.txt"), "secret").unwrap();
    // The repository takes in more than the workspace: its commit has a file next to it.
    commit_all(&root);
    std::fs::write(ws.join("deck.html"), "new").unwrap();
    std::fs::write(ws.join("ignored.png"), "here only").unwrap();
    std::fs::remove_dir_all(ws.join("assets")).unwrap();
    let open = OpenWorkspace::default();
    let read = |path: PathBuf| read_at_head(&open, &url_path(&path));

    assert_eq!(read(ws.join("deck.html")), Err(StatusCode::FORBIDDEN));
    open.set("main", Some(ws.clone()));
    assert_eq!(
        read(ws.join("deck.html")),
        Ok(("text/html; charset=utf-8", b"old".to_vec()))
    );
    assert_eq!(
        read(ws.join("assets/gone.png")),
        Ok(("image/png", b"image".to_vec())),
        "a file deleted since the commit still shows"
    );
    assert_eq!(
        read(ws.join("ignored.png")),
        Ok(("image/png", b"here only".to_vec())),
        "what the commit does not have comes from the workspace"
    );
    assert_eq!(read(ws.join("missing.png")), Err(StatusCode::FORBIDDEN));
    assert_eq!(read(root.join("secret.txt")), Err(StatusCode::FORBIDDEN));
    assert_eq!(
        read(ws.join("../secret.txt")),
        Err(StatusCode::FORBIDDEN),
        "the commit has it, but it is outside the workspace"
    );
}

#[test]
fn a_committed_file_is_read_once_per_commit_and_kept_by_its_version() {
    let root = TempDir::new("proto");
    let ws = root.join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::write(ws.join("deck.html"), "first").unwrap();
    commit_all(&root);
    let open = OpenWorkspace::default();
    open.set("main", Some(ws.clone()));
    let find = || find_at_head(&open, &url_path(&ws.join("deck.html"))).unwrap();
    let held = |found: &Found| match &found.body {
        Body::Shared(bytes) => bytes.clone(),
        other => panic!("not from the commit: {other:?}"),
    };

    let (first, again) = (find(), find());
    assert_eq!(held(&first).as_ref(), b"first");
    assert!(
        Arc::ptr_eq(&held(&first), &held(&again)),
        "the second request reads nothing from git"
    );
    assert_eq!(first.tag, again.tag);
    let answer = respond(
        first,
        Some("embed&slide=a&v=abc1234&static&print"),
        &HeaderMap::new(),
    );
    assert_eq!(
        said(&answer, header::CACHE_CONTROL),
        Some("public, max-age=31536000, immutable"),
        "a commit's file under the commit's hash never changes"
    );
    let asset = respond(again, None, &HeaderMap::new());
    assert_eq!(said(&asset, header::CACHE_CONTROL), Some("no-cache"));

    std::fs::write(ws.join("deck.html"), "second").unwrap();
    commit_all(&root);
    let next = find();
    assert_eq!(held(&next).as_ref(), b"second", "a new commit is read anew");
    assert_ne!(
        next.tag,
        asset
            .headers()
            .get(header::ETAG)
            .map(|t| t.to_str().unwrap().to_string())
    );
}

#[test]
fn serves_files_inside_sessions_only() {
    let root = TempDir::new("proto");
    let deck = root.join("deck");
    std::fs::create_dir_all(&deck).unwrap();
    std::fs::write(deck.join("deck.html"), "<html>").unwrap();
    let sessions = Sessions::new(&root.join("home"));
    let session = sessions.start(&deck.join("deck.html")).unwrap();
    std::fs::create_dir_all(session.join("sketches")).unwrap();
    std::fs::write(session.join("sketches/1.png"), "png").unwrap();

    assert_eq!(
        read_in_session(&sessions, &url_path(&session.join("sketches/1.png"))),
        Ok(("image/png", b"png".to_vec()))
    );
    assert_eq!(
        read_in_session(&sessions, &url_path(&deck.join("deck.html"))),
        Err(StatusCode::FORBIDDEN),
        "only session files"
    );
    assert_eq!(
        read_in_session(&sessions, &url_path(&session.join("../../deck/deck.html"))),
        Err(StatusCode::FORBIDDEN)
    );
    assert_eq!(
        read_in_session(&sessions, &url_path(&session.join("sketches/missing.png"))),
        Err(StatusCode::FORBIDDEN),
        "a missing file is not known to be inside"
    );
}

#[test]
fn serves_a_template_with_its_runtime_and_a_tag() {
    let root = TempDir::new("proto");
    let builtin = find_in_template(&root, "swiss", "deck.html").unwrap();
    assert_eq!(builtin.mime, "text/html; charset=utf-8");
    assert!(builtin.tag.is_some());
    let answer = respond(builtin, Some("embed&slide=title&static"), &HeaderMap::new());
    assert_eq!(said(&answer, header::CACHE_CONTROL), Some("no-cache"));
    let page = String::from_utf8_lossy(answer.body()).into_owned();
    assert!(page.contains("slopslide:runtime-js"));
    let slides = html::find_slides(&page);
    assert!(slides.len() > 1);
    assert_eq!(
        find_in_template(&root, "nope", "deck.html").unwrap_err(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        find_in_template(&root, "swiss", "assets/logo.svg").unwrap_err(),
        StatusCode::NOT_FOUND
    );
}
