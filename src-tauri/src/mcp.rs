//! Workspace MCP tools: lint_deck validates a workspace-relative deck, open_file queues a
//! request in the current workspace session for the app to show a file, and render_slide
//! asks the app, the same way, for images of slides (see render.rs). set_narration_audio
//! makes an audio file the narration of a slide and times its words.
//! Started as `slopslide --lint-mcp [workspace root]`.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::deck;
use crate::error::{Error, Result};
use crate::lint;
use crate::narration;
use crate::render;
use crate::sessions::Sessions;
use crate::voice;

pub const FLAG: &str = "--lint-mcp";
pub const SERVER: &str = "slopslide";
pub const TOOL: &str = "lint_deck";
pub const OPEN_TOOL: &str = "open_file";
pub const RENDER_TOOL: &str = "render_slide";
pub const NARRATION_TOOL: &str = "set_narration_audio";
const OPEN_REQUESTS: &str = "open-requests";
/// Claude Code's rule for every tool of this server, for `--allowedTools`; its tools are
/// named `mcp__slopslide__<tool>`.
pub const CLAUDE_TOOLS: &str = "mcp__slopslide";

/// Whether Claude Code tool `name` is one of this server's. The agent may always use them.
pub fn is_claude_tool(name: &str) -> bool {
    claude_tool(name).is_some()
}

fn claude_tool(name: &str) -> Option<&str> {
    name.strip_prefix(CLAUDE_TOOLS)?
        .strip_prefix("__")
        .filter(|tool| !tool.is_empty())
}

/// The name the chat shows for a tool: this server's tools without the prefix each
/// provider adds (Claude Code's `mcp__slopslide__`, Copilot's `slopslide-`), so they read
/// alike for every provider; other tools as named.
pub fn display_name(name: &str) -> &str {
    claude_tool(name)
        .or_else(|| {
            name.strip_prefix(SERVER)?
                .strip_prefix('-')
                .filter(|tool| !tool.is_empty())
        })
        .unwrap_or(name)
}

const DEFAULT_PROTOCOL: &str = "2024-11-05";

/// Serves requests from stdin until it closes. Locked slides are checked against the deck's
/// current session, where the app records them for the running turn.
pub fn serve(dir: &Path) {
    let sessions = deck::app_home().ok().map(|home| Sessions::new(&home));
    let session = |_: &Path| sessions.as_ref().and_then(|s| s.current(dir));
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(request) => handle(&request, dir, &session),
            Err(e) => Some(error(Value::Null, -32700, &format!("parse error: {e}"))),
        };
        if let Some(response) = response {
            if writeln!(stdout, "{response}")
                .and_then(|_| stdout.flush())
                .is_err()
            {
                break;
            }
        }
    }
}

/// Answers one JSON-RPC message; notifications get no response. `session` finds the workspace's current session.
pub fn handle(
    request: &Value,
    dir: &Path,
    session: &dyn Fn(&Path) -> Option<PathBuf>,
) -> Option<Value> {
    let id = request.get("id")?.clone();
    let result = match request["method"].as_str().unwrap_or("") {
        "initialize" => json!({
            "protocolVersion": request["params"]["protocolVersion"]
                .as_str()
                .unwrap_or(DEFAULT_PROTOCOL),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": SERVER, "version": env!("CARGO_PKG_VERSION") },
        }),
        "ping" => json!({}),
        "tools/list" => json!({ "tools": [{
            "name": TOOL,
            "description": "Lint the deck file (deck.html unless `path` names another): \
                checks that the HTML is well formed (all elements \
                closed, no stray end tags) and follows the deck format (slides are \
                <section class=\"slide\" id=\"…\"> in <main class=\"deck\">, unique kebab-case \
                ids, attached assets exist, images have alt text) and that locked slides \
                (data-locked) are unchanged. Run it after editing the deck and fix every \
                issue it reports.",
            "inputSchema": { "type": "object", "properties": {
                "path": {
                    "type": "string",
                    "description": "The deck file, relative to the workspace root; deck.html when left out.",
                },
            } },
        }, {
            "name": OPEN_TOOL,
            "description": "Show a workspace file in SlopSlide. Use after creating a deck or to show the user another file.",
            "inputSchema": { "type": "object", "properties": {
                "path": { "type": "string", "description": "Workspace-relative file path." }
            }, "required": ["path"] }
        }, {
            "name": RENDER_TOOL,
            "description": format!("See slides of a deck as the app renders them: returns an \
                image of each slide, hidden ones too, with every entrance animation finished, \
                and lists the elements that run past the slide or are cut off by their own \
                box. Use it to check the look after building or reworking slides, instead of \
                a browser or screenshots from the shell. Takes at most {} slides per call.",
                render::MAX_SLIDES),
            "inputSchema": { "type": "object", "properties": {
                "path": {
                    "type": "string",
                    "description": "The deck file, relative to the workspace root; deck.html when left out.",
                },
                "slides": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "The ids of the slides to render.",
                },
            }, "required": ["slides"] }
        }, {
            "name": NARRATION_TOOL,
            "description": "Make an existing audio file (WAV, MP3, M4A/AAC, FLAC, Ogg Vorbis or \
                AIFF) the narration audio of a slide, in place of any it has, then time its \
                words with the speech-to-text model. Returns when each word is said, in seconds \
                into the audio (also kept under the slide in narration/manifest.json). Like a \
                recording, the audio is kept as the slide's whatever its narration script says; \
                the script is not changed. Use it when the user has narration audio made \
                elsewhere. The audio file must be in the workspace: copy it in first if needed.",
            "inputSchema": { "type": "object", "properties": {
                "path": {
                    "type": "string",
                    "description": "The deck file, relative to the workspace root; deck.html when left out.",
                },
                "slide": { "type": "string", "description": "The id of the slide it narrates." },
                "audio": {
                    "type": "string",
                    "description": "The audio file, relative to the workspace root.",
                },
            }, "required": ["slide", "audio"] }
        }]}),
        "tools/call" if request["params"]["name"] == TOOL => {
            let rel = request["params"]["arguments"]["path"]
                .as_str()
                .filter(|p| !p.is_empty())
                .unwrap_or(deck::DECK_FILE);
            let linted = crate::workspace::resolve(dir, rel).and_then(|file| {
                let session = session(&file);
                deck::lint(&file, session.as_deref())
            });
            let (text, failed) = match linted {
                Ok(issues) => (lint::format_report(&issues), false),
                Err(e) => (format!("Could not lint {rel}: {e}"), true),
            };
            json!({ "content": [{ "type": "text", "text": text }], "isError": failed })
        }
        "tools/call" if request["params"]["name"] == OPEN_TOOL => {
            let opened = (|| -> crate::error::Result<String> {
                let rel = request["params"]["arguments"]["path"]
                    .as_str()
                    .filter(|p| !p.is_empty())
                    .ok_or_else(|| crate::error::Error::msg("path is required"))?;
                let file = crate::workspace::open_file(dir, rel)?;
                if file.kind == crate::workspace::FileKind::Directory {
                    return Err(crate::error::Error::msg("expected a file"));
                }
                let session =
                    session(dir).ok_or_else(|| crate::error::Error::msg("no workspace session"))?;
                let inbox = session.join(OPEN_REQUESTS);
                std::fs::create_dir_all(&inbox)?;
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos();
                let name = format!("{stamp:025}-{}", uuid::Uuid::new_v4());
                let temp = inbox.join(format!("{name}.tmp"));
                std::fs::write(&temp, json!({"path": rel}).to_string())?;
                std::fs::rename(temp, inbox.join(format!("{name}.json")))?;
                Ok(format!("Requested opening {rel} in SlopSlide."))
            })();
            let (text, failed) = match opened {
                Ok(text) => (text, false),
                Err(e) => (e.to_string(), true),
            };
            json!({ "content": [{ "type": "text", "text": text }], "isError": failed })
        }
        "tools/call" if request["params"]["name"] == RENDER_TOOL => {
            let rendered = (|| -> crate::error::Result<Vec<Value>> {
                let arguments = &request["params"]["arguments"];
                let rel = arguments["path"]
                    .as_str()
                    .filter(|p| !p.is_empty())
                    .unwrap_or(deck::DECK_FILE);
                crate::workspace::open_file(dir, rel)?;
                let slides: Vec<String> = arguments["slides"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|slide| slide.as_str().map(str::to_string))
                    .collect();
                render::check_slides(&slides)?;
                let session =
                    session(dir).ok_or_else(|| crate::error::Error::msg("no workspace session"))?;
                let slides = render::ask(&session, rel, slides, render::WAIT)?;
                Ok(render_content(&slides))
            })();
            let (content, failed) = match rendered {
                Ok(content) => (content, false),
                Err(e) => (vec![json!({ "type": "text", "text": e.to_string() })], true),
            };
            json!({ "content": content, "isError": failed })
        }
        "tools/call" if request["params"]["name"] == NARRATION_TOOL => {
            let set = deck::app_home()
                .and_then(|home| set_narration_audio(dir, &request["params"]["arguments"], &home));
            let (text, failed) = match set {
                Ok(text) => (text, false),
                Err(e) => (e.to_string(), true),
            };
            json!({ "content": [{ "type": "text", "text": text }], "isError": failed })
        }
        "tools/call" => return Some(error(id, -32602, "unknown tool")),
        method => return Some(error(id, -32601, &format!("method not found: {method}"))),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

/// The speech-to-text model, kept loaded between calls.
static VOICE: std::sync::OnceLock<voice::Voice> = std::sync::OnceLock::new();

/// Makes the workspace file `audio` the narration of `slide` of the deck at `path`
/// (`arguments`), then times its words with the speech-to-text model in `home`; what it did,
/// for the agent.
fn set_narration_audio(dir: &Path, arguments: &Value, home: &Path) -> Result<String> {
    let text = |key: &str| arguments[key].as_str().filter(|v| !v.is_empty());
    let rel = text("path").unwrap_or(deck::DECK_FILE);
    let slide = text("slide").ok_or_else(|| Error::msg("slide is required"))?;
    let audio = text("audio").ok_or_else(|| Error::msg("audio is required"))?;
    let file = crate::workspace::open_file(dir, rel)?;
    let file = PathBuf::from(file.absolute);
    let source = crate::workspace::open_file(dir, audio)?;
    if source.kind == crate::workspace::FileKind::Directory {
        return Err(Error::msg(format!(
            "{audio} is a folder, not an audio file"
        )));
    }
    let deck = deck::load(&file)?;
    if !deck.slides.iter().any(|s| s.id == slide) {
        return Err(Error::msg(format!("{rel} has no slide `{slide}`")));
    }
    let seconds = narration::import_audio(&file, slide, Path::new(&source.absolute))?;
    let kept = narration::audio_file(&file, slide);
    let kept = kept.strip_prefix(dir).unwrap_or(&kept).display();
    let mut out =
        format!("Slide `{slide}` is narrated by {audio} now ({seconds:.1} s, kept as {kept}).");
    let voice = VOICE.get_or_init(voice::Voice::default);
    let slides = [slide.to_string()];
    let timed = tauri::async_runtime::block_on(narration::time_words(
        voice,
        home,
        &file,
        Some(&slides),
        |_| {},
    ));
    match (timed, narration::words(&file, slide)) {
        (Ok(_), Some(words)) if words.is_empty() => out.push_str(" No words are heard in it."),
        (Ok(_), Some(words)) => {
            out.push_str(" When each word is said, in seconds into the audio:");
            for word in words {
                out.push_str(&format!(
                    "\n{:.2}-{:.2} {}",
                    word.start, word.end, word.text
                ));
            }
        }
        (Ok(_), None) => out.push_str(" Its words are not timed."),
        (Err(e), _) => out.push_str(&format!(
            " Its words are not timed: {}. The user can time them in the Narration panel.",
            e.to_string().trim_end_matches('.')
        )),
    }
    Ok(out)
}

/// A tool result for rendered `slides`: what was found on each, followed by its image.
fn render_content(slides: &[render::Rendered]) -> Vec<Value> {
    let mut content = Vec::new();
    for slide in slides {
        content.push(json!({ "type": "text", "text": slide.report() }));
        if let Some(png) = &slide.png {
            content.push(json!({ "type": "image", "data": png, "mimeType": "image/png" }));
        }
    }
    content
}

/// Drain the session inbox. Validate again before forwarding a request to the UI.
pub fn take_open_requests(root: &Path, session: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(session.join(OPEN_REQUESTS)) else {
        return Vec::new();
    };
    let mut requests = Vec::new();
    let mut files: Vec<_> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    for file in files {
        let request = std::fs::read_to_string(&file)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
        let _ = std::fs::remove_file(file);
        if let Some(path) = request.as_ref().and_then(|r| r["path"].as_str()) {
            if crate::workspace::open_file(root, path)
                .is_ok_and(|f| f.kind != crate::workspace::FileKind::Directory)
            {
                requests.push(path.to_string());
            }
        }
    }
    requests
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::html;

    fn temp_deck(html: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("slopslide-mcp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(deck::DECK_FILE), html).unwrap();
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
        assert_eq!(tools.len(), 4);
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
        std::fs::remove_dir_all(dir).unwrap();
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
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn lint_tool_reports_locked_slides_changed_during_a_turn() {
        let html = "<html><body><main class=\"deck\"><section class=\"slide\" id=\"a\" data-locked>A</section></main></body></html>";
        let dir = temp_deck(html);
        deck::guard_locked(&dir.join(deck::DECK_FILE), &dir.join("session")).unwrap();
        std::fs::write(dir.join(deck::DECK_FILE), html.replace(">A<", ">B<")).unwrap();
        let res = call(&dir, "tools/call", json!({"name": TOOL, "arguments": {}}));
        let text = res["result"]["content"][0]["text"].as_str().unwrap();
        assert!(
            text.contains("[locked-slide-changed] (slide `a`)"),
            "{text}"
        );
        std::fs::remove_dir_all(dir).unwrap();
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
        std::fs::remove_dir_all(dir).unwrap();
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
        std::fs::remove_dir_all(dir).unwrap();
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
        std::fs::remove_dir_all(dir).unwrap();
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
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn narrated_deck() -> PathBuf {
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
        let text = res["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("Slide `intro` is narrated by talks/sound/quiet.wav now (1.0 s, kept as narration/intro.wav)."), "{text}");
        assert!(text.ends_with("No words are heard in it."), "{text}");
        let file = dir.join(deck::DECK_FILE);
        assert_eq!(narration::words(&file, "intro"), Some(vec![]));
        let manifest = std::fs::read_to_string(dir.join("narration/manifest.json")).unwrap();
        assert!(manifest.contains("\"recorded\": true"), "{manifest}");

        // Speech without the model is kept, untimed; another deck keeps its audio apart.
        let args =
            json!({"path": "talks/q3.html", "slide": "intro", "audio": "talks/sound/talk.wav"});
        let text = set_narration_audio(&dir, &args, Path::new("/nonexistent")).unwrap();
        assert!(
            text.contains("kept as talks/narration/q3/intro.wav"),
            "{text}"
        );
        assert!(
            text.ends_with("Its words are not timed: Slide intro: The speech model is not downloaded. The user can time them in the Narration panel."),
            "{text}"
        );
        assert_eq!(narration::words(&dir.join("talks/q3.html"), "intro"), None);
        assert_eq!(narration::words(&file, "intro"), Some(vec![]));
        std::fs::remove_dir_all(dir).unwrap();
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
        std::fs::remove_dir_all(dir).unwrap();
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
}
