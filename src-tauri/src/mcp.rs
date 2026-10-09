//! A tiny MCP server (JSON-RPC over stdio) that gives the agent one tool, `lint_deck`, so
//! it can verify deck.html after editing. The agent starts it as
//! `slopslide --lint-mcp [deck dir]`, the deck defaulting to the working directory
//! (see `agent.rs`).

use std::io::{BufRead, Write};
use std::path::Path;

use serde_json::{json, Value};

use crate::deck;
use crate::lint;
use crate::sessions::Sessions;

pub const FLAG: &str = "--lint-mcp";
pub const SERVER: &str = "slopslide";
pub const TOOL: &str = "lint_deck";
/// The name Claude Code gives the tool, for `--allowedTools`.
pub const QUALIFIED_TOOL: &str = "mcp__slopslide__lint_deck";

const DEFAULT_PROTOCOL: &str = "2024-11-05";

/// Serves requests from stdin until it closes. Locked slides are checked against the deck's
/// current session, where the app records them for the running turn.
pub fn serve(dir: &Path) {
    let session = deck::app_home()
        .ok()
        .and_then(|home| Sessions::new(&home).current(dir));
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(request) => handle(&request, dir, session.as_deref()),
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

/// Answers one JSON-RPC message; notifications get no response.
pub fn handle(request: &Value, dir: &Path, session: Option<&Path>) -> Option<Value> {
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
            "description": "Lint deck.html: checks that the HTML is well formed (all elements \
                closed, no stray end tags) and follows the deck format (slides are \
                <section class=\"slide\" id=\"…\"> in <main class=\"deck\">, unique kebab-case \
                ids, attached assets exist, images have alt text) and that locked slides \
                (data-locked) are unchanged. Run it after editing deck.html and fix every \
                issue it reports.",
            "inputSchema": { "type": "object", "properties": {} },
        }]}),
        "tools/call" if request["params"]["name"] == TOOL => {
            let (text, failed) = match deck::lint(dir, session) {
                Ok(issues) => (lint::format_report(&issues), false),
                Err(e) => (format!("Could not lint deck.html: {e}"), true),
            };
            json!({ "content": [{ "type": "text", "text": text }], "isError": failed })
        }
        "tools/call" => return Some(error(id, -32602, "unknown tool")),
        method => return Some(error(id, -32601, &format!("method not found: {method}"))),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_deck(html: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("slopslide-mcp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(deck::DECK_FILE), html).unwrap();
        dir
    }

    fn call(dir: &Path, method: &str, params: Value) -> Value {
        handle(
            &json!({"jsonrpc":"2.0","id":7,"method":method,"params":params}),
            dir,
            Some(&dir.join("session")),
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
            None
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
        assert_eq!(tools.len(), 1);
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
        deck::guard_locked(&dir, &dir.join("session")).unwrap();
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
    fn lint_tool_reports_a_missing_deck_as_an_error() {
        let res = call(
            Path::new("/nonexistent"),
            "tools/call",
            json!({"name": TOOL}),
        );
        assert_eq!(res["result"]["isError"], true);
    }
}
