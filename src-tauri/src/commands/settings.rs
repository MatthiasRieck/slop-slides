//! Commands for the app's settings (see [`crate::settings`]) and what Settings › Providers
//! shows beside them: which providers are at work, and the environment they run in.

use tauri::{AppHandle, Emitter, State};

use crate::agent::{AgentManager, Provider};
use crate::error::Result;
use crate::files;
use crate::providers::{self, EnvironmentCheck};
use crate::settings::{AppSettings, Settings, SettingsPatch, CHANGED_EVENT};

#[tauri::command]
pub fn get_settings(settings: State<Settings>) -> AppSettings {
    settings.get()
}

/// Changes the settings and tells every window. On the main thread, where commands run in the
/// order the frontend sent them: of two changes made one after the other, the later one wins.
#[tauri::command]
pub fn update_settings(
    app: AppHandle,
    settings: State<Settings>,
    agent: State<AgentManager>,
    patch: SettingsPatch,
) -> Result<AppSettings> {
    // No turn starts while the change is made: a provider is turned off only with none running.
    agent.with_busy_providers(|busy| {
        settings.update(&patch, busy, |next| {
            let _ = app.emit(CHANGED_EVENT, next);
        })
    })
}

/// The providers that have a turn running right now, in any window: they cannot be turned off.
#[tauri::command]
pub fn busy_providers(agent: State<AgentManager>) -> Vec<Provider> {
    agent.busy_providers()
}

/// What the agents need from the machine besides their CLIs. Off the main thread: it waits for
/// the environment of the user's shell and reads a file.
#[tauri::command(async)]
pub fn check_environment() -> Result<Vec<EnvironmentCheck>> {
    Ok(providers::check_environment(&files::app_home()?))
}
