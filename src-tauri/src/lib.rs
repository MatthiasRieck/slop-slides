mod agent;
mod app_block;
mod assets;
mod capture;
mod claude;
mod clipboard;
mod codex;
mod commands;
mod comments;
mod copilot;
mod deck;
mod env;
mod error;
mod export;
mod export_smoke;
mod extensions;
mod files;
mod find;
mod git;
mod guard;
mod history;
mod html;
mod lint;
mod mcp;
mod mp4;
mod narration;
mod pdf;
mod permissions;
mod pptx;
mod process;
mod protocol;
mod providers;
mod render;
mod review;
mod rewind;
mod safety;
mod screens;
mod sessions;
mod size;
mod templates;
#[cfg(test)]
mod test_support;
mod video;
mod voice;
mod watcher;
mod windows;
mod workspace;

use tauri::Manager;

use agent::AgentManager;
use watcher::WorkspaceWatcher;
use workspace::OpenWorkspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    process::worker_if_requested();
    // `slopslide --lint-mcp [deck dir]`: the agent's lint tool, started by the agent CLI in
    // the deck folder.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some(mcp::FLAG) {
        let dir = args
            .get(2)
            .map_or_else(|| ".".into(), std::path::PathBuf::from);
        return mcp::serve(&dir);
    }
    let context = tauri::generate_context!();
    // `slopslide --export-smoke <deck.html> <out dir> [text…]`: exports a deck with the
    // platform's webview and exits, for CI (see export_smoke.rs).
    if args.get(1).map(String::as_str) == Some(export_smoke::FLAG) {
        std::process::exit(export_smoke::run(context, &args[2..]));
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
            commands::workspace::new_window,
            commands::workspace::list_screens,
            commands::workspace::screen_previews,
            commands::workspace::present_on,
            commands::workspace::close_presenter_view,
            commands::workspace::present_in_windows,
            commands::workspace::take_pending_folder,
            commands::workspace::open_workspace,
            commands::workspace::close_workspace,
            commands::workspace::recent_workspaces,
            commands::workspace::forget_workspace,
            commands::workspace::library_folder,
            commands::workspace::list_dir,
            commands::workspace::open_file,
            commands::deck::create_deck,
            commands::deck::open_deck,
            commands::deck::load_deck,
            commands::deck::rename_deck,
            commands::deck::save_review,
            commands::deck::save_comments,
            commands::deck::reorder_slides,
            commands::deck::add_slide,
            commands::deck::duplicate_slides,
            commands::deck::set_slides_hidden,
            commands::deck::set_slide_locked,
            commands::deck::set_slide_narration,
            commands::deck::set_slide_notes,
            commands::deck::set_slide_time,
            commands::deck::set_slide_timing,
            commands::deck::set_slide_size,
            commands::deck::add_section,
            commands::deck::rename_section,
            commands::deck::delete_section,
            commands::deck::delete_slides,
            commands::deck::update_slide,
            commands::deck::slide_source,
            commands::deck::save_deck_source,
            commands::history::deck_history,
            commands::history::undo_deck,
            commands::history::redo_deck,
            commands::history::restore_slides,
            commands::chat::rewind_chat,
            commands::deck::import_assets,
            commands::deck::save_asset,
            commands::clipboard::copy_to_clipboard,
            commands::clipboard::copy_slide,
            commands::clipboard::paste_slide,
            commands::clipboard::paste_from_clipboard,
            commands::clipboard::read_clipboard_text,
            commands::deck::find_in_deck,
            commands::deck::replace_in_deck,
            commands::export::export_deck,
            commands::git::deck_in_repository,
            commands::git::deck_changes,
            commands::git::stage_change,
            commands::git::unstage_change,
            commands::git::restore_change,
            commands::git::stage_all,
            commands::git::unstage_all,
            commands::git::commit_changes,
            commands::deck::lint_deck,
            commands::chat::capture_sketch,
            commands::chat::capture_area,
            commands::export::create_image_export_dir,
            commands::export::export_slide_image,
            commands::export::export_pdf,
            commands::export::export_pptx,
            commands::deck::import_pptx,
            commands::export::export_video,
            commands::export::cancel_video_export,
            commands::chat::load_chat,
            commands::chat::session_provider,
            commands::chat::save_chat,
            commands::chat::reset_chat,
            commands::chat::list_chat_threads,
            commands::chat::select_chat_thread,
            commands::chat::send_message,
            commands::chat::interrupt_agent,
            commands::chat::steer_agent,
            commands::chat::permission_modes,
            commands::chat::respond_approval,
            commands::chat::set_permission_mode,
            commands::chat::agent_running,
            commands::chat::list_providers,
            commands::templates::list_templates,
            commands::templates::stage_template,
            commands::templates::apply_template,
            commands::templates::add_template_slide,
            commands::templates::create_template,
            commands::voice::voice_status,
            commands::voice::download_voice_model,
            commands::voice::follow_speech,
            commands::voice::start_recording,
            commands::voice::stop_recording,
            commands::voice::cancel_recording,
            commands::narration::start_narration_recording,
            commands::narration::narration_recording_slide,
            commands::narration::stop_narration_recording,
            commands::narration::delete_recorded_narration,
            commands::narration::speech_status,
            commands::narration::narration_audio,
            commands::narration::render_narration,
            commands::narration::cancel_narration,
            commands::narration::narration_wav,
            commands::narration::narration_peaks,
            commands::narration::time_narration,
            commands::narration::narration_words,
            commands::narration::set_narration_voice,
            commands::narration::set_narration_provider,
            commands::narration::set_speech_key,
            commands::narration::speech_voices,
            commands::narration::set_narration_language,
        ])
        .build(context)
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
mod window_config_tests {
    #[test]
    fn traffic_lights_are_vertically_centered_in_the_top_bar() {
        // The top bar and home header are `h-14` (56px); macOS window buttons are 14px tall.
        // tao grows the title bar container to button height + y, and AppKit keeps the
        // buttons 9px up from its bottom edge, so a button's top edge lands at y - 9.
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let position = &config["app"]["windows"][0]["trafficLightPosition"];
        assert_eq!(position["y"].as_f64(), Some((56.0 - 14.0) / 2.0 + 9.0));
        // Leaves room before the `pl-[84px]` content padding.
        assert!(position["x"].as_f64().unwrap() + 54.0 < 84.0);
    }
}
