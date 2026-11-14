//! Commands for a deck's narration: recording it, saying it with a hosted voice, and its timing.

use tauri::{AppHandle, State};

use super::{changing, reading};
use crate::deck::{self, Deck};
use crate::error::Result;
use crate::files;
use crate::history::{Change, Source};
use crate::narration;
use crate::voice;

/// Starts recording the deck's narration for the calling window, from `slide` on: what is said
/// goes to the slide on screen as text or as audio, with `narration-recorded` events as it does.
/// With `replace`, recorded audio takes the place of what a slide had, instead of adding to it.
#[tauri::command]
pub async fn start_narration_recording(
    app: AppHandle,
    window: tauri::Window,
    voice: State<'_, voice::Voice>,
    id: String,
    slide: String,
    mode: voice::RecordMode,
    replace: Option<bool>,
) -> Result<()> {
    let target = voice::NarrationTarget {
        file: deck::deck_file(&id)?,
        deck: id,
        mode,
        replace: replace.unwrap_or(false),
    };
    voice
        .record_narration(
            app,
            &files::app_home()?,
            window.label().to_string(),
            target,
            slide,
        )
        .await
}

/// Tells the narration recording which slide is on screen now.
#[tauri::command]
pub fn narration_recording_slide(voice: State<voice::Voice>, slide: String) {
    voice.narrate_slide(&slide);
}

/// Ends the narration recording, once all of it is kept.
#[tauri::command]
pub async fn stop_narration_recording(voice: State<'_, voice::Voice>) -> Result<()> {
    voice.stop_narration().await
}

/// Deletes a slide's recorded narration; returns every slide's audio.
#[tauri::command(async)]
pub fn delete_recorded_narration(id: String, slide: String) -> Result<Vec<narration::SlideAudio>> {
    reading(&id, |file| {
        narration::delete_recording(file, &slide)?;
        Ok(narration::statuses(file, &deck::load(file)?))
    })
}

#[tauri::command]
pub fn speech_status(narration: State<narration::Narration>) -> Result<narration::SpeechStatus> {
    Ok(narration.status(&files::app_home()?))
}

/// Each slide's narration audio: whether it is there and up to date, and how long it plays.
#[tauri::command(async)]
pub fn narration_audio(id: String) -> Result<Vec<narration::SlideAudio>> {
    // The deck comes from the deck cache: the one just loaded or saved is not parsed again.
    reading(&id, |file| {
        Ok(narration::statuses(file, &deck::load(file)?))
    })
}

/// Says the narration of the deck's `slides` (all for None) that has no up-to-date audio,
/// with `narration-render` progress events to every window.
#[tauri::command]
pub async fn render_narration(
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
            &files::app_home()?,
            &deck::deck_file(&id)?,
            slides.as_deref(),
            progress,
        )
        .await
}

/// Stops saying narration; the render fails with "the narration was cancelled".
#[tauri::command]
pub fn cancel_narration(narration: State<narration::Narration>) {
    narration.cancel();
}

/// Has the speech-to-text model hear the up-to-date audio of the deck's `slides` (all for None)
/// again, to keep when each word is said, with `narration-timing` progress events to every
/// window; returns every slide's audio.
#[tauri::command]
pub async fn time_narration(
    app: AppHandle,
    voice: State<'_, voice::Voice>,
    id: String,
    slides: Option<Vec<String>>,
) -> Result<Vec<narration::SlideAudio>> {
    use tauri::Emitter;
    let file = deck::deck_file(&id)?;
    let progress = |p: narration::TimingProgress| {
        let _ = app.emit(narration::TIMING_EVENT, p);
    };
    narration::time_words(
        &voice,
        &files::app_home()?,
        &file,
        slides.as_deref(),
        progress,
    )
    .await
}

/// Stops timing words, before the next slide is heard; `time_narration` fails with "the
/// narration was cancelled", and what was heard so far is kept.
#[tauri::command]
pub fn cancel_narration_timing() {
    narration::cancel_timing();
}

/// What the deck keeps of how its narration is said and timed (see
/// [`narration::DeckSettings`]): its own times, when it set them, and the pace and style.
#[tauri::command(async)]
pub fn narration_settings(id: String) -> Result<narration::DeckSettings> {
    Ok(narration::deck_settings(&deck::deck_file(&id)?))
}

/// Sets the times the deck plays with wherever it plays by itself; returns all it keeps.
#[tauri::command(async)]
pub fn set_narration_timing(
    id: String,
    timing: narration::Timing,
) -> Result<narration::DeckSettings> {
    narration::set_timing(&deck::deck_file(&id)?, timing)
}

/// Sets how fast and in what manner the deck's narration is said; returns all it keeps. Audio
/// said another way is out of date from then on.
#[tauri::command(async)]
pub fn set_narration_delivery(
    id: String,
    pace: narration::Pace,
    style: String,
) -> Result<narration::DeckSettings> {
    narration::set_delivery(&deck::deck_file(&id)?, pace, &style)
}

/// A short sample of `voice` of `provider` in `language`, as WAV bytes: said once with the
/// user's key, then kept in `~/.slopslides/voice-previews` for every deck.
#[tauri::command]
pub async fn preview_narration_voice(
    provider: String,
    voice: String,
    language: String,
) -> Result<tauri::ipc::Response> {
    let provider = narration::Provider::named(&provider)?;
    let file = narration::preview_voice(&files::app_home()?, provider, &voice, &language).await?;
    Ok(tauri::ipc::Response::new(std::fs::read(file)?))
}

/// When each word of a slide's narration audio is said, in seconds from the audio's start;
/// null until `time_narration` heard it.
#[tauri::command(async)]
pub fn narration_words(id: String, slide: String) -> Result<Option<Vec<voice::Word>>> {
    Ok(narration::words(&deck::deck_file(&id)?, &slide))
}

/// A slide's narration audio, as WAV bytes.
#[tauri::command(async)]
pub fn narration_wav(id: String, slide: String) -> Result<tauri::ipc::Response> {
    let file = narration::audio_file(&deck::deck_file(&id)?, &slide);
    Ok(tauri::ipc::Response::new(std::fs::read(file)?))
}

/// How loud a slide's narration audio is along its length, for drawing its waveform.
#[tauri::command]
pub async fn narration_peaks(id: String, slide: String) -> Result<Vec<f32>> {
    let file = narration::audio_file(&deck::deck_file(&id)?, &slide);
    let (samples, rate) = narration::audio::read_wav(&file)?;
    Ok(narration::audio::peaks(&samples, rate))
}

#[tauri::command(async)]
pub fn set_narration_voice(id: String, voice: String) -> Result<Deck> {
    changing(
        &id,
        Change::new(Source::Narration, "Change voice"),
        |file| deck::set_narration_voice(file, &voice),
    )
}

#[tauri::command(async)]
pub fn set_narration_provider(id: String, provider: String) -> Result<Deck> {
    changing(
        &id,
        Change::new(Source::Narration, "Change narration provider"),
        |file| deck::set_narration_provider(file, &provider),
    )
}

/// Saves the API key of a hosted narration provider in `~/.slopslides`, or forgets it for
/// None; returns what narration can do now.
#[tauri::command]
pub fn set_speech_key(
    narration: State<narration::Narration>,
    provider: String,
    key: Option<String>,
) -> Result<narration::SpeechStatus> {
    let provider = narration::Provider::named(&provider)?;
    let home = files::app_home()?;
    narration::cloud::set_key(&home, provider, key.as_deref())?;
    Ok(narration.status(&home))
}

/// Every voice the provider's account can use: for ElevenLabs, its premade voices and the
/// account's own; for the others, their built-in ones.
#[tauri::command]
pub async fn speech_voices(provider: String) -> Result<Vec<narration::cloud::VoiceOption>> {
    let provider = narration::Provider::named(&provider)?;
    let home = files::app_home()?;
    match (provider, narration::cloud::key(&home, provider)) {
        (narration::Provider::ElevenLabs, Some((key, _))) => {
            narration::cloud::elevenlabs_voices(&key).await
        }
        _ => Ok(provider.voices().iter().map(Into::into).collect()),
    }
}

#[tauri::command(async)]
pub fn set_narration_language(id: String, language: String) -> Result<Deck> {
    changing(
        &id,
        Change::new(Source::Narration, "Change language"),
        |file| deck::set_narration_language(file, &language),
    )
}
