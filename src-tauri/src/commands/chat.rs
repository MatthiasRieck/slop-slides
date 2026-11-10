//! Commands for the workspace's conversations with the agent.

use tauri::{AppHandle, State, Window};

use super::{session, sessions};
use crate::agent::{self, AgentManager, SendArgs};
use crate::capture;
use crate::codex;
use crate::deck;
use crate::error::{self, Result};
use crate::permissions;
use crate::providers;
use crate::rewind;
use crate::sessions::{self, OpenedThread, Thread};
use crate::workspace;

#[tauri::command]
pub fn load_chat(id: String) -> Result<serde_json::Value> {
    sessions::load_chat(sessions()?.current(&workspace::root(&id)?).as_deref())
}

#[tauri::command]
pub fn session_provider(id: String) -> Result<Option<agent::Provider>> {
    sessions()?
        .current(&workspace::root(&id)?)
        .map(|path| sessions::provider(&path))
        .transpose()
        .map(Option::flatten)
}

#[tauri::command]
pub fn save_chat(id: String, chat: serde_json::Value) -> Result<()> {
    sessions::save_chat(
        &sessions()?.current_or_start(&workspace::root(&id)?)?,
        &chat,
    )
}

/// Takes workspace `id`'s conversation back to before chat message `message` when its next turn
/// starts; that turn's prompt starts with `note` instead when it cannot be (see [`rewind`]).
#[tauri::command]
pub fn rewind_chat(id: String, message: String, note: String) -> Result<()> {
    let session = sessions()?
        .current(&workspace::root(&id)?)
        .ok_or_else(|| error::Error::msg("This folder has no conversation."))?;
    rewind::request(&session, &message, &note)
}

/// Workspace `id`'s conversations, newest first.
#[tauri::command]
pub fn list_chat_threads(id: String) -> Result<Vec<Thread>> {
    sessions()?.threads(&workspace::root(&id)?)
}

#[tauri::command]
pub fn select_chat_thread(
    agent: State<AgentManager>,
    id: String,
    thread: String,
) -> Result<OpenedThread> {
    if agent.is_running(&id) {
        return Err(error::Error::msg(
            "Stop the current turn before switching conversations.",
        ));
    }
    sessions()?.open_thread(&workspace::root(&id)?, &thread)
}

/// Starts a new chat in a new session; the old conversation stays in its own.
#[tauri::command]
pub fn reset_chat(agent: State<AgentManager>, id: String) -> Result<()> {
    agent.interrupt(&id);
    sessions()?.new_chat(&workspace::root(&id)?).map(|_| ())
}

#[tauri::command]
pub fn send_message(app: AppHandle, agent: State<AgentManager>, args: SendArgs) -> Result<()> {
    agent.send(app, args)
}

#[tauri::command]
pub async fn permission_modes(
    provider: agent::Provider,
    id: String,
) -> Result<Vec<permissions::PermissionMode>> {
    match provider {
        agent::Provider::Codex => codex::permission_modes(&workspace::root(&id)?).await,
        _ => Ok(permissions::fixed_modes(provider)),
    }
}

/// Changes the permission mode of the turn running in workspace `id`, if any.
#[tauri::command]
pub fn set_permission_mode(
    agent: State<AgentManager>,
    id: String,
    mode: permissions::PermissionMode,
) {
    agent.set_permission_mode(&id, mode);
}

#[tauri::command]
pub fn respond_approval(
    agent: State<AgentManager>,
    workspace: String,
    id: String,
    decision: permissions::Decision,
) -> Result<()> {
    agent.approvals.respond(&workspace, &id, decision)
}

#[tauri::command]
pub fn interrupt_agent(agent: State<AgentManager>, id: String) {
    agent.interrupt(&id);
}

/// Sends `prompt` into the workspace's running turn; false when it did not get in (no turn
/// is running, or it is ending), and the frontend runs it as the next turn instead.
#[tauri::command]
pub async fn steer_agent(
    agent: State<'_, AgentManager>,
    workspace: String,
    prompt: String,
    message: Option<String>,
) -> Result<bool> {
    Ok(agent.steer(&workspace, &prompt, message.as_deref()).await)
}

#[tauri::command]
pub fn agent_running(agent: State<AgentManager>, id: String) -> bool {
    agent.is_running(&id)
}

#[tauri::command]
pub async fn list_providers() -> Vec<providers::ProviderInfo> {
    providers::list().await
}

/// Screenshots `rect` of the window (the sketched-on slide) into the deck's session.
/// Both are in CSS pixels; `viewport` is the window's size, to find the display scale.
#[tauri::command]
pub async fn capture_sketch(
    window: Window,
    webview: tauri::Webview,
    id: String,
    rect: capture::Rect,
    viewport: capture::Size,
) -> Result<String> {
    deck::deck_file(&id)?;
    let png = capture::snapshot(&webview, rect, viewport, capture::SKETCH_WIDTH).await?;
    sessions::save_sketch(&session(&window)?, &png)
}

/// Screenshots `rect` of the window (an area of the slide a comment is on) into the deck's
/// session, with what lies outside `outline` (in fractions of `rect`) made transparent.
#[tauri::command]
pub async fn capture_area(
    window: Window,
    webview: tauri::Webview,
    id: String,
    rect: capture::Rect,
    viewport: capture::Size,
    outline: Vec<[f64; 2]>,
) -> Result<String> {
    deck::deck_file(&id)?;
    let png = capture::snapshot_within(
        &webview,
        rect,
        viewport,
        capture::SKETCH_WIDTH,
        Some(outline),
    )
    .await?;
    sessions::save_sketch(&session(&window)?, &png)
}
