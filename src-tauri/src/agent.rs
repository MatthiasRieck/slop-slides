//! Drives a coding agent CLI headless inside a deck folder, one process per turn, resuming
//! the workspace's session between turns: Claude Code (`claude -p --output-format stream-json`)
//! OpenAI Codex (`codex app-server`), or GitHub Copilot (see [`crate::copilot`]). Stream events are normalized into [`AgentEvent`]s
//! and emitted to the frontend as `agent-event`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::watch;

use crate::deck;
use crate::env;
use crate::error::{Error, Result};
use crate::mcp;
use crate::permissions::{Approval, Approvals, Choices, Decision, PermissionMode};
use crate::sessions::Sessions;
use crate::{codex, copilot};

/// The agent's instructions, with the design reference it consults appended.
pub(crate) const SYSTEM_PROMPT: &str = concat!(
    include_str!("../prompts/system.md"),
    "\n\n",
    include_str!("../prompts/design-reference.md"),
);
/// The agent's tools; no MCP servers but the app's. What runs without asking depends on the
/// permission mode (see [`build_claude_args`]).
const TOOLS: &str = "Read,Write,Edit,Glob,Grep,Bash,WebSearch,WebFetch";
/// Tools that never ask in Ask mode, besides the app's MCP tools. Claude Code itself lets
/// file tools work inside the workspace and asks outside it; the shell always asks.
const ALLOWED_TOOLS: &str = "WebSearch,WebFetch";
const STDERR_LIMIT: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Provider {
    #[default]
    Claude,
    Codex,
    Copilot,
}

impl Provider {
    pub const ALL: [Provider; 3] = [Provider::Claude, Provider::Codex, Provider::Copilot];

    /// File in the workspace's session (see [`crate::sessions`]) holding this provider's
    /// resumable session id.
    pub fn session_file(self) -> &'static str {
        match self {
            Provider::Claude => "claude-session",
            Provider::Codex => "codex-session",
            Provider::Copilot => "copilot-session",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Provider::Claude => "Claude Code",
            Provider::Codex => "Codex",
            Provider::Copilot => "GitHub Copilot",
        }
    }

    fn resolve(self) -> Result<PathBuf> {
        match self {
            Provider::Claude => env::resolve_claude().ok_or_else(|| {
                Error::msg(
                    "Claude Code was not found. Install it from https://claude.com/claude-code, \
                     or set SLOPSLIDE_CLAUDE_PATH to the `claude` executable.",
                )
            }),
            Provider::Codex => env::resolve_codex().ok_or_else(|| {
                Error::msg(
                    "Codex was not found. Install it with `npm i -g @openai/codex` and sign in, \
                     or set SLOPSLIDE_CODEX_PATH to the `codex` executable.",
                )
            }),
            Provider::Copilot => env::resolve_copilot().ok_or_else(|| {
                Error::msg(
                    "GitHub Copilot was not found. Install it with `npm i -g @github/copilot` and \
                     sign in, or set SLOPSLIDE_COPILOT_PATH to the `copilot` executable.",
                )
            }),
        }
    }
}

#[derive(Default)]
pub struct AgentManager {
    running: Mutex<HashMap<String, watch::Sender<bool>>>,
    pub approvals: Arc<Approvals>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AgentEvent {
    ApprovalRequested {
        approval: Approval,
    },
    ApprovalResolved {
        id: String,
    },
    ApprovalReview {
        id: String,
        status: String,
        detail: Option<String>,
    },
    Started {
        session_id: Option<String>,
    },
    Thinking,
    TextStart,
    TextDelta {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        id: String,
        is_error: bool,
    },
    Result {
        is_error: bool,
        text: Option<String>,
        cost_usd: Option<f64>,
        duration_ms: Option<u64>,
    },
    Error {
        message: String,
    },
    /// How full the session's context window is. A `None` field is not known from this
    /// event; the frontend keeps what it knew before.
    Usage {
        context_tokens: Option<u64>,
        context_window: Option<u64>,
    },
    /// The agent started summarizing the conversation to free up context.
    Compacting,
    /// The conversation was summarized; its new size is reported by the next `Usage`.
    Compacted,
    OpenFile {
        path: String,
    },
    Finished {
        interrupted: bool,
    },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope<'a> {
    workspace: &'a str,
    event: &'a AgentEvent,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendArgs {
    pub workspace: String,
    pub prompt: String,
    #[serde(default)]
    pub provider: Provider,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// Claude only: `200k` or `1m`.
    #[serde(default)]
    pub context_window: Option<String>,
    /// Summarize the conversation so far instead of sending `prompt`.
    #[serde(default)]
    pub compact: bool,
    #[serde(default)]
    pub permission_mode: PermissionMode,
}

impl AgentManager {
    pub fn is_running(&self, workspace: &str) -> bool {
        let path = Path::new(workspace)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(workspace));
        self.running.lock().unwrap().keys().any(|key| {
            Path::new(key)
                .canonicalize()
                .unwrap_or_else(|_| PathBuf::from(key))
                == path
        })
    }

    pub fn send(&self, app: AppHandle, args: SendArgs) -> Result<()> {
        let dir = crate::workspace::root(&args.workspace)?;
        let app_home = deck::app_home()?;
        let session_dir = Sessions::new(&app_home).current_or_start(&dir)?;
        let bin = args.provider.resolve()?;
        let (cancel_tx, cancel_rx) = watch::channel(false);
        {
            let mut running = self.running.lock().unwrap();
            if running.contains_key(&args.workspace) {
                return Err(Error::msg("The agent is still working in this workspace."));
            }
            crate::sessions::claim_provider(&session_dir, args.provider)?;
            running.insert(args.workspace.clone(), cancel_tx);
        }
        let approvals = self.approvals.clone();
        tauri::async_runtime::spawn(async move {
            let (emitter, workspace) = (app.clone(), args.workspace.clone());
            let turn = Turn {
                emit: Box::new(move |event| {
                    let _ = emitter.emit(
                        "agent-event",
                        Envelope {
                            workspace: &workspace,
                            event,
                        },
                    );
                }),
                dir,
                app_home,
                session_dir,
                provider: args.provider,
                bin,
                model: args
                    .model
                    .filter(|m| !m.is_empty())
                    .map(|m| match args.provider {
                        Provider::Claude => claude_model(m, args.context_window.as_deref()),
                        _ => m,
                    }),
                effort: args.effort.filter(|e| !e.is_empty()),
                compact: args.compact,
                workspace: args.workspace.clone(),
                permission_mode: args.permission_mode,
                approvals,
            };
            let interrupted = match crate::safety::Guard::start(&turn.dir, &turn.session_dir) {
                Ok(guard) => {
                    let interrupted = turn.run_with_open_requests(&args.prompt, cancel_rx).await;
                    match guard.finish() {
                        Ok(restored) => {
                            for (file, ids) in restored {
                                turn.emit(&AgentEvent::Error {
                                    message: format!("{file}: {}", locked_restored_message(&ids)),
                                });
                            }
                        }
                        Err(e) => turn.emit(&AgentEvent::Error {
                            message: format!(
                                "Could not protect the workspace after this turn: {e}"
                            ),
                        }),
                    }
                    interrupted
                }
                Err(e) => {
                    turn.emit(&AgentEvent::Error {
                        message: format!("Could not protect the workspace before this turn: {e}"),
                    });
                    false
                }
            };
            app.state::<AgentManager>()
                .running
                .lock()
                .unwrap()
                .remove(&args.workspace);
            turn.emit(&AgentEvent::Finished { interrupted });
        });
        Ok(())
    }

    pub fn interrupt(&self, workspace: &str) {
        self.approvals.cancel_workspace(workspace);
        if let Some(tx) = self.running.lock().unwrap().get(workspace) {
            let _ = tx.send(true);
        }
    }
}

/// Tells the user which locked slides the agent changed and the app put back.
fn locked_restored_message(ids: &[String]) -> String {
    let list = ids
        .iter()
        .map(|id| format!("`{id}`"))
        .collect::<Vec<_>>()
        .join(", ");
    format!("The agent changed locked slides; they were put back as they were: {list}.")
}

struct Turn {
    emit: Box<dyn Fn(&AgentEvent) + Send + Sync>,
    /// The workspace root, where the agent works.
    dir: PathBuf,
    /// Where the files every deck's agent shares are written (see [`deck::app_home`]).
    app_home: PathBuf,
    /// The workspace's session this turn belongs to: chat state, snapshots, provider session ids.
    session_dir: PathBuf,
    provider: Provider,
    bin: PathBuf,
    model: Option<String>,
    effort: Option<String>,
    compact: bool,
    workspace: String,
    permission_mode: PermissionMode,
    approvals: Arc<Approvals>,
}

/// The prompt Claude Code runs as its built-in compaction command.
const CLAUDE_COMPACT: &str = "/compact";

pub(crate) enum Outcome {
    Done,
    Interrupted,
    ResumeFailed,
}

impl Turn {
    /// MCP requests use a session inbox, independent of provider-specific tool events.
    async fn run_with_open_requests(&self, prompt: &str, cancel: watch::Receiver<bool>) -> bool {
        let run = self.run(prompt, cancel);
        tokio::pin!(run);
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(100));
        loop {
            tokio::select! {
                interrupted = &mut run => { self.open_requests(); return interrupted; }
                _ = interval.tick() => self.open_requests(),
            }
        }
    }

    fn open_requests(&self) {
        for path in mcp::take_open_requests(&self.dir, &self.session_dir) {
            self.emit(&AgentEvent::OpenFile { path });
        }
    }

    fn emit(&self, event: &AgentEvent) {
        (self.emit)(event);
    }

    /// Returns whether the turn was interrupted.
    async fn run(&self, prompt: &str, mut cancel: watch::Receiver<bool>) -> bool {
        let session_file = self.provider.session_file();
        let session = deck::read_session(&self.session_dir, session_file);
        if self.compact {
            if let Some(message) = compact_refusal(self.provider, session.as_deref()) {
                self.emit(&AgentEvent::Error {
                    message: message.into(),
                });
                return false;
            }
        }
        let mut outcome = self.run_once(prompt, session.as_deref(), &mut cancel).await;
        if self.compact && matches!(outcome, Ok(Outcome::ResumeFailed)) {
            // Starting fresh would leave nothing to compact.
            let _ = deck::write_session(&self.session_dir, session_file, None);
            self.emit(&AgentEvent::Error {
                message: "The conversation could not be resumed, so there is nothing to compact."
                    .into(),
            });
            return false;
        }
        if matches!(outcome, Ok(Outcome::ResumeFailed)) {
            // The stored session is gone (other machine, cleared history): start fresh.
            let _ = deck::write_session(&self.session_dir, session_file, None);
            outcome = self.run_once(prompt, None, &mut cancel).await;
        }
        match outcome {
            Ok(Outcome::Interrupted) => true,
            Ok(_) => false,
            Err(e) => {
                self.emit(&AgentEvent::Error {
                    message: e.to_string(),
                });
                false
            }
        }
    }

    async fn run_once(
        &self,
        prompt: &str,
        session: Option<&str>,
        cancel: &mut watch::Receiver<bool>,
    ) -> Result<Outcome> {
        let model = self.model.as_deref();
        let effort = self.effort.as_deref();
        if self.provider == Provider::Copilot {
            let args = copilot::TurnArgs {
                bin: &self.bin,
                dir: &self.dir,
                lint_server: &std::env::current_exe()?,
                prompt,
                model,
                effort,
                session,
                compact: self.compact,
                workspace: &self.workspace,
                mode: self.permission_mode,
                approvals: self.approvals.clone(),
            };
            let on_session = |id: &str| {
                deck::write_session(&self.session_dir, self.provider.session_file(), Some(id))
            };
            return copilot::run_turn(args, cancel, &|event| self.emit(event), &on_session).await;
        }
        if self.provider == Provider::Codex {
            return codex::run_turn(
                codex::TurnArgs {
                    bin: &self.bin,
                    dir: &self.dir,
                    lint_server: &std::env::current_exe()?,
                    workspace: &self.workspace,
                    prompt,
                    model,
                    effort,
                    session,
                    mode: self.permission_mode,
                    approvals: self.approvals.clone(),
                },
                cancel,
                &|event| self.emit(event),
                &|id| {
                    deck::write_session(&self.session_dir, self.provider.session_file(), Some(id))
                },
            )
            .await;
        }
        // A file rather than an argument: the prompt outgrows Windows command lines.
        let system_prompt = self.app_home.join("system-prompt.md");
        write_if_changed(&system_prompt, SYSTEM_PROMPT)?;
        let mcp_config = self.app_home.join("mcp.json");
        write_if_changed(&mcp_config, &lint_server_config(&std::env::current_exe()?))?;
        let args = build_claude_args(
            &system_prompt,
            &mcp_config,
            &self.session_dir,
            model,
            effort,
            session,
            self.permission_mode,
        );
        let started = Instant::now();

        let mut cmd = Command::new(&self.bin);
        cmd.args(args)
            .current_dir(&self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

        let mut child = cmd.spawn().map_err(|e| {
            Error::msg(format!(
                "Could not start {} ({}): {e}",
                self.provider.name(),
                self.bin.display()
            ))
        })?;
        self.emit(&AgentEvent::Started {
            session_id: session.map(str::to_string),
        });

        // Stream-json input keeps stdin open for answering permission requests; closing it
        // after the result lets Claude Code exit.
        let mut stdin = child.stdin.take();
        let prompt = if self.compact { CLAUDE_COMPACT } else { prompt };
        write_line(stdin.as_mut(), &claude_user_message(prompt)).await?;
        let (run, mut answers) = self.approvals.start(&self.workspace);

        let mut stderr = child.stderr.take().expect("piped stderr");
        let stderr_task = tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = (&mut stderr)
                .take(STDERR_LIMIT as u64)
                .read_to_end(&mut buf)
                .await;
            // Keep draining so the child never blocks on a full pipe.
            let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
            String::from_utf8_lossy(&buf).into_owned()
        });

        let mut lines = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
        let mut saw_init = false;
        let mut result_text = None;
        loop {
            tokio::select! {
                biased;
                Some(answer) = answers.recv() => {
                    let response = claude_control_response(&answer.wire_id, Ok(answer.payload));
                    write_line(stdin.as_mut(), &response).await?;
                    self.emit(&AgentEvent::ApprovalResolved { id: answer.id });
                }
                line = lines.next_line() => {
                    let Some(line) = line? else { break };
                    let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
                    match value["type"].as_str() {
                        Some("control_request") => {
                            let id = &value["request_id"];
                            match claude_permission(&value["request"], self.permission_mode) {
                                ClaudePermission::Answer(reply) => {
                                    write_line(stdin.as_mut(), &claude_control_response(id, reply)).await?;
                                }
                                ClaudePermission::Ask(approval, choices) => {
                                    run.ask(id.clone(), &approval, choices);
                                    self.emit(&AgentEvent::ApprovalRequested { approval });
                                }
                            }
                            continue;
                        }
                        Some("control_cancel_request") => {
                            if let Some(id) = run.resolved(&value["request_id"]) {
                                self.emit(&AgentEvent::ApprovalResolved { id });
                            }
                            continue;
                        }
                        Some("result") => stdin = None,
                        _ => {}
                    }
                    if let Some(id) = session_id_of_init(&value) {
                        saw_init = true;
                        deck::write_session(&self.session_dir, self.provider.session_file(), Some(&id))?;
                        self.emit(&AgentEvent::Started { session_id: Some(id) });
                    }
                    if session.is_some() && !saw_init && is_missing_session(&value) {
                        let _ = child.kill().await;
                        return Ok(Outcome::ResumeFailed);
                    }
                    for mut event in parse_line(&value) {
                        if let AgentEvent::Result { text, duration_ms, .. } = &mut event {
                            result_text = text.clone();
                            duration_ms.get_or_insert(started.elapsed().as_millis() as u64);
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
            let detail = if detail.is_empty() {
                format!("exit status {status}")
            } else {
                detail.to_string()
            };
            return Err(Error::msg(format!(
                "{} stopped unexpectedly: {detail}",
                self.provider.name()
            )));
        }
        Ok(Outcome::Done)
    }
}

/// Why a compaction cannot run, if it cannot: there must be a conversation, and Codex's
/// headless mode has no way to compact one.
fn compact_refusal(provider: Provider, session: Option<&str>) -> Option<&'static str> {
    if provider == Provider::Codex {
        Some("Codex cannot compact the conversation from SlopSlide. Start a new chat instead.")
    } else if session.is_none() {
        Some("There is no conversation to compact yet.")
    } else {
        None
    }
}

/// MCP config running this app binary as the agent's lint tool server (`mcp.rs`). Shared by
/// every deck: the server lints the deck in its working directory, which Claude Code sets
/// to its own (the deck folder).
fn lint_server_config(exe: &Path) -> String {
    serde_json::json!({
        "mcpServers": {
            mcp::SERVER: {
                "type": "stdio",
                "command": exe,
                "args": [mcp::FLAG],
            }
        }
    })
    .to_string()
}

/// Writes `path` unless it already holds `contents`. Turns in other decks may be reading
/// it, so it is replaced whole rather than rewritten in place.
fn write_if_changed(path: &Path, contents: &str) -> Result<()> {
    if std::fs::read_to_string(path).ok().as_deref() == Some(contents) {
        return Ok(());
    }
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, contents)?;
    std::fs::rename(&temp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })?;
    Ok(())
}

/// Claude Code selects the 1M-token context window with a `[1m]` model suffix.
fn claude_model(model: String, context_window: Option<&str>) -> String {
    match context_window {
        Some("1m") if !model.ends_with("[1m]") => format!("{model}[1m]"),
        _ => model,
    }
}

fn build_claude_args(
    system_prompt: &Path,
    mcp_config: &Path,
    session_dir: &Path,
    model: Option<&str>,
    effort: Option<&str>,
    session: Option<&str>,
    mode: PermissionMode,
) -> Vec<String> {
    let permission_mode = match mode {
        PermissionMode::FullAccess => "bypassPermissions",
        _ => "acceptEdits",
    };
    let mut args: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        permission_mode,
        // Requests that would prompt arrive on stdout as `can_use_tool` control requests.
        "--permission-prompt-tool",
        "stdio",
        "--strict-mcp-config",
        "--tools",
        TOOLS,
    ]
    .into_iter()
    .map(String::from)
    .collect();
    args.extend([
        "--allowedTools".into(),
        format!("{ALLOWED_TOOLS},{}", mcp::CLAUDE_TOOLS),
        "--mcp-config".into(),
        mcp_config.to_string_lossy().into_owned(),
        "--append-system-prompt-file".into(),
        system_prompt.to_string_lossy().into_owned(),
        // Sketches and staged templates are in the session, outside the deck.
        "--add-dir".into(),
        session_dir.to_string_lossy().into_owned(),
    ]);
    if let Some(model) = model {
        args.extend(["--model".into(), model.into()]);
    }
    if let Some(effort) = effort {
        args.extend(["--effort".into(), effort.into()]);
    }
    if let Some(session) = session {
        args.extend(["--resume".into(), session.into()]);
    }
    args
}

/// Writes one stream-json line; nothing once stdin is closed.
async fn write_line(stdin: Option<&mut tokio::process::ChildStdin>, value: &Value) -> Result<()> {
    let Some(stdin) = stdin else { return Ok(()) };
    let mut line = serde_json::to_vec(value).expect("serializable JSON");
    line.push(b'\n');
    stdin.write_all(&line).await?;
    stdin.flush().await?;
    Ok(())
}

fn claude_user_message(prompt: &str) -> Value {
    json!({"type": "user", "message": {"role": "user", "content": prompt}})
}

/// Answers control request `id`: `Ok` with the response, `Err` with a refusal.
fn claude_control_response(id: &Value, reply: std::result::Result<Value, &str>) -> Value {
    let response = match reply {
        Ok(response) => json!({"subtype": "success", "request_id": id, "response": response}),
        Err(error) => json!({"subtype": "error", "request_id": id, "error": error}),
    };
    json!({"type": "control_response", "response": response})
}

enum ClaudePermission {
    /// Answered without the user.
    Answer(std::result::Result<Value, &'static str>),
    /// The user decides.
    Ask(Approval, Choices),
}

/// How to answer one Claude Code control request. Only tool permission prompts are
/// handled: the app's MCP tools and everything under Full access are allowed outright,
/// anything else asks the user.
fn claude_permission(request: &Value, mode: PermissionMode) -> ClaudePermission {
    if request["subtype"] != "can_use_tool" {
        return ClaudePermission::Answer(Err("SlopSlide does not support this request."));
    }
    let tool = request["tool_name"].as_str().unwrap_or_default();
    let input = &request["input"];
    let allow = json!({"behavior": "allow", "updatedInput": input});
    if mode == PermissionMode::FullAccess || mcp::is_claude_tool(tool) {
        return ClaudePermission::Answer(Ok(allow));
    }
    let text = |key: &str| input[key].as_str().map(str::to_string);
    let (title, details) = match tool {
        "Bash" => ("Run a command", text("command")),
        "Write" | "Edit" | "NotebookEdit" => ("Change files", text("file_path")),
        "Read" => ("Read files", text("file_path")),
        "Glob" | "Grep" => ("Read files", text("path").or_else(|| text("pattern"))),
        "WebFetch" => ("Network access", text("url")),
        _ => ("Use a tool", None),
    };
    let details = details.unwrap_or_else(|| {
        format!(
            "{tool}\n{}",
            serde_json::to_string_pretty(input).unwrap_or_default()
        )
    });
    let reason = request["description"]
        .as_str()
        .or_else(|| input["description"].as_str())
        .map(str::to_string);
    let mut choices = Choices::from([
        ("accept", allow.clone()),
        (
            "decline",
            json!({"behavior": "deny", "message": "The user declined this request."}),
        ),
    ]);
    let mut decisions = vec![Decision::Accept];
    // Claude Code suggests the rules that would allow requests like this one; kept for the
    // session only, never written to the user's settings.
    let rules: Vec<Value> = request["permission_suggestions"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|rule| {
            let mut rule = rule.clone();
            rule["destination"] = json!("session");
            rule
        })
        .collect();
    if !rules.is_empty() {
        let mut session = allow;
        session["updatedPermissions"] = json!(rules);
        choices.insert("acceptForSession", session);
        decisions.push(Decision::AcceptForSession);
    }
    decisions.push(Decision::Decline);
    ClaudePermission::Ask(Approval::new(title, reason, details, decisions), choices)
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
            match (
                event["type"].as_str(),
                event["content_block"]["type"].as_str(),
                event["delta"]["type"].as_str(),
            ) {
                (Some("content_block_start"), Some("text"), _) => vec![AgentEvent::TextStart],
                (Some("content_block_start"), Some("thinking"), _) => vec![AgentEvent::Thinking],
                (Some("content_block_delta"), _, Some("text_delta")) => event["delta"]["text"]
                    .as_str()
                    .map(|text| {
                        vec![AgentEvent::TextDelta {
                            text: text.to_string(),
                        }]
                    })
                    .unwrap_or_default(),
                _ => Vec::new(),
            }
        }
        Some("assistant") => content_blocks(value)
            .filter(|block| block["type"] == "tool_use")
            .map(|block| AgentEvent::ToolUse {
                id: block["id"].as_str().unwrap_or_default().to_string(),
                name: mcp::display_name(block["name"].as_str().unwrap_or_default()).to_string(),
                input: block["input"].clone(),
            })
            .chain(
                claude_context_tokens(&value["message"]["usage"]).map(|tokens| AgentEvent::Usage {
                    context_tokens: Some(tokens),
                    context_window: None,
                }),
            )
            .collect(),
        Some("system") => match value["subtype"].as_str() {
            Some("status") if value["status"] == "compacting" => vec![AgentEvent::Compacting],
            Some("compact_boundary") => vec![AgentEvent::Compacted],
            _ => Vec::new(),
        },
        Some("user") => content_blocks(value)
            .filter(|block| block["type"] == "tool_result")
            .map(|block| AgentEvent::ToolResult {
                id: block["tool_use_id"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                is_error: block["is_error"].as_bool().unwrap_or(false),
            })
            .collect(),
        Some("result") => {
            let mut events = vec![AgentEvent::Result {
                is_error: value["is_error"].as_bool().unwrap_or(false)
                    || value["subtype"] != "success",
                text: value["result"].as_str().map(str::to_string),
                cost_usd: value["total_cost_usd"].as_f64(),
                duration_ms: value["duration_ms"].as_u64(),
            }];
            // Only the result says how large the window is. Background calls to smaller
            // models are listed too, so take the largest.
            let window = value["modelUsage"]
                .as_object()
                .into_iter()
                .flat_map(|models| models.values())
                .filter_map(|model| model["contextWindow"].as_u64())
                .max();
            if window.is_some() {
                events.push(AgentEvent::Usage {
                    context_tokens: None,
                    context_window: window,
                });
            }
            events
        }
        _ => Vec::new(),
    }
}

/// Tokens in the context after one model call: everything it read plus what it wrote,
/// which the next call reads back.
fn claude_context_tokens(usage: &Value) -> Option<u64> {
    let input = usage["input_tokens"].as_u64()?;
    Some(
        input
            + usage["cache_creation_input_tokens"].as_u64().unwrap_or(0)
            + usage["cache_read_input_tokens"].as_u64().unwrap_or(0)
            + usage["output_tokens"].as_u64().unwrap_or(0),
    )
}

fn content_blocks(value: &Value) -> impl Iterator<Item = &Value> {
    value["message"]["content"].as_array().into_iter().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_model_adds_1m_suffix() {
        assert_eq!(
            claude_model("claude-opus-5-5".into(), Some("1m")),
            "claude-opus-5-5[1m]"
        );
        assert_eq!(
            claude_model("claude-opus-5-5[1m]".into(), Some("1m")),
            "claude-opus-5-5[1m]"
        );
        assert_eq!(
            claude_model("claude-sonnet-5".into(), Some("200k")),
            "claude-sonnet-5"
        );
        assert_eq!(
            claude_model("claude-haiku-4-5".into(), None),
            "claude-haiku-4-5"
        );
    }

    #[test]
    fn parses_text_stream() {
        let start = json!({"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}});
        let delta = json!({"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}});
        assert_eq!(parse_line(&start), vec![AgentEvent::TextStart]);
        assert_eq!(
            parse_line(&delta),
            vec![AgentEvent::TextDelta { text: "Hi".into() }]
        );
    }

    #[test]
    fn parses_tools_and_results() {
        let tool = json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"/d/slides/01.html"}}]}});
        let result = json!({"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}});
        let done = json!({"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0.02,"duration_ms":1200});
        assert!(
            matches!(&parse_line(&tool)[0], AgentEvent::ToolUse { name, .. } if name == "Write")
        );
        assert_eq!(
            parse_line(&result),
            vec![AgentEvent::ToolResult {
                id: "t1".into(),
                is_error: false
            }]
        );
        assert!(matches!(
            &parse_line(&done)[0],
            AgentEvent::Result {
                is_error: false,
                ..
            }
        ));
    }

    #[test]
    fn parses_context_usage() {
        let assistant = json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":9,"cache_creation_input_tokens":7662,"cache_read_input_tokens":12313,"output_tokens":4}}});
        assert_eq!(
            parse_line(&assistant),
            vec![AgentEvent::Usage {
                context_tokens: Some(19988),
                context_window: None
            }]
        );
        let tool = json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}],"usage":{"input_tokens":100}}});
        assert!(matches!(
            &parse_line(&tool)[..],
            [
                AgentEvent::ToolUse { .. },
                AgentEvent::Usage {
                    context_tokens: Some(100),
                    ..
                }
            ]
        ));
        let nested = json!({"type":"assistant","parent_tool_use_id":"t1","message":{"content":[],"usage":{"input_tokens":5}}});
        assert!(
            parse_line(&nested).is_empty(),
            "sub-agents have their own context"
        );
        let no_usage =
            json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[]}});
        assert!(parse_line(&no_usage).is_empty());

        let result = json!({"type":"result","subtype":"success","is_error":false,"result":"ok","modelUsage":{
            "claude-haiku-4-5-20251001":{"contextWindow":200000},
            "claude-opus-5-5":{"contextWindow":1000000}
        }});
        assert_eq!(
            parse_line(&result)[1..],
            [AgentEvent::Usage {
                context_tokens: None,
                context_window: Some(1_000_000)
            }]
        );
        let bare = json!({"type":"result","subtype":"success","is_error":false,"result":"ok"});
        assert_eq!(parse_line(&bare).len(), 1, "no window, no usage event");
    }

    #[test]
    fn parses_compaction() {
        let status = |status: Value| json!({"type":"system","subtype":"status","status":status});
        assert_eq!(
            parse_line(&status(json!("compacting"))),
            vec![AgentEvent::Compacting]
        );
        assert!(parse_line(&status(Value::Null)).is_empty());
        let boundary = json!({"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"auto","pre_tokens":20018,"post_tokens":1512}});
        assert_eq!(parse_line(&boundary), vec![AgentEvent::Compacted]);
        let init = json!({"type":"system","subtype":"init","session_id":"s"});
        assert!(parse_line(&init).is_empty());
    }

    #[test]
    fn refuses_compaction_it_cannot_run() {
        assert_eq!(compact_refusal(Provider::Claude, Some("s")), None);
        assert_eq!(compact_refusal(Provider::Copilot, Some("s")), None);
        assert!(compact_refusal(Provider::Claude, None).is_some());
        assert!(compact_refusal(Provider::Copilot, None).is_some());
        assert!(compact_refusal(Provider::Codex, Some("s"))
            .unwrap()
            .starts_with("Codex cannot compact"));
    }

    #[test]
    fn names_the_locked_slides_it_put_back() {
        assert_eq!(
            locked_restored_message(&["intro".into(), "plan".into()]),
            "The agent changed locked slides; they were put back as they were: `intro`, `plan`."
        );
    }

    #[test]
    fn send_args_compact_defaults_to_off() {
        let args: SendArgs =
            serde_json::from_value(json!({"workspace":"d","prompt":"hi","provider":"claude"}))
                .unwrap();
        assert!(!args.compact);
        let args: SendArgs = serde_json::from_value(
            json!({"workspace":"d","prompt":"/compact","provider":"copilot","compact":true}),
        )
        .unwrap();
        assert!(args.compact);
    }

    #[test]
    fn serializes_usage_events_in_camel_case() {
        let usage = AgentEvent::Usage {
            context_tokens: Some(12),
            context_window: None,
        };
        assert_eq!(
            serde_json::to_value(&usage).unwrap(),
            json!({"type":"usage","contextTokens":12,"contextWindow":null})
        );
        assert_eq!(
            serde_json::to_value(&AgentEvent::Compacted).unwrap(),
            json!({"type":"compacted"})
        );
    }

    #[test]
    fn detects_missing_session() {
        let missing = json!({"type":"result","subtype":"error_during_execution","is_error":true,"errors":["No conversation found with session ID: x"]});
        assert!(is_missing_session(&missing));
        assert!(!is_missing_session(
            &json!({"type":"result","subtype":"success"})
        ));
    }

    #[test]
    fn reads_session_from_init() {
        let init = json!({"type":"system","subtype":"init","session_id":"abc"});
        assert_eq!(session_id_of_init(&init).as_deref(), Some("abc"));
        assert_eq!(
            session_id_of_init(&json!({"type":"system","subtype":"status"})),
            None
        );
    }

    #[test]
    fn parses_thinking_and_ignores_other_stream_events() {
        let thinking = json!({"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"thinking"}}});
        assert_eq!(parse_line(&thinking), vec![AgentEvent::Thinking]);
        for ignored in [
            json!({"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use"}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{"}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta"}}}),
            json!({"type":"stream_event","event":{"type":"message_stop"}}),
            json!({"type":"system","subtype":"init","session_id":"abc"}),
            json!({"type":"something_new"}),
            json!({}),
            json!("just a string"),
        ] {
            assert_eq!(parse_line(&ignored), vec![], "{ignored}");
        }
    }

    #[test]
    fn hides_events_from_nested_agents() {
        let nested = json!({"type":"assistant","parent_tool_use_id":"t0","message":{"content":[{"type":"tool_use","id":"t9","name":"Read","input":{}}]}});
        assert_eq!(parse_line(&nested), vec![]);
        let nested_text = json!({"type":"stream_event","parent_tool_use_id":"t0","event":{"type":"content_block_start","content_block":{"type":"text"}}});
        assert_eq!(parse_line(&nested_text), vec![]);
    }

    #[test]
    fn emits_every_tool_use_in_a_message_and_skips_text_blocks() {
        let message = json!({"type":"assistant","message":{"content":[
            {"type":"text","text":"Let me look."},
            {"type":"tool_use","id":"a","name":"Read","input":{"file_path":"deck.html"}},
            {"type":"tool_use","id":"b","name":"Edit","input":{"old_string":"x","new_string":"y"}}
        ]}});
        assert_eq!(
            parse_line(&message),
            vec![
                AgentEvent::ToolUse {
                    id: "a".into(),
                    name: "Read".into(),
                    input: json!({"file_path":"deck.html"})
                },
                AgentEvent::ToolUse {
                    id: "b".into(),
                    name: "Edit".into(),
                    input: json!({"old_string":"x","new_string":"y"})
                },
            ]
        );
        let no_content = json!({"type":"assistant","message":{}});
        assert_eq!(parse_line(&no_content), vec![]);
    }

    #[test]
    fn reports_failed_tool_results() {
        let result = json!({"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":"a","is_error":true,"content":"denied"},
            {"type":"text","text":"ignored"}
        ]}});
        assert_eq!(
            parse_line(&result),
            vec![AgentEvent::ToolResult {
                id: "a".into(),
                is_error: true
            }]
        );
    }

    #[test]
    fn non_success_results_are_errors() {
        let max_turns =
            json!({"type":"result","subtype":"error_max_turns","is_error":false,"duration_ms":10});
        assert_eq!(
            parse_line(&max_turns),
            vec![AgentEvent::Result {
                is_error: true,
                text: None,
                cost_usd: None,
                duration_ms: Some(10)
            }]
        );
        let flagged = json!({"type":"result","subtype":"success","is_error":true,"result":"API Error","total_cost_usd":0.5});
        assert_eq!(
            parse_line(&flagged),
            vec![AgentEvent::Result {
                is_error: true,
                text: Some("API Error".into()),
                cost_usd: Some(0.5),
                duration_ms: None
            }]
        );
    }

    #[test]
    fn missing_session_needs_a_result_with_that_error() {
        assert!(!is_missing_session(
            &json!({"type":"assistant","errors":["No conversation found"]})
        ));
        assert!(!is_missing_session(
            &json!({"type":"result","errors":["Rate limited"]})
        ));
        assert!(!is_missing_session(&json!({"type":"result","errors":[42]})));
        assert!(!is_missing_session(&json!({"type":"result"})));
    }

    #[test]
    fn init_without_session_id_is_ignored() {
        assert_eq!(
            session_id_of_init(&json!({"type":"system","subtype":"init"})),
            None
        );
        assert_eq!(
            session_id_of_init(&json!({"type":"result","subtype":"init","session_id":"x"})),
            None
        );
    }

    #[test]
    fn builds_cli_arguments() {
        let prompt = Path::new("/home/.slopslides/system-prompt.md");
        let mcp = Path::new("/home/.slopslides/mcp.json");
        let session = Path::new("/home/.slopslides/sessions/1-ab");
        let base = build_claude_args(prompt, mcp, session, None, None, None, PermissionMode::Ask);
        assert_eq!(
            base[..5],
            [
                "-p",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json"
            ]
        );
        let after = |args: &[String], flag: &str| {
            args.iter()
                .position(|a| a == flag)
                .map(|i| args[i + 1].clone())
        };
        assert_eq!(
            after(&base, "--permission-mode").as_deref(),
            Some("acceptEdits")
        );
        assert_eq!(after(&base, "--tools").as_deref(), Some(TOOLS));
        assert_eq!(
            after(&base, "--allowedTools").as_deref(),
            Some("WebSearch,WebFetch,mcp__slopslide"),
            "the shell and files outside the workspace ask; the app's tools never do"
        );
        assert_eq!(
            after(&base, "--permission-prompt-tool").as_deref(),
            Some("stdio")
        );
        assert_eq!(
            after(&base, "--mcp-config").as_deref(),
            Some("/home/.slopslides/mcp.json")
        );
        assert_eq!(
            after(&base, "--append-system-prompt-file").as_deref(),
            Some("/home/.slopslides/system-prompt.md")
        );
        assert_eq!(
            after(&base, "--add-dir").as_deref(),
            Some("/home/.slopslides/sessions/1-ab"),
            "the agent reads sketches and templates in the session"
        );
        assert!(base.contains(&"--strict-mcp-config".to_string()));
        assert!(!base.contains(&"--model".to_string()));
        assert!(!base.contains(&"--resume".to_string()));
        assert!(!base.contains(&"--effort".to_string()));

        let full = build_claude_args(
            prompt,
            mcp,
            session,
            Some("opus"),
            Some("high"),
            Some("s-1"),
            PermissionMode::FullAccess,
        );
        assert_eq!(
            after(&full, "--permission-mode").as_deref(),
            Some("bypassPermissions")
        );
        assert_eq!(after(&full, "--model").as_deref(), Some("opus"));
        assert_eq!(after(&full, "--effort").as_deref(), Some("high"));
        assert_eq!(after(&full, "--resume").as_deref(), Some("s-1"));
    }

    #[test]
    fn shows_the_apps_tools_by_their_own_names() {
        let line = json!({"type":"assistant","message":{"content":[
            {"type":"tool_use","id":"t1","name":"mcp__slopslide__lint_deck","input":{}},
            {"type":"tool_use","id":"t2","name":"mcp__github__push","input":{}}
        ]}});
        let names: Vec<_> = parse_line(&line)
            .into_iter()
            .filter_map(|e| match e {
                AgentEvent::ToolUse { name, .. } => Some(name),
                _ => None,
            })
            .collect();
        assert_eq!(names, ["lint_deck", "mcp__github__push"]);
    }

    fn can_use_tool(tool: &str, input: Value) -> Value {
        json!({"subtype":"can_use_tool","tool_name":tool,"input":input,"permission_suggestions":[]})
    }

    #[test]
    fn claude_runs_the_apps_tools_without_asking() {
        for tool in ["mcp__slopslide__lint_deck", "mcp__slopslide__open_file"] {
            let request = can_use_tool(tool, json!({"path":"deck.html"}));
            assert!(matches!(
                claude_permission(&request, PermissionMode::Ask),
                ClaudePermission::Answer(Ok(r)) if r["behavior"] == "allow" && r["updatedInput"]["path"] == "deck.html"
            ));
        }
    }

    #[test]
    fn claude_asks_before_other_tools() {
        let cases = [
            (
                "Bash",
                json!({"command":"npm test","description":"Run tests"}),
                "Run a command",
                "npm test",
            ),
            (
                "Write",
                json!({"file_path":"/etc/hosts"}),
                "Change files",
                "/etc/hosts",
            ),
            (
                "Read",
                json!({"file_path":"/Users/me/.ssh/id"}),
                "Read files",
                "/Users/me/.ssh/id",
            ),
            (
                "WebFetch",
                json!({"url":"https://example.com"}),
                "Network access",
                "https://example.com",
            ),
            (
                "mcp__github__push",
                json!({"branch":"main"}),
                "Use a tool",
                "mcp__github__push",
            ),
        ];
        for (tool, input, title, details) in cases {
            let ClaudePermission::Ask(approval, choices) =
                claude_permission(&can_use_tool(tool, input.clone()), PermissionMode::Ask)
            else {
                panic!("{tool} asks");
            };
            assert_eq!(approval.title, title);
            assert!(approval.details.contains(details), "{}", approval.details);
            assert_eq!(
                approval.decisions,
                [Decision::Accept, Decision::Decline],
                "no rule offered"
            );
            assert_eq!(
                choices["accept"],
                json!({"behavior":"allow","updatedInput":input})
            );
            assert_eq!(choices["decline"]["behavior"], "deny");
        }
        let ClaudePermission::Ask(approval, _) = claude_permission(
            &can_use_tool("Bash", json!({"command":"ls","description":"List files"})),
            PermissionMode::Ask,
        ) else {
            panic!("asks");
        };
        assert_eq!(approval.reason.as_deref(), Some("List files"));
    }

    #[test]
    fn claude_full_access_allows_everything() {
        let request = can_use_tool("Bash", json!({"command":"rm -rf build"}));
        assert!(matches!(
            claude_permission(&request, PermissionMode::FullAccess),
            ClaudePermission::Answer(Ok(r)) if r["behavior"] == "allow"
        ));
    }

    #[test]
    fn claude_refuses_other_control_requests() {
        let request = json!({"subtype":"hook_callback"});
        assert!(matches!(
            claude_permission(&request, PermissionMode::Ask),
            ClaudePermission::Answer(Err(_))
        ));
        assert_eq!(
            claude_control_response(&json!("r1"), Err("no")),
            json!({"type":"control_response","response":{"subtype":"error","request_id":"r1","error":"no"}})
        );
    }

    #[test]
    fn lint_server_config_runs_this_binary_in_the_working_directory() {
        let config: Value =
            serde_json::from_str(&lint_server_config(Path::new("/Apps/SlopSlide"))).unwrap();
        let server = &config["mcpServers"]["slopslide"];
        assert_eq!(server["type"], "stdio");
        assert_eq!(server["command"], "/Apps/SlopSlide");
        assert_eq!(
            server["args"],
            json!(["--lint-mcp"]),
            "no deck: shared by all"
        );
    }

    #[test]
    fn system_prompt_includes_the_design_reference() {
        assert!(SYSTEM_PROMPT.starts_with(include_str!("../prompts/system.md")));
        assert!(SYSTEM_PROMPT.ends_with(include_str!("../prompts/design-reference.md")));
        assert!(
            SYSTEM_PROMPT.contains("\"Design Reference\""),
            "system.md points at the reference by its title"
        );
        assert!(
            !SYSTEM_PROMPT.contains("Style Presets")
                && !SYSTEM_PROMPT.contains("Animation Patterns"),
            "styles live in the templates, not in the prompt"
        );
        assert!(
            !SYSTEM_PROMPT.contains(".slopslide/reference"),
            "the references are not files in the deck"
        );
    }

    #[test]
    fn write_if_changed_replaces_only_different_contents() {
        let dir = std::env::temp_dir().join(format!("slopslide-write-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mcp.json");
        write_if_changed(&path, "one").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "one");
        let written = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        write_if_changed(&path, "one").unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            written,
            "unchanged contents are not rewritten"
        );
        write_if_changed(&path, "two").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "two");
        let leftovers = std::fs::read_dir(&dir).unwrap().count();
        assert_eq!(leftovers, 1, "no temporary files left behind");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn events_serialize_to_the_frontend_shape() {
        let cases = [
            (
                AgentEvent::Started { session_id: None },
                json!({"type":"started","sessionId":null}),
            ),
            (AgentEvent::Thinking, json!({"type":"thinking"})),
            (AgentEvent::TextStart, json!({"type":"textStart"})),
            (
                AgentEvent::TextDelta { text: "hi".into() },
                json!({"type":"textDelta","text":"hi"}),
            ),
            (
                AgentEvent::ToolUse {
                    id: "t".into(),
                    name: "Write".into(),
                    input: json!({"a":1}),
                },
                json!({"type":"toolUse","id":"t","name":"Write","input":{"a":1}}),
            ),
            (
                AgentEvent::ToolResult {
                    id: "t".into(),
                    is_error: true,
                },
                json!({"type":"toolResult","id":"t","isError":true}),
            ),
            (
                AgentEvent::Result {
                    is_error: false,
                    text: Some("ok".into()),
                    cost_usd: Some(0.1),
                    duration_ms: Some(9),
                },
                json!({"type":"result","isError":false,"text":"ok","costUsd":0.1,"durationMs":9}),
            ),
            (
                AgentEvent::Error {
                    message: "bad".into(),
                },
                json!({"type":"error","message":"bad"}),
            ),
            (
                AgentEvent::Finished { interrupted: true },
                json!({"type":"finished","interrupted":true}),
            ),
        ];
        for (event, expected) in cases {
            assert_eq!(serde_json::to_value(&event).unwrap(), expected);
        }
        let envelope = Envelope {
            workspace: "talk",
            event: &AgentEvent::Thinking,
        };
        assert_eq!(
            serde_json::to_value(envelope).unwrap(),
            json!({"workspace":"talk","event":{"type":"thinking"}})
        );
    }

    #[test]
    fn send_args_deserialize_from_the_frontend() {
        let args: SendArgs =
            serde_json::from_value(json!({"workspace":"talk","prompt":"Hi","model":null})).unwrap();
        assert_eq!(
            (args.workspace.as_str(), args.prompt.as_str()),
            ("talk", "Hi")
        );
        assert_eq!(args.model, None);
        assert_eq!(
            args.provider,
            Provider::Claude,
            "older frontends send no provider"
        );
        let args: SendArgs = serde_json::from_value(
            json!({"workspace":"t","prompt":"","provider":"codex","model":"gpt-6-astra","effort":"high"}),
        )
        .unwrap();
        assert_eq!(args.provider, Provider::Codex);
        assert_eq!(args.model.as_deref(), Some("gpt-6-astra"));
        assert_eq!(args.effort.as_deref(), Some("high"));
    }

    #[test]
    fn manager_tracks_nothing_by_default() {
        let manager = AgentManager::default();
        assert!(!manager.is_running("talk"));
        manager.interrupt("talk"); // no-op, must not panic
    }

    /// Runs whole turns against a shell script standing in for the `claude` CLI.
    #[cfg(unix)]
    mod process {
        use super::*;
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        use std::sync::Arc;
        use std::time::Duration;

        /// Where the fake `claude` logs its arguments and input, inside the test deck.
        const LOG_DIR: &str = ".test-log";

        struct Fixture {
            dir: PathBuf,
            events: Arc<Mutex<Vec<AgentEvent>>>,
            /// How the user answers approval requests; unanswered when `None`.
            answer: Option<Decision>,
            mode: PermissionMode,
        }

        impl Fixture {
            /// A deck folder plus a fake `claude` that logs its arguments and stdin, then
            /// runs `body` (with `$RESUME` set when `--resume` was passed).
            fn new(body: &str) -> Self {
                let dir =
                    std::env::temp_dir().join(format!("slopslide-agent-{}", uuid::Uuid::new_v4()));
                fs::create_dir_all(dir.join(LOG_DIR)).unwrap();
                fs::create_dir_all(dir.join("home")).unwrap();
                let script = format!(
                    "#!/bin/sh\n\
                     LOG=\"$PWD/{LOG_DIR}\"\n\
                     RESUME=\n\
                     prev=\n\
                     for a in \"$@\"; do [ \"$prev\" = --resume ] && RESUME=\"$a\"; prev=\"$a\"; done\n\
                     printf '%s\\n' \"$@\" > \"$LOG/args.$$\"\n\
                     printf '%s\\n' \"$$\" >> \"$LOG/runs\"\n\
                     IFS= read -r line; printf '%s' \"$line\" > \"$LOG/stdin.log\"\n\
                     {body}\n"
                );
                let claude = dir.join("claude");
                fs::write(&claude, script).unwrap();
                fs::set_permissions(&claude, fs::Permissions::from_mode(0o755)).unwrap();
                Fixture {
                    dir,
                    events: Arc::default(),
                    answer: None,
                    mode: PermissionMode::Ask,
                }
            }

            fn turn(&self) -> Turn {
                self.turn_with(self.dir.join("claude"), None)
            }

            fn turn_with(&self, claude: PathBuf, model: Option<&str>) -> Turn {
                let events = self.events.clone();
                let approvals = Arc::<Approvals>::default();
                let (broker, answer) = (approvals.clone(), self.answer);
                Turn {
                    emit: Box::new(move |e| {
                        events.lock().unwrap().push(e.clone());
                        if let (AgentEvent::ApprovalRequested { approval }, Some(decision)) =
                            (e, answer)
                        {
                            broker.respond("test", &approval.id, decision).unwrap();
                        }
                    }),
                    dir: self.dir.clone(),
                    app_home: self.dir.join("home"),
                    session_dir: self.session_dir(),
                    provider: Provider::Claude,
                    bin: claude,
                    model: model.map(str::to_string),
                    effort: None,
                    compact: false,
                    workspace: "test".into(),
                    permission_mode: self.mode,
                    approvals,
                }
            }

            async fn run_compact(&self) -> bool {
                let (_tx, rx) = watch::channel(false);
                let mut turn = self.turn();
                turn.compact = true;
                tokio::time::timeout(
                    Duration::from_secs(20),
                    turn.run("whatever the composer held", rx),
                )
                .await
                .expect("turn timed out")
            }

            async fn run(&self, prompt: &str, model: Option<&str>) -> bool {
                let (_tx, rx) = watch::channel(false);
                let turn = self.turn_with(self.dir.join("claude"), model);
                tokio::time::timeout(Duration::from_secs(20), turn.run(prompt, rx))
                    .await
                    .expect("turn timed out")
            }

            fn events(&self) -> Vec<AgentEvent> {
                self.events.lock().unwrap().clone()
            }

            fn errors(&self) -> Vec<String> {
                self.events()
                    .into_iter()
                    .filter_map(|e| match e {
                        AgentEvent::Error { message } => Some(message),
                        _ => None,
                    })
                    .collect()
            }

            /// The prompt of the last invocation, from its stream-json user message.
            fn prompt(&self) -> String {
                let line = fs::read_to_string(self.dir.join(LOG_DIR).join("stdin.log")).unwrap();
                let message: Value = serde_json::from_str(&line).unwrap();
                assert_eq!(message["type"], "user");
                message["message"]["content"].as_str().unwrap().to_string()
            }

            /// Arguments of each invocation, in order.
            fn invocations(&self) -> Vec<Vec<String>> {
                let log = self.dir.join(LOG_DIR);
                let runs = fs::read_to_string(log.join("runs")).unwrap_or_default();
                runs.lines()
                    .map(|pid| {
                        fs::read_to_string(log.join(format!("args.{pid}")))
                            .unwrap()
                            .lines()
                            .map(String::from)
                            .collect()
                    })
                    .collect()
            }

            /// The workspace's session folder, outside the deck.
            fn session_dir(&self) -> PathBuf {
                self.dir.join("home").join("sessions").join("1-test")
            }

            fn session(&self) -> Option<String> {
                deck::read_session(&self.session_dir(), Provider::Claude.session_file())
            }
        }

        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.dir);
            }
        }

        const INIT: &str =
            r#"echo '{"type":"system","subtype":"init","session_id":"new-session"}'"#;
        const OK: &str = r#"echo '{"type":"result","subtype":"success","is_error":false,"result":"Done.","total_cost_usd":0.01,"duration_ms":5}'"#;

        fn has_flag(args: &[String], flag: &str, value: &str) -> bool {
            args.windows(2).any(|w| w[0] == flag && w[1] == value)
        }

        #[tokio::test]
        async fn streams_a_turn_and_stores_the_session() {
            let fx = Fixture::new(&format!(
                r#"{INIT}
echo 'not json, ignored'
echo '{{"type":"stream_event","event":{{"type":"content_block_start","content_block":{{"type":"text"}}}}}}'
echo '{{"type":"stream_event","event":{{"type":"content_block_delta","delta":{{"type":"text_delta","text":"Hello"}}}}}}'
echo '{{"type":"assistant","message":{{"content":[{{"type":"tool_use","id":"t1","name":"Edit","input":{{}}}}]}}}}'
echo '{{"type":"user","message":{{"content":[{{"type":"tool_result","tool_use_id":"t1"}}]}}}}'
{OK}"#
            ));
            let interrupted = fx.run("Make it pop", Some("sonnet")).await;
            assert!(!interrupted);
            assert_eq!(
                fx.events(),
                vec![
                    AgentEvent::Started { session_id: None },
                    AgentEvent::Started {
                        session_id: Some("new-session".into())
                    },
                    AgentEvent::TextStart,
                    AgentEvent::TextDelta {
                        text: "Hello".into()
                    },
                    AgentEvent::ToolUse {
                        id: "t1".into(),
                        name: "Edit".into(),
                        input: json!({})
                    },
                    AgentEvent::ToolResult {
                        id: "t1".into(),
                        is_error: false
                    },
                    AgentEvent::Result {
                        is_error: false,
                        text: Some("Done.".into()),
                        cost_usd: Some(0.01),
                        duration_ms: Some(5)
                    },
                ]
            );
            assert_eq!(fx.session().as_deref(), Some("new-session"));
            assert_eq!(fx.prompt(), "Make it pop");
            let home = fx.dir.join("home");
            let prompt_file = home.join("system-prompt.md");
            assert_eq!(fs::read_to_string(&prompt_file).unwrap(), SYSTEM_PROMPT);
            let mcp_file = home.join("mcp.json");
            let mcp: Value = serde_json::from_str(&fs::read_to_string(&mcp_file).unwrap()).unwrap();
            assert_eq!(
                mcp["mcpServers"]["slopslide"]["args"],
                json!(["--lint-mcp"])
            );
            let mut written: Vec<_> = fs::read_dir(&fx.dir)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            written.sort();
            assert_eq!(
                written,
                [LOG_DIR, "claude", "home"],
                "nothing of the app's is written into the deck"
            );
            assert!(has_flag(
                &fx.invocations()[0],
                "--add-dir",
                &fx.session_dir().to_string_lossy()
            ));
            let runs = fx.invocations();
            assert_eq!(runs.len(), 1);
            assert!(has_flag(&runs[0], "--model", "sonnet"));
            assert!(has_flag(
                &runs[0],
                "--mcp-config",
                &mcp_file.to_string_lossy()
            ));
            assert!(has_flag(
                &runs[0],
                "--append-system-prompt-file",
                &prompt_file.to_string_lossy()
            ));
            assert!(!runs[0].contains(&"--resume".to_string()));
        }

        #[tokio::test]
        async fn resumes_the_stored_session() {
            let fx = Fixture::new(&format!(
                r#"echo "{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"$RESUME\"}}"
{OK}"#
            ));
            deck::write_session(&fx.session_dir(), "claude-session", Some("old-session")).unwrap();
            assert!(!fx.run("Again", None).await);
            let runs = fx.invocations();
            assert_eq!(runs.len(), 1);
            assert!(has_flag(&runs[0], "--resume", "old-session"));
            assert!(!runs[0].contains(&"--model".to_string()));
            assert_eq!(
                fx.events()[0],
                AgentEvent::Started {
                    session_id: Some("old-session".into())
                }
            );
            assert_eq!(fx.session().as_deref(), Some("old-session"));
            assert!(fx.errors().is_empty());
        }

        #[tokio::test]
        async fn starts_fresh_when_the_session_is_gone() {
            let fx = Fixture::new(&format!(
                r#"if [ -n "$RESUME" ]; then
  echo '{{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["No conversation found with session ID: gone"]}}'
  exit 1
fi
{INIT}
{OK}"#
            ));
            deck::write_session(&fx.session_dir(), "claude-session", Some("gone")).unwrap();
            assert!(!fx.run("Hi", None).await);
            let runs = fx.invocations();
            assert_eq!(runs.len(), 2, "retried once");
            assert!(has_flag(&runs[0], "--resume", "gone"));
            assert!(!runs[1].contains(&"--resume".to_string()));
            assert_eq!(fx.session().as_deref(), Some("new-session"));
            assert!(fx.errors().is_empty(), "{:?}", fx.errors());
            let results: Vec<_> = fx
                .events()
                .into_iter()
                .filter(|e| matches!(e, AgentEvent::Result { .. }))
                .collect();
            assert_eq!(results.len(), 1, "the failed resume's result is not shown");
            assert!(matches!(
                results[0],
                AgentEvent::Result {
                    is_error: false,
                    ..
                }
            ));
        }

        #[tokio::test]
        async fn starts_fresh_when_stderr_reports_a_missing_session() {
            let fx = Fixture::new(&format!(
                r#"if [ -n "$RESUME" ]; then
  echo "Error: No conversation found with session ID: $RESUME" >&2
  exit 1
fi
{INIT}
{OK}"#
            ));
            deck::write_session(&fx.session_dir(), "claude-session", Some("gone")).unwrap();
            assert!(!fx.run("Hi", None).await);
            assert_eq!(fx.invocations().len(), 2);
            assert_eq!(fx.session().as_deref(), Some("new-session"));
            assert!(fx.errors().is_empty(), "{:?}", fx.errors());
        }

        /// A `can_use_tool` request for `curl`, then the response the app wrote, then a result.
        fn permission_script() -> String {
            format!(
                r#"{INIT}
echo '{{"type":"control_request","request_id":"req-1","request":{{"subtype":"can_use_tool","tool_name":"Bash","input":{{"command":"curl -sI https://example.com"}},"permission_suggestions":[{{"type":"addRules","rules":[{{"toolName":"Bash","ruleContent":"curl -sI https://example.com"}}],"behavior":"allow","destination":"localSettings"}}]}}}}'
IFS= read -r answer; printf '%s' "$answer" > "$LOG/answer.log"
{OK}"#
            )
        }

        #[tokio::test]
        async fn asks_the_user_and_answers_claude_code() {
            for (decision, behavior) in [
                (Decision::Accept, "allow"),
                (Decision::AcceptForSession, "allow"),
                (Decision::Decline, "deny"),
            ] {
                let mut fx = Fixture::new(&permission_script());
                fx.answer = Some(decision);
                assert!(!fx.run("Check the site", None).await);
                let answer: Value = serde_json::from_str(
                    &fs::read_to_string(fx.dir.join(LOG_DIR).join("answer.log")).unwrap(),
                )
                .unwrap();
                assert_eq!(answer["type"], "control_response");
                let response = &answer["response"];
                assert_eq!(response["request_id"], "req-1");
                assert_eq!(response["response"]["behavior"], behavior);
                let rules = &response["response"]["updatedPermissions"];
                assert_eq!(rules.is_array(), decision == Decision::AcceptForSession);
                if decision == Decision::AcceptForSession {
                    assert_eq!(
                        rules[0]["destination"], "session",
                        "never saved to settings"
                    );
                }
                let events = fx.events();
                let requested = events.iter().find_map(|e| match e {
                    AgentEvent::ApprovalRequested { approval } => Some(approval.clone()),
                    _ => None,
                });
                let approval = requested.expect("the user was asked");
                assert_eq!(approval.title, "Run a command");
                assert_eq!(approval.details, "curl -sI https://example.com");
                assert!(events.contains(&AgentEvent::ApprovalResolved { id: approval.id }));
                assert!(fx.errors().is_empty(), "{:?}", fx.errors());
            }
        }

        #[tokio::test]
        async fn full_access_answers_without_asking() {
            let mut fx = Fixture::new(&permission_script());
            fx.mode = PermissionMode::FullAccess;
            assert!(!fx.run("Check the site", None).await);
            let answer = fs::read_to_string(fx.dir.join(LOG_DIR).join("answer.log")).unwrap();
            assert!(answer.contains(r#""behavior":"allow""#), "{answer}");
            assert!(!fx
                .events()
                .iter()
                .any(|e| matches!(e, AgentEvent::ApprovalRequested { .. })));
            assert!(has_flag(
                &fx.invocations()[0],
                "--permission-mode",
                "bypassPermissions"
            ));
        }

        #[tokio::test]
        async fn interrupting_closes_a_pending_approval() {
            let fx = Fixture::new(&permission_script());
            let (tx, rx) = watch::channel(false);
            let turn = fx.turn();
            let approvals = turn.approvals.clone();
            let run = tokio::spawn(async move { turn.run("Check the site", rx).await });
            for _ in 0..200 {
                if fx
                    .events()
                    .iter()
                    .any(|e| matches!(e, AgentEvent::ApprovalRequested { .. }))
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            assert!(!approvals.is_empty(), "waiting for the user");
            tx.send(true).unwrap();
            let interrupted = tokio::time::timeout(Duration::from_secs(5), run)
                .await
                .expect("interrupt did not stop the turn")
                .unwrap();
            assert!(interrupted);
            assert!(approvals.is_empty(), "the request closed with the turn");
        }

        #[tokio::test]
        async fn compacts_the_stored_session() {
            let fx = Fixture::new(&format!(
                r#"echo "{{\"type\":\"system\",\"subtype\":\"status\",\"status\":\"compacting\"}}"
echo "{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"$RESUME\"}}"
echo '{{"type":"system","subtype":"compact_boundary","compact_metadata":{{"trigger":"manual"}}}}'
{OK}"#
            ));
            deck::write_session(&fx.session_dir(), "claude-session", Some("old-session")).unwrap();
            assert!(!fx.run_compact().await);
            let runs = fx.invocations();
            assert_eq!(runs.len(), 1);
            assert!(has_flag(&runs[0], "--resume", "old-session"));
            assert_eq!(fx.prompt(), "/compact");
            let events = fx.events();
            assert!(events.contains(&AgentEvent::Compacting));
            assert!(events.contains(&AgentEvent::Compacted));
            assert!(fx.errors().is_empty(), "{:?}", fx.errors());
            assert_eq!(fx.session().as_deref(), Some("old-session"));
        }

        #[tokio::test]
        async fn compacting_needs_a_conversation() {
            let fx = Fixture::new(&format!("{INIT}\n{OK}"));
            assert!(!fx.run_compact().await);
            assert!(fx.invocations().is_empty(), "the CLI is not started");
            assert_eq!(fx.errors(), ["There is no conversation to compact yet."]);
        }

        #[tokio::test]
        async fn compacting_a_lost_session_does_not_start_fresh() {
            let fx = Fixture::new(&format!(
                r#"if [ -n "$RESUME" ]; then
  echo '{{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["No conversation found with session ID: gone"]}}'
  exit 1
fi
{INIT}
{OK}"#
            ));
            deck::write_session(&fx.session_dir(), "claude-session", Some("gone")).unwrap();
            assert!(!fx.run_compact().await);
            assert_eq!(fx.invocations().len(), 1, "not retried without the session");
            assert_eq!(fx.session(), None, "the stale session is forgotten");
            assert_eq!(fx.errors().len(), 1);
        }

        #[tokio::test]
        async fn a_fresh_turn_is_not_retried() {
            let fx = Fixture::new(
                r#"echo '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["No conversation found"]}'"#,
            );
            assert!(!fx.run("Hi", None).await);
            assert_eq!(fx.invocations().len(), 1);
        }

        #[tokio::test]
        async fn reports_a_crash_with_its_stderr() {
            let fx = Fixture::new("echo '  Invalid API key  ' >&2\nexit 3");
            assert!(!fx.run("Hi", None).await);
            assert_eq!(
                fx.errors(),
                ["Claude Code stopped unexpectedly: Invalid API key"]
            );
        }

        #[tokio::test]
        async fn reports_the_exit_status_when_stderr_is_empty() {
            let fx = Fixture::new("exit 7");
            assert!(!fx.run("Hi", None).await);
            let errors = fx.errors();
            assert_eq!(errors.len(), 1);
            assert!(
                errors[0].starts_with("Claude Code stopped unexpectedly: exit status"),
                "{}",
                errors[0]
            );
            assert!(errors[0].contains('7'), "{}", errors[0]);
        }

        #[tokio::test]
        async fn a_failing_exit_after_a_result_is_not_an_extra_error() {
            let fx = Fixture::new(&format!("{OK}\necho noise >&2\nexit 1"));
            assert!(!fx.run("Hi", None).await);
            assert!(fx.errors().is_empty(), "{:?}", fx.errors());
        }

        #[tokio::test]
        async fn large_stderr_does_not_block_the_child() {
            // Far more than a pipe buffer; the reader must keep draining past STDERR_LIMIT.
            let fx = Fixture::new(&format!(
                "i=0; while [ $i -lt 2000 ]; do echo 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' >&2; i=$((i+1)); done\n{OK}"
            ));
            assert!(!fx.run("Hi", None).await);
            assert!(fx.events().iter().any(|e| matches!(
                e,
                AgentEvent::Result {
                    is_error: false,
                    ..
                }
            )));
        }

        #[tokio::test]
        async fn interrupting_kills_the_process() {
            let fx = Fixture::new(&format!("{INIT}\nexec sleep 30"));
            let (tx, rx) = watch::channel(false);
            let turn = fx.turn();
            let run = tokio::spawn(async move { turn.run("Hi", rx).await });
            // Wait until the turn is under way.
            for _ in 0..200 {
                if fx.session().is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            assert_eq!(fx.session().as_deref(), Some("new-session"));
            tx.send(true).unwrap();
            let interrupted = tokio::time::timeout(Duration::from_secs(5), run)
                .await
                .expect("interrupt did not stop the turn")
                .unwrap();
            assert!(interrupted);
            assert!(fx.errors().is_empty());
        }

        #[tokio::test]
        async fn reports_a_missing_executable() {
            let fx = Fixture::new("");
            let (_tx, rx) = watch::channel(false);
            let missing = fx.dir.join("no-such-claude");
            assert!(!fx.turn_with(missing, None).run("Hi", rx).await);
            let errors = fx.errors();
            assert_eq!(errors.len(), 1);
            assert!(
                errors[0].starts_with("Could not start Claude Code"),
                "{}",
                errors[0]
            );
            assert!(errors[0].contains("no-such-claude"), "{}", errors[0]);
        }
    }
}
