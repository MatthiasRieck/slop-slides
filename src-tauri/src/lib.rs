mod agent;
mod deck;
mod env;
mod error;
mod html;
mod lint;
mod mcp;
mod protocol;
mod watcher;

use serde::Serialize;
use tauri::{AppHandle, State};

use agent::{AgentManager, SendArgs};
use deck::{Deck, DeckSummary};
use error::Result;
use watcher::DeckWatcher;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreatedSlide {
    deck: Deck,
    slide: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentStatus {
    claude_path: Option<String>,
    library_path: String,
}

#[tauri::command]
fn list_decks(app: AppHandle) -> Result<Vec<DeckSummary>> {
    deck::list(&deck::library_root(&app)?)
}

#[tauri::command]
fn create_deck(app: AppHandle, watcher: State<DeckWatcher>, title: String) -> Result<Deck> {
    let deck = deck::create(&deck::library_root(&app)?, &title)?;
    watcher.watch(app, deck.id.clone(), deck.path.clone().into())?;
    Ok(deck)
}

#[tauri::command]
fn open_deck(
    app: AppHandle,
    agent: State<AgentManager>,
    watcher: State<DeckWatcher>,
    id: String,
) -> Result<Deck> {
    let deck = deck::open(&deck::deck_dir(&app, &id)?, &id, !agent.is_running(&id))?;
    watcher.watch(app, deck.id.clone(), deck.path.clone().into())?;
    Ok(deck)
}

#[tauri::command]
fn close_deck(watcher: State<DeckWatcher>) {
    watcher.stop();
}

#[tauri::command]
fn load_deck(app: AppHandle, id: String) -> Result<Deck> {
    deck::load(&deck::deck_dir(&app, &id)?, &id)
}

#[tauri::command]
fn rename_deck(app: AppHandle, id: String, title: String) -> Result<Deck> {
    deck::rename(&deck::deck_dir(&app, &id)?, &id, &title)
}

#[tauri::command]
fn delete_deck(
    app: AppHandle,
    agent: State<AgentManager>,
    watcher: State<DeckWatcher>,
    id: String,
) -> Result<()> {
    agent.interrupt(&id);
    watcher.stop();
    deck::delete_deck(&deck::deck_dir(&app, &id)?)
}

#[tauri::command]
fn reorder_slides(app: AppHandle, id: String, slides: Vec<String>) -> Result<Deck> {
    deck::reorder(&deck::deck_dir(&app, &id)?, &id, slides)
}

#[tauri::command]
fn add_slide(app: AppHandle, id: String, after: Option<String>) -> Result<CreatedSlide> {
    let (deck, slide) = deck::add_blank(&deck::deck_dir(&app, &id)?, &id, after)?;
    Ok(CreatedSlide { deck, slide })
}

#[tauri::command]
fn duplicate_slide(app: AppHandle, id: String, slide: String) -> Result<CreatedSlide> {
    let (deck, slide) = deck::duplicate(&deck::deck_dir(&app, &id)?, &id, &slide)?;
    Ok(CreatedSlide { deck, slide })
}

#[tauri::command]
fn set_slide_hidden(app: AppHandle, id: String, slide: String, hidden: bool) -> Result<Deck> {
    deck::set_slide_hidden(&deck::deck_dir(&app, &id)?, &id, &slide, hidden)
}

#[tauri::command]
fn delete_slide(app: AppHandle, id: String, slide: String) -> Result<Deck> {
    deck::delete_slide(&deck::deck_dir(&app, &id)?, &id, &slide)
}

#[tauri::command]
fn save_deck_source(
    app: AppHandle,
    agent: State<AgentManager>,
    id: String,
    source: String,
    base: Option<String>,
) -> Result<Deck> {
    // Normalizing mid-turn could rewrite ids the agent is about to reference.
    let normalize = !agent.is_running(&id);
    deck::save_source(
        &deck::deck_dir(&app, &id)?,
        &id,
        &source,
        base.as_deref(),
        normalize,
    )
}

#[tauri::command]
fn import_assets(app: AppHandle, id: String, paths: Vec<String>) -> Result<Vec<String>> {
    deck::import_assets(&deck::deck_dir(&app, &id)?, paths)
}

#[tauri::command]
fn export_deck(app: AppHandle, id: String, dest: String) -> Result<()> {
    deck::export(&deck::deck_dir(&app, &id)?, std::path::Path::new(&dest))
}

#[tauri::command]
fn lint_deck(app: AppHandle, id: String) -> Result<Vec<lint::Issue>> {
    deck::lint(&deck::deck_dir(&app, &id)?)
}

#[tauri::command]
fn load_chat(app: AppHandle, id: String) -> Result<serde_json::Value> {
    deck::load_chat(&deck::deck_dir(&app, &id)?)
}

#[tauri::command]
fn save_chat(app: AppHandle, id: String, chat: serde_json::Value) -> Result<()> {
    deck::save_chat(&deck::deck_dir(&app, &id)?, &chat)
}

#[tauri::command]
fn reset_chat(app: AppHandle, agent: State<AgentManager>, id: String) -> Result<()> {
    agent.interrupt(&id);
    let dir = deck::deck_dir(&app, &id)?;
    deck::write_session(&dir, None)?;
    deck::save_chat(&dir, &serde_json::Value::Null)
}

#[tauri::command]
fn send_message(app: AppHandle, agent: State<AgentManager>, args: SendArgs) -> Result<()> {
    agent.send(app, args)
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
fn agent_status(app: AppHandle) -> Result<AgentStatus> {
    Ok(AgentStatus {
        claude_path: env::resolve_claude().map(|p| p.to_string_lossy().into_owned()),
        library_path: deck::library_root(&app)?.to_string_lossy().into_owned(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `slopslide --lint-mcp <deck dir>`: the agent's lint tool, started by Claude Code.
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
        .manage(DeckWatcher::default())
        .register_uri_scheme_protocol("slop", |ctx, request| {
            protocol::handle(ctx.app_handle(), request)
        })
        .invoke_handler(tauri::generate_handler![
            list_decks,
            create_deck,
            open_deck,
            close_deck,
            load_deck,
            rename_deck,
            delete_deck,
            reorder_slides,
            add_slide,
            duplicate_slide,
            set_slide_hidden,
            delete_slide,
            save_deck_source,
            import_assets,
            export_deck,
            lint_deck,
            load_chat,
            save_chat,
            reset_chat,
            send_message,
            interrupt_agent,
            agent_running,
            agent_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SlopSlide");
}
