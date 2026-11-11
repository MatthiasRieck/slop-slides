//! Workspace MCP tools: lint_deck validates a workspace-relative deck, open_file queues a
//! request in the current workspace session for the app to show a file, and render_slide
//! asks the app, the same way, for images of slides (see render.rs). set_narration_audio
//! makes an audio file the narration of a slide and times its words, and
//! generate_narration_audio has the deck's voice say slides' narration scripts. export_deck
//! exports a deck as the Export menu does (see export.rs).
//! Started as `slopslide --lint-mcp [workspace root] [session folder]`. This file speaks the protocol; the
//! tools are in `mcp/tools.rs` and `mcp/narration_tools.rs`.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::sessions::Sessions;

mod narration_tools;
mod tools;

pub use tools::take_open_requests;

pub const FLAG: &str = "--lint-mcp";
pub const SERVER: &str = "slopslide";
pub const TOOL: &str = "lint_deck";
pub const OPEN_TOOL: &str = "open_file";
pub const RENDER_TOOL: &str = "render_slide";
pub const NARRATION_TOOL: &str = "set_narration_audio";
pub const TIMELINE_TOOL: &str = "narration_timeline";
pub const BEATS_TOOL: &str = "narration_beats";
pub const GENERATE_TOOL: &str = "generate_narration_audio";
pub const EXPORT_TOOL: &str = "export_deck";
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

/// What starts this server for a turn in workspace `dir` whose chat is the session `session`,
/// after the executable.
pub fn launch_args(dir: &Path, session: &Path) -> [String; 3] {
    [
        FLAG.into(),
        dir.to_string_lossy().into_owned(),
        session.to_string_lossy().into_owned(),
    ]
}

/// The session the tools work in: the turn's own (`given`, see [`launch_args`]), where the app
/// serves render and export requests and records locked slides while the turn runs. A deck's
/// chat is a session of the deck, not of the workspace, so it cannot be found from `dir`;
/// started without one, the workspace's current session is the best guess.
fn turn_session(given: Option<&Path>, sessions: Option<&Sessions>, dir: &Path) -> Option<PathBuf> {
    given
        .map(Path::to_path_buf)
        .or_else(|| sessions?.current(dir))
}

/// Serves requests from stdin until it closes, for the turn whose session is `given`.
pub fn serve(dir: &Path, given: Option<&Path>) {
    let sessions = crate::files::app_home()
        .ok()
        .map(|home| Sessions::new(&home));
    let session = |_: &Path| turn_session(given, sessions.as_ref(), dir);
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
    narration_tools::shutdown();
}

/// Answers one JSON-RPC message; notifications get no response. `session` finds the turn's session.
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
        "tools/list" => json!({ "tools": tools::definitions() }),
        "tools/call" => {
            let call = tools::Call {
                arguments: &request["params"]["arguments"],
                dir,
                session,
            };
            let name = request["params"]["name"].as_str().unwrap_or_default();
            match tools::call(name, &call) {
                Some(result) => result,
                None => return Some(error(id, -32602, "unknown tool")),
            }
        }
        method => return Some(error(id, -32601, &format!("method not found: {method}"))),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

#[cfg(test)]
mod tests;
