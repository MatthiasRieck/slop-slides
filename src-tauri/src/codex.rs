//! Drives OpenAI Codex through `codex app-server`, one process per turn: its JSON-RPC
//! connection, the thread and turn requests, its permission policies and approval requests,
//! and the models it offers.
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{mpsc, watch};

use crate::agent::{
    tool_images, tool_output, AgentEvent, Outcome, Steers, TurnArgs, SYSTEM_PROMPT,
};
use crate::error::{Error, Result};
use crate::extensions::{self, Extensions};
use crate::permissions::{self, Answer, Approval, Choices, Decision, PermissionMode, Run};
use crate::providers::ModelInfo;
use crate::{env, mcp, rewind};

/// A `codex app-server` process and its newline-delimited JSON-RPC connection.
struct Server {
    child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    next_id: u64,
    buffered: VecDeque<Value>,
    active_turn: Option<(String, String)>,
}
impl Server {
    /// `config` holds `-c` overrides.
    fn spawn(bin: &Path, cwd: Option<&Path>, config: &[String]) -> Result<Self> {
        Self::start(bin, cwd, config, "Codex app-server")
    }
    /// Starts the server; errors name it `name`.
    fn start(bin: &Path, cwd: Option<&Path>, config: &[String], name: &str) -> Result<Self> {
        let mut cmd = crate::process::command(bin)?;
        cmd.arg("app-server").args(config);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = cmd
            .spawn()
            .map_err(|e| Error::msg(format!("Could not start {name}: {e}")))?;
        Ok(Self {
            stdin: child.stdin.take().expect("piped stdin"),
            lines: BufReader::new(child.stdout.take().expect("piped stdout")).lines(),
            child,
            next_id: 0,
            buffered: VecDeque::new(),
            active_turn: None,
        })
    }
    async fn send(&mut self, value: &Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(value).expect("serializable JSON");
        bytes.push(b'\n');
        self.stdin.write_all(&bytes).await?;
        self.stdin.flush().await?;
        Ok(())
    }
    async fn next(&mut self) -> Result<Value> {
        if let Some(v) = self.buffered.pop_front() {
            return Ok(v);
        }
        self.read().await
    }
    async fn read(&mut self) -> Result<Value> {
        self.read_message()
            .await?
            .ok_or_else(|| Error::msg("Codex app-server exited before finishing the turn."))
    }
    /// The next JSON message, skipping lines that are not; None once the server exits.
    async fn read_message(&mut self) -> Result<Option<Value>> {
        while let Some(line) = self.lines.next_line().await? {
            if let Ok(v) = serde_json::from_str(&line) {
                return Ok(Some(v));
            }
        }
        Ok(None)
    }
    /// Sends request `method` and returns its result, keeping the notifications and requests
    /// that arrive meanwhile for [`Server::next`].
    async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(&json!({"id":id,"method":method,"params":params}))
            .await?;
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let v = self.read().await?;
                if v.get("method").is_some() {
                    self.buffered.push_back(v);
                    continue;
                }
                if v["id"] != id {
                    continue;
                }
                if v.get("error").is_some() {
                    return Err(Error::msg(format!(
                        "Codex {method}: {}",
                        v["error"]["message"].as_str().unwrap_or("request failed")
                    )));
                }
                return Ok(v["result"].clone());
            }
        })
        .await
        .map_err(|_| Error::msg(format!("Codex {method} timed out.")))?
    }
    /// Sends request `method` and returns its result, dropping everything else that arrives:
    /// for short exchanges outside a turn, such as listing the models.
    async fn probe(&mut self, method: &str, params: Value) -> Result<Value> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(&json!({"id":id,"method":method,"params":params}))
            .await?;
        while let Some(message) = self.read_message().await? {
            // Skip notifications and server-initiated requests.
            if message.get("method").is_some() || message["id"].as_u64() != Some(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                let detail = error["message"].as_str().unwrap_or("unknown error");
                return Err(Error::msg(format!("Codex {method} failed: {detail}")));
            }
            return Ok(message["result"].clone());
        }
        Err(Error::msg("Codex exited before answering."))
    }
    async fn reject_unknown(&mut self, v: &Value) -> Result<()> {
        self.send(&json!({"id":v["id"],"error":{"code":-32601,"message":"SlopSlide does not support this interactive request; no permission was granted."}})).await
    }
    async fn initialize(&mut self) -> Result<()> {
        self.request("initialize",json!({"clientInfo":{"name":"slopslide","title":"SlopSlide","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}})).await?;
        self.send(&json!({"method":"initialized"})).await
    }
    async fn configuration(&mut self, dir: &Path) -> Result<(Value, Value)> {
        let config = self.request("config/read", json!({"cwd":dir})).await?;
        let requirements = self.request("configRequirements/read", Value::Null).await?;
        Ok((
            config["config"].clone(),
            requirements["requirements"].clone(),
        ))
    }
}

/// How long Codex lets a tool of the app's MCP server run; generating narration audio for a
/// whole deck takes minutes, far past Codex's 60-second default.
const MCP_TOOL_TIMEOUT_SECS: u32 = 3600;

/// `-c` overrides that add the app's MCP server, its tools approved up front.
fn mcp_config_args(exe: &Path, dir: &Path, session: &Path) -> Vec<String> {
    let server = mcp::SERVER;
    let command = serde_json::to_string(&exe.to_string_lossy()).expect("serializable path");
    let args = json!(mcp::launch_args(dir, session));
    [
        format!("mcp_servers.{server}.command={command}"),
        format!("mcp_servers.{server}.args={args}"),
        format!("mcp_servers.{server}.default_tools_approval_mode=\"approve\""),
        format!("mcp_servers.{server}.tool_timeout_sec={MCP_TOOL_TIMEOUT_SECS}"),
    ]
    .into_iter()
    .flat_map(|value| ["-c".to_string(), value])
    .collect()
}

/// The skill folders Codex does not find itself: it reads the workspace's `.agents/skills`
/// but not the app home's or the plugins'.
fn skill_roots(ext: &Extensions) -> Vec<PathBuf> {
    ext.user_skills
        .iter()
        .cloned()
        .chain(ext.plugin_skill_folders())
        .collect()
}

fn allowed(requirements: &Value, key: &str, value: &str) -> bool {
    requirements[key]
        .as_array()
        .map_or(true, |a| a.iter().any(|v| v == value))
}
fn supported_modes(config: &Value, requirements: &Value) -> Vec<PermissionMode> {
    let reviewer = config.get("approvals_reviewer").is_some();
    let mut modes = Vec::new();
    if allowed(requirements, "allowedSandboxModes", "workspace-write")
        && allowed(requirements, "allowedApprovalPolicies", "on-request")
    {
        if !reviewer || allowed(requirements, "allowedApprovalsReviewers", "user") {
            modes.push(PermissionMode::Ask);
        }
        if reviewer && allowed(requirements, "allowedApprovalsReviewers", "auto_review") {
            modes.push(PermissionMode::AutoReview);
        }
    }
    if allowed(requirements, "allowedSandboxModes", "danger-full-access")
        && allowed(requirements, "allowedApprovalPolicies", "never")
        && (!reviewer || allowed(requirements, "allowedApprovalsReviewers", "user"))
    {
        modes.push(PermissionMode::FullAccess);
    }
    modes.push(PermissionMode::Custom);
    modes
}

pub async fn permission_modes(dir: &Path) -> Result<Vec<PermissionMode>> {
    let bin = env::resolve_codex().ok_or_else(|| Error::msg("Codex is not installed."))?;
    let mut server = Server::spawn(&bin, Some(dir), &[])?;
    server.initialize().await?;
    let (config, requirements) = server.configuration(dir).await?;
    Ok(supported_modes(&config, &requirements))
}

/// Models the signed-in account may use: every page of `model/list`, from a short-lived
/// `codex app-server`.
pub async fn list_models(bin: &Path) -> Result<Vec<ModelInfo>> {
    let mut server = Server::start(bin, None, &[], "Codex")?;
    server
        .probe(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "slopslide",
                    "title": "SlopSlide",
                    "version": env!("CARGO_PKG_VERSION"),
                },
            }),
        )
        .await?;
    server.send(&json!({ "method": "initialized" })).await?;

    let mut models = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let params = match &cursor {
            Some(cursor) => json!({ "cursor": cursor }),
            None => json!({}),
        };
        let page = server.probe("model/list", params).await?;
        models.extend(
            page["data"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(parse_model),
        );
        cursor = page["nextCursor"].as_str().map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    let _ = server.child.kill().await;
    Ok(models)
}

fn parse_model(model: &Value) -> Option<ModelInfo> {
    if model["hidden"].as_bool().unwrap_or(false) {
        return None;
    }
    let id = model["model"].as_str()?.to_string();
    let name = model["displayName"].as_str().unwrap_or(&id);
    Some(ModelInfo {
        label: format_name(name),
        is_default: model["isDefault"].as_bool().unwrap_or(false),
        efforts: model["supportedReasoningEfforts"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|e| e["reasoningEffort"].as_str().map(str::to_string))
            .collect(),
        default_effort: model["defaultReasoningEffort"].as_str().map(str::to_string),
        context_windows: Vec::new(),
        default_context_window: None,
        id,
    })
}

/// `gpt-6-astra` → `GPT-6-Astra`, matching T3 Code.
fn format_name(name: &str) -> String {
    let name = match name.get(..3) {
        Some(prefix) if prefix.eq_ignore_ascii_case("gpt") => format!("GPT{}", &name[3..]),
        _ => name.to_string(),
    };
    let mut out = String::with_capacity(name.len());
    let mut after_dash = false;
    for c in name.chars() {
        out.push(if after_dash {
            c.to_ascii_uppercase()
        } else {
            c
        });
        after_dash = c == '-';
    }
    out
}

/// The `thread/start`/`thread/resume` parameters for a turn in `mode`.
fn thread_params(args: &TurnArgs<'_>, mode: PermissionMode, config: &Value) -> Value {
    let instructions = args.extensions.system_prompt(SYSTEM_PROMPT);
    let mut p = json!({"cwd":args.dir,"developerInstructions":instructions});
    if let Some(model) = args.model {
        p["model"] = json!(model);
    }
    // Custom must explicitly restore current config when resuming a previously unrestricted thread.
    let (sandbox, policy, reviewer) = match mode {
        PermissionMode::Ask => (json!("workspace-write"), json!("on-request"), json!("user")),
        PermissionMode::AutoReview => (
            json!("workspace-write"),
            json!("on-request"),
            json!("auto_review"),
        ),
        PermissionMode::FullAccess => (json!("danger-full-access"), json!("never"), json!("user")),
        PermissionMode::Custom => (
            config["sandbox_mode"]
                .as_str()
                .map_or(json!("read-only"), |v| json!(v)),
            config
                .get("approval_policy")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(json!("on-request")),
            config
                .get("approvals_reviewer")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(json!("user")),
        ),
    };
    p["sandbox"] = sandbox;
    p["approvalPolicy"] = policy;
    if config.get("approvals_reviewer").is_some() {
        p["approvalsReviewer"] = reviewer;
    }
    if mode != PermissionMode::Custom && mode != PermissionMode::FullAccess {
        p["config"] = json!({"sandbox_workspace_write.network_access":false});
    }
    p
}

/// Runs one turn. Codex fixes the permission policy as the turn starts: a mode the user picks
/// while it runs applies to the next turn. `on_session` persists the thread id once known.
pub(crate) async fn run_turn(
    args: TurnArgs<'_>,
    cancel: &mut watch::Receiver<bool>,
    steers: &mut Steers,
    emit: &(dyn Fn(&AgentEvent) + Sync),
    on_session: &(dyn Fn(&str) -> Result<()> + Sync),
) -> Result<Outcome> {
    let mode = *args.mode.borrow();
    let mut warnings = Vec::new();
    let mut config = mcp_config_args(args.lint_server, args.dir, args.session_dir);
    config.extend(extensions::codex_config_args(
        &args.extensions.all_mcp_servers(),
        &mut warnings,
    ));
    for message in warnings {
        emit(&AgentEvent::Error { message });
    }
    let mut server = Server::spawn(args.bin, Some(args.dir), &config)?;
    let (run, mut answers) = args.approvals.start(args.chat);
    // Cancellation covers initialization/resume as well as generation and approval waits.
    if *cancel.borrow() {
        return Ok(Outcome::Interrupted);
    }
    tokio::select! {
        biased;
        _ = cancel.changed() => {
            // Give Codex a chance to stop its tools before killing the server process.
            if let Some((thread, turn)) = server.active_turn.clone() {
                let _ = tokio::time::timeout(Duration::from_secs(2), async {
                    server.request("turn/interrupt", json!({"threadId":thread,"turnId":turn})).await?;
                    loop {
                        let v = server.next().await?;
                        if v["method"] == "turn/completed" && v["params"]["turn"]["id"] == turn {
                            return Ok::<(), Error>(());
                        }
                    }
                }).await;
            }
            Ok(Outcome::Interrupted)
        },
        result = connected_turn(&mut server, &args, mode, &run, &mut answers, steers, emit, on_session) => result,
    }
    // Server's kill_on_drop closes the transport, including any pending approvals.
}

#[allow(clippy::too_many_arguments)]
async fn connected_turn(
    server: &mut Server,
    args: &TurnArgs<'_>,
    mode: PermissionMode,
    run: &Run,
    answers: &mut mpsc::UnboundedReceiver<Answer>,
    steers: &mut Steers,
    emit: &(dyn Fn(&AgentEvent) + Sync),
    on_session: &(dyn Fn(&str) -> Result<()> + Sync),
) -> Result<Outcome> {
    server.initialize().await?;
    let roots = skill_roots(args.extensions);
    if !roots.is_empty() {
        if let Err(e) = server
            .request("skills/extraRoots/set", json!({"extraRoots": roots}))
            .await
        {
            emit(&AgentEvent::Error {
                message: format!("Codex could not load the skills from ~/.slopslides: {e}"),
            });
        }
    }
    let (config, requirements) = server.configuration(args.dir).await?;
    if !supported_modes(&config, &requirements).contains(&mode) {
        return Err(Error::msg(
            "This permission mode is unavailable in your Codex configuration. Select another mode.",
        ));
    }
    let mut params = thread_params(args, mode, &config);
    let method = if let Some(id) = args.session {
        params["threadId"] = json!(id);
        "thread/resume"
    } else {
        "thread/start"
    };
    let response = match server.request(method, params).await {
        Ok(v) => v,
        Err(e) if args.session.is_some() && missing_thread(&e.to_string()) => {
            return Ok(Outcome::ResumeFailed)
        }
        Err(e) => return Err(e),
    };
    let thread = response["thread"]["id"]
        .as_str()
        .ok_or_else(|| Error::msg("Codex returned no thread ID."))?
        .to_string();
    on_session(&thread)?;
    emit(&AgentEvent::Started {
        session_id: Some(thread.clone()),
    });
    let mut prompt = std::borrow::Cow::Borrowed(args.prompt);
    if let Some((point, note)) = args.rewind.cut {
        let reverted = server
            .request(
                "thread/revert",
                json!({"threadId": thread, "beforeTurnId": point}),
            )
            .await;
        if reverted.is_err() {
            prompt = rewind::with_note(note, args.prompt).into();
        }
    }
    let started = Instant::now();
    let response = server
        .request(
            "turn/start",
            json!({
                "threadId": thread,
                "input": [{"type": "text", "text": prompt}],
                "effort": args.effort,
            }),
        )
        .await?;
    let turn = response["turn"]["id"]
        .as_str()
        .ok_or_else(|| Error::msg("Codex returned no turn ID."))?
        .to_string();
    if let Some(started) = args.rewind.started {
        started(Some(&turn));
    }
    server.active_turn = Some((thread.clone(), turn.clone()));
    let mut mapper = EventMapper::default();
    loop {
        let message = tokio::select! {
            biased;
            Some(answer) = answers.recv() => {
                server.send(&json!({"id":answer.wire_id,"result":answer.payload})).await?;
                emit(&AgentEvent::ApprovalResolved { id: answer.id });
                continue;
            }
            Some(steer) = steers.recv() => {
                // Fails once the turn is over: the message then starts the next turn.
                let steered = server
                    .request("turn/steer", steer_params(&thread, &turn, &steer.prompt))
                    .await;
                match steered {
                    Ok(_) => steer.delivered(emit),
                    Err(_) => steer.refused(),
                }
                continue;
            }
            message = server.next() => message?,
        };
        let method = message["method"].as_str().unwrap_or_default();
        let p = &message["params"];
        let request = message.get("id").is_some() && message.get("method").is_some();
        let other_thread = p["threadId"].as_str().is_some_and(|id| id != thread);
        let other_turn = p["turnId"].as_str().is_some_and(|id| id != turn);
        if other_thread || other_turn {
            if request {
                server.reject_unknown(&message).await?;
            }
            continue;
        }
        if request {
            // MCP elicitation is scoped to a thread; its turn correlation is optional.
            let scoped_mcp = method == "mcpServer/elicitation/request" && p["turnId"].is_null();
            if p["threadId"] != thread || (p["turnId"] != turn && !scoped_mcp) {
                server.reject_unknown(&message).await?;
                continue;
            }
            if builtin_mcp_request(method, p) {
                server
                    .send(&json!({"id":message["id"],"result":{"action":"accept","content":{}}}))
                    .await?;
                continue;
            }
            if let Some((approval, choices)) =
                approval_request(method, &mapper.approval_details(method, p))
            {
                run.ask(message["id"].clone(), &approval, choices);
                emit(&AgentEvent::ApprovalRequested { approval });
            } else {
                server.reject_unknown(&message).await?;
                emit(&AgentEvent::Error { message: format!("Codex requested an unsupported interaction ({method}); no permission was granted.") });
            }
            continue;
        }
        if method == "serverRequest/resolved" {
            if let Some(id) = run.resolved(&p["requestId"]) {
                emit(&AgentEvent::ApprovalResolved { id });
            }
        }
        for event in mapper.map(method, p) {
            emit(&event);
        }
        if method == "turn/completed" && p["turn"]["id"] == turn {
            let status = p["turn"]["status"].as_str().unwrap_or("failed");
            if status == "interrupted" {
                return Ok(Outcome::Interrupted);
            }
            let text = (status != "completed").then(|| {
                p["turn"]["error"]["message"]
                    .as_str()
                    .unwrap_or("Codex turn failed.")
                    .into()
            });
            emit(&AgentEvent::Result {
                is_error: status != "completed",
                text,
                cost_usd: None,
                duration_ms: Some(started.elapsed().as_millis() as u64),
            });
            return Ok(Outcome::Done);
        }
    }
}

/// Adds `prompt` to turn `turn` while it runs; Codex refuses it once that turn is over.
fn steer_params(thread: &str, turn: &str, prompt: &str) -> Value {
    json!({
        "threadId": thread,
        "expectedTurnId": turn,
        "input": [{"type": "text", "text": prompt}],
    })
}

fn missing_thread(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    m.contains("no rollout found")
        || m.contains("thread not found")
        || m.contains("no conversation found")
}

/// The app's own MCP tools need no approval; the server config already says so (see
/// [`Server::spawn`]), this covers Codex asking anyway.
fn builtin_mcp_request(method: &str, p: &Value) -> bool {
    method == "mcpServer/elicitation/request"
        && p["serverName"] == mcp::SERVER
        && p["_meta"]["codex_approval_kind"] == "mcp_tool_call"
        && p["_meta"]["codex_requires_user_input"] != true
}

fn approval_request(method: &str, p: &Value) -> Option<(Approval, Choices)> {
    if method == "mcpServer/elicitation/request" {
        return mcp_approval_request(p);
    }
    let permissions = method == "item/permissions/requestApproval";
    let (title, mut details) = match method {
        "item/commandExecution/requestApproval" => {
            if !p["networkApprovalContext"].is_null() {
                (
                    "Network access",
                    serde_json::to_string_pretty(&p["networkApprovalContext"]).ok()?,
                )
            } else {
                (
                    "Run a command",
                    p["command"]
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| serde_json::to_string_pretty(p).unwrap_or_default()),
                )
            }
        }
        "item/fileChange/requestApproval" => {
            ("Change files", serde_json::to_string_pretty(p).ok()?)
        }
        "item/permissions/requestApproval" => (
            "Additional permissions",
            serde_json::to_string_pretty(&p["permissions"]).ok()?,
        ),
        _ => return None,
    };
    if method == "item/commandExecution/requestApproval" {
        // A command approval may also grant access or send stdin to an existing process.
        // Keep that scope visible rather than displaying only the command text.
        let mut context = serde_json::Map::new();
        for key in ["cwd", "kind", "additionalPermissions"] {
            if let Some(value) = p.get(key).filter(|v| !v.is_null()) {
                context.insert(key.into(), value.clone());
            }
        }
        if !p["networkApprovalContext"].is_null() && !p["command"].is_null() {
            context.insert("command".into(), p["command"].clone());
        }
        if !context.is_empty() {
            details.push_str("\n\n");
            details.push_str(&serde_json::to_string_pretty(&context).ok()?);
        }
    }
    let choices = [
        Decision::Accept,
        Decision::AcceptForSession,
        Decision::Decline,
    ];
    let mut result = Choices::new();
    let mut decisions = Vec::new();
    for d in choices {
        let offered = if permissions {
            d != Decision::AcceptForSession
        } else {
            p["availableDecisions"]
                .as_array()
                .map_or(true, |a| a.iter().any(|v| v == d.key()))
        };
        if !offered {
            continue;
        }
        let value = if permissions {
            json!({"permissions":if d==Decision::Accept {p["permissions"].clone()}else{json!({})},"scope":"turn"})
        } else {
            json!({"decision":d.key()})
        };
        result.insert(d.key(), value);
        decisions.push(d);
    }
    Some((
        Approval {
            id: uuid::Uuid::new_v4().to_string(),
            title: title.into(),
            reason: p["reason"].as_str().map(str::to_string),
            details,
            accept_label: if permissions {
                "Allow for this turn"
            } else {
                "Allow once"
            }
            .into(),
            decisions,
            session_scope: None,
        },
        result,
    ))
}

/// Codex wraps MCP tool approvals in empty forms. These are confirmations, not input forms.
fn mcp_approval_request(p: &Value) -> Option<(Approval, Choices)> {
    let meta = &p["_meta"];
    let schema = &p["requestedSchema"];
    if p["mode"] != "form"
        || meta["codex_approval_kind"] != "mcp_tool_call"
        || meta["codex_requires_user_input"] == true
        || schema["type"] != "object"
        || !schema["properties"].as_object()?.is_empty()
        || schema["required"].as_array().is_some_and(|a| !a.is_empty())
    {
        return None;
    }
    let server = p["serverName"].as_str()?;
    let message = p["message"].as_str()?;
    let persist = &meta["persist"];
    let for_session = (persist == "session"
        || persist
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == "session")))
    .then(|| json!({"action":"accept","content":{},"_meta":{"persist":"session"}}));
    let (decisions, result) = permissions::offer(
        json!({"action":"accept","content":{}}),
        for_session,
        json!({"action":"decline"}),
    );
    let details = serde_json::to_string_pretty(&json!({"server":server,"tool":meta})).ok()?;
    Some((
        Approval::new("Use an MCP tool", Some(message.into()), details, decisions),
        result,
    ))
}

#[derive(Default)]
struct EventMapper {
    text_started: HashSet<String>,
    streamed: HashSet<String>,
    tools: HashSet<String>,
    items: HashMap<String, Value>,
}
impl EventMapper {
    fn approval_details(&self, method: &str, p: &Value) -> Value {
        let mut details = p.clone();
        if method == "item/fileChange/requestApproval" {
            if let Some(item) = p["itemId"].as_str().and_then(|id| self.items.get(id)) {
                details["changes"] = item["changes"].clone();
            }
        }
        details
    }
    fn map(&mut self, method: &str, p: &Value) -> Vec<AgentEvent> {
        match method {
            "turn/started" => vec![AgentEvent::Thinking],
            "item/agentMessage/delta" => {
                let id = p["itemId"].as_str().unwrap_or_default().to_string();
                self.streamed.insert(id.clone());
                let mut e = Vec::new();
                if self.text_started.insert(id) {
                    e.push(AgentEvent::TextStart);
                }
                if let Some(text) = p["delta"].as_str() {
                    e.push(AgentEvent::TextDelta { text: text.into() });
                }
                e
            }
            "item/started" | "item/completed" => {
                let item = &p["item"];
                let id = item["id"].as_str().unwrap_or_default().to_string();
                let complete = method == "item/completed";
                if !complete {
                    self.items.insert(id.clone(), item.clone());
                }
                if item["type"] == "agentMessage" {
                    if complete && !self.streamed.contains(&id) {
                        return vec![
                            AgentEvent::TextStart,
                            AgentEvent::TextDelta {
                                text: item["text"].as_str().unwrap_or_default().into(),
                            },
                        ];
                    }
                    return Vec::new();
                }
                let Some((name, input)) = tool(item) else {
                    return Vec::new();
                };
                let mut events = Vec::new();
                if self.tools.insert(id.clone()) {
                    events.push(AgentEvent::ToolUse {
                        id: id.clone(),
                        name,
                        input,
                    });
                }
                if complete {
                    events.push(AgentEvent::ToolResult {
                        id,
                        is_error: item["status"] == "failed"
                            || item["status"] == "declined"
                            || item["exitCode"].as_i64().is_some_and(|n| n != 0),
                        output: output(item),
                        images: tool_images(&item["result"]),
                    });
                }
                events
            }
            "thread/tokenUsage/updated" => vec![AgentEvent::Usage {
                context_tokens: p["tokenUsage"]["last"]["totalTokens"].as_u64(),
                context_window: p["tokenUsage"]["modelContextWindow"].as_u64(),
            }],
            "item/autoApprovalReview/started" | "item/autoApprovalReview/completed" => {
                vec![AgentEvent::ApprovalReview {
                    id: p["reviewId"].as_str().unwrap_or_default().into(),
                    status: p["review"]["status"].as_str().unwrap_or("reviewing").into(),
                    detail: p["review"]["rationale"].as_str().map(str::to_string),
                }]
            }
            "error" if !p["willRetry"].as_bool().unwrap_or(false) => vec![AgentEvent::Error {
                message: p["error"]["message"]
                    .as_str()
                    .unwrap_or("Codex reported an error.")
                    .into(),
            }],
            _ => Vec::new(),
        }
    }
}
fn tool(item: &Value) -> Option<(String, Value)> {
    match item["type"].as_str()? {
        "commandExecution" => Some(("Bash".into(), json!({"command":item["command"]}))),
        "fileChange" => Some((
            "Edit".into(),
            json!({"file_path":item["changes"].as_array().and_then(|a|a.first()).map(|v|v["path"].clone())}),
        )),
        "mcpToolCall" => Some((
            item["tool"].as_str().unwrap_or("Tool").into(),
            item["arguments"].clone(),
        )),
        "webSearch" => Some(("WebSearch".into(), json!({"query":item["query"]}))),
        _ => None,
    }
}

/// What a finished tool item gave back: a command's output, the diffs of a file change, or an
/// MCP tool's result (or why it failed).
fn output(item: &Value) -> Option<String> {
    match item["type"].as_str()? {
        "commandExecution" => tool_output(&item["aggregatedOutput"]),
        "fileChange" => tool_output(&Value::Array(
            item["changes"]
                .as_array()?
                .iter()
                .map(|change| change["diff"].clone())
                .filter(Value::is_string)
                .collect(),
        )),
        "mcpToolCall" => {
            tool_output(&item["result"]).or_else(|| tool_output(&item["error"]["message"]))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests;
