//! Drives Claude Code headless (`claude -p --input-format stream-json --output-format
//! stream-json`), one process per turn: its arguments and the config files it reads, the
//! stream-json lines it writes and reads, and how its permission prompts are answered.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Instant;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::watch;

use crate::agent::{AgentEvent, Outcome, Steers, TurnArgs, SYSTEM_PROMPT};
use crate::error::{Error, Result};
use crate::permissions::{self, Approval, Choices, PermissionMode};
use crate::{mcp, rewind};

/// How errors name the CLI.
const NAME: &str = "Claude Code";
/// The agent's built-in tools, besides MCP servers (see [`crate::extensions`]). What runs
/// without asking depends on the permission mode (see [`build_args`]).
const TOOLS: &str = "Read,Write,Edit,Glob,Grep,Bash,WebSearch,WebFetch,Skill";
/// Tools that never ask in Ask mode, besides the app's MCP tools. Claude Code itself lets
/// file tools work inside the workspace and asks outside it; the shell always asks. Loading
/// a skill only reads its instructions.
const ALLOWED_TOOLS: &str = "WebSearch,WebFetch,Skill";
const STDERR_LIMIT: usize = 16 * 1024;
/// The prompt Claude Code runs as its built-in compaction command.
const COMPACT: &str = "/compact";
/// Claude Code's MCP config in the session: the user's `servers` and this app binary as the
/// agent's lint tool server (`mcp.rs`), which lints the deck in its working directory, which
/// Claude Code sets to its own (the workspace).
const MCP_CONFIG: &str = "mcp.json";
/// Where the session's generated Claude Code plugins go (see
/// [`crate::extensions::Extensions::claude_skills_plugin`]).
const PLUGINS: &str = "claude-plugins";
const MISSING_SESSION: &str = "No conversation found";

/// Claude Code selects the 1M-token context window with a `[1m]` model suffix.
pub fn model(model: String, context_window: Option<&str>) -> String {
    match context_window {
        Some("1m") if !model.ends_with("[1m]") => format!("{model}[1m]"),
        _ => model,
    }
}

/// Runs one turn. `on_session` persists the session id as soon as it is known.
pub async fn run_turn(
    args: TurnArgs<'_>,
    cancel: &mut watch::Receiver<bool>,
    steers: &mut Steers,
    emit: &(dyn Fn(&AgentEvent) + Sync),
    on_session: &(dyn Fn(&str) -> Result<()> + Sync),
) -> Result<Outcome> {
    let session = args.session;
    let cut = args.rewind.cut;
    // A file rather than an argument: the prompt outgrows Windows command lines.
    let system_prompt = args.app_home.join("system-prompt.md");
    write_if_changed(
        &system_prompt,
        &args.extensions.system_prompt(SYSTEM_PROMPT),
    )?;
    // Per workspace, as it holds the workspace's servers. Claude Code leaves out the
    // servers of the plugins it loads (`--strict-mcp-config`), so they are added here.
    let mcp_config = args.session_dir.join(MCP_CONFIG);
    write_if_changed(
        &mcp_config,
        &mcp_config_json(args.lint_server, &args.extensions.all_mcp_servers()),
    )?;
    let mut plugins = args.extensions.plugins.clone();
    plugins.extend(
        args.extensions
            .claude_skills_plugin(&args.session_dir.join(PLUGINS))?,
    );
    // Changes from here on reach Claude Code as control requests.
    let mut mode = args.mode.clone();
    let launched = *mode.borrow_and_update();
    let mut cli_args = build_args(
        &system_prompt,
        &mcp_config,
        args.session_dir,
        args.model,
        args.effort,
        session,
        launched,
    );
    if let (Some(_), Some((point, _))) = (session, cut) {
        // Drops the conversation after this message (see `rewind`).
        cli_args.extend(["--resume-session-at".into(), point.into()]);
    }
    cli_args.extend(plugin_args(&plugins));
    // The conversation's newest message before this turn, where taking it back resumes.
    let tail = match (session, cut) {
        (None, _) => None,
        (Some(_), Some((point, _))) => Some(point.to_string()),
        (Some(_), None) => rewind::claude_tail(args.session_dir),
    };
    if let Some(started) = args.rewind.started {
        started(tail.as_deref());
    }
    let mut newest = tail;
    let started = Instant::now();

    let mut cmd = crate::process::command(args.bin)?;
    cmd.args(cli_args)
        .current_dir(args.dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| {
        Error::msg(format!(
            "Could not start {NAME} ({}): {e}",
            args.bin.display()
        ))
    })?;
    emit(&AgentEvent::Started {
        session_id: session.map(str::to_string),
    });

    // Stream-json input keeps stdin open for answering permission requests; closing it
    // after the result lets Claude Code exit.
    let mut stdin = child.stdin.take();
    let prompt = if args.compact { COMPACT } else { args.prompt };
    write_line(stdin.as_mut(), &user_message(prompt)).await?;
    let (run, mut answers) = args.approvals.start(args.workspace);
    let mut mode_requests = 0;

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
    // A steer ends the segment it interrupts with a result of its own; the turn goes on.
    let mut steered = false;
    loop {
        tokio::select! {
            biased;
            Some(answer) = answers.recv() => {
                let response = control_response(&answer.wire_id, Ok(answer.payload));
                write_line(stdin.as_mut(), &response).await?;
                emit(&AgentEvent::ApprovalResolved { id: answer.id });
            }
            Ok(()) = mode.changed() => {
                let mode = *mode.borrow_and_update();
                mode_requests += 1;
                let request = set_mode(&format!("mode-{mode_requests}"), mode);
                write_line(stdin.as_mut(), &request).await?;
                if mode == PermissionMode::FullAccess {
                    run.accept_all();
                }
            }
            Some(steer) = steers.recv() => {
                // Once stdin is closed the turn is ending; a compaction takes no message.
                if stdin.is_none() || args.compact {
                    steer.refused();
                    continue;
                }
                write_line(stdin.as_mut(), &steer_message(&steer.prompt)).await?;
                steered = true;
                steer.delivered(emit);
            }
            line = lines.next_line() => {
                let Some(line) = line? else { break };
                let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
                match value["type"].as_str() {
                    Some("control_request") => {
                        let id = &value["request_id"];
                        let current = *mode.borrow();
                        match permission(&value["request"], current, args.session_dir) {
                            Permission::Answer(reply) => {
                                write_line(stdin.as_mut(), &control_response(id, reply)).await?;
                            }
                            Permission::Ask(approval, choices) => {
                                run.ask(id.clone(), &approval, choices);
                                emit(&AgentEvent::ApprovalRequested { approval });
                            }
                        }
                        continue;
                    }
                    Some("control_cancel_request") => {
                        if let Some(id) = run.resolved(&value["request_id"]) {
                            emit(&AgentEvent::ApprovalResolved { id });
                        }
                        continue;
                    }
                    Some("result") if steered && is_steer_abort(&value) => continue,
                    Some("result") => stdin = None,
                    Some("assistant") if value["parent_tool_use_id"].is_null() => {
                        if let Some(uuid) = value["uuid"].as_str() {
                            newest = Some(uuid.to_string());
                        }
                    }
                    _ => {}
                }
                if let Some(id) = session_id_of_init(&value) {
                    saw_init = true;
                    on_session(&id)?;
                    emit(&AgentEvent::Started { session_id: Some(id) });
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
                    emit(&event);
                }
            }
            _ = cancel.changed() => {
                let _ = child.kill().await;
                let _ = rewind::set_claude_tail(args.session_dir, newest.as_deref());
                return Ok(Outcome::Interrupted);
            }
        }
    }
    let _ = rewind::set_claude_tail(args.session_dir, newest.as_deref());

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
        return Err(Error::msg(format!("{NAME} stopped unexpectedly: {detail}")));
    }
    Ok(Outcome::Done)
}

fn mcp_config_json(exe: &Path, servers: &serde_json::Map<String, Value>) -> String {
    let mut servers = servers.clone();
    servers.insert(
        mcp::SERVER.into(),
        json!({
            "type": "stdio",
            "command": exe,
            "args": [mcp::FLAG],
        }),
    );
    json!({ "mcpServers": servers }).to_string()
}

/// `--plugin-dir` for each plugin folder.
fn plugin_args(plugins: &[PathBuf]) -> Vec<String> {
    plugins
        .iter()
        .flat_map(|p| ["--plugin-dir".into(), p.to_string_lossy().into_owned()])
        .collect()
}

/// Writes `path` unless it already holds `contents`. Turns in other decks may be reading
/// it, so it is replaced whole rather than rewritten in place.
fn write_if_changed(path: &Path, contents: &str) -> Result<()> {
    if std::fs::read_to_string(path).ok().as_deref() == Some(contents) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, contents)?;
    std::fs::rename(&temp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })?;
    Ok(())
}

fn build_args(
    system_prompt: &Path,
    mcp_config: &Path,
    session_dir: &Path,
    model: Option<&str>,
    effort: Option<&str>,
    session: Option<&str>,
    mode: PermissionMode,
) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        cli_mode(mode),
        // Lets the user grant Full access while a turn runs (see [`set_mode`]).
        "--allow-dangerously-skip-permissions",
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

/// Claude Code's permission mode for `mode`. Outside Full access the app's handler decides
/// what asks (see [`permission`]).
fn cli_mode(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::FullAccess => "bypassPermissions",
        _ => "acceptEdits",
    }
}

/// Switches a running Claude Code to `mode`.
fn set_mode(id: &str, mode: PermissionMode) -> Value {
    json!({
        "type": "control_request",
        "request_id": id,
        "request": {"subtype": "set_permission_mode", "mode": cli_mode(mode)},
    })
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

fn user_message(prompt: &str) -> Value {
    json!({"type": "user", "message": {"role": "user", "content": prompt}})
}

/// A message for the running turn: priority `now` makes Claude Code stop what it is doing
/// (generating, or waiting on tools) and take the message in, rather than queue it.
fn steer_message(prompt: &str) -> Value {
    let mut message = user_message(prompt);
    message["priority"] = json!("now");
    message
}

/// The result Claude Code reports for the segment a steer cut short; more follows.
fn is_steer_abort(result: &Value) -> bool {
    matches!(
        result["terminal_reason"].as_str(),
        Some("aborted_streaming" | "aborted_tools")
    )
}

/// Answers control request `id`: `Ok` with the response, `Err` with a refusal.
fn control_response(id: &Value, reply: std::result::Result<Value, &str>) -> Value {
    let response = match reply {
        Ok(response) => json!({"subtype": "success", "request_id": id, "response": response}),
        Err(error) => json!({"subtype": "error", "request_id": id, "error": error}),
    };
    json!({"type": "control_response", "response": response})
}

enum Permission {
    /// Answered without the user.
    Answer(std::result::Result<Value, &'static str>),
    /// The user decides.
    Ask(Approval, Choices),
}

/// How to answer one Claude Code control request. Only tool permission prompts are
/// handled: the app's MCP tools, reads of the templates staged in `session_dir` and
/// everything under Full access are allowed outright, anything else asks the user.
fn permission(request: &Value, mode: PermissionMode, session_dir: &Path) -> Permission {
    if request["subtype"] != "can_use_tool" {
        return Permission::Answer(Err("SlopSlide does not support this request."));
    }
    let tool = request["tool_name"].as_str().unwrap_or_default();
    let input = &request["input"];
    let allow = json!({"behavior": "allow", "updatedInput": input});
    if mode == PermissionMode::FullAccess
        || mcp::is_claude_tool(tool)
        || reads_staged_template(tool, input, session_dir)
    {
        return Permission::Answer(Ok(allow));
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
    let for_session = (!rules.is_empty()).then(|| {
        let mut session = allow.clone();
        session["updatedPermissions"] = json!(rules);
        session
    });
    let (decisions, choices) = permissions::offer(
        allow,
        for_session,
        json!({"behavior": "deny", "message": "The user declined this request."}),
    );
    Permission::Ask(Approval::new(title, reason, details, decisions), choices)
}

/// Whether `tool` reads a template staged in `session_dir` (see [`crate::templates::stage`]):
/// a style the user picked, so reading it never asks.
fn reads_staged_template(tool: &str, input: &Value, session_dir: &Path) -> bool {
    let Some(path) = input["file_path"].as_str().map(Path::new) else {
        return false;
    };
    if tool != "Read" {
        return false;
    }
    path.is_absolute()
        && !path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        && path.starts_with(session_dir.join(crate::templates::STAGED_DIR))
}

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
                context_tokens(&value["message"]["usage"]).map(|tokens| AgentEvent::Usage {
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
fn context_tokens(usage: &Value) -> Option<u64> {
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
mod tests;
