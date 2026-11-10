//! The narration tools: set_narration_audio, narration_timeline, narration_beats and
//! generate_narration_audio. Each takes the deck the call names and reports, for the agent,
//! what it did or found.

use std::path::Path;

use serde_json::{json, Value};

use super::tools::{deck_argument, slides_argument, text_result, Tool};
use super::{BEATS_TOOL, GENERATE_TOOL, NARRATION_TOOL, TIMELINE_TOOL};
use crate::deck;
use crate::error::{Error, Result};
use crate::narration;
use crate::voice;

pub(super) const SET_AUDIO: Tool = Tool {
    name: NARRATION_TOOL,
    describe: || {
        (
            format!(
                "Make an existing audio file (WAV, MP3, M4A/AAC, FLAC, Ogg \
                Vorbis or AIFF) the narration audio of a slide, in place of any it has. It plays \
                from the moment the slide shows (it sets data-narration-start=\"0\") and goes on \
                playing over the next slides when it is longer than the slide: music for several \
                slides goes on the first, and those after it get no narration of their own. Like \
                a recording, it is the slide's audio whatever its narration script says; the \
                script is not changed. Its words are then timed with the speech-to-text model. \
                The audio file must be in the workspace: copy it in first if needed. Then call \
                {TIMELINE_TOOL} for when its words fall on the slides and {BEATS_TOOL} for its \
                beat."
            ),
            json!({ "type": "object", "properties": {
                "path": super::tools::deck_path_property(),
                "slide": { "type": "string", "description": "The id of the slide it starts on." },
                "audio": {
                    "type": "string",
                    "description": "The audio file, relative to the workspace root.",
                },
                "replace": {
                    "type": "boolean",
                    "description": "Replace the user's own recording of the slide; only when the user agreed. Without it a recorded slide keeps its audio.",
                },
            }, "required": ["slide", "audio"] }),
        )
    },
    call: |call| {
        let session = call.session();
        text_result(crate::files::app_home().and_then(|home| {
            set_narration_audio(call.dir, call.arguments, &home, session.as_deref())
        }))
    },
};

pub(super) const TIMELINE: Tool = Tool {
    name: TIMELINE_TOOL,
    describe: || {
        (
            "How a deck plays out with its narration, as a video export and \
                the self-running show play it: when each shown slide starts and ends, when each \
                slide's narration audio plays and over which slides, and when each word of it is \
                said (timed first where needed), as seconds into the show and into the slide \
                showing then. Use the time into a slide for animation delays on that slide when \
                timing animations to the narration; never count from the audio file alone."
                .into(),
            json!({ "type": "object", "properties": {
                "path": super::tools::deck_path_property(),
                "words": {
                    "type": "boolean",
                    "description": "List when each word is said (the default); false for the slides and narration only.",
                },
            } }),
        )
    },
    call: |call| {
        let session = call.session();
        text_result(crate::files::app_home().and_then(|home| {
            narration_timeline(call.dir, call.arguments, &home, session.as_deref())
        }))
    },
};

pub(super) const BEATS: Tool = Tool {
    name: BEATS_TOOL,
    describe: || {
        (
            format!(
                "The beat of a slide's narration audio, for music: its \
                tempo and when each beat falls, as seconds into the show and into the slide \
                showing then (as {TIMELINE_TOOL} counts), with how strong each is. Use it to \
                time animations to the music instead of analysing the audio yourself."
            ),
            json!({ "type": "object", "properties": {
                "path": super::tools::deck_path_property(),
                "slide": { "type": "string", "description": "The id of the slide whose narration audio it is." },
            }, "required": ["slide"] }),
        )
    },
    call: |call| {
        let session = call.session();
        text_result(narration_beats(
            call.dir,
            call.arguments,
            session.as_deref(),
        ))
    },
};

pub(super) const GENERATE: Tool = Tool {
    name: GENERATE_TOOL,
    describe: || {
        (
            format!(
                "Generate narration audio: the hosted text-to-speech service \
                the deck's narration provider meta names (OpenAI without one) reads \
                out the narration script (<aside class=\"narration\">) of one slide, of the \
                slides listed, or of every slide when `slides` is left out, in the deck's voice \
                and language. Only slides whose audio is missing or out of date (script, voice \
                or language changed) are said again; the user's own recordings, audio set with \
                {NARRATION_TOOL}, locked slides and slides without a script are left alone. It \
                takes a while (seconds per sentence), so ask for the slides you changed rather \
                than all of them. The service's API key must be entered in the Narration panel \
                (or set in the environment). Then call \
                {TIMELINE_TOOL} for when its words fall on the slides."
            ),
            json!({ "type": "object", "properties": {
                "path": super::tools::deck_path_property(),
                "slides": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "The ids of the slides to say; every slide when left out.",
                },
            } }),
        )
    },
    call: |call| {
        let session = call.session();
        text_result(crate::files::app_home().and_then(|home| {
            generate_narration_audio(call.dir, call.arguments, &home, session.as_deref())
        }))
    },
};

/// The speech-to-text model, kept loaded between calls.
static VOICE: std::sync::OnceLock<voice::Voice> = std::sync::OnceLock::new();

/// Unloads the speech-to-text model if a call loaded it, before the process exits: a model
/// still loaded aborts the process as it exits on macOS (see Voice::shutdown).
pub(super) fn shutdown() {
    if let Some(voice) = VOICE.get() {
        voice.shutdown();
    }
}

/// Times the words of the up-to-date audio of the deck `file`'s `slides` (all for None) that
/// are not timed yet, with the speech-to-text model in `home`.
fn time_words(file: &Path, slides: Option<&[String]>, home: &Path) -> Result<()> {
    let voice = VOICE.get_or_init(voice::Voice::default);
    tauri::async_runtime::block_on(narration::time_words(voice, home, file, slides, |_| {}))
        .map(|_| ())
}

/// Makes the workspace file `audio` the narration of `slide` of the deck at `path`
/// (`arguments`), starting with the slide, then times its words with the speech-to-text model
/// in `home`; what it did, for the agent. A slide locked in the deck, or in the turn's guard in
/// the workspace's `session`, keeps its audio.
pub(super) fn set_narration_audio(
    dir: &Path,
    arguments: &Value,
    home: &Path,
    session: Option<&Path>,
) -> Result<String> {
    let text = |key: &str| arguments[key].as_str().filter(|v| !v.is_empty());
    let (rel, file) = deck_argument(dir, arguments)?;
    let slide = text("slide").ok_or_else(|| Error::msg("slide is required"))?;
    let audio = text("audio").ok_or_else(|| Error::msg("audio is required"))?;
    let source = crate::workspace::open_file(dir, audio)?;
    if source.kind == crate::workspace::FileKind::Directory {
        return Err(Error::msg(format!(
            "{audio} is a folder, not an audio file"
        )));
    }
    let deck = deck::load(&file)?;
    let Some(found) = deck.slides.iter().find(|s| s.id == slide) else {
        return Err(Error::msg(format!("{rel} has no slide `{slide}`")));
    };
    let duration = found.duration;
    // Checked before the audio is replaced: audio is not in the deck's history to undo.
    let markup = std::fs::read_to_string(&file)?;
    if crate::html::is_locked(&markup, slide)
        || crate::guard::read_guard(&file, session)
            .iter()
            .any(|locked| locked.id == slide)
    {
        return Err(Error::msg(format!(
            "The slide `{slide}` is locked; unlock it to change its narration."
        )));
    }
    // The presenter's own recording cannot be made again: replaced only when asked to.
    if arguments["replace"].as_bool() != Some(true) && narration::has_own_recording(&file, slide) {
        return Err(Error::msg(format!(
            "The slide `{slide}` is narrated by the user's own recording, which would be lost. Ask the user first; call again with replace: true to replace it."
        )));
    }
    let seconds = narration::import_audio(&file, slide, Path::new(&source.absolute))?;
    let kept = narration::audio_file(&file, slide);
    // Workspace-relative, with `/` as the agent writes paths on every platform.
    let kept: Vec<String> = kept
        .strip_prefix(dir)
        .unwrap_or(&kept)
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect();
    let kept = kept.join("/");
    let mut out =
        format!("Slide `{slide}` is narrated by {audio} now ({seconds:.2} s, kept as {kept}).");
    // Audio made elsewhere plays from the moment the slide shows, whatever the app's pause.
    let pinned = deck::set_slide_timing(
        &file,
        &[deck::SlideTiming {
            slide: slide.to_string(),
            duration,
            narration_start: Some(0.0),
        }],
    );
    match pinned {
        Ok(_) => out.push_str(&format!(
            " It starts as the slide shows ({}=\"0\").",
            crate::html::NARRATION_START_ATTR
        )),
        Err(e) => out.push_str(&format!(" Its start is not pinned to the slide's: {e}.")),
    }
    let slides = [slide.to_string()];
    match time_words(&file, Some(&slides), home).map(|_| narration::words(&file, slide)) {
        Ok(Some(words)) if words.is_empty() => out.push_str(" No words are heard in it."),
        Ok(Some(words)) => out.push_str(&format!(" Its {} words are timed.", words.len())),
        Ok(None) => out.push_str(" Its words are not timed."),
        Err(e) => out.push_str(&format!(
            " Its words are not timed: {}. The user can time them in the Narration panel.",
            e.to_string().trim_end_matches('.')
        )),
    }
    out.push_str(&format!(
        " Call {TIMELINE_TOOL} for when its words fall on the slides, {BEATS_TOOL} for its beat."
    ));
    Ok(out)
}

/// Narration's state, so one generation runs at a time in this process.
static NARRATION: std::sync::OnceLock<narration::Narration> = std::sync::OnceLock::new();

/// Has the deck's narration service, with the API key in `home`, say the narration of the deck at `path` (`arguments`): of its
/// `slides`, or all of them, whose audio is missing or out of date. Slides locked in the deck,
/// or in the turn's guard in the workspace's `session`, are left alone. What it did, for the
/// agent, slide by slide.
pub(super) fn generate_narration_audio(
    dir: &Path,
    arguments: &Value,
    home: &Path,
    session: Option<&Path>,
) -> Result<String> {
    let (rel, file) = deck_argument(dir, arguments)?;
    let asked = slides_argument(arguments)?;
    let deck = deck::load(&file)?;
    if let Some(missing) = asked
        .iter()
        .flatten()
        .find(|id| !deck.slides.iter().any(|s| &s.id == *id))
    {
        return Err(Error::msg(format!("{rel} has no slide `{missing}`")));
    }
    let guard = crate::guard::read_guard(&file, session);
    let locked = |slide: &deck::Slide| slide.locked || guard.iter().any(|l| l.id == slide.id);
    let wanted: Vec<&deck::Slide> = deck
        .slides
        .iter()
        .filter(|s| asked.as_ref().map_or(true, |ids| ids.contains(&s.id)))
        .collect();
    let to_say: Vec<String> = wanted
        .iter()
        .filter(|s| !locked(s))
        .map(|s| s.id.clone())
        .collect();
    let before = narration::statuses(&file, &deck);
    let after = if to_say.is_empty() {
        before.clone()
    } else {
        let speech = NARRATION.get_or_init(narration::Narration::default);
        tauri::async_runtime::block_on(speech.render(home, &file, Some(&to_say), |_| {}))
            .map_err(|e| Error::msg(format!("Generating the narration audio failed: {e}")))?
    };
    let state_of =
        |all: &[narration::SlideAudio], id: &str| all.iter().find(|a| a.slide == id).cloned();
    let mut lines = Vec::new();
    let mut said = 0;
    for slide in &wanted {
        let id = &slide.id;
        let was = state_of(&before, id);
        let now = state_of(&after, id);
        let seconds = now
            .as_ref()
            .and_then(|a| a.seconds)
            .map(|s| format!(" ({s:.2} s)"))
            .unwrap_or_default();
        let line = match now {
            _ if locked(slide) => "locked, its audio is left as it was".to_string(),
            Some(a) if a.recorded && a.imported => {
                format!("keeps the audio set for it{seconds}")
            }
            Some(a) if a.recorded => format!("keeps the user's own recording{seconds}"),
            Some(a) if a.state == narration::AudioState::None => {
                "has no narration script; nothing to say".to_string()
            }
            Some(a) if a.state == narration::AudioState::Ready => {
                if was.is_some_and(|w| w.state == narration::AudioState::Ready) {
                    format!("already up to date{seconds}")
                } else {
                    said += 1;
                    format!("said{seconds}")
                }
            }
            _ => "has no audio".to_string(),
        };
        lines.push(format!("- `{id}`: {line}"));
    }
    Ok(format!(
        "Narration audio of {rel}: {said} slide{} said.\n{}\n\nCall {TIMELINE_TOOL} for when its words fall on the slides.",
        if said == 1 { "" } else { "s" },
        lines.join("\n")
    ))
}

/// Seconds as the timing tools show them.
fn secs(seconds: f64) -> String {
    format!("{seconds:.2}")
}

/// Seconds as the timing tools save them: to the millisecond.
fn ms(seconds: f64) -> f64 {
    (seconds * 1000.0).round() / 1000.0
}

/// Writes `data` to `name` in the `timing/` folder of the workspace's `session`, for the agent's
/// scripts to read; a line telling where, or nothing without a session.
pub(super) fn saved(session: Option<&Path>, rel: &str, what: &str, data: &Value) -> String {
    let Some(session) = session else {
        return String::new();
    };
    let folder = session.join("timing");
    // `what` may hold a slide id, which the agent writes: keep it one plain file name.
    let name = format!(
        "{}.{}.json",
        rel.replace(['/', '\\'], "_"),
        narration::file_stem(what)
    );
    let written = std::fs::create_dir_all(&folder).and_then(|_| {
        let text = serde_json::to_string_pretty(data).unwrap_or_default();
        std::fs::write(folder.join(&name), text)
    });
    match written {
        Ok(()) => format!(
            "\n\nThe same as JSON, for your scripts to read rather than copy: {}",
            folder.join(name).display()
        ),
        Err(e) => format!("\n\n(Its JSON could not be saved: {e}.)"),
    }
}

/// How the deck at `path` (`arguments`) plays out with its narration, with when each word is
/// said (timing them first with the model in `home` where needed) unless `words` is false; also
/// saved as JSON in the workspace's `session`.
pub(super) fn narration_timeline(
    dir: &Path,
    arguments: &Value,
    home: &Path,
    session: Option<&Path>,
) -> Result<String> {
    use narration::timeline;
    let (rel, file) = deck_argument(dir, arguments)?;
    let with_words = arguments["words"].as_bool().unwrap_or(true);
    let deck = deck::load(&file)?;
    let mut slides = timeline::layout(&file, &deck, &timeline::DEFAULTS);
    let mut untimed = None;
    if with_words {
        if let Err(e) = time_words(&file, None, home) {
            untimed = Some(e.to_string());
        }
        slides = timeline::layout(&file, &deck, &timeline::DEFAULTS);
    }
    let d = timeline::DEFAULTS;
    let mut out = format!(
        "How {rel} plays in a video export and the self-running show, in seconds from its \
         start. What a slide does not pin follows the app's default export settings: a slide \
         shows at least {} s, its narration starts {} s in and the slide stays {} s after it; \
         the user may export with others, so pin `{}` and `{}` on slides you time to narration. \
         A narration never talks over the one before it: it waits. An animation on a slide \
         starts as the slide shows, so its delay is the time into that slide.\n",
        d.seconds_per_slide,
        d.pause_before,
        d.pause_after,
        crate::html::DURATION_ATTR,
        crate::html::NARRATION_START_ATTR,
    );
    let mut data_slides = Vec::new();
    let mut data_words = Vec::new();
    for (i, slide) in slides.iter().enumerate() {
        let pinned = |set: Option<f64>| if set.is_some() { "pinned" } else { "default" };
        data_slides.push(json!({
            "id": slide.id,
            "start": ms(slide.start),
            "end": ms(slide.end),
            "duration": slide.duration,
            "narrationStart": slide.narration_start,
            "narration": slide.narration.as_ref().map(|clip| json!({
                "start": ms(clip.start),
                "end": ms(clip.end),
                "source": match (clip.imported, clip.recorded) {
                    (true, _) => "imported",
                    (_, true) => "recording",
                    _ => "voice",
                },
                "waits": ms(clip.start - clip.planned.max(0.0)).max(0.0),
            })),
            "unspoken": slide.unspoken,
        }));
        out.push_str(&format!(
            "\n{}. `{}` shows {}–{} ({} s, {})",
            i + 1,
            slide.id,
            secs(slide.start),
            secs(slide.end),
            secs(slide.end - slide.start),
            pinned(slide.duration),
        ));
        if let Some(clip) = &slide.narration {
            let over: Vec<String> = slides
                .iter()
                .filter(|s| s.id != slide.id && s.start < clip.end - 0.005 && s.end > clip.start)
                .map(|s| format!("`{}`", s.id))
                .collect();
            out.push_str(&format!(
                "\n   narration ({}, {} s) plays {}–{}, starting {} s into the slide ({})",
                match (clip.imported, clip.recorded) {
                    (true, _) => "imported audio",
                    (_, true) => "the presenter's recording",
                    _ => "generated speech",
                },
                secs(clip.end - clip.start),
                secs(clip.start),
                secs(clip.end),
                secs(clip.start - slide.start),
                if clip.start > clip.planned + 0.005 {
                    "waiting for the narration before it"
                } else {
                    pinned(slide.narration_start)
                },
            ));
            if !over.is_empty() {
                out.push_str(&format!("; plays on over {}", over.join(", ")));
            }
        } else if slide.unspoken {
            out.push_str("\n   narration script without up-to-date audio: the user has it spoken in the Narration panel (an export does it first); until then its timing is unknown");
        }
    }
    if with_words {
        for slide in slides.iter().filter(|s| s.narration.is_some()) {
            out.push_str(&format!("\n\nWords of `{}`'s narration", slide.id));
            match narration::words(&file, &slide.id) {
                None => out.push_str(&format!(
                    ": not timed{}.",
                    untimed.as_ref().map_or(String::new(), |e| format!(
                        " ({}; the user can time them in the Narration panel)",
                        e.trim_end_matches('.')
                    ))
                )),
                Some(words) if words.is_empty() => out.push_str(": none heard."),
                Some(words) => {
                    out.push_str(
                        ": start–end in the show, then the slide showing at the start and the \
                         seconds into it.",
                    );
                    for word in words {
                        let Some(at) = timeline::place(&slides, &slide.id, word.start) else {
                            continue;
                        };
                        out.push_str(&format!(
                            "\n{}–{} {} +{} {}",
                            secs(at.at),
                            secs(at.at + word.end - word.start),
                            at.slide,
                            secs(at.into_slide),
                            word.text
                        ));
                        data_words.push(json!({
                            "audio": slide.id,
                            "text": word.text,
                            "start": ms(at.at),
                            "end": ms(at.at + word.end - word.start),
                            "slide": at.slide,
                            "intoSlide": ms(at.into_slide),
                        }));
                    }
                }
            }
        }
    }
    let data = json!({
        "deck": rel,
        "assumed": {
            "secondsPerSlide": d.seconds_per_slide,
            "pauseBefore": d.pause_before,
            "pauseAfter": d.pause_after,
        },
        "end": slides.last().map_or(0.0, |s| ms(s.end)),
        "slides": data_slides,
        "words": data_words,
    });
    out.push_str(&saved(session, &rel, "timeline", &data));
    Ok(out)
}

/// The beat of the narration audio of `slide` of the deck at `path` (`arguments`), placed on
/// the deck's timeline; also saved as JSON in the workspace's `session`.
fn narration_beats(dir: &Path, arguments: &Value, session: Option<&Path>) -> Result<String> {
    use narration::timeline;
    let (rel, file) = deck_argument(dir, arguments)?;
    let slide = arguments["slide"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| Error::msg("slide is required"))?;
    let deck = deck::load(&file)?;
    if !deck.slides.iter().any(|s| s.id == slide) {
        return Err(Error::msg(format!("{rel} has no slide `{slide}`")));
    }
    let slides = timeline::layout(&file, &deck, &timeline::DEFAULTS);
    if !slides
        .iter()
        .any(|s| s.id == slide && s.narration.is_some())
    {
        return Err(Error::msg(format!(
            "slide `{slide}` has no up-to-date narration audio that plays"
        )));
    }
    let (samples, rate) = narration::audio::read_wav(&narration::audio_file(&file, slide))?;
    let Some(found) = narration::beats::find(&samples, rate) else {
        return Ok(format!("No beat is heard in slide `{slide}`'s narration."));
    };
    let mut out = format!(
        "Slide `{slide}`'s narration has a beat of {:.1} BPM (one every {} s), {} beats. Each: \
         when it falls in the show (as {TIMELINE_TOOL} counts), the slide showing then and the \
         seconds into it, how strong its onset is (0 to 1, 1 the strongest), and bar.beat: \
         bars of four, beat 1 their downbeat, found from the accents and shifting where the \
         music does (bar 0 is before the first downbeat).",
        found.tempo,
        secs(60.0 / found.tempo),
        found.beats.len(),
    );
    let mut bar = 0;
    let mut data_beats = Vec::new();
    for ((at, strength), &in_bar) in found.beats.iter().zip(&found.in_bar) {
        if in_bar == 0 {
            bar += 1;
        }
        let Some(placed) = timeline::place(&slides, slide, *at) else {
            continue;
        };
        out.push_str(&format!(
            "\n{} {} +{} {strength:.2} {bar}.{}",
            secs(placed.at),
            placed.slide,
            secs(placed.into_slide),
            in_bar + 1
        ));
        data_beats.push(json!({
            "at": ms(placed.at),
            "slide": placed.slide,
            "intoSlide": ms(placed.into_slide),
            "strength": (strength * 100.0).round() / 100.0,
            "bar": bar,
            "beat": in_bar + 1,
        }));
    }
    let data = json!({
        "deck": rel,
        "audio": slide,
        "tempo": (found.tempo * 10.0).round() / 10.0,
        "beats": data_beats,
    });
    out.push_str(&saved(session, &rel, &format!("beats-{slide}"), &data));
    Ok(out)
}
