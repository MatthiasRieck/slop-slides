//! Workspace MCP tools: lint_deck validates a workspace-relative deck and open_file
//! queues a request in the current workspace session for the app to show a file.
//! Started as `slopslide --lint-mcp [workspace root]`.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::deck;
use crate::lint;
use crate::sessions::Sessions;

pub const FLAG: &str = "--lint-mcp";
pub const SERVER: &str = "slopslide";
pub const TOOL: &str = "lint_deck";
pub const OPEN_TOOL: &str = "open_file";
pub const QUALIFIED_OPEN_TOOL: &str = "mcp__slopslide__open_file";
const OPEN_REQUESTS: &str = "open-requests";
/// The name Claude Code gives the tool, for `--allowedTools`.
pub const QUALIFIED_TOOL: &str = "mcp__slopslide__lint_deck";

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
        "tools/call" => return Some(error(id, -32602, "unknown tool")),
        method => return Some(error(id, -32601, &format!("method not found: {method}"))),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
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
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[1]["name"], OPEN_TOOL);
        assert_eq!(tools[0]["name"], TOOL);
        assert_eq!(QUALIFIED_TOOL, format!("mcp__{SERVER}__{TOOL}"));
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
    fn lint_tool_reports_a_missing_deck_as_an_error() {
        let res = call(
            Path::new("/nonexistent"),
            "tools/call",
            json!({"name": TOOL}),
        );
        assert_eq!(res["result"]["isError"], true);
    }
}
