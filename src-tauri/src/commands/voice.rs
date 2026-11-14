//! Commands for speech to text: dictating and following the presenter's speech.

use tauri::{AppHandle, State};

use crate::error::Result;
use crate::files;
use crate::voice;

#[tauri::command]
pub fn voice_status(voice: State<voice::Voice>) -> Result<voice::VoiceStatus> {
    Ok(voice.status(&files::app_home()?))
}

/// Downloads the speech-to-text model to `~/.slopslides/models` unless it is there.
#[tauri::command]
pub async fn download_voice_model(app: AppHandle, voice: State<'_, voice::Voice>) -> Result<()> {
    voice.download(&app, &files::app_home()?).await
}

/// Stops the speech-to-text model's download, if one runs; `download_voice_model` fails with
/// "the download was cancelled".
#[tauri::command]
pub fn cancel_voice_download(voice: State<voice::Voice>) {
    voice.cancel_download();
}

/// Listens for the teleprompter in the calling window, reporting recent words as `voice-heard`
/// events until `cancel_recording`.
#[tauri::command]
pub async fn follow_speech(
    app: AppHandle,
    window: tauri::Window,
    voice: State<'_, voice::Voice>,
) -> Result<()> {
    voice
        .follow(app, &files::app_home()?, window.label().to_string())
        .await
}

/// Starts recording, transcribing live as `voice-partial` events.
#[tauri::command]
pub async fn start_recording(app: AppHandle, voice: State<'_, voice::Voice>) -> Result<()> {
    voice.start(app, &files::app_home()?).await
}

/// Stops recording and returns what was said.
#[tauri::command]
pub async fn stop_recording(voice: State<'_, voice::Voice>) -> Result<String> {
    voice.stop(&files::app_home()?).await
}

#[tauri::command]
pub fn cancel_recording(voice: State<voice::Voice>) {
    voice.cancel();
}
