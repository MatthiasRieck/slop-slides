mod agent;
mod deck;
mod env;
mod error;
mod html;
mod protocol;
mod providers;
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

#[tauri::command]
fn list_decks(app: AppHandle) -> Result<Vec<DeckSummary>> {
    deck::list(&app)
}

#[tauri::command]
fn create_deck(app: AppHandle, watcher: State<DeckWatcher>, title: String) -> Result<Deck> {
    let deck = deck::create(&app, &title)?;
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
    let deck = deck::open(&app, &id, !agent.is_running(&id))?;
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
    deck::rename(&app, &id, &title)
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
    deck::delete_deck(&app, &id)
}

#[tauri::command]
fn reorder_slides(app: AppHandle, id: String, slides: Vec<String>) -> Result<Deck> {
    deck::reorder(&app, &id, slides)
}

#[tauri::command]
fn add_slide(app: AppHandle, id: String, after: Option<String>) -> Result<CreatedSlide> {
    let (deck, slide) = deck::add_blank(&app, &id, after)?;
    Ok(CreatedSlide { deck, slide })
}

#[tauri::command]
fn duplicate_slide(app: AppHandle, id: String, slide: String) -> Result<CreatedSlide> {
    let (deck, slide) = deck::duplicate(&app, &id, &slide)?;
    Ok(CreatedSlide { deck, slide })
}

#[tauri::command]
fn delete_slide(app: AppHandle, id: String, slide: String) -> Result<Deck> {
    deck::delete_slide(&app, &id, &slide)
}

#[tauri::command]
fn import_assets(app: AppHandle, id: String, paths: Vec<String>) -> Result<Vec<String>> {
    deck::import_assets(&app, &id, paths)
}

#[tauri::command]
fn export_deck(app: AppHandle, id: String, dest: String) -> Result<()> {
    deck::export(&app, &id, std::path::Path::new(&dest))
}

#[tauri::command]
fn load_chat(app: AppHandle, id: String) -> Result<serde_json::Value> {
    deck::load_chat(&app, &id)
}

#[tauri::command]
fn save_chat(app: AppHandle, id: String, chat: serde_json::Value) -> Result<()> {
    deck::save_chat(&app, &id, &chat)
}

#[tauri::command]
fn reset_chat(app: AppHandle, agent: State<AgentManager>, id: String) -> Result<()> {
    agent.interrupt(&id);
    let dir = deck::deck_dir(&app, &id)?;
    for provider in agent::Provider::ALL {
        deck::write_session(&dir, provider.session_file(), None)?;
    }
    deck::save_chat(&app, &id, &serde_json::Value::Null)
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
async fn list_providers() -> Vec<providers::ProviderInfo> {
    providers::list().await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            delete_slide,
            import_assets,
            export_deck,
            load_chat,
            save_chat,
            reset_chat,
            send_message,
            interrupt_agent,
            agent_running,
            list_providers,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SlopSlide");
}
