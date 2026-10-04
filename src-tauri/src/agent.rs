//! Drives Claude Code headless (`claude -p --output-format stream-json`) inside a deck
//! folder, one process per turn, resuming the deck's session between turns. Stream events
//! are normalized into [`AgentEvent`]s and emitted to the frontend as `agent-event`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::watch;

use crate::deck::{self, INTERNAL_DIR};
use crate::env;
use crate::error::{Error, Result};

const SYSTEM_PROMPT: &str = include_str!("../prompts/system.md");
/// The agent edits files only: no shell, no MCP servers.
const TOOLS: &str = "Read,Write,Edit,Glob,Grep,WebSearch,WebFetch";
const STDERR_LIMIT: usize = 16 * 1024;

#[derive(Default)]
pub struct AgentManager {
    running: Mutex<HashMap<String, watch::Sender<bool>>>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AgentEvent {
    Started { session_id: Option<String> },
    Thinking,
    TextStart,
    TextDelta { text: String },
    ToolUse { id: String, name: String, input: Value },
    ToolResult { id: String, is_error: bool },
    Result { is_error: bool, text: Option<String>, cost_usd: Option<f64>, duration_ms: Option<u64> },
    Error { message: String },
    Finished { interrupted: bool },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope<'a> {
    deck_id: &'a str,
    event: &'a AgentEvent,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendArgs {
    pub deck_id: String,
    pub prompt: String,
    pub model: Option<String>,
}

impl AgentManager {
    pub fn is_running(&self, deck_id: &str) -> bool {
        self.running.lock().unwrap().contains_key(deck_id)
    }

    pub fn send(&self, app: AppHandle, args: SendArgs) -> Result<()> {
        let dir = deck::deck_dir(&app, &args.deck_id)?;
        let claude = env::resolve_claude().ok_or_else(|| {
            Error::msg(
                "Claude Code was not found. Install it from https://claude.com/claude-code, \
                 or set SLOPSLIDE_CLAUDE_PATH to the `claude` executable.",
            )
        })?;
        let (cancel_tx, cancel_rx) = watch::channel(false);
        {
            let mut running = self.running.lock().unwrap();
            if running.contains_key(&args.deck_id) {
                return Err(Error::msg("The agent is still working on this deck."));
            }
            running.insert(args.deck_id.clone(), cancel_tx);
        }
        tauri::async_runtime::spawn(async move {
            let turn = Turn { app: app.clone(), deck_id: args.deck_id.clone(), dir, claude };
            let interrupted = turn.run(&args.prompt, args.model.as_deref(), cancel_rx).await;
            app.state::<AgentManager>().running.lock().unwrap().remove(&args.deck_id);
            turn.emit(&AgentEvent::Finished { interrupted });
        });
        Ok(())
    }

    pub fn interrupt(&self, deck_id: &str) {
        if let Some(tx) = self.running.lock().unwrap().get(deck_id) {
            let _ = tx.send(true);
        }
    }
}

struct Turn {
    app: AppHandle,
    deck_id: String,
    dir: PathBuf,
    claude: PathBuf,
}

enum Outcome {
    Done,
    Interrupted,
    ResumeFailed,
}

impl Turn {
    fn emit(&self, event: &AgentEvent) {
        let _ = self.app.emit("agent-event", Envelope { deck_id: &self.deck_id, event });
    }

    /// Returns whether the turn was interrupted.
    async fn run(&self, prompt: &str, model: Option<&str>, mut cancel: watch::Receiver<bool>) -> bool {
        let session = deck::read_session(&self.dir);
        let mut outcome = self.run_once(prompt, model, session.as_deref(), &mut cancel).await;
        if matches!(outcome, Ok(Outcome::ResumeFailed)) {
            // The stored session is gone (other machine, cleared history): start fresh.
            let _ = deck::write_session(&self.dir, None);
            outcome = self.run_once(prompt, model, None, &mut cancel).await;
        }
        match outcome {
            Ok(Outcome::Interrupted) => true,
            Ok(_) => false,
            Err(e) => {
                self.emit(&AgentEvent::Error { message: e.to_string() });
                false
            }
        }
    }

    async fn run_once(
        &self,
        prompt: &str,
        model: Option<&str>,
        session: Option<&str>,
        cancel: &mut watch::Receiver<bool>,
    ) -> Result<Outcome> {
        let system_prompt = self.dir.join(INTERNAL_DIR).join("system-prompt.md");
        std::fs::write(&system_prompt, SYSTEM_PROMPT)?;

        let mut cmd = Command::new(&self.claude);
        cmd.args(build_args(&system_prompt, model, session))
            .current_dir(&self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

        let mut child = cmd
            .spawn()
            .map_err(|e| Error::msg(format!("Could not start Claude Code ({}): {e}", self.claude.display())))?;
        self.emit(&AgentEvent::Started { session_id: session.map(str::to_string) });

        let mut stdin = child.stdin.take().expect("piped stdin");
        stdin.write_all(prompt.as_bytes()).await?;
        drop(stdin);

        let mut stderr = child.stderr.take().expect("piped stderr");
        let stderr_task = tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = (&mut stderr).take(STDERR_LIMIT as u64).read_to_end(&mut buf).await;
            // Keep draining so the child never blocks on a full pipe.
            let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
            String::from_utf8_lossy(&buf).into_owned()
        });

        let mut lines = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
        let mut saw_init = false;
        let mut result_text = None;
        loop {
            tokio::select! {
                line = lines.next_line() => {
                    let Some(line) = line? else { break };
                    let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
                    if let Some(id) = session_id_of_init(&value) {
                        saw_init = true;
                        deck::write_session(&self.dir, Some(&id))?;
                        self.emit(&AgentEvent::Started { session_id: Some(id) });
                    }
                    if session.is_some() && !saw_init && is_missing_session(&value) {
                        let _ = child.kill().await;
                        return Ok(Outcome::ResumeFailed);
                    }
                    for event in parse_line(&value) {
                        if let AgentEvent::Result { text, .. } = &event {
                            result_text = text.clone();
                        }
                        self.emit(&event);
                    }
                }
                _ = cancel.changed() => {
                    let _ = child.kill().await;
                    return Ok(Outcome::Interrupted);
                }
            }
        }

        let status = child.wait().await?;
        let stderr = stderr_task.await.unwrap_or_default();
        if session.is_some() && !saw_init && stderr.contains(MISSING_SESSION) {
            return Ok(Outcome::ResumeFailed);
        }
        if !status.success() && result_text.is_none() {
            let detail = stderr.trim();
            let detail = if detail.is_empty() { format!("exit status {status}") } else { detail.to_string() };
            return Err(Error::msg(format!("Claude Code stopped unexpectedly: {detail}")));
        }
        Ok(Outcome::Done)
    }
}

fn build_args(system_prompt: &Path, model: Option<&str>, session: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        "acceptEdits",
        "--strict-mcp-config",
        "--tools",
        TOOLS,
        "--allowedTools",
        TOOLS,
        "--append-system-prompt-file",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    args.push(system_prompt.to_string_lossy().into_owned());
    if let Some(model) = model.filter(|m| !m.is_empty()) {
        args.extend(["--model".into(), model.into()]);
    }
    if let Some(session) = session {
        args.extend(["--resume".into(), session.into()]);
    }
    args
}

const MISSING_SESSION: &str = "No conversation found";

fn is_missing_session(value: &Value) -> bool {
    value["type"] == "result"
        && value["errors"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|e| e.as_str().is_some_and(|e| e.contains(MISSING_SESSION)))
}

fn session_id_of_init(value: &Value) -> Option<String> {
    (value["type"] == "system" && value["subtype"] == "init")
        .then(|| value["session_id"].as_str().map(str::to_string))
        .flatten()
}

/// Maps one Claude Code stream-json line to UI events. Unknown lines map to nothing.
fn parse_line(value: &Value) -> Vec<AgentEvent> {
    // Events from nested agents are not shown.
    if !value["parent_tool_use_id"].is_null() {
        return Vec::new();
    }
    match value["type"].as_str() {
        Some("stream_event") => {
            let event = &value["event"];
            match (event["type"].as_str(), event["content_block"]["type"].as_str(), event["delta"]["type"].as_str()) {
                (Some("content_block_start"), Some("text"), _) => vec![AgentEvent::TextStart],
                (Some("content_block_start"), Some("thinking"), _) => vec![AgentEvent::Thinking],
                (Some("content_block_delta"), _, Some("text_delta")) => event["delta"]["text"]
                    .as_str()
                    .map(|text| vec![AgentEvent::TextDelta { text: text.to_string() }])
                    .unwrap_or_default(),
                _ => Vec::new(),
            }
        }
        Some("assistant") => content_blocks(value)
            .filter(|block| block["type"] == "tool_use")
            .map(|block| AgentEvent::ToolUse {
                id: block["id"].as_str().unwrap_or_default().to_string(),
                name: block["name"].as_str().unwrap_or_default().to_string(),
                input: block["input"].clone(),
            })
            .collect(),
        Some("user") => content_blocks(value)
            .filter(|block| block["type"] == "tool_result")
            .map(|block| AgentEvent::ToolResult {
                id: block["tool_use_id"].as_str().unwrap_or_default().to_string(),
                is_error: block["is_error"].as_bool().unwrap_or(false),
            })
            .collect(),
        Some("result") => vec![AgentEvent::Result {
            is_error: value["is_error"].as_bool().unwrap_or(false) || value["subtype"] != "success",
            text: value["result"].as_str().map(str::to_string),
            cost_usd: value["total_cost_usd"].as_f64(),
            duration_ms: value["duration_ms"].as_u64(),
        }],
        _ => Vec::new(),
    }
}

fn content_blocks(value: &Value) -> impl Iterator<Item = &Value> {
    value["message"]["content"].as_array().into_iter().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_text_stream() {
        let start = json!({"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}});
        let delta = json!({"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}});
        assert_eq!(parse_line(&start), vec![AgentEvent::TextStart]);
        assert_eq!(parse_line(&delta), vec![AgentEvent::TextDelta { text: "Hi".into() }]);
    }

    #[test]
    fn parses_tools_and_results() {
        let tool = json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"/d/slides/01.html"}}]}});
        let result = json!({"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}});
        let done = json!({"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0.02,"duration_ms":1200});
        assert!(matches!(&parse_line(&tool)[0], AgentEvent::ToolUse { name, .. } if name == "Write"));
        assert_eq!(parse_line(&result), vec![AgentEvent::ToolResult { id: "t1".into(), is_error: false }]);
        assert!(matches!(&parse_line(&done)[0], AgentEvent::Result { is_error: false, .. }));
    }

    #[test]
    fn detects_missing_session() {
        let missing = json!({"type":"result","subtype":"error_during_execution","is_error":true,"errors":["No conversation found with session ID: x"]});
        assert!(is_missing_session(&missing));
        assert!(!is_missing_session(&json!({"type":"result","subtype":"success"})));
    }

    #[test]
    fn reads_session_from_init() {
        let init = json!({"type":"system","subtype":"init","session_id":"abc"});
        assert_eq!(session_id_of_init(&init).as_deref(), Some("abc"));
        assert_eq!(session_id_of_init(&json!({"type":"system","subtype":"status"})), None);
    }
}
