mod agent;
mod capture;
mod codex;
mod copilot;
mod deck;
mod env;
mod error;
mod html;
mod lint;
mod mcp;
mod protocol;
mod providers;
mod review;
mod safety;
mod sessions;
mod size;
mod templates;
mod watcher;
mod workspace;

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, State};

use agent::{AgentManager, SendArgs};
use deck::Deck;
use error::Result;
use sessions::Sessions;
use watcher::WorkspaceWatcher;
use workspace::OpenWorkspace;

fn sessions() -> Result<Sessions> {
    Ok(Sessions::new(&deck::app_home()?))
}

/// The deck's current session, starting one if it has none.
fn session(open: &OpenWorkspace) -> Result<PathBuf> {
    sessions()?.current_or_start(&workspace_root(open)?)
}

/// The deck's current session, if it has one.
fn current_session(open: &OpenWorkspace) -> Result<Option<PathBuf>> {
    Ok(sessions()?.current(&workspace_root(open)?))
}

/// The open workspace's folder.
fn workspace_root(open: &OpenWorkspace) -> Result<PathBuf> {
    open.get()
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

/// Opens a folder as the workspace: the file tree shows it, `slop://` serves from it, and
/// the watcher reports its changes.
#[tauri::command]
fn open_workspace(
    app: AppHandle,
    open: State<OpenWorkspace>,
    watcher: State<WorkspaceWatcher>,
    path: String,
) -> Result<WorkspaceInfo> {
    let root = workspace::root(&path)?;
    sessions()?.current_or_start(&root)?;
    open.set(Some(root.clone()));
    watcher.watch(app, root.clone())?;
    workspace::remember(&deck::app_home()?, &root)?;
    Ok(WorkspaceInfo {
        name: workspace::display_name(&root),
        path: root.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn close_workspace(open: State<OpenWorkspace>, watcher: State<WorkspaceWatcher>) {
    watcher.stop();
    open.set(None);
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
fn list_dir(open: State<OpenWorkspace>, path: String) -> Result<Vec<workspace::Entry>> {
    workspace::list_dir(&workspace_root(&open)?, &path)
}

/// A file of the open workspace, with the viewer it opens in.
#[tauri::command]
fn open_file(open: State<OpenWorkspace>, path: String) -> Result<workspace::OpenedFile> {
    workspace::open_file(&workspace_root(&open)?, &path)
}

/// Creates a deck in its own folder at the root of the open workspace.
#[tauri::command]
fn create_deck(
    open: State<OpenWorkspace>,
    title: String,
    template: Option<String>,
) -> Result<Deck> {
    let root = templates::user_root()?;
    let source = template
        .as_deref()
        .map(|t| templates::source(&root, t))
        .transpose()?;
    let template = template
        .as_deref()
        .zip(source.as_deref())
        .map(|(id, html)| deck::TemplateSource { id, html });
    deck::create(&workspace_root(&open)?, &title, template)
}

#[tauri::command]
fn list_templates() -> Result<Vec<templates::TemplateSummary>> {
    Ok(templates::list(&templates::user_root()?))
}

/// Copies a template into the deck's session for the agent; returns its absolute path.
#[tauri::command]
fn stage_template(open: State<OpenWorkspace>, id: String, template: String) -> Result<String> {
    deck::deck_file(&id)?;
    templates::stage(&session(&open)?, &templates::user_root()?, &template)
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
fn open_deck(open: State<OpenWorkspace>, agent: State<AgentManager>, id: String) -> Result<Deck> {
    let file = deck::deck_file(&id)?;
    let session = current_session(&open)?;
    deck::open(
        &file,
        session.as_deref(),
        !agent.is_running(&workspace_root(&open)?.to_string_lossy()),
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
fn rename_deck(id: String, title: String) -> Result<Deck> {
    deck::rename(&deck::deck_file(&id)?, &title)
}

#[tauri::command]
fn reorder_slides(id: String, slides: Vec<String>) -> Result<Deck> {
    deck::reorder(&deck::deck_file(&id)?, slides)
}

#[tauri::command]
fn add_slide(id: String, after: Option<String>) -> Result<CreatedSlide> {
    let (deck, slide) = deck::add_blank(&deck::deck_file(&id)?, after)?;
    Ok(CreatedSlide { deck, slide })
}

#[tauri::command]
fn duplicate_slide(id: String, slide: String) -> Result<CreatedSlide> {
    let (deck, slide) = deck::duplicate(&deck::deck_file(&id)?, &slide)?;
    Ok(CreatedSlide { deck, slide })
}

#[tauri::command]
fn set_slide_hidden(
    open: State<OpenWorkspace>,
    id: String,
    slide: String,
    hidden: bool,
) -> Result<Deck> {
    let file = deck::deck_file(&id)?;
    deck::set_slide_hidden(&file, current_session(&open)?.as_deref(), &slide, hidden)
}

/// Gives every slide of the deck the canvas `size`.
#[tauri::command]
fn set_slide_size(id: String, size: size::SlideSize) -> Result<Deck> {
    deck::set_slide_size(&deck::deck_file(&id)?, size)
}

#[tauri::command]
fn set_slide_locked(
    open: State<OpenWorkspace>,
    id: String,
    slide: String,
    locked: bool,
) -> Result<Deck> {
    let file = deck::deck_file(&id)?;
    deck::set_slide_locked(&file, current_session(&open)?.as_deref(), &slide, locked)
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
fn delete_slide(open: State<OpenWorkspace>, id: String, slide: String) -> Result<Deck> {
    let file = deck::deck_file(&id)?;
    deck::delete_slide(&file, &session(&open)?, &slide)
}

/// Saves a slide edited on the stage (text edits, moved elements). `base` is its hash when
/// the edit started.
#[tauri::command]
fn update_slide(
    open: State<OpenWorkspace>,
    id: String,
    slide: String,
    markup: String,
    base: String,
) -> Result<UpdatedSlide> {
    let file = deck::deck_file(&id)?;
    let (deck, previous) = deck::update_slide(&file, &session(&open)?, &slide, &markup, &base)?;
    Ok(UpdatedSlide { deck, previous })
}

#[tauri::command]
fn save_deck_source(
    open: State<OpenWorkspace>,
    agent: State<AgentManager>,
    id: String,
    source: String,
    base: Option<String>,
) -> Result<Deck> {
    // Normalizing mid-turn could rewrite ids the agent is about to reference.
    let normalize = !agent.is_running(&workspace_root(&open)?.to_string_lossy());
    let file = deck::deck_file(&id)?;
    deck::save_source(&file, &session(&open)?, &source, base.as_deref(), normalize)
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
fn import_assets(
    open: State<OpenWorkspace>,
    id: String,
    paths: Vec<String>,
) -> Result<Vec<String>> {
    let root = workspace_root(&open)?;
    let target = asset_target(&root, &id)?;
    deck::import_assets(&target, paths)
}

#[tauri::command]
fn save_asset(
    open: State<OpenWorkspace>,
    id: String,
    name: String,
    data: String,
) -> Result<String> {
    let root = workspace_root(&open)?;
    let target = asset_target(&root, &id)?;
    deck::save_asset(&target, &name, &data)
}

#[tauri::command]
fn export_deck(id: String, dest: String) -> Result<()> {
    deck::export(&deck::deck_file(&id)?, std::path::Path::new(&dest))
}

#[tauri::command]
fn lint_deck(open: State<OpenWorkspace>, id: String) -> Result<Vec<lint::Issue>> {
    let file = deck::deck_file(&id)?;
    deck::lint(&file, current_session(&open)?.as_deref())
}

/// Screenshots `rect` of the window (the sketched-on slide) into the deck's session.
/// Both are in CSS pixels; `viewport` is the window's size, to find the display scale.
#[tauri::command]
async fn capture_sketch(
    open: State<'_, OpenWorkspace>,
    webview: tauri::Webview,
    id: String,
    rect: capture::Rect,
    viewport: capture::Size,
) -> Result<String> {
    deck::deck_file(&id)?;
    let png = capture::snapshot(&webview, rect, viewport, capture::SKETCH_WIDTH).await?;
    deck::save_sketch(&session(&open)?, &png)
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
async fn codex_permission_modes(id: String) -> Result<Vec<codex::PermissionMode>> {
    codex::permission_modes(&workspace::root(&id)?).await
}

#[tauri::command]
fn respond_approval(
    agent: State<AgentManager>,
    workspace: String,
    id: String,
    decision: codex::Decision,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `slopslide --lint-mcp [deck dir]`: the agent's lint tool, started by the agent CLI in
    // the deck folder.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some(mcp::FLAG) {
        let dir = args
            .get(2)
            .map_or_else(|| ".".into(), std::path::PathBuf::from);
        return mcp::serve(&dir);
    }
    env::adopt_login_shell_path();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AgentManager::default())
        .manage(WorkspaceWatcher::default())
        .manage(OpenWorkspace::default())
        .register_uri_scheme_protocol("slop", |ctx, request| {
            protocol::handle(ctx.app_handle(), request)
        })
        .invoke_handler(tauri::generate_handler![
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
            reorder_slides,
            add_slide,
            duplicate_slide,
            set_slide_hidden,
            set_slide_locked,
            set_slide_size,
            add_section,
            rename_section,
            delete_section,
            delete_slide,
            update_slide,
            save_deck_source,
            import_assets,
            save_asset,
            export_deck,
            lint_deck,
            capture_sketch,
            create_image_export_dir,
            export_slide_image,
            load_chat,
            session_provider,
            save_chat,
            reset_chat,
            send_message,
            interrupt_agent,
            codex_permission_modes,
            respond_approval,
            agent_running,
            list_providers,
            list_templates,
            stage_template,
            apply_template,
            add_template_slide,
            create_template,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SlopSlide");
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
