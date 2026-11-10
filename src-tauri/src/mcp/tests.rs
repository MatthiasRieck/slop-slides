use super::narration_tools::{
    generate_narration_audio, narration_beats, narration_timeline, saved, set_narration_audio,
};
use super::tools::export_deck;
use super::*;
use crate::test_support::TempDir;
use crate::{deck, export, html, narration, render, video};

/// A workspace whose deck.html holds `html`; its session is `session/` in it.
fn temp_deck(html: &str) -> TempDir {
    let dir = TempDir::new("mcp");
    dir.write(deck::DECK_FILE, html);
    dir
}

fn call(dir: &Path, method: &str, params: Value) -> Value {
    let session = dir.join("session");
    handle(
        &json!({"jsonrpc":"2.0","id":7,"method":method,"params":params}),
        dir,
        &|_| Some(session.clone()),
    )
    .unwrap()
}

#[test]
fn initializes_with_the_clients_protocol_version() {
    let dir = Path::new("/nonexistent");
    let res = call(dir, "initialize", json!({"protocolVersion":"2025-06-18"}));
    assert_eq!(res["id"], 7);
    assert_eq!(res["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(res["result"]["serverInfo"]["name"], SERVER);
    assert!(res["result"]["capabilities"]["tools"].is_object());
    let res = call(dir, "initialize", json!({}));
    assert_eq!(res["result"]["protocolVersion"], DEFAULT_PROTOCOL);
}

#[test]
fn ignores_notifications_and_rejects_unknown_methods() {
    let dir = Path::new("/nonexistent");
    assert!(handle(
        &json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        dir,
        &|_| None
    )
    .is_none());
    assert_eq!(
        call(dir, "resources/list", json!({}))["error"]["code"],
        -32601
    );
    assert_eq!(
        call(dir, "tools/call", json!({"name":"rm"}))["error"]["code"],
        -32602
    );
    assert_eq!(call(dir, "ping", json!({}))["result"], json!({}));
}

#[test]
fn lists_the_lint_tool() {
    let res = call(Path::new("/nonexistent"), "tools/list", json!({}));
    let tools = res["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 8);
    assert_eq!(tools[7]["name"], EXPORT_TOOL);
    assert_eq!(tools[7]["inputSchema"]["required"], json!(["format"]));
    assert_eq!(
        tools[7]["inputSchema"]["properties"]["format"]["enum"],
        json!(["html", "pdf", "pptx", "video", "images"])
    );
    assert!(crate::agent::SYSTEM_PROMPT.contains(EXPORT_TOOL));
    assert_eq!(tools[4]["name"], TIMELINE_TOOL);
    assert_eq!(tools[5]["name"], BEATS_TOOL);
    assert_eq!(tools[5]["inputSchema"]["required"], json!(["slide"]));
    assert_eq!(tools[6]["name"], GENERATE_TOOL);
    assert_eq!(tools[6]["inputSchema"]["required"], Value::Null);
    for tool in [TIMELINE_TOOL, BEATS_TOOL, GENERATE_TOOL] {
        assert!(crate::agent::SYSTEM_PROMPT.contains(tool), "{tool}");
    }
    assert_eq!(tools[3]["name"], NARRATION_TOOL);
    assert_eq!(
        tools[3]["inputSchema"]["required"],
        json!(["slide", "audio"])
    );
    assert!(crate::agent::SYSTEM_PROMPT.contains(NARRATION_TOOL));
    assert_eq!(tools[2]["name"], RENDER_TOOL);
    assert_eq!(tools[2]["inputSchema"]["required"], json!(["slides"]));
    assert!(crate::agent::SYSTEM_PROMPT.contains(RENDER_TOOL));
    assert_eq!(tools[1]["name"], OPEN_TOOL);
    assert_eq!(tools[0]["name"], TOOL);
    assert_eq!(CLAUDE_TOOLS, format!("mcp__{SERVER}"));
}

#[test]
fn recognizes_its_claude_tool_names() {
    assert!(is_claude_tool("mcp__slopslide__lint_deck"));
    assert!(is_claude_tool("mcp__slopslide__open_file"));
    assert!(is_claude_tool("mcp__slopslide__render_slide"));
    assert!(is_claude_tool("mcp__slopslide__set_narration_audio"));
    assert!(is_claude_tool("mcp__slopslide__narration_timeline"));
    assert!(is_claude_tool("mcp__slopslide__narration_beats"));
    assert!(is_claude_tool("mcp__slopslide__export_deck"));
    assert!(!is_claude_tool("mcp__slopslide__"));
    assert!(!is_claude_tool("mcp__slopslides__lint_deck"));
    assert!(!is_claude_tool("mcp__github__push"));
    assert!(!is_claude_tool("Bash"));
}

#[test]
fn shows_its_tools_alike_for_every_provider() {
    assert_eq!(display_name("mcp__slopslide__lint_deck"), TOOL);
    assert_eq!(display_name("slopslide-lint_deck"), TOOL);
    assert_eq!(display_name("slopslide-open_file"), OPEN_TOOL);
    assert_eq!(display_name("mcp__slopslide__render_slide"), RENDER_TOOL);
    assert_eq!(display_name("slopslide-render_slide"), RENDER_TOOL);
    assert_eq!(
        display_name("slopslide-set_narration_audio"),
        NARRATION_TOOL
    );
    assert_eq!(display_name("lint_deck"), TOOL);
    assert_eq!(display_name("mcp__github__push"), "mcp__github__push");
    assert_eq!(display_name("github-push"), "github-push");
    assert_eq!(display_name("slopslide-"), "slopslide-");
}

#[test]
fn lint_tool_reports_issues_in_the_deck() {
    let dir = temp_deck("<html><body><main class=\"deck\"><section class=\"slide\" id=\"a\"><div></section></main></body></html>");
    let res = call(&dir, "tools/call", json!({"name": TOOL, "arguments": {}}));
    assert_eq!(res["result"]["isError"], false);
    let text = res["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("[unclosed-tag]"), "{text}");
}

#[test]
fn lint_tool_reports_slide_id_styles_for_agent_repair_without_modifying_the_deck() {
    let source = html::ensure_runtime(
        "<!DOCTYPE html><html><head><title>Pitch</title>\n<style>\n#title .card { color: red; }\n</style></head><body><main class=\"deck\"><section class=\"slide\" id=\"title\"><div class=\"card\">AI-KIT</div></section></main></body></html>",
    );
    let dir = temp_deck(&source);
    let report = || {
        let res = call(&dir, "tools/call", json!({"name": TOOL, "arguments": {}}));
        assert_eq!(res["result"]["isError"], false);
        res["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let text = report();
    assert!(
        text.starts_with("The deck has 1 error(s) and 0 warning(s):"),
        "{text}"
    );
    assert!(
        text.contains("error [slide-id-style] (slide `title`)"),
        "{text}"
    );
    assert!(text.contains("reusable layout class"), "{text}");
    assert_eq!(
        std::fs::read_to_string(dir.join(deck::DECK_FILE)).unwrap(),
        source
    );

    let repaired = source
        .replace("class=\"slide\"", "class=\"slide layout-title\"")
        .replace("#title .card", ".layout-title .card");
    std::fs::write(dir.join(deck::DECK_FILE), repaired).unwrap();
    assert_eq!(report(), "The deck passes lint: no issues.");
}

#[test]
fn lint_tool_reports_locked_slides_changed_during_a_turn() {
    let html = "<html><body><main class=\"deck\"><section class=\"slide\" id=\"a\" data-locked>A</section></main></body></html>";
    let dir = temp_deck(html);
    crate::guard::guard_locked(&dir.join(deck::DECK_FILE), &dir.join("session")).unwrap();
    std::fs::write(dir.join(deck::DECK_FILE), html.replace(">A<", ">B<")).unwrap();
    let res = call(&dir, "tools/call", json!({"name": TOOL, "arguments": {}}));
    let text = res["result"]["content"][0]["text"].as_str().unwrap();
    assert!(
        text.contains("[locked-slide-changed] (slide `a`)"),
        "{text}"
    );
}

#[test]
fn lint_tool_lints_the_deck_file_named_by_path() {
    let dir = temp_deck(&html::ensure_runtime(
        "<html><body><main class=\"deck\"></main></body></html>",
    ));
    std::fs::write(dir.join("q3.html"), "<html><body><main class=\"deck\"><section class=\"slide\" id=\"a\"><div></section></main></body></html>").unwrap();
    let text = |args: Value| {
        let res = call(&dir, "tools/call", json!({"name": TOOL, "arguments": args}));
        res["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert!(
        !text(json!({})).contains("[unclosed-tag]"),
        "deck.html by default"
    );
    assert!(text(json!({"path": "q3.html"})).contains("[unclosed-tag]"));
    let res = call(
        &dir,
        "tools/call",
        json!({"name": TOOL, "arguments": {"path": "../x.html"}}),
    );
    assert_eq!(res["result"]["isError"], true, "only files in the folder");
}

#[test]
fn opens_workspace_files_through_the_session_inbox_and_rejects_escapes() {
    let dir = temp_deck("<main class=\"deck\"></main>");
    std::fs::create_dir_all(dir.join("talks")).unwrap();
    std::fs::write(dir.join("talks/q3.html"), "<main class=\"deck\"></main>").unwrap();
    let res = call(
        &dir,
        "tools/call",
        json!({"name":OPEN_TOOL,"arguments":{"path":"talks/q3.html"}}),
    );
    assert_eq!(res["result"]["isError"], false);
    assert_eq!(
        take_open_requests(&dir, &dir.join("session")),
        ["talks/q3.html"]
    );
    assert!(take_open_requests(&dir, &dir.join("session")).is_empty());
    for path in ["../outside.html", "/etc/passwd", "talks", "missing.html"] {
        assert_eq!(
            call(
                &dir,
                "tools/call",
                json!({"name":OPEN_TOOL,"arguments":{"path":path}})
            )["result"]["isError"],
            true
        );
    }
    let res = call(
        &dir,
        "tools/call",
        json!({"name":TOOL,"arguments":{"path":"talks/q3.html"}}),
    );
    assert_eq!(res["result"]["isError"], false);
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(std::env::temp_dir(), dir.join("outside")).unwrap();
        for tool in [TOOL, OPEN_TOOL] {
            assert_eq!(
                call(
                    &dir,
                    "tools/call",
                    json!({"name":tool,"arguments":{"path":"outside"}})
                )["result"]["isError"],
                true
            );
        }
    }
}

#[test]
fn render_tool_returns_what_the_app_rendered_as_images() {
    let dir = temp_deck("<main class=\"deck\"></main>");
    std::fs::create_dir_all(dir.join("talks")).unwrap();
    std::fs::write(dir.join("talks/q3.html"), "<main class=\"deck\"></main>").unwrap();
    let session = dir.join("session");
    let app = {
        let session = session.clone();
        std::thread::spawn(move || loop {
            if let Some((name, request)) = render::take_requests(&session).pop() {
                assert_eq!(request.path, "talks/q3.html");
                assert_eq!(request.slides, ["title", "gone"]);
                let title = render::Rendered {
                    id: "title".into(),
                    png: Some("cG5n".into()),
                    overflow: vec!["<h1> \"Big\" runs past the right edge by 40px".into()],
                };
                let gone = render::Rendered {
                    id: "gone".into(),
                    png: None,
                    overflow: Vec::new(),
                };
                render::answer(&session, &name, &Ok(vec![title, gone])).unwrap();
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        })
    };
    let res = call(
        &dir,
        "tools/call",
        json!({"name": RENDER_TOOL, "arguments": {"path": "talks/q3.html", "slides": ["title", "gone"]}}),
    );
    app.join().unwrap();
    assert_eq!(res["result"]["isError"], false);
    let content = res["result"]["content"].as_array().unwrap();
    assert_eq!(content.len(), 3);
    let text = content[0]["text"].as_str().unwrap();
    assert!(text.contains("slide `title`"), "{text}");
    assert!(text.contains("runs past the right edge by 40px"), "{text}");
    assert_eq!(
        content[1],
        json!({"type": "image", "data": "cG5n", "mimeType": "image/png"})
    );
    assert!(content[2]["text"].as_str().unwrap().contains("no slide"));
}

const TITLED: &str = "<!DOCTYPE html><html><head><title>Q3 Plan</title></head><body><main class=\"deck\"><section class=\"slide\" id=\"a\">A</section></main></body></html>";

#[test]
fn export_tool_writes_standalone_html_itself() {
    let dir = temp_deck(TITLED);
    let res = call(
        &dir,
        "tools/call",
        json!({"name": EXPORT_TOOL, "arguments": {"format": "html"}}),
    );
    assert_eq!(res["result"]["isError"], false, "{res}");
    let text = res["result"]["content"][0]["text"].as_str().unwrap();
    assert!(
        text.starts_with("Exported deck.html as a standalone HTML file to exports/Q3 Plan.html ("),
        "{text}"
    );
    let written = std::fs::read_to_string(dir.join("exports/Q3 Plan.html")).unwrap();
    assert!(written.contains("id=\"a\""), "{written}");
    // Exported again, it is not replaced unless asked.
    let again = call(
        &dir,
        "tools/call",
        json!({"name": EXPORT_TOOL, "arguments": {"format": "html"}}),
    );
    assert_eq!(again["result"]["isError"], true);
    let replaced = call(
        &dir,
        "tools/call",
        json!({"name": EXPORT_TOOL, "arguments": {"format": "html", "overwrite": true}}),
    );
    assert_eq!(replaced["result"]["isError"], false);
}

#[test]
fn export_tool_asks_the_app_for_other_formats() {
    let dir = temp_deck(TITLED);
    let session = dir.join("session");
    let app = {
        let session = session.clone();
        std::thread::spawn(move || {
            let mut seen = Vec::new();
            while seen.len() < 2 {
                for (name, request) in export::take_requests(&session) {
                    export::answer(&session, &name, &Ok(format!("made {}", request.dest))).unwrap();
                    seen.push(request);
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            seen
        })
    };
    let pdf = call(
        &dir,
        "tools/call",
        json!({"name": EXPORT_TOOL, "arguments": {"format": "pdf", "dest": "out/handout"}}),
    );
    assert_eq!(pdf["result"]["content"][0]["text"], "made out/handout.pdf");
    let video = call(
        &dir,
        "tools/call",
        json!({"name": EXPORT_TOOL, "arguments": {"format": "video", "fps": 60, "narration": false}}),
    );
    assert_eq!(video["result"]["isError"], false, "{video}");
    let seen = app.join().unwrap();
    assert_eq!(seen[0].format, export::Format::Pdf);
    assert_eq!(seen[0].video, None);
    assert_eq!(seen[1].dest, "exports/Q3 Plan.mp4");
    assert_eq!(
        seen[1].video,
        Some(video::Options {
            fps: 60,
            narration: false,
            ..narration::timeline::DEFAULTS
        })
    );
}

#[test]
fn export_tool_refuses_bad_requests_without_asking_the_app() {
    let dir = temp_deck(TITLED);
    for (arguments, expected) in [
        (json!({}), "format is required"),
        (json!({"format": "gif"}), "format is one of"),
        (json!({"format": "pdf", "path": "missing.html"}), "missing"),
        (
            json!({"format": "pdf", "dest": "../out.pdf"}),
            "invalid path",
        ),
        (
            json!({"format": "pptx", "dest": "out.pdf"}),
            "is a .pptx file",
        ),
        (
            json!({"format": "video", "fps": 25}),
            "unsupported frame rate",
        ),
        (
            json!({"format": "video", "seconds_per_slide": "long"}),
            "is a number",
        ),
        (json!({"format": "video", "animate": 1}), "true or false"),
        (
            json!({"format": "html", "dest": "deck.html", "overwrite": true}),
            "the deck itself",
        ),
    ] {
        let res = call(
            &dir,
            "tools/call",
            json!({"name": EXPORT_TOOL, "arguments": arguments}),
        );
        assert_eq!(res["result"]["isError"], true, "{arguments}");
        let text = res["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains(expected), "{arguments}: {text}");
    }
    assert!(export::take_requests(&dir.join("session")).is_empty());
}

#[test]
fn without_the_app_an_export_times_out() {
    let dir = temp_deck(TITLED);
    let session = dir.join("session");
    let arguments = json!({"format": "pdf"});
    let error = export_deck(
        &dir,
        &arguments,
        Some(&session),
        std::time::Duration::from_millis(20),
    )
    .unwrap_err();
    assert!(error.to_string().contains("did not finish"), "{error}");
    let error = export_deck(&dir, &arguments, None, export::WAIT).unwrap_err();
    assert_eq!(error.to_string(), "no workspace session");
}

#[test]
fn render_tool_refuses_bad_requests_without_asking_the_app() {
    let dir = temp_deck("<main class=\"deck\"></main>");
    let too_many: Vec<String> = (0..=render::MAX_SLIDES).map(|n| n.to_string()).collect();
    for arguments in [
        json!({"slides": []}),
        json!({}),
        json!({"slides": too_many}),
        json!({"path": "../x.html", "slides": ["a"]}),
        json!({"path": "missing.html", "slides": ["a"]}),
        json!({"path": "/etc/passwd", "slides": ["a"]}),
    ] {
        let res = call(
            &dir,
            "tools/call",
            json!({"name": RENDER_TOOL, "arguments": arguments}),
        );
        assert_eq!(res["result"]["isError"], true, "{arguments}");
    }
    assert!(render::take_requests(&dir.join("session")).is_empty());
}

fn narrated_deck() -> TempDir {
    let dir = temp_deck(
        r#"<main class="deck"><section class="slide" id="intro"><aside class="narration">Hi.</aside></section></main>"#,
    );
    std::fs::create_dir_all(dir.join("talks/sound")).unwrap();
    std::fs::write(
        dir.join("talks/q3.html"),
        r#"<main class="deck"><section class="slide" id="intro"></section></main>"#,
    )
    .unwrap();
    narration::audio::write_wav(&dir.join("talks/sound/quiet.wav"), &[0.0; 16_000], 16_000)
        .unwrap();
    let tone: Vec<f32> = (0..16_000).map(|i| (i as f32 / 20.0).sin() * 0.3).collect();
    narration::audio::write_wav(&dir.join("talks/sound/talk.wav"), &tone, 16_000).unwrap();
    std::fs::write(dir.join("talks/sound/notes.txt"), "not audio").unwrap();
    dir
}

#[test]
fn narration_tool_makes_audio_the_slides_narration_and_times_its_words() {
    let dir = narrated_deck();
    // Silence is timed as no words, with no speech model needed.
    let res = call(
        &dir,
        "tools/call",
        json!({"name": NARRATION_TOOL, "arguments": {"slide": "intro", "audio": "talks/sound/quiet.wav"}}),
    );
    assert_eq!(res["result"]["isError"], false, "{res}");
    assert_eq!(
        text_of(&res),
        "Slide `intro` is narrated by talks/sound/quiet.wav now (1.00 s, kept as narration/intro.wav). \
         It starts as the slide shows (data-narration-start=\"0\"). No words are heard in it. \
         Call narration_timeline for when its words fall on the slides, narration_beats for its beat."
    );
    let file = dir.join(deck::DECK_FILE);
    let deck = deck::load(&file).unwrap();
    assert_eq!(deck.slides[0].narration_start, Some(0.0));
    assert_eq!(
        deck.slides[0].duration, None,
        "its length is left as it was"
    );
    assert_eq!(narration::words(&file, "intro"), Some(vec![]));
    let manifest = std::fs::read_to_string(dir.join("narration/manifest.json")).unwrap();
    assert!(manifest.contains("\"recorded\": true"), "{manifest}");

    // Speech without the model is kept, untimed; another deck keeps its audio apart.
    let args = json!({"path": "talks/q3.html", "slide": "intro", "audio": "talks/sound/talk.wav"});
    let text = set_narration_audio(&dir, &args, Path::new("/nonexistent"), None).unwrap();
    assert_eq!(
        text,
        "Slide `intro` is narrated by talks/sound/talk.wav now (1.00 s, kept as talks/narration/q3/intro.wav). \
         It starts as the slide shows (data-narration-start=\"0\"). Its words are not timed: Slide intro: \
         The speech model is not downloaded. The user can time them in the Narration panel. \
         Call narration_timeline for when its words fall on the slides, narration_beats for its beat."
    );
    assert_eq!(narration::words(&dir.join("talks/q3.html"), "intro"), None);
    assert_eq!(narration::words(&file, "intro"), Some(vec![]));
}

#[test]
fn narration_tool_leaves_a_locked_slides_audio_alone() {
    let dir = temp_deck(
        r#"<main class="deck"><section class="slide" id="intro" data-locked><aside class="narration">Hi.</aside></section></main>"#,
    );
    narration::audio::write_wav(&dir.join("quiet.wav"), &[0.0; 16_000], 16_000).unwrap();
    let res = call(
        &dir,
        "tools/call",
        json!({"name": NARRATION_TOOL, "arguments": {"slide": "intro", "audio": "quiet.wav"}}),
    );
    assert_eq!(res["result"]["isError"], true, "{res}");
    assert_eq!(
        text_of(&res),
        "The slide `intro` is locked; unlock it to change its narration."
    );
    // Nothing was replaced: no audio, no manifest, no pinned start.
    assert!(!dir.join("narration").exists());
    let deck = deck::load(&dir.join(deck::DECK_FILE)).unwrap();
    assert_eq!(deck.slides[0].narration_start, None);
}

#[test]
fn narration_tool_replaces_the_users_own_recording_only_when_asked() {
    let dir = narrated_deck();
    let file = dir.join(deck::DECK_FILE);
    let take: Vec<f32> = (0..8_000).map(|i| (i as f32 / 30.0).sin() * 0.2).collect();
    narration::append_recording(&file, "intro", &take, 16_000).unwrap();
    let recording = std::fs::read(narration::audio_file(&file, "intro")).unwrap();
    let args = json!({"name": NARRATION_TOOL, "arguments": {"slide": "intro", "audio": "talks/sound/quiet.wav"}});
    let res = call(&dir, "tools/call", args.clone());
    assert_eq!(res["result"]["isError"], true, "{res}");
    assert_eq!(
        text_of(&res),
        "The slide `intro` is narrated by the user's own recording, which would be lost. Ask the user first; call again with replace: true to replace it."
    );
    assert_eq!(
        std::fs::read(narration::audio_file(&file, "intro")).unwrap(),
        recording,
        "the take is kept"
    );
    // Asked to, it replaces it; audio brought in before is replaced without asking.
    let mut replace = args.clone();
    replace["arguments"]["replace"] = json!(true);
    let res = call(&dir, "tools/call", replace);
    assert_eq!(res["result"]["isError"], false, "{res}");
    assert_eq!(
        narration::refusal(&file, "intro", None, false).unwrap(),
        None,
        "no recording of the user's is left"
    );
    let res = call(&dir, "tools/call", args);
    assert_eq!(res["result"]["isError"], false, "{res}");
}

#[test]
fn timing_data_saved_for_a_slide_stays_in_the_sessions_timing_folder() {
    let session = TempDir::new("saved");
    let data = json!({"beats": []});
    // Slide ids are written by the agent; none may lead out of the folder or name a stream
    // (`:` on Windows) or a folder (`/`, `\`).
    for id in ["../../escape", "a/b", "a\\b", "c:x", "intro"] {
        let text = saved(
            Some(session.path()),
            "talks/deck.html",
            &format!("beats-{id}"),
            &data,
        );
        assert!(!text.contains("could not be saved"), "{id}: {text}");
    }
    let names: Vec<String> = std::fs::read_dir(session.join("timing"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names.len(), 5, "{names:?}");
    assert!(names.contains(&"talks_deck.html.beats-intro.json".to_string()));
    assert!(names
        .iter()
        .all(|n| n.starts_with("talks_deck.html.") && n.ends_with(".json")));
    assert!(!session.parent().unwrap().join("escape.json").exists());
}

/// `seconds` of a kick drum at 120 BPM, at `rate`.
fn drums(seconds: f64, rate: u32) -> Vec<f32> {
    (0..(seconds * f64::from(rate)) as usize)
        .map(|i| {
            let t = i as f64 / f64::from(rate);
            let since = t % 0.5;
            ((-since * 25.0).exp()
                * (std::f64::consts::TAU * (50.0 + 120.0 * (-since * 40.0).exp()) * t).sin()
                * 0.8) as f32
        })
        .collect()
}

fn text_of(res: &Value) -> String {
    res["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .to_string()
}

/// A deck whose short first slide `song` has 8 s of drums that play on over `verse`.
fn song_deck() -> TempDir {
    let dir = temp_deck(concat!(
        r#"<main class="deck">"#,
        r#"<section class="slide" id="song" data-duration="2"></section>"#,
        r#"<section class="slide" id="verse" data-duration="10"></section>"#,
        r#"<section class="slide" id="outro"><aside class="narration">Bye.</aside></section>"#,
        r#"</main>"#,
    ));
    narration::audio::write_wav(&dir.join("song.wav"), &drums(8.0, 22_050), 22_050).unwrap();
    let args = json!({"slide": "song", "audio": "song.wav"});
    set_narration_audio(&dir, &args, Path::new("/nonexistent"), None).unwrap();
    dir
}

#[test]
fn timeline_tool_places_slides_narration_and_words_on_the_show() {
    let dir = song_deck();
    // Words as the model timed them.
    let manifest = dir.join("narration/manifest.json");
    let json = std::fs::read_to_string(&manifest).unwrap().replace(
        "\"recorded\": true",
        r#""recorded": true, "timing": 3, "words": [{"text": "One,", "start": 1.0, "end": 1.4}, {"text": "two.", "start": 3.25, "end": 3.5}]"#,
    );
    std::fs::write(&manifest, json).unwrap();
    let res = call(
        &dir,
        "tools/call",
        json!({"name": TIMELINE_TOOL, "arguments": {}}),
    );
    assert_eq!(res["result"]["isError"], false, "{res}");
    let saved = dir
        .join("session")
        .join("timing")
        .join("deck.html.timeline.json");
    let intro = "How deck.html plays in a video export and the self-running show, in seconds from \
        its start. What a slide does not pin follows the app's default export settings: a slide \
        shows at least 5 s, its narration starts 0.5 s in and the slide stays 1 s after it; the \
        user may export with others, so pin `data-duration` and `data-narration-start` on slides \
        you time to narration. A narration never talks over the one before it: it waits. An \
        animation on a slide starts as the slide shows, so its delay is the time into that slide.\n";
    let slides = "
1. `song` shows 0.00–2.00 (2.00 s, pinned)
   narration (imported audio, 8.00 s) plays 0.00–8.00, starting 0.00 s into the slide (pinned); plays on over `verse`
2. `verse` shows 2.00–12.00 (10.00 s, pinned)
3. `outro` shows 12.00–17.00 (5.00 s, default)
   narration script without up-to-date audio: the user has it spoken in the Narration panel (an export does it first); until then its timing is unknown";
    let words = "

Words of `song`'s narration: start–end in the show, then the slide showing at the start and the seconds into it.
1.00–1.40 song +1.00 One,
3.25–3.50 verse +1.25 two.";
    let json_at = format!(
        "\n\nThe same as JSON, for your scripts to read rather than copy: {}",
        saved.display()
    );
    assert_eq!(text_of(&res), format!("{intro}{slides}{words}{json_at}"));
    // The same as JSON in the session, for scripts (see narration::timeline for its data).
    let data: Value = serde_json::from_str(&std::fs::read_to_string(&saved).unwrap()).unwrap();
    let file = dir.join(deck::DECK_FILE);
    let deck = deck::load(&file).unwrap();
    assert_eq!(
        data,
        narration::timeline::timeline(&file, &deck, true).data("deck.html")
    );
    assert_eq!(
        data["words"][1],
        json!({"audio": "song", "text": "two.", "start": 3.25, "end": 3.5, "slide": "verse", "intoSlide": 1.25})
    );
    // Without words, just the slides.
    let res = call(
        &dir,
        "tools/call",
        json!({"name": TIMELINE_TOOL, "arguments": {"words": false}}),
    );
    assert_eq!(text_of(&res), format!("{intro}{slides}{json_at}"));
    let res = call(
        &dir,
        "tools/call",
        json!({"name": TIMELINE_TOOL, "arguments": {"path": "nope.html"}}),
    );
    assert_eq!(res["result"]["isError"], true);
}

#[test]
fn timeline_tool_says_why_words_are_not_timed() {
    let dir = song_deck();
    let text = narration_timeline(&dir, &json!({}), Path::new("/nonexistent"), None).unwrap();
    assert!(
        text.contains("Words of `song`'s narration: not timed (Slide song: The speech model is not downloaded; the user can time them in the Narration panel)."),
        "{text}"
    );
}

#[test]
fn beats_tool_finds_the_beat_on_the_show() {
    let dir = song_deck();
    let res = call(
        &dir,
        "tools/call",
        json!({"name": BEATS_TOOL, "arguments": {"slide": "song"}}),
    );
    assert_eq!(res["result"]["isError"], false, "{res}");
    let text = text_of(&res);
    // Joined part by part, as the tool does: the text names the path with the platform's
    // separators.
    let saved = dir
        .join("session")
        .join("timing")
        .join("deck.html.beats-song.json");
    let data: Value = serde_json::from_str(&std::fs::read_to_string(&saved).unwrap()).unwrap();
    let beats = data["beats"].as_array().unwrap();
    let header = format!(
        "Slide `song`'s narration has a beat of {:.1} BPM (one every 0.50 s), {} beats. Each: \
         when it falls in the show (as narration_timeline counts), the slide showing then and \
         the seconds into it, how strong its onset is (0 to 1, 1 the strongest), and bar.beat: \
         bars of four, beat 1 their downbeat, found from the accents and shifting where the \
         music does (bar 0 is before the first downbeat).",
        data["tempo"].as_f64().unwrap(),
        beats.len()
    );
    let mut lines = text.lines();
    assert_eq!(lines.next(), Some(header.as_str()), "{text}");
    assert_eq!(lines.clone().count(), beats.len() + 2, "{text}");
    assert_eq!(
        lines.last().unwrap_or_default(),
        format!(
            "The same as JSON, for your scripts to read rather than copy: {}",
            saved.display()
        )
    );
    // Beats after the first slide fall on `verse`, counted from its start.
    let line = text
        .lines()
        .find(|l| l.starts_with("2.50 "))
        .unwrap_or_default();
    assert!(line.starts_with("2.50 verse +0.50 "), "{text}");
    // Each ends in its bar and beat.
    assert!(
        line.rsplit(' ').next().is_some_and(|b| b.contains('.')),
        "{line}"
    );
    // The saved data is the beats placed on the show (see narration::beats for them).
    let file = dir.join(deck::DECK_FILE);
    let deck = deck::load(&file).unwrap();
    let narration::beats::SlideBeat::Found(found) =
        narration::beats::on_show(&file, &deck, "song").unwrap()
    else {
        panic!("no beat");
    };
    assert_eq!(data, found.data("deck.html", "song"));

    // Silence has no beat.
    narration::audio::write_wav(&dir.join("quiet.wav"), &[0.0; 16_000 * 4], 16_000).unwrap();
    let args = json!({"slide": "outro", "audio": "quiet.wav"});
    set_narration_audio(&dir, &args, Path::new("/nonexistent"), None).unwrap();
    let text = narration_beats(&dir, &json!({"slide": "outro"}), None).unwrap();
    assert_eq!(text, "No beat is heard in slide `outro`'s narration.");

    for (arguments, why) in [
        (json!({}), "slide is required"),
        (
            json!({"slide": "chorus"}),
            "deck.html has no slide `chorus`",
        ),
        (
            json!({"slide": "verse"}),
            "slide `verse` has no up-to-date narration audio that plays",
        ),
    ] {
        let res = call(
            &dir,
            "tools/call",
            json!({"name": BEATS_TOOL, "arguments": arguments}),
        );
        assert_eq!(res["result"]["isError"], true, "{arguments}");
        assert_eq!(text_of(&res), why, "{arguments}");
    }
}

#[test]
fn narration_tool_refuses_what_it_cannot_use() {
    let dir = narrated_deck();
    for (arguments, why) in [
        (
            json!({"audio": "talks/sound/quiet.wav"}),
            "slide is required",
        ),
        (json!({"slide": "intro"}), "audio is required"),
        (
            json!({"slide": "outro", "audio": "talks/sound/quiet.wav"}),
            "deck.html has no slide `outro`",
        ),
        (
            json!({"slide": "intro", "audio": "talks/sound/missing.wav"}),
            "missing: talks/sound/missing.wav",
        ),
        (
            json!({"slide": "intro", "audio": "../outside.wav"}),
            "invalid path",
        ),
        (
            json!({"slide": "intro", "audio": "/etc/hosts"}),
            "invalid path",
        ),
        (
            json!({"slide": "intro", "audio": "talks/sound"}),
            "is a folder",
        ),
        (
            json!({"slide": "intro", "audio": "talks/sound/notes.txt"}),
            "is no usable audio",
        ),
        (
            json!({"path": "missing.html", "slide": "intro", "audio": "talks/sound/quiet.wav"}),
            "missing.html",
        ),
    ] {
        let res = call(
            &dir,
            "tools/call",
            json!({"name": NARRATION_TOOL, "arguments": arguments}),
        );
        assert_eq!(res["result"]["isError"], true, "{arguments}");
        let text = res["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains(why), "{arguments}: {text}");
    }
    assert!(!dir.join("narration").exists(), "nothing was kept");
}

fn speaking_deck() -> TempDir {
    temp_deck(
        r#"<main class="deck">
<section class="slide" id="intro" data-locked><aside class="narration">Hi.</aside></section>
<section class="slide" id="plain"><h1>No script</h1></section>
<section class="slide" id="own"><aside class="narration">Mine.</aside></section>
<section class="slide" id="talk"><aside class="narration">Say this.</aside></section>
</main>"#,
    )
}

#[test]
fn generate_tool_reports_slides_it_leaves_alone_without_an_api_key() {
    let dir = speaking_deck();
    let file = dir.join(deck::DECK_FILE);
    let take: Vec<f32> = (0..8_000).map(|i| (i as f32 / 30.0).sin() * 0.2).collect();
    narration::append_recording(&file, "own", &take, 16_000).unwrap();
    // `talk` is locked in the turn's guard, though the turn unlocked it since.
    let session = dir.join("session");
    std::fs::create_dir_all(&session).unwrap();
    let html = std::fs::read_to_string(&file).unwrap();
    let locked = html.replace(r#"id="talk">"#, r#"id="talk" data-locked>"#);
    std::fs::write(&file, &locked).unwrap();
    crate::guard::guard_locked(&file, &session).unwrap();
    std::fs::write(&file, &html).unwrap();
    let res = call(
        &dir,
        "tools/call",
        json!({"name": GENERATE_TOOL, "arguments": {"slides": ["intro", "plain", "own", "talk"]}}),
    );
    assert_eq!(res["result"]["isError"], false, "{res}");
    assert_eq!(
        text_of(&res),
        "Narration audio of deck.html: 0 slides said.
- `intro`: locked, its audio is left as it was
- `plain`: has no narration script; nothing to say
- `own`: keeps the user's own recording (0.50 s)
- `talk`: locked, its audio is left as it was

Call narration_timeline for when its words fall on the slides."
    );
    assert!(
        !narration::audio_file(&file, "intro").exists(),
        "a locked slide gets no audio"
    );
}

#[test]
fn generate_tool_needs_an_api_key_to_say_a_script() {
    if std::env::var_os("OPENAI_API_KEY").is_some() {
        return;
    }
    let dir = speaking_deck();
    let file = dir.join(deck::DECK_FILE);
    // Every slide, as when `slides` is left out: `talk` has a script to say.
    let err = generate_narration_audio(&dir, &json!({}), Path::new("/nonexistent"), None)
        .unwrap_err()
        .to_string();
    assert_eq!(
        err,
        "Generating the narration audio failed: Add your OpenAI API key in the Narration tab first."
    );
    assert!(!narration::audio_file(&file, "talk").exists());
}

#[test]
fn generate_tool_refuses_what_it_cannot_use() {
    let dir = speaking_deck();
    for (arguments, why) in [
        (json!({"slides": ["gone"]}), "deck.html has no slide `gone`"),
        (json!({"slides": []}), "slides is empty"),
        (json!({"slides": "talk"}), "slides is a list of slide ids"),
        (json!({"slides": [3]}), "slides is a list of slide ids"),
        (json!({"path": "../x.html"}), "invalid path"),
        (json!({"path": "missing.html"}), "missing.html"),
    ] {
        let res = call(
            &dir,
            "tools/call",
            json!({"name": GENERATE_TOOL, "arguments": arguments}),
        );
        assert_eq!(res["result"]["isError"], true, "{arguments}");
        assert!(
            text_of(&res).contains(why),
            "{arguments}: {}",
            text_of(&res)
        );
    }
    assert!(!dir.join("narration").exists(), "nothing was said");
}

#[test]
fn lint_tool_reports_a_missing_deck_as_an_error() {
    let res = call(
        Path::new("/nonexistent"),
        "tools/call",
        json!({"name": TOOL}),
    );
    assert_eq!(res["result"]["isError"], true);
}
