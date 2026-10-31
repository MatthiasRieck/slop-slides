mod agent;
mod capture;
mod clipboard;
mod codex;
mod comments;
mod copilot;
mod deck;
mod env;
mod error;
mod extensions;
mod find;
mod html;
mod lint;
mod mcp;
mod mp4;
mod narration;
mod pdf;
mod permissions;
mod protocol;
mod providers;
mod review;
mod safety;
mod screens;
mod sessions;
mod size;
mod templates;
#[cfg(all(test, unix))]
mod test_support;
mod video;
mod voice;
mod watcher;
mod windows;
mod workspace;

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, State, Window};

use agent::{AgentManager, SendArgs};
use deck::{Deck, RailEdit};
use error::Result;
use sessions::Sessions;
use watcher::WorkspaceWatcher;
use workspace::OpenWorkspace;

fn sessions() -> Result<Sessions> {
    Ok(Sessions::new(&deck::app_home()?))
}

/// The current session of the window's workspace, starting one if it has none.
fn session(window: &Window) -> Result<PathBuf> {
    sessions()?.current_or_start(&workspace_root(window)?)
}

/// The current session of the window's workspace, if it has one.
fn current_session(window: &Window) -> Result<Option<PathBuf>> {
    Ok(sessions()?.current(&workspace_root(window)?))
}

/// The folder the window has open.
fn workspace_root(window: &Window) -> Result<PathBuf> {
    window
        .state::<OpenWorkspace>()
        .get(window.label())
        .ok_or_else(|| error::Error::msg("No folder is open."))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreatedSlide {
    deck: Deck,
    slide: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdatedSlide {
    deck: Deck,
    /// The slide's markup before the update, to undo it.
    previous: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceInfo {
    path: String,
    name: String,
}

/// Opens a folder as the window's workspace: the file tree shows it, `slop://` serves from
/// it, and the watcher reports its changes. A folder open in another window is shown there
/// instead: two windows on one folder would share (and overwrite) its chat and session.
#[tauri::command]
fn open_workspace(
    app: AppHandle,
    window: Window,
    open: State<OpenWorkspace>,
    watcher: State<WorkspaceWatcher>,
    path: String,
) -> Result<WorkspaceInfo> {
    let root = workspace::root(&path)?;
    if let Some(other) = open.window_with(&root, window.label()) {
        if let Some(other) = app.get_webview_window(&other) {
            let _ = other.unminimize();
            let _ = other.set_focus();
        }
        return Err(error::Error::msg(format!(
            "{} is already open in another window.",
            workspace::display_name(&root)
        )));
    }
    sessions()?.current_or_start(&root)?;
    open.set(window.label(), Some(root.clone()));
    watcher.watch(app, window.label(), root.clone())?;
    workspace::remember(&deck::app_home()?, &root)?;
    Ok(WorkspaceInfo {
        name: workspace::display_name(&root),
        path: root.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn close_workspace(window: Window, open: State<OpenWorkspace>, watcher: State<WorkspaceWatcher>) {
    watcher.stop(window.label());
    open.set(window.label(), None);
}

/// The folder waiting to be opened in this window (see [`windows::open_folder`]), once.
#[tauri::command]
fn take_pending_folder(window: Window, pending: State<windows::PendingFolders>) -> Option<String> {
    pending
        .take(window.label())
        .map(|root| root.to_string_lossy().into_owned())
}

/// Opens another app window on the start screen.
#[tauri::command]
fn new_window(app: AppHandle) -> Result<()> {
    windows::open_new(&app)
}

/// The attached screens, for choosing where to present.
#[tauri::command]
fn list_screens(app: AppHandle) -> Result<Vec<screens::Screen>> {
    screens::list_named(&app)
}

/// A screenshot of each attached screen, for telling them apart in the picker. `grabbed` hears
/// when the screens are captured, which is well before the screenshots are ready.
#[tauri::command]
async fn screen_previews(app: AppHandle, grabbed: tauri::ipc::Channel<()>) -> Vec<Option<String>> {
    screens::previews(&app, grabbed).await
}

/// Moves the show window to the `audience` screen and opens the presenter view on `presenter`.
/// Off the main thread, which building a window from a command needs on Windows.
#[tauri::command(async)]
fn present_on(
    app: AppHandle,
    window: Window,
    audience: usize,
    presenter: Option<usize>,
) -> Result<()> {
    screens::present(&app, &window, audience, presenter)
}

/// Closes the presenter view window when the show ends.
#[tauri::command]
fn close_presenter_view(app: AppHandle) {
    screens::close_presenter_view(&app);
}

#[tauri::command]
fn recent_workspaces() -> Result<Vec<workspace::RecentWorkspace>> {
    Ok(workspace::recent(&deck::app_home()?))
}

#[tauri::command]
fn forget_workspace(path: String) -> Result<()> {
    workspace::forget(&deck::app_home()?, &path)
}

/// `~/Documents/SlopSlide`, where decks lived before workspaces.
#[tauri::command]
fn library_folder(app: AppHandle) -> Result<String> {
    Ok(deck::library_root(&app)?.to_string_lossy().into_owned())
}

/// One folder of the open workspace (`""` for its root).
#[tauri::command]
fn list_dir(window: Window, path: String) -> Result<Vec<workspace::Entry>> {
    workspace::list_dir(&workspace_root(&window)?, &path)
}

/// A file of the open workspace, with the viewer it opens in.
#[tauri::command]
fn open_file(window: Window, path: String) -> Result<workspace::OpenedFile> {
    workspace::open_file(&workspace_root(&window)?, &path)
}

/// Creates a deck in its own folder at the root of the open workspace.
#[tauri::command]
fn create_deck(window: Window, title: String, template: Option<String>) -> Result<Deck> {
    let root = templates::user_root()?;
    let source = template
        .as_deref()
        .map(|t| templates::source(&root, t))
        .transpose()?;
    let template = template
        .as_deref()
        .zip(source.as_deref())
        .map(|(id, html)| deck::TemplateSource { id, html });
    deck::create(&workspace_root(&window)?, &title, template)
}

#[tauri::command]
fn list_templates() -> Result<Vec<templates::TemplateSummary>> {
    Ok(templates::list(&templates::user_root()?))
}

/// Copies a template into the deck's session for the agent; returns its absolute path.
#[tauri::command]
fn stage_template(window: Window, id: String, template: String) -> Result<String> {
    deck::deck_file(&id)?;
    templates::stage(&session(&window)?, &templates::user_root()?, &template)
}

/// Gives a deck without slides the template's styles.
#[tauri::command]
fn apply_template(id: String, template: String) -> Result<Deck> {
    let root = templates::user_root()?;
    let html = templates::source(&root, &template)?;
    let source = deck::TemplateSource {
        id: &template,
        html: &html,
    };
    deck::apply_template(&deck::deck_file(&id)?, source)
}

/// Adds a copy of one of the template's slides after `after`.
#[tauri::command]
fn add_template_slide(
    id: String,
    template: String,
    slide: String,
    after: Option<String>,
) -> Result<CreatedSlide> {
    let html = templates::source(&templates::user_root()?, &template)?;
    let (deck, slide) = deck::add_template_slide(&deck::deck_file(&id)?, after, &html, &slide)?;
    Ok(CreatedSlide { deck, slide })
}

/// Saves the deck as a new user template, with placeholder text in place of its content.
#[tauri::command]
fn create_template(id: String, name: String) -> Result<templates::TemplateSummary> {
    templates::create_from_deck(&deck::deck_file(&id)?, &templates::user_root()?, &name)
}

#[tauri::command]
fn open_deck(window: Window, agent: State<AgentManager>, id: String) -> Result<Deck> {
    let file = deck::deck_file(&id)?;
    let session = current_session(&window)?;
    deck::open(
        &file,
        session.as_deref(),
        !agent.is_running(&workspace_root(&window)?.to_string_lossy()),
    )
}

#[tauri::command]
fn load_deck(id: String) -> Result<Deck> {
    deck::load(&deck::deck_file(&id)?)
}

#[tauri::command]
fn save_review(id: String, review: review::Review) -> Result<()> {
    deck::save_review(&deck::deck_file(&id)?, &review)
}

#[tauri::command]
fn save_comments(id: String, comments: comments::Comments) -> Result<()> {
    deck::save_comments(&deck::deck_file(&id)?, &comments)
}

#[tauri::command]
fn rename_deck(id: String, title: String) -> Result<Deck> {
    deck::rename(&deck::deck_file(&id)?, &title)
}

#[tauri::command]
fn reorder_slides(id: String, slides: Vec<String>) -> Result<RailEdit> {
    deck::reorder(&deck::deck_file(&id)?, slides)
}

#[tauri::command]
fn add_slide(id: String, after: Option<String>) -> Result<CreatedSlide> {
    let (deck, slide) = deck::add_blank(&deck::deck_file(&id)?, after)?;
    Ok(CreatedSlide { deck, slide })
}

#[tauri::command]
fn duplicate_slides(id: String, slides: Vec<String>) -> Result<RailEdit> {
    deck::duplicate_slides(&deck::deck_file(&id)?, &slides)
}

#[tauri::command]
fn set_slides_hidden(
    window: Window,
    id: String,
    slides: Vec<String>,
    hidden: bool,
) -> Result<RailEdit> {
    let file = deck::deck_file(&id)?;
    deck::set_slides_hidden(&file, current_session(&window)?.as_deref(), &slides, hidden)
}

/// Sets what is said over a slide; empty `text` removes its narration.
#[tauri::command]
fn set_slide_narration(id: String, slide: String, text: String) -> Result<Deck> {
    deck::set_slide_narration(&deck::deck_file(&id)?, &slide, &text)
}

/// Sets a slide's speaker notes; empty `text` removes them.
#[tauri::command]
fn set_slide_notes(id: String, slide: String, text: String) -> Result<Deck> {
    deck::set_slide_notes(&deck::deck_file(&id)?, &slide, &text)
}

/// Sets the seconds the presenter expects to spend on a slide; 0 removes them.
#[tauri::command]
fn set_slide_time(id: String, slide: String, seconds: u32) -> Result<Deck> {
    deck::set_slide_time(&deck::deck_file(&id)?, &slide, seconds)
}

/// Gives every slide of the deck the canvas `size`.
#[tauri::command]
fn set_slide_size(id: String, size: size::SlideSize) -> Result<Deck> {
    deck::set_slide_size(&deck::deck_file(&id)?, size)
}

#[tauri::command]
fn set_slide_locked(window: Window, id: String, slide: String, locked: bool) -> Result<Deck> {
    let file = deck::deck_file(&id)?;
    deck::set_slide_locked(&file, current_session(&window)?.as_deref(), &slide, locked)
}

#[tauri::command]
fn add_section(id: String, before: Option<String>, title: String) -> Result<Deck> {
    deck::add_section(&deck::deck_file(&id)?, before, &title)
}

#[tauri::command]
fn rename_section(id: String, index: usize, title: String) -> Result<Deck> {
    deck::rename_section(&deck::deck_file(&id)?, index, &title)
}

#[tauri::command]
fn delete_section(id: String, index: usize) -> Result<Deck> {
    deck::delete_section(&deck::deck_file(&id)?, index)
}

#[tauri::command]
fn delete_slides(window: Window, id: String, slides: Vec<String>) -> Result<RailEdit> {
    let file = deck::deck_file(&id)?;
    deck::delete_slides(&file, &session(&window)?, &slides)
}

/// Saves a slide edited on the stage (text edits, moved elements). `base` is its hash when
/// the edit started.
#[tauri::command]
fn update_slide(
    window: Window,
    id: String,
    slide: String,
    markup: String,
    base: String,
) -> Result<UpdatedSlide> {
    let file = deck::deck_file(&id)?;
    let (deck, previous) = deck::update_slide(&file, &session(&window)?, &slide, &markup, &base)?;
    Ok(UpdatedSlide { deck, previous })
}

#[tauri::command]
fn save_deck_source(
    window: Window,
    agent: State<AgentManager>,
    id: String,
    source: String,
    base: Option<String>,
) -> Result<Deck> {
    // Normalizing mid-turn could rewrite ids the agent is about to reference.
    let normalize = !agent.is_running(&workspace_root(&window)?.to_string_lossy());
    let file = deck::deck_file(&id)?;
    deck::save_source(
        &file,
        &session(&window)?,
        &source,
        base.as_deref(),
        normalize,
    )
}

fn asset_target(root: &Path, id: &str) -> Result<PathBuf> {
    let path = PathBuf::from(id);
    if !workspace::inside(root, &path) {
        return Err(error::Error::msg("asset target outside workspace"));
    }
    if path == root || path.canonicalize()? == root.canonicalize()? {
        Ok(root.into())
    } else {
        deck::deck_file(id)
    }
}

#[tauri::command]
fn import_assets(window: Window, id: String, paths: Vec<String>) -> Result<Vec<String>> {
    let root = workspace_root(&window)?;
    let target = asset_target(&root, &id)?;
    deck::import_assets(&target, paths)
}

#[tauri::command]
fn save_asset(window: Window, id: String, name: String, data: String) -> Result<String> {
    let root = workspace_root(&window)?;
    let target = asset_target(&root, &id)?;
    deck::save_asset(&target, &name, &data)
}

/// Puts an element copied in the slide editor of deck `id` on the system clipboard.
#[tauri::command]
fn copy_to_clipboard(html: String, text: String, id: Option<String>) -> Result<()> {
    let html = match id {
        Some(id) => clipboard::with_source(&html, &deck::deck_file(&id)?),
        None => html,
    };
    clipboard::write(&html, &text)
}

/// Puts slide `slide` of deck `id` on the system clipboard, to paste into any deck.
#[tauri::command]
fn copy_slide(id: String, slide: String) -> Result<()> {
    clipboard::copy_slide(&deck::deck_file(&id)?, &slide)
}

/// Inserts the slide on the system clipboard into deck `id` after `after`, with the assets
/// it shows; None when the clipboard holds no slide.
#[tauri::command]
fn paste_slide(id: String, after: Option<String>) -> Result<Option<CreatedSlide>> {
    let Some(copied) = clipboard::read_slide()? else {
        return Ok(None);
    };
    let file = deck::deck_file(&id)?;
    let (deck, slide) = deck::paste_slide(&file, after, copied.deck.as_deref(), &copied.markup)?;
    Ok(Some(CreatedSlide { deck, slide }))
}

/// The clipboard's plain text, for pasting into text on a slide without its formatting.
#[tauri::command]
fn read_clipboard_text() -> Result<String> {
    clipboard::read_text()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplacedText {
    deck: Deck,
    /// How many matches were replaced.
    count: usize,
    /// The slides that changed.
    slides: Vec<String>,
    /// Locked slides with matches, left as they were.
    skipped: Vec<String>,
    /// The deck's source before and after, to undo the replace by saving `previous` over `source`.
    previous: String,
    source: String,
}

/// Where `query` is found in the text of deck `id`'s slides.
#[tauri::command]
fn find_in_deck(id: String, query: String, options: find::Options) -> Result<Vec<find::Match>> {
    deck::find_text(&deck::deck_file(&id)?, &query, options)
}

/// Replaces `query` with `replacement` in the text of deck `id`'s slides (or of `slides`).
#[tauri::command]
fn replace_in_deck(
    window: Window,
    id: String,
    query: String,
    replacement: String,
    options: find::Options,
    slides: Option<Vec<String>>,
) -> Result<ReplacedText> {
    let file = deck::deck_file(&id)?;
    let done = deck::replace_text(
        &file,
        &session(&window)?,
        &query,
        &replacement,
        options,
        slides.as_deref(),
    )?;
    Ok(ReplacedText {
        deck: done.deck,
        count: done.count,
        slides: done.slides,
        skipped: done.skipped,
        previous: done.previous,
        source: done.source,
    })
}

/// What pasting into deck `id` brings in; pasted images are saved into its assets.
#[tauri::command]
fn paste_from_clipboard(window: Window, id: String) -> Result<clipboard::Pasted> {
    let root = workspace_root(&window)?;
    let target = asset_target(&root, &id)?;
    clipboard::paste(clipboard::read()?, &target)
}

#[tauri::command]
fn export_deck(id: String, dest: String) -> Result<()> {
    deck::export(&deck::deck_file(&id)?, std::path::Path::new(&dest))
}

#[tauri::command]
fn lint_deck(window: Window, id: String) -> Result<Vec<lint::Issue>> {
    let file = deck::deck_file(&id)?;
    deck::lint(&file, current_session(&window)?.as_deref())
}

/// Screenshots `rect` of the window (the sketched-on slide) into the deck's session.
/// Both are in CSS pixels; `viewport` is the window's size, to find the display scale.
#[tauri::command]
async fn capture_sketch(
    window: Window,
    webview: tauri::Webview,
    id: String,
    rect: capture::Rect,
    viewport: capture::Size,
) -> Result<String> {
    deck::deck_file(&id)?;
    let png = capture::snapshot(&webview, rect, viewport, capture::SKETCH_WIDTH).await?;
    deck::save_sketch(&session(&window)?, &png)
}

/// Creates `<parent>/<deck title>` (or `<deck title> 2`, …) for exported slide images.
#[tauri::command]
fn create_image_export_dir(id: String, parent: String) -> Result<String> {
    let deck = deck::load(&deck::deck_file(&id)?)?;
    let dir = deck::create_export_dir(std::path::Path::new(&parent), &deck.title)?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Screenshots `rect` of the window (one slide, shown full size) as `<dir>/<slide-NN>.png`, at
/// most `width` pixels wide: the slides' canvas width.
#[tauri::command]
async fn export_slide_image(
    webview: tauri::Webview,
    dir: String,
    index: usize,
    total: usize,
    rect: capture::Rect,
    viewport: capture::Size,
    width: Option<u32>,
) -> Result<String> {
    let width = width.unwrap_or(capture::SLIDE_WIDTH).clamp(1, size::MAX_PX);
    let png = capture::snapshot(&webview, rect, viewport, width).await?;
    let path = std::path::Path::new(&dir).join(deck::slide_image_name(index, total));
    std::fs::write(&path, png)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Prints the deck to `dest` as a PDF, one page per shown slide, with selectable text.
#[tauri::command]
async fn export_pdf(app: AppHandle, id: String, dest: String) -> Result<()> {
    pdf::export(&app, &deck::deck_file(&id)?, Path::new(&dest)).await
}

/// Records the deck to `dest` as an MP4, each shown slide on screen for the same time (or,
/// speaking its narration, until that ends), with `video-export-progress` events to `window`
/// as it goes.
#[tauri::command]
async fn export_video(
    app: AppHandle,
    window: Window,
    id: String,
    dest: String,
    options: video::Options,
) -> Result<()> {
    use tauri::Emitter;
    let progress = |p: video::Progress| {
        let _ = window.emit("video-export-progress", p);
    };
    video::export(
        &app,
        &deck::deck_file(&id)?,
        Path::new(&dest),
        options,
        progress,
    )
    .await
}

/// Stops the running video export; it fails with "the video export was cancelled".
#[tauri::command]
fn cancel_video_export() {
    video::cancel();
}

#[tauri::command]
fn load_chat(id: String) -> Result<serde_json::Value> {
    deck::load_chat(sessions()?.current(&workspace::root(&id)?).as_deref())
}

#[tauri::command]
fn session_provider(id: String) -> Result<Option<agent::Provider>> {
    sessions()?
        .current(&workspace::root(&id)?)
        .map(|path| sessions::provider(&path))
        .transpose()
        .map(Option::flatten)
}

#[tauri::command]
fn save_chat(id: String, chat: serde_json::Value) -> Result<()> {
    deck::save_chat(
        &sessions()?.current_or_start(&workspace::root(&id)?)?,
        &chat,
    )
}

#[tauri::command]
fn list_chat_threads(id: String) -> Result<Vec<serde_json::Value>> {
    let sessions = sessions()?;
    let root = workspace::root(&id)?;
    let current = sessions.current(&root);
    sessions
        .list_scoped(&root)
        .into_iter()
        .rev()
        .map(|path| {
            let chat = deck::load_chat(Some(&path))?;
            let messages = chat.as_array();
            let first = messages.and_then(|items| items.iter().find(|m| m["role"] == "user"));
            let title = first
                .and_then(|m| m["text"].as_str())
                .unwrap_or("New conversation");
            Ok(serde_json::json!({
                "id": path.file_name().unwrap().to_string_lossy(),
                "title": title.chars().take(100).collect::<String>(),
                "createdAt": first.and_then(|m| m["createdAt"].as_u64()),
                "current": current.as_ref() == Some(&path),
                "messageCount": messages.map_or(0, Vec::len),
                "association": sessions::association_of(&path).map(|associated| {
                    let relative = associated.strip_prefix(&root).unwrap_or(&associated);
                    if relative.as_os_str().is_empty() { ".".to_string() }
                    else { relative.to_string_lossy().replace('\\', "/") }
                }),
            }))
        })
        .collect()
}

#[tauri::command]
fn select_chat_thread(
    agent: State<AgentManager>,
    id: String,
    thread: String,
) -> Result<serde_json::Value> {
    if agent.is_running(&id) {
        return Err(error::Error::msg(
            "Stop the current turn before switching conversations.",
        ));
    }
    let sessions = sessions()?;
    let root = workspace::root(&id)?;
    let path = sessions
        .list_scoped(&root)
        .into_iter()
        .find(|path| path.file_name().is_some_and(|name| name == thread.as_str()))
        .ok_or_else(|| error::Error::msg("Conversation not found in this workspace."))?;
    // Read before selecting: a damaged transcript must not change the active conversation.
    let chat = deck::load_chat(Some(&path))?;
    let provider = sessions::provider(&path)?;
    sessions.select(&root, &thread)?;
    Ok(serde_json::json!({ "chat": chat, "provider": provider }))
}

/// Starts a new chat in a new session; the old conversation stays in its own.
#[tauri::command]
fn reset_chat(agent: State<AgentManager>, id: String) -> Result<()> {
    agent.interrupt(&id);
    new_chat(&sessions()?, &workspace::root(&id)?).map(|_| ())
}

/// A session for a new chat: the current one while it has no conversation yet, else a new one.
fn new_chat(sessions: &Sessions, file: &Path) -> Result<PathBuf> {
    if let Some(current) = sessions.current(file) {
        if deck::load_chat(Some(&current))?.is_null() && sessions::provider(&current)?.is_none() {
            for provider in agent::Provider::ALL {
                deck::write_session(&current, provider.session_file(), None)?;
            }
            return Ok(current);
        }
    }
    sessions.start(file)
}

#[tauri::command]
fn send_message(app: AppHandle, agent: State<AgentManager>, args: SendArgs) -> Result<()> {
    agent.send(app, args)
}

#[tauri::command]
async fn permission_modes(
    provider: agent::Provider,
    id: String,
) -> Result<Vec<permissions::PermissionMode>> {
    match provider {
        agent::Provider::Codex => codex::permission_modes(&workspace::root(&id)?).await,
        _ => Ok(permissions::fixed_modes(provider)),
    }
}

#[tauri::command]
fn respond_approval(
    agent: State<AgentManager>,
    workspace: String,
    id: String,
    decision: permissions::Decision,
) -> Result<()> {
    agent.approvals.respond(&workspace, &id, decision)
}

#[tauri::command]
fn interrupt_agent(agent: State<AgentManager>, id: String) {
    agent.interrupt(&id);
}

#[tauri::command]
fn agent_running(agent: State<AgentManager>, id: String) -> bool {
    agent.is_running(&id)
}

#[tauri::command]
async fn list_providers() -> Vec<providers::ProviderInfo> {
    providers::list().await
}

#[tauri::command]
fn voice_status(voice: State<voice::Voice>) -> Result<voice::VoiceStatus> {
    Ok(voice.status(&deck::app_home()?))
}

/// Downloads the speech-to-text model to `~/.slopslides/models` unless it is there.
#[tauri::command]
async fn download_voice_model(app: AppHandle, voice: State<'_, voice::Voice>) -> Result<()> {
    voice.download(&app, &deck::app_home()?).await
}

/// Listens for the teleprompter in the calling window, reporting recent words as `voice-heard`
/// events until `cancel_recording`.
#[tauri::command]
async fn follow_speech(
    app: AppHandle,
    window: tauri::Window,
    voice: State<'_, voice::Voice>,
) -> Result<()> {
    voice
        .follow(app, &deck::app_home()?, window.label().to_string())
        .await
}

/// Starts recording, transcribing live as `voice-partial` events.
#[tauri::command]
async fn start_recording(app: AppHandle, voice: State<'_, voice::Voice>) -> Result<()> {
    voice.start(app, &deck::app_home()?).await
}

/// Stops recording and returns what was said.
#[tauri::command]
async fn stop_recording(voice: State<'_, voice::Voice>) -> Result<String> {
    voice.stop(&deck::app_home()?).await
}

#[tauri::command]
fn cancel_recording(voice: State<voice::Voice>) {
    voice.cancel();
}

#[tauri::command]
fn speech_status(narration: State<narration::Narration>) -> Result<narration::SpeechStatus> {
    Ok(narration.status(&deck::app_home()?))
}

/// Downloads the narration voice model to `~/.slopslides/models` unless it is there, with
/// `speech-download` progress events.
#[tauri::command]
async fn download_speech_model(
    app: AppHandle,
    narration: State<'_, narration::Narration>,
) -> Result<()> {
    narration.download(&app, &deck::app_home()?).await
}

/// Each slide's narration audio: whether it is there and up to date, and how long it plays.
#[tauri::command]
fn narration_audio(id: String) -> Result<Vec<narration::SlideAudio>> {
    let file = deck::deck_file(&id)?;
    Ok(narration::statuses(&file, &deck::load(&file)?))
}

/// Says the narration of the deck's `slides` (all for None) that has no up-to-date audio,
/// with `narration-render` progress events to every window.
#[tauri::command]
async fn render_narration(
    app: AppHandle,
    narration: State<'_, narration::Narration>,
    id: String,
    slides: Option<Vec<String>>,
) -> Result<Vec<narration::SlideAudio>> {
    use tauri::Emitter;
    let progress = |p: narration::RenderProgress| {
        let _ = app.emit(narration::RENDER_EVENT, p);
    };
    narration
        .render(
            &deck::app_home()?,
            &deck::deck_file(&id)?,
            slides.as_deref(),
            progress,
        )
        .await
}

/// Stops saying narration; the render fails with "the narration was cancelled".
#[tauri::command]
fn cancel_narration(narration: State<narration::Narration>) {
    narration.cancel();
}

/// A slide's narration audio, as WAV bytes.
#[tauri::command]
fn narration_wav(id: String, slide: String) -> Result<tauri::ipc::Response> {
    let file = narration::audio_file(&deck::deck_file(&id)?, &slide);
    Ok(tauri::ipc::Response::new(std::fs::read(file)?))
}

#[tauri::command]
fn set_narration_voice(id: String, voice: String) -> Result<Deck> {
    deck::set_narration_voice(&deck::deck_file(&id)?, &voice)
}

#[tauri::command]
fn set_narration_language(id: String, language: String) -> Result<Deck> {
    deck::set_narration_language(&deck::deck_file(&id)?, &language)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `slopslide --lint-mcp [deck dir]`: the agent's lint tool, started by the agent CLI in
    // the deck folder.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--narration-license") {
        println!("{}", narration::engine::license());
        return;
    }
    if args.get(1).map(String::as_str) == Some(mcp::FLAG) {
        let dir = args
            .get(2)
            .map_or_else(|| ".".into(), std::path::PathBuf::from);
        return mcp::serve(&dir);
    }
    // `slopslide --narration-worker <model dir>`: the speech engine's process (see
    // narration/engine.rs), started by the app itself.
    if args.get(1).map(String::as_str) == Some(narration::engine::WORKER_FLAG) {
        let dir = args
            .get(2)
            .map(std::path::PathBuf::from)
            .unwrap_or_default();
        std::process::exit(narration::engine::worker_main(&dir));
    }
    env::adopt_login_shell_env();
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(windows::menu).setup(|app| {
        windows::dock::add_menu(app.handle());
        Ok(())
    });
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AgentManager::default())
        .manage(WorkspaceWatcher::default())
        .manage(OpenWorkspace::default())
        .manage(windows::PendingFolders::default())
        .manage(voice::Voice::default())
        .manage(narration::Narration::default())
        .on_menu_event(|app, event| {
            if event.id() == windows::NEW_WINDOW_MENU {
                if let Err(e) = windows::open_new(app) {
                    eprintln!("{e}");
                }
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                windows::closed(window);
                window.state::<voice::Voice>().window_closed(window.label());
            }
        })
        .register_uri_scheme_protocol("slop", |ctx, request| {
            protocol::handle(ctx.app_handle(), request)
        })
        .invoke_handler(tauri::generate_handler![
            new_window,
            list_screens,
            screen_previews,
            present_on,
            close_presenter_view,
            take_pending_folder,
            open_workspace,
            close_workspace,
            recent_workspaces,
            forget_workspace,
            library_folder,
            list_dir,
            open_file,
            create_deck,
            open_deck,
            load_deck,
            rename_deck,
            save_review,
            save_comments,
            reorder_slides,
            add_slide,
            duplicate_slides,
            set_slides_hidden,
            set_slide_locked,
            set_slide_narration,
            set_slide_notes,
            set_slide_time,
            set_slide_size,
            add_section,
            rename_section,
            delete_section,
            delete_slides,
            update_slide,
            save_deck_source,
            import_assets,
            save_asset,
            copy_to_clipboard,
            copy_slide,
            paste_slide,
            paste_from_clipboard,
            read_clipboard_text,
            find_in_deck,
            replace_in_deck,
            export_deck,
            lint_deck,
            capture_sketch,
            create_image_export_dir,
            export_slide_image,
            export_pdf,
            export_video,
            cancel_video_export,
            load_chat,
            session_provider,
            save_chat,
            reset_chat,
            list_chat_threads,
            select_chat_thread,
            send_message,
            interrupt_agent,
            permission_modes,
            respond_approval,
            agent_running,
            list_providers,
            list_templates,
            stage_template,
            apply_template,
            add_template_slide,
            create_template,
            voice_status,
            download_voice_model,
            follow_speech,
            start_recording,
            stop_recording,
            cancel_recording,
            speech_status,
            download_speech_model,
            narration_audio,
            render_narration,
            cancel_narration,
            narration_wav,
            set_narration_voice,
            set_narration_language,
        ])
        .build(tauri::generate_context!())
        .expect("error while running SlopSlide")
        .run(|app, event| match event {
            tauri::RunEvent::Exit => app.state::<voice::Voice>().shutdown(),
            // Opening the app again: a double-click in Finder, a click on its Dock icon.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } => {
                if let Err(e) = windows::reopened(app, has_visible_windows) {
                    eprintln!("{e}");
                }
            }
            // Folders opened with the app from Finder (dropped on its icon, Open With).
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => {
                let folders = urls
                    .iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .filter(|path| path.is_dir());
                for folder in folders {
                    if let Err(e) = windows::open_folder(app, folder) {
                        eprintln!("{e}");
                    }
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod session_tests {
    use super::*;

    #[test]
    fn resetting_a_claimed_session_starts_a_new_chat_even_without_saved_messages() {
        let root = std::env::temp_dir().join(format!("slopslide-reset-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("deck.html");
        std::fs::write(&file, "<html></html>").unwrap();
        let sessions = Sessions::new(&root.join("home"));
        let first = new_chat(&sessions, &root).unwrap();
        assert_eq!(new_chat(&sessions, &root).unwrap(), first);
        sessions::claim_provider(&first, agent::Provider::Codex).unwrap();
        let next = new_chat(&sessions, &root).unwrap();
        assert_ne!(next, first);
        assert_eq!(sessions::provider(&next).unwrap(), None);
        assert_eq!(
            sessions::provider(&first).unwrap(),
            Some(agent::Provider::Codex)
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod window_config_tests {
    #[test]
    fn traffic_lights_are_vertically_centered_in_the_top_bar() {
        // The top bar and home header are `h-12` (48px); macOS window buttons are 14px tall.
        // tao grows the title bar container to button height + y, and AppKit keeps the
        // buttons 9px up from its bottom edge, so a button's top edge lands at y - 9.
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let position = &config["app"]["windows"][0]["trafficLightPosition"];
        assert_eq!(position["y"].as_f64(), Some((48.0 - 14.0) / 2.0 + 9.0));
        // Leaves room before the `pl-[84px]` content padding.
        assert!(position["x"].as_f64().unwrap() + 54.0 < 84.0);
    }
}
