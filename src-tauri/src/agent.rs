//! Runs the agent's turns, one at a time per chat (a deck's, or a folder's own: see
//! [`crate::sessions`]), provider-neutrally: a turn resumes the chat's session, takes back what the user rewound, and is guarded, steered,
//! interrupted and reported the same way whichever CLI runs it. The CLIs are driven by their
//! own modules, all given a [`TurnArgs`]: Claude Code ([`crate::claude`]), OpenAI Codex
//! ([`crate::codex`]) and GitHub Copilot ([`crate::copilot`]). Their events are normalized
//! into [`AgentEvent`]s and emitted to the frontend as `agent-event`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, oneshot, watch};

use crate::env;
use crate::error::{Error, Result};
use crate::extensions::Extensions;
use crate::mcp;
use crate::permissions::{Approval, Approvals, LiveMode, PermissionMode};
use crate::rewind;
use crate::sessions::Sessions;
use crate::{claude, codex, copilot};

mod deltas;

/// The most of a tool's output the chat keeps, in characters: it is shown on demand and saved
/// with the chat.
pub(crate) const TOOL_OUTPUT_LIMIT: usize = 20_000;

/// A tool's output as the chat shows it: `value` is its text, its content blocks, or an object
/// holding either as `content`. Blocks that are not text (a screenshot the agent read) are only
/// named, never carried along. Long output is cut to [`TOOL_OUTPUT_LIMIT`].
pub(crate) fn tool_output(value: &Value) -> Option<String> {
    let text = match value {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| match (block.as_str(), block["text"].as_str()) {
                (Some(text), _) | (_, Some(text)) => Some(text.to_string()),
                _ => block["type"].as_str().map(|kind| format!("[{kind}]")),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(_) => return tool_output(&value["content"]),
        _ => return None,
    };
    let text = text.trim_end();
    if text.trim().is_empty() {
        return None;
    }
    Some(cut_short(text).unwrap_or_else(|| text.to_string()))
}

/// `text` cut to its first [`TOOL_OUTPUT_LIMIT`] characters, saying how many more there were;
/// None when it is no longer than that.
fn cut_short(text: &str) -> Option<String> {
    // No more bytes than the limit means no more characters either: nothing to count.
    if text.len() <= TOOL_OUTPUT_LIMIT {
        return None;
    }
    let (cut, _) = text.char_indices().nth(TOOL_OUTPUT_LIMIT)?;
    let more = text[cut..].chars().count();
    Some(format!("{}\n… ({more} more characters)", &text[..cut]))
}

/// A tool's input as the chat shows and keeps it: `input` with every long text in it cut to
/// [`TOOL_OUTPUT_LIMIT`], like a tool's output; None when nothing in it is that long. The agent
/// writes a whole deck as one argument of a `Write`, and the chat is saved with every tool call
/// in it after each turn. The start of each text stays, where an edit names the slide it is of
/// (the chat finds the slide by the `id` in `new_string`), and short arguments like `file_path`
/// are as they were.
pub(crate) fn tool_input(input: &Value) -> Option<Value> {
    match input {
        Value::String(text) => cut_short(text).map(Value::String),
        Value::Array(items) => {
            let cut: Vec<Option<Value>> = items.iter().map(tool_input).collect();
            cut.iter().any(Option::is_some).then(|| {
                let kept = cut.into_iter().zip(items);
                Value::Array(
                    kept.map(|(cut, item)| cut.unwrap_or_else(|| item.clone()))
                        .collect(),
                )
            })
        }
        Value::Object(fields) => {
            let cut: Vec<Option<Value>> = fields.values().map(tool_input).collect();
            cut.iter().any(Option::is_some).then(|| {
                let kept = cut.into_iter().zip(fields);
                Value::Object(
                    kept.map(|(cut, (name, value))| {
                        (name.clone(), cut.unwrap_or_else(|| value.clone()))
                    })
                    .collect(),
                )
            })
        }
        _ => None,
    }
}

/// The images in a tool's output, as `data:` URLs: `value` is its content blocks, or an object
/// holding them as `content` or `contents`. A block carries its image the way Claude does
/// (`source.media_type` and `source.data`) or the way MCP does (`mimeType` and `data`).
pub(crate) fn tool_images(value: &Value) -> Vec<String> {
    match value {
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block["type"] == "image")
            .filter_map(|block| {
                let source = &block["source"];
                let kind = source["media_type"]
                    .as_str()
                    .or(block["mimeType"].as_str())?;
                let data = source["data"].as_str().or(block["data"].as_str())?;
                Some(format!("data:{kind};base64,{data}"))
            })
            .collect(),
        Value::Object(_) => ["content", "contents"]
            .iter()
            .flat_map(|key| tool_images(&value[*key]))
            .collect(),
        _ => Vec::new(),
    }
}

/// The agent's instructions, with the design reference it consults appended.
pub(crate) const SYSTEM_PROMPT: &str = concat!(
    include_str!("../prompts/system.md"),
    "\n\n",
    include_str!("../prompts/design-reference.md"),
);

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
    running: Mutex<HashMap<String, Running>>,
    pub approvals: Arc<Approvals>,
}

/// A chat's turn in progress: how to stop it and how to steer it.
struct Running {
    cancel: watch::Sender<bool>,
    steer: mpsc::UnboundedSender<Steer>,
    /// The turn's permission mode, which the user may change while it runs.
    mode: watch::Sender<PermissionMode>,
}

/// A message the user sent while a turn runs, to go into that turn rather than wait for it to
/// end. Dropping it unanswered tells the sender it did not get in.
#[derive(Debug)]
pub(crate) struct Steer {
    pub prompt: String,
    /// The chat message it comes from, reported back with [`AgentEvent::Steered`].
    pub message: Option<String>,
    reply: oneshot::Sender<bool>,
}

impl Steer {
    pub(crate) fn new(prompt: &str, message: Option<&str>) -> (Self, oneshot::Receiver<bool>) {
        let (reply, rx) = oneshot::channel();
        let steer = Steer {
            prompt: prompt.into(),
            message: message.map(str::to_string),
            reply,
        };
        (steer, rx)
    }

    /// The agent took the message into its turn; the chat shows it from here on.
    pub(crate) fn delivered(self, emit: &(dyn Fn(&AgentEvent) + Sync)) {
        emit(&AgentEvent::Steered {
            message: self.message,
        });
        let _ = self.reply.send(true);
    }

    /// The turn cannot take it (it is ending, or compacting); the sender runs it next.
    pub(crate) fn refused(self) {
        let _ = self.reply.send(false);
    }
}

/// The steers waiting for the running turn (see [`AgentManager::steer`]).
pub(crate) type Steers = mpsc::UnboundedReceiver<Steer>;

/// Steers for a turn nobody steers.
#[cfg(test)]
pub(crate) fn no_steers() -> Steers {
    mpsc::unbounded_channel().1
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
        /// What the tool gave back, as text (see [`tool_output`]); `None` when it gave none.
        output: Option<String>,
        /// The images the tool gave back (a slide it rendered, an image file it opened). A
        /// provider reports them as `data:` URLs (see [`tool_images`]); the frontend gets the
        /// absolute paths of the files they were saved as in the chat's session.
        images: Vec<String>,
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
    /// The user's message `message` went into the running turn; what follows answers it.
    Steered {
        message: Option<String>,
    },
    Finished {
        interrupted: bool,
    },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope<'a> {
    /// The chat the event belongs to, as the frontend named it (see [`SendArgs::chat`]).
    chat: &'a str,
    event: &'a AgentEvent,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendArgs {
    /// The folder the agent works in: the one the window has open.
    pub workspace: String,
    /// What the chat is about: the deck file's path, or the folder's for its own chat (also
    /// when left out).
    #[serde(default)]
    pub chat: Option<String>,
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
    /// The id of the chat message this turn answers, to take the conversation back to it.
    #[serde(default)]
    pub message: Option<String>,
    /// What the user wrote, to label the turn's changes in the decks' histories.
    #[serde(default)]
    pub label: Option<String>,
}

/// A path in one spelling, to compare what chats are about.
fn resolved(path: &str) -> PathBuf {
    Path::new(path)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(path))
}

/// What chat `chat` is about: an existing deck file or folder.
pub fn subject(chat: &str) -> Result<PathBuf> {
    let path = PathBuf::from(chat);
    let known = path.is_absolute() && (path.is_dir() || crate::deck::deck_file(chat).is_ok());
    if !known {
        return Err(Error::msg(format!("not a deck or a folder: {chat}")));
    }
    Ok(path.canonicalize()?)
}

/// Why a turn about `subject` cannot start beside the turns running in the chats `running`.
/// A folder's chat works on all its decks, so it does not run beside theirs; the chats of two
/// decks do run side by side.
fn conflict<'a>(
    mut running: impl Iterator<Item = &'a String>,
    subject: &Path,
) -> Option<&'static str> {
    running.find_map(|key| {
        let other = resolved(key);
        if other == subject {
            Some("The agent is still working in this chat.")
        } else if subject.starts_with(&other) || other.starts_with(subject) {
            Some("The agent is still working on this folder in another chat.")
        } else {
            None
        }
    })
}

impl AgentManager {
    /// Whether a turn runs in chat `chat`.
    pub fn is_running(&self, chat: &str) -> bool {
        let path = resolved(chat);
        self.running
            .lock()
            .unwrap()
            .keys()
            .any(|key| resolved(key) == path)
    }

    /// Whether a turn is at work on the deck `file`: one of the deck's own chat, or of the chat
    /// of a folder above it, which works on every deck in the folder.
    pub fn works_on(&self, file: &Path) -> bool {
        let file = file.canonicalize().unwrap_or_else(|_| file.to_path_buf());
        self.running
            .lock()
            .unwrap()
            .keys()
            .any(|key| file.starts_with(resolved(key)))
    }

    pub fn send(&self, app: AppHandle, args: SendArgs) -> Result<()> {
        let dir = crate::workspace::root(&args.workspace)?;
        let chat = args.chat.clone().unwrap_or_else(|| args.workspace.clone());
        let subject = subject(&chat)?;
        let app_home = crate::files::app_home()?;
        let session_dir = Sessions::new(&app_home).current_or_start(&subject)?;
        let bin = args.provider.resolve()?;
        let extensions = Extensions::load(&app_home, &dir);
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let (mode_tx, mode_rx) = watch::channel(args.permission_mode);
        let (steer_tx, steers) = mpsc::unbounded_channel();
        {
            let mut running = self.running.lock().unwrap();
            if let Some(why) = conflict(running.keys(), &subject) {
                return Err(Error::msg(why));
            }
            crate::sessions::claim_provider(&session_dir, args.provider)?;
            running.insert(
                chat.clone(),
                Running {
                    cancel: cancel_tx,
                    mode: mode_tx,
                    steer: steer_tx,
                },
            );
        }
        let approvals = self.approvals.clone();
        tauri::async_runtime::spawn(async move {
            let (emitter, key) = (app.clone(), chat.clone());
            // Streamed text goes out once a frame, not once per piece (see `deltas`).
            let events = deltas::Deltas::per_frame(move |event| {
                let _ = emitter.emit("agent-event", Envelope { chat: &key, event });
            });
            let turn = Turn {
                emit: Box::new(move |event| events.emit(event)),
                dir,
                app_home,
                session_dir,
                provider: args.provider,
                bin,
                model: args
                    .model
                    .filter(|m| !m.is_empty())
                    .map(|m| match args.provider {
                        Provider::Claude => claude::model(m, args.context_window.as_deref()),
                        _ => m,
                    }),
                effort: args.effort.filter(|e| !e.is_empty()),
                compact: args.compact,
                message: args.message.clone(),
                chat: chat.clone(),
                permission_mode: mode_rx,
                approvals,
                extensions,
                steers: tokio::sync::Mutex::new(steers),
            };
            let _renders =
                crate::render::start(app.clone(), turn.dir.clone(), turn.session_dir.clone());
            let _exports =
                crate::export::start(app.clone(), turn.dir.clone(), turn.session_dir.clone());
            for message in &turn.extensions.warnings {
                turn.emit(&AgentEvent::Error {
                    message: message.clone(),
                });
            }
            // A deck's chat answers for its deck alone: other chats may be at work beside it.
            let only = subject.is_file().then(|| subject.clone());
            let guard = crate::safety::start(
                turn.dir.clone(),
                only,
                turn.session_dir.clone(),
                turn.app_home.clone(),
            )
            .await;
            let change = crate::history::Change::chat(
                args.label.as_deref().unwrap_or(""),
                args.message.clone(),
            );
            let interrupted = match guard {
                Ok(guard) => {
                    let interrupted = turn.run_with_open_requests(&args.prompt, cancel_rx).await;
                    match crate::safety::finish(guard, change).await {
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
                .remove(&chat);
            turn.emit(&AgentEvent::Finished { interrupted });
        });
        Ok(())
    }

    pub fn interrupt(&self, chat: &str) {
        let running = self.running.lock().unwrap();
        // Whatever the spelling: a closing window names its chat by the resolved path.
        let path = resolved(chat);
        for (key, turn) in running.iter().filter(|(key, _)| resolved(key) == path) {
            self.approvals.cancel_workspace(key);
            let _ = turn.cancel.send(true);
        }
        self.approvals.cancel_workspace(chat);
    }

    /// Changes the permission mode of the turn running in `chat`, if any. Claude Code
    /// and GitHub Copilot apply it to the requests that follow (Full access also allows
    /// those waiting); Codex fixes its policy when the turn starts, so it applies next turn.
    pub fn set_permission_mode(&self, chat: &str, mode: PermissionMode) {
        if let Some(running) = self.running.lock().unwrap().get(chat) {
            running.mode.send_replace(mode);
        }
    }

    /// Sends `prompt` into the chat's running turn. False when there is no turn, or it
    /// could not take the message: the caller then runs it as the next turn.
    pub async fn steer(&self, chat: &str, prompt: &str, message: Option<&str>) -> bool {
        let (steer, delivered) = Steer::new(prompt, message);
        let sent = match self.running.lock().unwrap().get(chat) {
            Some(running) => running.steer.send(steer).is_ok(),
            None => false,
        };
        sent && delivered.await.unwrap_or(false)
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
    /// Where the files every deck's agent shares are written (see [`crate::files::app_home`]).
    app_home: PathBuf,
    /// The chat's session this turn belongs to: chat state, provider session ids.
    session_dir: PathBuf,
    provider: Provider,
    bin: PathBuf,
    model: Option<String>,
    effort: Option<String>,
    compact: bool,
    /// The chat message the turn answers (see [`SendArgs::message`]).
    message: Option<String>,
    /// The chat the turn runs in (see [`SendArgs::chat`]), which its approvals belong to.
    chat: String,
    permission_mode: LiveMode,
    approvals: Arc<Approvals>,
    /// The user's MCP servers, skills, plugins and instructions.
    extensions: Extensions,
    /// Messages to send into the turn while it runs.
    steers: tokio::sync::Mutex<Steers>,
}

/// How a provider's turn ended.
pub(crate) enum Outcome {
    Done,
    Interrupted,
    /// The stored session could not be resumed; the turn did not run.
    ResumeFailed,
}

/// What a provider's turn runs with (see [`claude::run_turn`], [`codex::run_turn`],
/// [`copilot::run_turn`]).
pub(crate) struct TurnArgs<'a> {
    /// The provider's CLI.
    pub bin: &'a Path,
    /// The workspace root, where the agent works.
    pub dir: &'a Path,
    /// Where the files every deck's agent shares are written (see [`crate::files::app_home`]).
    pub app_home: &'a Path,
    /// The chat's session the turn belongs to (see [`crate::sessions`]).
    pub session_dir: &'a Path,
    /// This app's binary, which serves the app's MCP tools (`mcp.rs`).
    pub lint_server: &'a Path,
    /// The chat the turn runs in, which its approvals belong to.
    pub chat: &'a str,
    pub prompt: &'a str,
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    /// The provider's session to resume; a new conversation when None.
    pub session: Option<&'a str>,
    /// Summarize the session's history instead of sending `prompt`.
    pub compact: bool,
    /// The turn's permission mode, which the user may change while it runs.
    pub mode: LiveMode,
    pub approvals: Arc<Approvals>,
    pub extensions: &'a Extensions,
    pub rewind: rewind::TurnRewind<'a>,
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

    /// Reports `event`; the images of a tool's output are saved in the session first, and
    /// reported as those files (one that cannot be saved is left out), and the long texts of a
    /// tool's input are cut short (see [`tool_input`]).
    fn emit(&self, event: &AgentEvent) {
        match event {
            AgentEvent::ToolUse { id, name, input } => match tool_input(input) {
                Some(input) => (self.emit)(&AgentEvent::ToolUse {
                    id: id.clone(),
                    name: name.clone(),
                    input,
                }),
                None => (self.emit)(event),
            },
            AgentEvent::ToolResult {
                id,
                is_error,
                output,
                images,
            } if !images.is_empty() => (self.emit)(&AgentEvent::ToolResult {
                id: id.clone(),
                is_error: *is_error,
                output: output.clone(),
                images: images
                    .iter()
                    .filter_map(|image| {
                        crate::sessions::save_tool_image(&self.session_dir, image).ok()
                    })
                    .collect(),
            }),
            _ => (self.emit)(event),
        }
    }

    /// Returns whether the turn was interrupted.
    async fn run(&self, prompt: &str, mut cancel: watch::Receiver<bool>) -> bool {
        let session_file = self.provider.session_file();
        let session = crate::sessions::read_session(&self.session_dir, session_file);
        if self.compact {
            if let Some(message) = compact_refusal(self.provider, session.as_deref()) {
                self.emit(&AgentEvent::Error {
                    message: message.into(),
                });
                return false;
            }
        }
        // A rewind the user asked for since the last turn (see `rewind`).
        let plan = if self.compact {
            None
        } else {
            rewind::take(&self.session_dir, self.provider).unwrap_or_default()
        };
        let mut session = session;
        let mut prompt = prompt.to_string();
        let mut cut = None;
        match plan {
            Some(rewind::Plan::Fresh) => {
                let _ = crate::sessions::write_session(&self.session_dir, session_file, None);
                session = None;
            }
            Some(rewind::Plan::At { point, note }) if session.is_some() => {
                cut = Some((point, note))
            }
            Some(rewind::Plan::At { note, .. } | rewind::Plan::Note(note)) => {
                prompt = rewind::with_note(&note, &prompt);
            }
            None => {}
        }
        let cut = cut
            .as_ref()
            .map(|(point, note)| (point.as_str(), note.as_str()));
        let mut outcome = self
            .run_once(&prompt, session.as_deref(), cut, &mut cancel)
            .await;
        if self.compact && matches!(outcome, Ok(Outcome::ResumeFailed)) {
            // Starting fresh would leave nothing to compact.
            let _ = crate::sessions::write_session(&self.session_dir, session_file, None);
            self.emit(&AgentEvent::Error {
                message: "The conversation could not be resumed, so there is nothing to compact."
                    .into(),
            });
            return false;
        }
        if matches!(outcome, Ok(Outcome::ResumeFailed)) {
            // The stored session is gone (other machine, cleared history): start fresh.
            let _ = crate::sessions::write_session(&self.session_dir, session_file, None);
            outcome = self.run_once(&prompt, None, None, &mut cancel).await;
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

    /// Records the provider's `point` where the turn of the user's message started.
    fn started_at(&self, point: Option<&str>) {
        if let Some(message) = &self.message {
            let _ = rewind::anchor(&self.session_dir, message, self.provider, point);
        }
    }

    /// One turn in `session` (or a new conversation), cut back at `cut` first (see
    /// [`rewind::TurnRewind::cut`]).
    async fn run_once(
        &self,
        prompt: &str,
        session: Option<&str>,
        cut: Option<(&str, &str)>,
        cancel: &mut watch::Receiver<bool>,
    ) -> Result<Outcome> {
        let mut steers = self.steers.lock().await;
        let steers = &mut *steers;
        let started = |point: Option<&str>| self.started_at(point);
        let lint_server = std::env::current_exe()?;
        let args = TurnArgs {
            bin: &self.bin,
            dir: &self.dir,
            app_home: &self.app_home,
            session_dir: &self.session_dir,
            lint_server: &lint_server,
            chat: &self.chat,
            prompt,
            model: self.model.as_deref(),
            effort: self.effort.as_deref(),
            session,
            compact: self.compact,
            mode: self.permission_mode.clone(),
            approvals: self.approvals.clone(),
            extensions: &self.extensions,
            rewind: rewind::TurnRewind {
                cut,
                started: Some(&started),
            },
        };
        let emit = |event: &AgentEvent| self.emit(event);
        let on_session = |id: &str| {
            crate::sessions::write_session(
                &self.session_dir,
                self.provider.session_file(),
                Some(id),
            )
        };
        match self.provider {
            Provider::Claude => claude::run_turn(args, cancel, steers, &emit, &on_session).await,
            Provider::Codex => codex::run_turn(args, cancel, steers, &emit, &on_session).await,
            Provider::Copilot => copilot::run_turn(args, cancel, steers, &emit, &on_session).await,
        }
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
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
    fn system_prompt_includes_the_design_reference() {
        assert!(SYSTEM_PROMPT.starts_with(include_str!("../prompts/system.md")));
        assert!(SYSTEM_PROMPT.ends_with(include_str!("../prompts/design-reference.md")));
        assert!(
            SYSTEM_PROMPT.contains("\"Design Reference\""),
            "system.md points at the reference by its title"
        );
        assert!(
            include_str!("../prompts/system.md")
                .contains("\"Hero Morphs\" in the design reference")
                && include_str!("../prompts/design-reference.md").contains("\n## Hero Morphs\n"),
            "the morph rule points at the reference's worked example"
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
    fn reads_tool_output_from_text_blocks_and_objects() {
        assert_eq!(tool_output(&json!("ok\n")), Some("ok".into()));
        assert_eq!(
            tool_output(&json!([{"type":"text","text":"a"},{"type":"text","text":"b"}])),
            Some("a\nb".into())
        );
        assert_eq!(
            tool_output(&json!({"content":"done","detailedContent":"more"})),
            Some("done".into())
        );
        assert_eq!(
            tool_output(&json!({"content":[{"type":"text","text":"x"}]})),
            Some("x".into())
        );
        for nothing in [
            json!(null),
            json!(""),
            json!("  \n"),
            json!([]),
            json!({}),
            json!(3),
        ] {
            assert_eq!(tool_output(&nothing), None, "{nothing}");
        }
    }

    /// A screenshot the agent read (the one Tidy layout sends) is named, not copied into the chat.
    #[test]
    fn names_images_in_tool_output_without_their_data() {
        let image = json!([
            {"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo"}}
        ]);
        assert_eq!(tool_output(&image), Some("[image]".into()));
        let mixed = json!([{"type":"text","text":"shot"}, image[0]]);
        assert_eq!(tool_output(&mixed), Some("shot\n[image]".into()));
    }

    #[test]
    fn finds_the_images_in_tool_output() {
        let claude = json!([
            {"type":"text","text":"Slide 1"},
            {"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo"}},
            {"type":"image","source":{"type":"url","url":"https://example.com/a.png"}}
        ]);
        assert_eq!(tool_images(&claude), ["data:image/png;base64,iVBORw0KGgo"]);
        let mcp = json!({"content":[
            {"type":"image","data":"/9j/4AAQ","mimeType":"image/jpeg"},
            {"type":"text","text":"done"},
            {"type":"image","data":"iVBORw0KGgo","mimeType":"image/png"}
        ]});
        assert_eq!(
            tool_images(&mcp),
            [
                "data:image/jpeg;base64,/9j/4AAQ",
                "data:image/png;base64,iVBORw0KGgo"
            ]
        );
        let copilot = json!({"content":"Viewed","contents":[{"type":"image","data":"R0lGOD","mimeType":"image/gif"}]});
        assert_eq!(tool_images(&copilot), ["data:image/gif;base64,R0lGOD"]);
        for nothing in [
            json!(null),
            json!("text"),
            json!([]),
            json!({"content":"text"}),
        ] {
            assert!(tool_images(&nothing).is_empty(), "{nothing}");
        }
    }

    #[test]
    fn cuts_long_tool_output() {
        let long = "é".repeat(TOOL_OUTPUT_LIMIT + 7);
        let output = tool_output(&json!(long)).unwrap();
        assert_eq!(
            output,
            format!("{}\n… (7 more characters)", "é".repeat(TOOL_OUTPUT_LIMIT))
        );
        let exact = "x".repeat(TOOL_OUTPUT_LIMIT);
        assert_eq!(tool_output(&json!(exact)), Some(exact));
    }

    #[test]
    fn cuts_the_long_texts_of_a_tool_input_and_leaves_the_rest() {
        let slide = "<section class=\"slide\" id=\"pricing\">";
        let long = format!("{slide}{}", "é".repeat(TOOL_OUTPUT_LIMIT));
        let input = json!({
            "file_path": "/d/talk/deck.html",
            "new_string": long,
            "old_string": "<p>short</p>",
            "replace_all": false,
            "edits": [{ "old_string": "a", "new_string": "x".repeat(TOOL_OUTPUT_LIMIT + 3) }],
        });
        let cut = tool_input(&input).expect("something was long");
        assert_eq!(cut["file_path"], "/d/talk/deck.html");
        assert_eq!(cut["old_string"], "<p>short</p>");
        assert_eq!(cut["replace_all"], false);
        let new_string = cut["new_string"].as_str().unwrap();
        assert!(
            new_string.starts_with(slide),
            "the start stays, where the edit names its slide"
        );
        let note = format!("\n… ({} more characters)", slide.chars().count());
        assert!(new_string.ends_with(&note), "as a tool's output is cut");
        assert_eq!(
            new_string.chars().count(),
            TOOL_OUTPUT_LIMIT + note.chars().count()
        );
        assert_eq!(cut["edits"][0]["old_string"], "a");
        assert_eq!(
            cut["edits"][0]["new_string"],
            format!("{}\n… (3 more characters)", "x".repeat(TOOL_OUTPUT_LIMIT))
        );
        let keys = |value: &Value| {
            value
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>()
        };
        assert_eq!(keys(&cut), keys(&input), "the arguments keep their order");
    }

    #[test]
    fn a_tool_input_without_long_text_is_not_copied() {
        let exact = "x".repeat(TOOL_OUTPUT_LIMIT);
        for input in [
            json!({ "file_path": "/d/deck.html", "content": exact, "limit": 3 }),
            json!({ "edits": [{ "old_string": "a", "new_string": "b" }] }),
            json!(null),
            json!("ls"),
        ] {
            assert_eq!(tool_input(&input), None, "{input}");
        }
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
                    output: None,
                    images: vec![],
                },
                json!({"type":"toolResult","id":"t","isError":true,"output":null,"images":[]}),
            ),
            (
                AgentEvent::ToolResult {
                    id: "t".into(),
                    is_error: false,
                    output: Some("ok".into()),
                    images: vec!["/s/tool-images/1.png".into()],
                },
                json!({"type":"toolResult","id":"t","isError":false,"output":"ok","images":["/s/tool-images/1.png"]}),
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
            (
                AgentEvent::Usage {
                    context_tokens: Some(12),
                    context_window: None,
                },
                json!({"type":"usage","contextTokens":12,"contextWindow":null}),
            ),
            (AgentEvent::Compacted, json!({"type":"compacted"})),
        ];
        for (event, expected) in cases {
            assert_eq!(serde_json::to_value(&event).unwrap(), expected);
        }
        let envelope = Envelope {
            chat: "talk",
            event: &AgentEvent::Thinking,
        };
        assert_eq!(
            serde_json::to_value(envelope).unwrap(),
            json!({"chat":"talk","event":{"type":"thinking"}})
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
        assert_eq!(args.chat, None, "the folder's own chat");
        let in_deck: SendArgs = serde_json::from_value(
            json!({"workspace":"talk","chat":"talk/deck.html","prompt":"Hi"}),
        )
        .unwrap();
        assert_eq!(in_deck.chat.as_deref(), Some("talk/deck.html"));
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
        assert!(!args.compact, "off unless asked");
        let args: SendArgs = serde_json::from_value(
            json!({"workspace":"d","prompt":"/compact","provider":"copilot","compact":true}),
        )
        .unwrap();
        assert!(args.compact);
    }

    #[test]
    fn changes_the_mode_of_the_running_turn_only() {
        let manager = AgentManager::default();
        let (cancel, _) = watch::channel(false);
        let (mode, live) = watch::channel(PermissionMode::Ask);
        let (steer, _) = mpsc::unbounded_channel();
        manager.running.lock().unwrap().insert(
            "talk".into(),
            Running {
                cancel,
                steer,
                mode,
            },
        );
        manager.set_permission_mode("talk", PermissionMode::FullAccess);
        assert_eq!(*live.borrow(), PermissionMode::FullAccess);
        manager.set_permission_mode("other", PermissionMode::Ask);
        assert_eq!(
            *live.borrow(),
            PermissionMode::FullAccess,
            "idle workspaces have no turn"
        );
    }

    /// A manager with a turn running in each of `chats`.
    fn manager_running(chats: &[&Path]) -> AgentManager {
        let manager = AgentManager::default();
        for chat in chats {
            let (cancel, _) = watch::channel(false);
            let (mode, _) = watch::channel(PermissionMode::Ask);
            let (steer, _) = mpsc::unbounded_channel();
            manager.running.lock().unwrap().insert(
                chat.to_string_lossy().into_owned(),
                Running {
                    cancel,
                    steer,
                    mode,
                },
            );
        }
        manager
    }

    #[test]
    fn a_turn_works_on_its_deck_or_on_every_deck_of_its_folder() {
        let temp = crate::test_support::TempDir::new("agent-chats");
        let folder = temp.join("talks");
        std::fs::create_dir_all(folder.join("q3")).unwrap();
        let (a, b) = (folder.join("a.html"), folder.join("q3").join("b.html"));
        std::fs::write(&a, "<html></html>").unwrap();
        std::fs::write(&b, "<html></html>").unwrap();

        // The chat of a deck: its deck alone.
        let manager = manager_running(&[&a]);
        assert!(manager.is_running(&a.to_string_lossy()));
        assert!(!manager.is_running(&folder.to_string_lossy()));
        assert!(manager.works_on(&a));
        assert!(!manager.works_on(&b));

        // The chat of a folder: every deck in it.
        let manager = manager_running(&[&folder]);
        assert!(manager.works_on(&a) && manager.works_on(&b));
        assert!(!manager.is_running(&a.to_string_lossy()));
        assert!(!manager.works_on(&temp.join("elsewhere.html")));
    }

    #[test]
    fn deck_chats_run_side_by_side_but_not_beside_their_folders() {
        let temp = crate::test_support::TempDir::canonical("agent-conflict");
        let folder = temp.join("talks");
        std::fs::create_dir_all(&folder).unwrap();
        let (a, b) = (folder.join("a.html"), folder.join("b.html"));
        std::fs::write(&a, "<html></html>").unwrap();
        std::fs::write(&b, "<html></html>").unwrap();
        let key = |path: &Path| path.to_string_lossy().into_owned();
        let running = [key(&a)];
        assert_eq!(conflict(running.iter(), &b), None);
        assert_eq!(
            conflict(running.iter(), &a),
            Some("The agent is still working in this chat.")
        );
        assert_eq!(
            conflict(running.iter(), &folder),
            Some("The agent is still working on this folder in another chat.")
        );
        let running = [key(&folder)];
        assert!(conflict(running.iter(), &a).is_some());
        assert_eq!(conflict([].iter(), &a), None);
    }

    #[test]
    fn a_chat_is_about_a_deck_file_or_a_folder() {
        let temp = crate::test_support::TempDir::canonical("agent-subject");
        let folder = temp.join("talks");
        std::fs::create_dir_all(&folder).unwrap();
        let deck = folder.join("deck.html");
        std::fs::write(&deck, "<html></html>").unwrap();
        std::fs::write(folder.join("notes.txt"), "x").unwrap();
        assert_eq!(subject(&folder.to_string_lossy()).unwrap(), folder);
        assert_eq!(subject(&deck.to_string_lossy()).unwrap(), deck);
        for bad in ["", "talks", &folder.join("notes.txt").to_string_lossy()] {
            assert!(subject(bad).is_err(), "{bad}");
        }
        assert!(subject(&folder.join("gone.html").to_string_lossy()).is_err());
    }

    #[test]
    fn interrupts_a_chats_turn_however_its_path_is_spelled() {
        let temp = crate::test_support::TempDir::new("agent-interrupt");
        let deck = temp.write("talks/a.html", "<html></html>");
        let other = temp.write("talks/b.html", "<html></html>");
        let manager = AgentManager::default();
        let mut stopped = Vec::new();
        for chat in [&deck, &other] {
            let (cancel, was_stopped) = watch::channel(false);
            let (mode, _) = watch::channel(PermissionMode::Ask);
            let (steer, _) = mpsc::unbounded_channel();
            stopped.push(was_stopped);
            manager.running.lock().unwrap().insert(
                chat.to_string_lossy().into_owned(),
                Running {
                    cancel,
                    steer,
                    mode,
                },
            );
        }
        // As a closing window names it: resolved.
        manager.interrupt(&deck.canonicalize().unwrap().to_string_lossy());
        assert!(*stopped[0].borrow());
        assert!(!*stopped[1].borrow(), "the other deck's turn goes on");
    }

    #[test]
    fn manager_tracks_nothing_by_default() {
        let manager = AgentManager::default();
        assert!(!manager.is_running("talk"));
        manager.interrupt("talk"); // no-op, must not panic
    }

    #[tokio::test]
    async fn steering_without_a_turn_does_not_get_in() {
        let manager = AgentManager::default();
        assert!(!manager.steer("talk", "Bluer", Some("m1")).await);
    }

    #[tokio::test]
    async fn steering_reaches_the_running_turn() {
        let manager = AgentManager::default();
        let (cancel, _) = watch::channel(false);
        let (steer, mut steers) = mpsc::unbounded_channel();
        let (mode, _) = watch::channel(PermissionMode::Ask);
        manager.running.lock().unwrap().insert(
            "talk".into(),
            Running {
                cancel,
                steer,
                mode,
            },
        );
        let turn = async {
            let steer = steers.recv().await.unwrap();
            assert_eq!(steer.prompt, "Bluer");
            assert_eq!(steer.message.as_deref(), Some("m1"));
            steer.delivered(&|_| {});
            // The turn ends: what is still waiting is refused.
            steers.recv().await.unwrap().refused();
        };
        let (first, second, ()) = tokio::join!(
            manager.steer("talk", "Bluer", Some("m1")),
            async {
                tokio::task::yield_now().await;
                manager.steer("talk", "Greener", None).await
            },
            turn
        );
        assert!(first);
        assert!(!second);
    }

    /// Runs whole turns against a shell script standing in for the `claude` CLI.
    #[cfg(unix)]
    mod process {
        use super::*;
        use crate::permissions::Decision;
        use crate::test_support::TempDir;
        use std::fs;
        use std::sync::Arc;
        use std::time::Duration;

        /// Where the fake `claude` logs its arguments and input, inside the test deck.
        const LOG_DIR: &str = ".test-log";

        struct Fixture {
            dir: TempDir,
            events: Arc<Mutex<Vec<AgentEvent>>>,
            /// How the user answers approval requests; unanswered when `None`.
            answer: Option<Decision>,
            mode: PermissionMode,
        }

        impl Fixture {
            /// A deck folder plus a fake `claude` that logs its arguments and stdin, then
            /// runs `body` (with `$RESUME` set when `--resume` was passed).
            fn new(body: &str) -> Self {
                let dir = TempDir::new("agent");
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
                crate::test_support::write_script(&claude, &script);
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
                    dir: self.dir.to_path_buf(),
                    app_home: self.dir.join("home"),
                    session_dir: self.session_dir(),
                    provider: Provider::Claude,
                    bin: claude,
                    model: model.map(str::to_string),
                    effort: None,
                    compact: false,
                    message: None,
                    chat: "test".into(),
                    permission_mode: crate::permissions::fixed_mode(self.mode),
                    approvals,
                    extensions: Extensions::default(),
                    steers: tokio::sync::Mutex::new(no_steers()),
                }
            }

            /// A turn plus the sender that steers it.
            fn steered_turn(&self) -> (Turn, mpsc::UnboundedSender<Steer>) {
                let mut turn = self.turn();
                let (tx, rx) = mpsc::unbounded_channel();
                turn.steers = tokio::sync::Mutex::new(rx);
                (turn, tx)
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
                crate::sessions::read_session(&self.session_dir(), Provider::Claude.session_file())
            }
        }

        const INIT: &str =
            r#"echo '{"type":"system","subtype":"init","session_id":"new-session"}'"#;
        const OK: &str = r#"echo '{"type":"result","subtype":"success","is_error":false,"result":"Done.","total_cost_usd":0.01,"duration_ms":5}'"#;

        fn has_flag(args: &[String], flag: &str, value: &str) -> bool {
            args.windows(2).any(|w| w[0] == flag && w[1] == value)
        }

        #[tokio::test]
        async fn a_steer_goes_into_the_running_turn() {
            // Claude Code ends the segment the steer cut short with a result of its own, then
            // answers the steer in the same process.
            let fx = Fixture::new(&format!(
                r#"{INIT}
IFS= read -r steer; printf '%s' "$steer" > "$LOG/steer.log"
echo '{{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_streaming"}}'
echo '{{"type":"stream_event","event":{{"type":"content_block_delta","delta":{{"type":"text_delta","text":"Blue"}}}}}}'
{OK}"#
            ));
            let (turn, steer) = fx.steered_turn();
            let (message, delivered) = Steer::new("Make it blue", Some("m2"));
            steer.send(message).unwrap();
            let (_cancel, rx) = watch::channel(false);
            let interrupted = tokio::time::timeout(Duration::from_secs(20), turn.run("Go", rx))
                .await
                .expect("turn timed out");
            assert!(!interrupted);
            assert_eq!(delivered.await, Ok(true));
            let line = fs::read_to_string(fx.dir.join(LOG_DIR).join("steer.log")).unwrap();
            let written: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(
                written,
                json!({"type": "user", "message": {"role": "user", "content": "Make it blue"}, "priority": "now"})
            );
            let events = fx.events();
            let steered = AgentEvent::Steered {
                message: Some("m2".into()),
            };
            let at = |wanted: &AgentEvent| events.iter().position(|e| e == wanted).unwrap();
            assert!(
                at(&steered)
                    < at(&AgentEvent::TextDelta {
                        text: "Blue".into()
                    })
            );
            let results: Vec<_> = events
                .iter()
                .filter(|e| matches!(e, AgentEvent::Result { .. }))
                .collect();
            assert_eq!(
                results,
                [&AgentEvent::Result {
                    is_error: false,
                    text: Some("Done.".into()),
                    cost_usd: Some(0.01),
                    duration_ms: Some(5)
                }],
                "the cut-short segment's result is not the turn's"
            );
            assert!(fx.errors().is_empty(), "{:?}", fx.errors());
        }

        #[tokio::test]
        async fn a_steer_after_the_result_does_not_get_in() {
            let fx = Fixture::new(&format!("{INIT}\n{OK}\nsleep 1"));
            let (turn, steer) = fx.steered_turn();
            let (_cancel, rx) = watch::channel(false);
            let late = async {
                while !fx
                    .events()
                    .iter()
                    .any(|e| matches!(e, AgentEvent::Result { .. }))
                {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                let (message, delivered) = Steer::new("Too late", None);
                steer.send(message).unwrap();
                delivered.await
            };
            let (interrupted, delivered) = tokio::time::timeout(Duration::from_secs(20), async {
                tokio::join!(turn.run("Go", rx), late)
            })
            .await
            .expect("turn timed out");
            assert!(!interrupted);
            assert_eq!(delivered, Ok(false));
            assert!(!fx
                .events()
                .iter()
                .any(|e| matches!(e, AgentEvent::Steered { .. })));
        }

        #[tokio::test]
        async fn a_compaction_takes_no_steer() {
            let fx = Fixture::new(&format!("{INIT}\n{OK}"));
            crate::sessions::write_session(&fx.session_dir(), "claude-session", Some("s1"))
                .unwrap();
            let (mut turn, steer) = fx.steered_turn();
            turn.compact = true;
            let (message, delivered) = Steer::new("Bluer", None);
            steer.send(message).unwrap();
            let (_cancel, rx) = watch::channel(false);
            tokio::time::timeout(Duration::from_secs(20), turn.run("ignored", rx))
                .await
                .expect("turn timed out");
            assert_eq!(delivered.await, Ok(false));
        }

        /// A slide the agent rendered, or an image file it opened: the chat gets the image as a
        /// file in the session, never its data, and an image that cannot be kept is left out.
        #[tokio::test]
        async fn saves_the_images_of_tool_output_in_the_session() {
            let fx = Fixture::new(&format!(
                r#"{INIT}
echo '{{"type":"assistant","message":{{"content":[{{"type":"tool_use","id":"t1","name":"Read","input":{{"file_path":"/d/shot.png"}}}}]}}}}'
echo '{{"type":"user","message":{{"content":[{{"type":"tool_result","tool_use_id":"t1","content":[{{"type":"text","text":"Slide intro"}},{{"type":"image","source":{{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}}}},{{"type":"image","source":{{"type":"base64","media_type":"image/png","data":"not base64!"}}}}]}}]}}}}'
{OK}"#
            ));
            fx.run("Look at it", None).await;
            let events = fx.events();
            let Some(AgentEvent::ToolResult { output, images, .. }) = events
                .iter()
                .find(|e| matches!(e, AgentEvent::ToolResult { .. }))
            else {
                panic!("no tool result: {events:?}");
            };
            assert_eq!(output.as_deref(), Some("Slide intro\n[image]\n[image]"));
            let [image] = &images[..] else {
                panic!("one image kept: {images:?}");
            };
            let image = Path::new(image);
            assert!(
                image.starts_with(fx.session_dir().join("tool-images")),
                "{image:?}"
            );
            assert_eq!(fs::read(image).unwrap(), b"\x89PNG\r\n\x1a\n");
        }

        /// A deck written whole is one argument of the tool call: the chat gets its start.
        #[tokio::test]
        async fn reports_a_tool_call_with_its_long_input_cut_short() {
            let content = format!(
                "<section class=\"slide\" id=\"a\">{}",
                "x".repeat(TOOL_OUTPUT_LIMIT)
            );
            let fx = Fixture::new(&format!(
                r#"{INIT}
echo '{{"type":"assistant","message":{{"content":[{{"type":"tool_use","id":"t1","name":"Write","input":{{"file_path":"/d/deck.html","content":"{}"}}}}]}}}}'
{OK}"#,
                content.replace('"', r#"\""#)
            ));
            fx.run("Write it", None).await;
            let events = fx.events();
            let Some(AgentEvent::ToolUse { input, .. }) = events
                .iter()
                .find(|e| matches!(e, AgentEvent::ToolUse { .. }))
            else {
                panic!("no tool call: {events:?}");
            };
            assert_eq!(input["file_path"], "/d/deck.html");
            let shown = input["content"].as_str().unwrap();
            assert!(shown.starts_with("<section class=\"slide\" id=\"a\">"));
            assert!(
                shown.ends_with("\n… (30 more characters)"),
                "{}",
                &shown[shown.len() - 40..]
            );
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
                        is_error: false,
                        output: None,
                        images: vec![]
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
            let mcp_file = fx.session_dir().join("mcp.json");
            let mcp: Value = serde_json::from_str(&fs::read_to_string(&mcp_file).unwrap()).unwrap();
            assert_eq!(
                mcp["mcpServers"]["slopslide"]["args"],
                json!([
                    "--lint-mcp",
                    fx.dir.to_string_lossy(),
                    fx.session_dir().to_string_lossy()
                ]),
                "the tools ask the app through the turn's own session"
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
        async fn loads_the_users_extensions() {
            let fx = Fixture::new(&format!("{INIT}\n{OK}"));
            let home = fx.dir.join("home");
            let skill = home.join("skills/tone");
            fs::create_dir_all(&skill).unwrap();
            fs::write(skill.join("SKILL.md"), "---\nname: tone\n---\n").unwrap();
            let plugin = home.join("plugins/p");
            fs::create_dir_all(&plugin).unwrap();
            fs::write(plugin.join(".mcp.json"), r#"{"ps":{"command":"p"}}"#).unwrap();
            fs::write(
                home.join("mcp.json"),
                r#"{"mcpServers":{"docs":{"url":"https://x"}}}"#,
            )
            .unwrap();
            fs::write(home.join("AGENTS.md"), "Be brief.").unwrap();

            let (_tx, rx) = watch::channel(false);
            let mut turn = fx.turn();
            turn.extensions = Extensions::load(&home, &fx.dir);
            assert!(
                !tokio::time::timeout(Duration::from_secs(20), turn.run("Hi", rx))
                    .await
                    .unwrap()
            );
            assert!(fx.errors().is_empty(), "{:?}", fx.errors());

            let run = &fx.invocations()[0];
            let skills_plugin = fx.session_dir().join("claude-plugins/slopslides");
            assert!(has_flag(run, "--plugin-dir", &plugin.to_string_lossy()));
            assert!(has_flag(
                run,
                "--plugin-dir",
                &skills_plugin.to_string_lossy()
            ));
            assert!(skills_plugin.join("skills/tone/SKILL.md").is_file());
            let mcp: Value = serde_json::from_str(
                &fs::read_to_string(fx.session_dir().join("mcp.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(mcp["mcpServers"]["docs"]["url"], "https://x");
            assert_eq!(
                mcp["mcpServers"]["ps"]["command"], "p",
                "--strict-mcp-config drops plugins' servers, so the app adds them"
            );
            assert!(mcp["mcpServers"]["slopslide"].is_object());
            let prompt = fs::read_to_string(home.join("system-prompt.md")).unwrap();
            assert!(prompt.starts_with(SYSTEM_PROMPT) && prompt.ends_with("Be brief."));
        }

        #[tokio::test]
        async fn takes_the_conversation_back_to_before_a_message() {
            let fx = Fixture::new(&format!(
                r#"echo '{{"type":"system","subtype":"init","session_id":"s1"}}'
echo '{{"type":"assistant","uuid":"nested","parent_tool_use_id":"t1","message":{{"content":[]}}}}'
echo "{{\"type\":\"assistant\",\"uuid\":\"u-$$\",\"parent_tool_use_id\":null,\"message\":{{\"content\":[]}}}}"
{OK}"#
            ));
            let run = |message: &str| {
                let (tx, rx) = watch::channel(false);
                let mut turn = fx.turn();
                turn.message = Some(message.into());
                async move {
                    // Dropping the sender would interrupt the turn.
                    let _tx = tx;
                    tokio::time::timeout(Duration::from_secs(20), turn.run("Go", rx))
                        .await
                        .expect("turn timed out")
                }
            };
            let pids = |fx: &Fixture| {
                fs::read_to_string(fx.dir.join(LOG_DIR).join("runs"))
                    .unwrap()
                    .lines()
                    .map(String::from)
                    .collect::<Vec<_>>()
            };
            run("m1").await;
            run("m2").await;
            let first = format!("u-{}", pids(&fx)[0]);

            rewind::request(&fx.session_dir(), "m2", "NOTE").unwrap();
            run("m3").await;
            let runs = fx.invocations();
            assert!(has_flag(&runs[2], "--resume", "s1"));
            assert!(
                has_flag(&runs[2], "--resume-session-at", &first),
                "resumes after the last reply before m2, not a nested agent's"
            );
            assert_eq!(fx.prompt(), "Go");

            rewind::request(&fx.session_dir(), "m1", "NOTE").unwrap();
            run("m4").await;
            let runs = fx.invocations();
            assert!(
                !runs[3].contains(&"--resume".to_string()),
                "m1 started the conversation: start a new one"
            );

            rewind::request(&fx.session_dir(), "unknown", "NOTE").unwrap();
            run("m5").await;
            assert!(!fx.invocations()[4].contains(&"--resume-session-at".to_string()));
            assert_eq!(fx.prompt(), "NOTE\n\nGo");
        }

        #[tokio::test]
        async fn resumes_the_stored_session() {
            let fx = Fixture::new(&format!(
                r#"echo "{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"$RESUME\"}}"
{OK}"#
            ));
            crate::sessions::write_session(
                &fx.session_dir(),
                "claude-session",
                Some("old-session"),
            )
            .unwrap();
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
            crate::sessions::write_session(&fx.session_dir(), "claude-session", Some("gone"))
                .unwrap();
            assert!(!fx.run("Hi", None).await);
            let runs = fx.invocations();
            assert_eq!(runs.len(), 2, "retried once: {:?}", fx.errors());
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
            crate::sessions::write_session(&fx.session_dir(), "claude-session", Some("gone"))
                .unwrap();
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
        async fn granting_full_access_mid_turn_switches_claude_and_allows_the_waiting_request() {
            let fx = Fixture::new(&format!(
                r#"{INIT}
echo '{{"type":"control_request","request_id":"req-1","request":{{"subtype":"can_use_tool","tool_name":"Bash","input":{{"command":"ls /"}}}}}}'
IFS= read -r mode; printf '%s' "$mode" > "$LOG/mode.log"
IFS= read -r answer; printf '%s' "$answer" > "$LOG/answer.log"
{OK}"#
            ));
            let (mode, live) = watch::channel(PermissionMode::Ask);
            let mut turn = fx.turn();
            turn.permission_mode = live;
            let (_cancel, rx) = watch::channel(false);
            let run = tokio::spawn(async move { turn.run("List the root", rx).await });
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
            mode.send_replace(PermissionMode::FullAccess);
            let interrupted = tokio::time::timeout(Duration::from_secs(10), run)
                .await
                .expect("turn timed out")
                .unwrap();
            assert!(!interrupted);
            assert!(has_flag(
                &fx.invocations()[0],
                "--permission-mode",
                "acceptEdits"
            ));
            let log = |name: &str| -> Value {
                serde_json::from_str(&fs::read_to_string(fx.dir.join(LOG_DIR).join(name)).unwrap())
                    .unwrap()
            };
            let switch = log("mode.log");
            assert_eq!(switch["type"], "control_request");
            assert_eq!(
                switch["request"],
                json!({"subtype": "set_permission_mode", "mode": "bypassPermissions"})
            );
            let answer = log("answer.log");
            assert_eq!(answer["response"]["request_id"], "req-1");
            assert_eq!(answer["response"]["response"]["behavior"], "allow");
            let events = fx.events();
            let approval = events
                .iter()
                .find_map(|e| match e {
                    AgentEvent::ApprovalRequested { approval } => Some(approval.clone()),
                    _ => None,
                })
                .expect("asked before Full access");
            assert!(events.contains(&AgentEvent::ApprovalResolved { id: approval.id }));
            assert!(fx.errors().is_empty(), "{:?}", fx.errors());
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
            crate::sessions::write_session(
                &fx.session_dir(),
                "claude-session",
                Some("old-session"),
            )
            .unwrap();
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
            crate::sessions::write_session(&fx.session_dir(), "claude-session", Some("gone"))
                .unwrap();
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
