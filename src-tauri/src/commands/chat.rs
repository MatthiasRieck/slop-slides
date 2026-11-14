//! Commands for the conversations with the agent: each deck has its own, and so does a folder
//! for when no deck is open (see [`crate::sessions`]).

use tauri::{AppHandle, State, Window};

use super::{session, sessions, workspace_root};
use crate::agent::{self, AgentManager, SendArgs};
use crate::assets;
use crate::capture;
use crate::codex;
use crate::deck;
use crate::error::{self, Result};
use crate::permissions;
use crate::providers;
use crate::rewind;
use crate::sessions::{self, OpenedThread, Thread};
use crate::workspace::{self, OpenWorkspace};

/// The chat of `id`: a deck's (its file's path), or a folder's own. It goes to the frontend as
/// the JSON text it was saved as, and is read off the main thread: a long chat is megabytes.
#[tauri::command(async)]
pub fn load_chat(id: String) -> Result<Box<serde_json::value::RawValue>> {
    sessions::load_chat_text(sessions()?.current(&agent::subject(&id)?).as_deref())
}

#[tauri::command(async)]
pub fn session_provider(id: String) -> Result<Option<agent::Provider>> {
    sessions()?
        .current(&agent::subject(&id)?)
        .map(|path| sessions::provider(&path))
        .transpose()
        .map(Option::flatten)
}

/// Saves the chat of `id`. On the main thread, where commands run in the order the frontend
/// sent them: a save that ran after the `reset_chat` or `select_chat_thread` sent behind it
/// would write this chat into the conversation that one made current.
#[tauri::command]
pub fn save_chat(id: String, chat: serde_json::Value) -> Result<()> {
    sessions::save_chat(&sessions()?.current_or_start(&agent::subject(&id)?)?, &chat)
}

/// Takes chat `id`'s conversation back to before chat message `message` when its next turn
/// starts; that turn's prompt starts with `note` instead when it cannot be (see [`rewind`]).
#[tauri::command]
pub fn rewind_chat(id: String, message: String, note: String) -> Result<()> {
    let session = sessions()?
        .current(&agent::subject(&id)?)
        .ok_or_else(|| error::Error::msg("There is no conversation here."))?;
    rewind::request(&session, &message, &note)
}

/// The conversations of the window's workspace, newest first; `id` is the chat shown now. Off
/// the main thread: every one of their chats is read for its title.
#[tauri::command(async)]
pub fn list_chat_threads(window: Window, id: String) -> Result<Vec<Thread>> {
    sessions()?.threads(&workspace_root(&window)?, &agent::subject(&id)?)
}

/// Goes on with conversation `thread` of the window's workspace in chat `id`, where it moves
/// (see [`sessions::Sessions::open_thread`]).
#[tauri::command]
pub fn select_chat_thread(
    window: Window,
    agent: State<AgentManager>,
    open: State<OpenWorkspace>,
    id: String,
    thread: String,
) -> Result<OpenedThread> {
    if agent.is_running(&id) {
        return Err(error::Error::msg(
            "Stop the current turn before switching conversations.",
        ));
    }
    let sessions = sessions()?;
    if shown_elsewhere(&sessions, &open, &window, &thread) {
        return Err(error::Error::msg(
            "This conversation is open in another window.",
        ));
    }
    sessions.open_thread(&workspace_root(&window)?, &agent::subject(&id)?, &thread)
}

/// The name the user gave the conversation on show in chat `id`; null while it has none.
#[tauri::command(async)]
pub fn chat_title(id: String) -> Result<Option<String>> {
    Ok(sessions()?
        .current(&agent::subject(&id)?)
        .and_then(|session| sessions::title(&session)))
}

/// Names conversation `thread` of the window's workspace; a blank `title` gives it back the
/// name its first message gives it.
#[tauri::command]
pub fn rename_chat_thread(window: Window, thread: String, title: String) -> Result<()> {
    sessions()?.rename_thread(&workspace_root(&window)?, &thread, &title)
}

/// Deletes conversation `thread` of the window's workspace for good. Refused for the one on
/// show in chat `id` and for one another window shows. On the main thread, in the order sent:
/// like the commands that change which conversation is current.
#[tauri::command]
pub fn delete_chat_thread(
    window: Window,
    open: State<OpenWorkspace>,
    id: String,
    thread: String,
) -> Result<()> {
    let sessions = sessions()?;
    if shown_elsewhere(&sessions, &open, &window, &thread) {
        return Err(error::Error::msg(
            "This conversation is open in another window.",
        ));
    }
    sessions.delete_thread(&workspace_root(&window)?, &agent::subject(&id)?, &thread)
}

/// Whether conversation `thread` is the one on show in a window other than `window`.
fn shown_elsewhere(
    sessions: &sessions::Sessions,
    open: &OpenWorkspace,
    window: &Window,
    thread: &str,
) -> bool {
    open.chats_except(window.label()).iter().any(|chat| {
        sessions
            .current(chat)
            .is_some_and(|path| path.file_name().is_some_and(|name| name == thread))
    })
}

/// Starts a new chat in a new session; the old conversation stays in its own.
#[tauri::command]
pub fn reset_chat(agent: State<AgentManager>, id: String) -> Result<()> {
    agent.interrupt(&id);
    sessions()?.new_chat(&agent::subject(&id)?).map(|_| ())
}

/// Moves the folder's own chat to the deck the window has open, once the turn that made the
/// deck is over: from here on it is the deck's chat.
#[tauri::command]
pub fn move_chat_to_deck(
    window: Window,
    agent: State<AgentManager>,
    open: State<OpenWorkspace>,
) -> Result<()> {
    let (root, label) = (workspace_root(&window)?, window.label());
    let deck = open
        .deck(label)
        .ok_or_else(|| error::Error::msg("No deck is open."))?;
    if open.chat(label).as_ref() != Some(&root) {
        return Ok(());
    }
    if agent.is_running(&root.to_string_lossy()) {
        return Err(error::Error::msg(
            "The agent is still working in this chat.",
        ));
    }
    sessions()?.move_current(&root, &deck)?;
    open.chat_follows_deck(label);
    Ok(())
}

/// Takes back `path` (`assets/<file>`), a file attached in the composer of chat `id` (a deck,
/// or the workspace folder) and never sent; false when it stays because a deck uses it.
#[tauri::command(async)]
pub fn discard_attachment(window: Window, id: String, path: String) -> Result<bool> {
    let target = assets::target(&workspace_root(&window)?, &id)?;
    assets::discard_asset(&target, &path)
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

/// Changes the permission mode of the turn running in chat `id`, if any.
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
    chat: String,
    id: String,
    decision: permissions::Decision,
) -> Result<()> {
    agent.approvals.respond(&chat, &id, decision)
}

#[tauri::command]
pub fn interrupt_agent(agent: State<AgentManager>, id: String) {
    agent.interrupt(&id);
}

/// Sends `prompt` into the chat's running turn; false when it did not get in (no turn
/// is running, or it is ending), and the frontend runs it as the next turn instead.
#[tauri::command]
pub async fn steer_agent(
    agent: State<'_, AgentManager>,
    chat: String,
    prompt: String,
    message: Option<String>,
) -> Result<bool> {
    Ok(agent.steer(&chat, &prompt, message.as_deref()).await)
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
