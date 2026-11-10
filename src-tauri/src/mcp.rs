//! Workspace MCP tools: lint_deck validates a workspace-relative deck, open_file queues a
//! request in the current workspace session for the app to show a file, and render_slide
//! asks the app, the same way, for images of slides (see render.rs). set_narration_audio
//! makes an audio file the narration of a slide and times its words, and
//! generate_narration_audio has the deck's voice say slides' narration scripts. export_deck
//! exports a deck as the Export menu does (see export.rs).
//! Started as `slopslide --lint-mcp [workspace root]`.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::deck;
use crate::error::{Error, Result};
use crate::export;
use crate::lint;
use crate::narration;
use crate::render;
use crate::sessions::Sessions;
use crate::video;
use crate::voice;

pub const FLAG: &str = "--lint-mcp";
pub const SERVER: &str = "slopslide";
pub const TOOL: &str = "lint_deck";
pub const OPEN_TOOL: &str = "open_file";
pub const RENDER_TOOL: &str = "render_slide";
pub const NARRATION_TOOL: &str = "set_narration_audio";
pub const TIMELINE_TOOL: &str = "narration_timeline";
pub const BEATS_TOOL: &str = "narration_beats";
pub const GENERATE_TOOL: &str = "generate_narration_audio";
pub const EXPORT_TOOL: &str = "export_deck";
const OPEN_REQUESTS: &str = "open-requests";
/// Claude Code's rule for every tool of this server, for `--allowedTools`; its tools are
/// named `mcp__slopslide__<tool>`.
pub const CLAUDE_TOOLS: &str = "mcp__slopslide";

/// Whether Claude Code tool `name` is one of this server's. The agent may always use them.
pub fn is_claude_tool(name: &str) -> bool {
    claude_tool(name).is_some()
}

fn claude_tool(name: &str) -> Option<&str> {
    name.strip_prefix(CLAUDE_TOOLS)?
        .strip_prefix("__")
        .filter(|tool| !tool.is_empty())
}

/// The name the chat shows for a tool: this server's tools without the prefix each
/// provider adds (Claude Code's `mcp__slopslide__`, Copilot's `slopslide-`), so they read
/// alike for every provider; other tools as named.
pub fn display_name(name: &str) -> &str {
    claude_tool(name)
        .or_else(|| {
            name.strip_prefix(SERVER)?
                .strip_prefix('-')
                .filter(|tool| !tool.is_empty())
        })
        .unwrap_or(name)
}

const DEFAULT_PROTOCOL: &str = "2024-11-05";

/// Serves requests from stdin until it closes. Locked slides are checked against the deck's
/// current session, where the app records them for the running turn.
pub fn serve(dir: &Path) {
    let sessions = crate::files::app_home()
        .ok()
        .map(|home| Sessions::new(&home));
    let session = |_: &Path| sessions.as_ref().and_then(|s| s.current(dir));
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(request) => handle(&request, dir, &session),
            Err(e) => Some(error(Value::Null, -32700, &format!("parse error: {e}"))),
        };
        if let Some(response) = response {
            if writeln!(stdout, "{response}")
                .and_then(|_| stdout.flush())
                .is_err()
            {
                break;
            }
        }
    }
    // A speech model still loaded aborts the process as it exits on macOS (see Voice::shutdown).
    if let Some(voice) = VOICE.get() {
        voice.shutdown();
    }
}

/// Answers one JSON-RPC message; notifications get no response. `session` finds the workspace's current session.
pub fn handle(
    request: &Value,
    dir: &Path,
    session: &dyn Fn(&Path) -> Option<PathBuf>,
) -> Option<Value> {
    let id = request.get("id")?.clone();
    let result = match request["method"].as_str().unwrap_or("") {
        "initialize" => json!({
            "protocolVersion": request["params"]["protocolVersion"]
                .as_str()
                .unwrap_or(DEFAULT_PROTOCOL),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": SERVER, "version": env!("CARGO_PKG_VERSION") },
        }),
        "ping" => json!({}),
        "tools/list" => json!({ "tools": [{
            "name": TOOL,
            "description": "Lint the deck file (deck.html unless `path` names another): \
                checks that the HTML is well formed (all elements \
                closed, no stray end tags) and follows the deck format (slides are \
                <section class=\"slide\" id=\"…\"> in <main class=\"deck\">, unique kebab-case \
                ids, attached assets exist, images have alt text) and that locked slides \
                (data-locked) are unchanged. Run it after editing the deck and fix every \
                issue it reports.",
            "inputSchema": { "type": "object", "properties": {
                "path": {
                    "type": "string",
                    "description": "The deck file, relative to the workspace root; deck.html when left out.",
                },
            } },
        }, {
            "name": OPEN_TOOL,
            "description": "Show a workspace file in SlopSlide. Use after creating a deck or to show the user another file.",
            "inputSchema": { "type": "object", "properties": {
                "path": { "type": "string", "description": "Workspace-relative file path." }
            }, "required": ["path"] }
        }, {
            "name": RENDER_TOOL,
            "description": format!("See slides of a deck as the app renders them: returns an \
                image of each slide, hidden ones too, with every animation finished, and lists \
                the elements that run past the slide or are cut off by their own box. With \
                `at`, each slide is shown that many seconds after it shows instead, its \
                animations where they are then, as that frame of a video export: use it to \
                check timed animations (what is on screen when a word is sung, say). The images \
                are what video exports and PDFs draw. Use it to check the look after building \
                or reworking slides, instead of a browser or screenshots from the shell. Takes \
                at most {} slides per call.",
                render::MAX_SLIDES),
            "inputSchema": { "type": "object", "properties": {
                "path": {
                    "type": "string",
                    "description": "The deck file, relative to the workspace root; deck.html when left out.",
                },
                "slides": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "The ids of the slides to render.",
                },
                "at": {
                    "type": "number",
                    "description": "Seconds after each slide shows to render it at (the time into the slide, as narration_timeline gives it); every animation finished when left out.",
                },
            }, "required": ["slides"] }
        }, {
            "name": NARRATION_TOOL,
            "description": format!("Make an existing audio file (WAV, MP3, M4A/AAC, FLAC, Ogg \
                Vorbis or AIFF) the narration audio of a slide, in place of any it has. It plays \
                from the moment the slide shows (it sets data-narration-start=\"0\") and goes on \
                playing over the next slides when it is longer than the slide: music for several \
                slides goes on the first, and those after it get no narration of their own. Like \
                a recording, it is the slide's audio whatever its narration script says; the \
                script is not changed. Its words are then timed with the speech-to-text model. \
                The audio file must be in the workspace: copy it in first if needed. Then call \
                {TIMELINE_TOOL} for when its words fall on the slides and {BEATS_TOOL} for its \
                beat."),
            "inputSchema": { "type": "object", "properties": {
                "path": {
                    "type": "string",
                    "description": "The deck file, relative to the workspace root; deck.html when left out.",
                },
                "slide": { "type": "string", "description": "The id of the slide it starts on." },
                "audio": {
                    "type": "string",
                    "description": "The audio file, relative to the workspace root.",
                },
                "replace": {
                    "type": "boolean",
                    "description": "Replace the user's own recording of the slide; only when the user agreed. Without it a recorded slide keeps its audio.",
                },
            }, "required": ["slide", "audio"] }
        }, {
            "name": TIMELINE_TOOL,
            "description": "How a deck plays out with its narration, as a video export and \
                the self-running show play it: when each shown slide starts and ends, when each \
                slide's narration audio plays and over which slides, and when each word of it is \
                said (timed first where needed), as seconds into the show and into the slide \
                showing then. Use the time into a slide for animation delays on that slide when \
                timing animations to the narration; never count from the audio file alone.",
            "inputSchema": { "type": "object", "properties": {
                "path": {
                    "type": "string",
                    "description": "The deck file, relative to the workspace root; deck.html when left out.",
                },
                "words": {
                    "type": "boolean",
                    "description": "List when each word is said (the default); false for the slides and narration only.",
                },
            } }
        }, {
            "name": BEATS_TOOL,
            "description": format!("The beat of a slide's narration audio, for music: its \
                tempo and when each beat falls, as seconds into the show and into the slide \
                showing then (as {TIMELINE_TOOL} counts), with how strong each is. Use it to \
                time animations to the music instead of analysing the audio yourself."),
            "inputSchema": { "type": "object", "properties": {
                "path": {
                    "type": "string",
                    "description": "The deck file, relative to the workspace root; deck.html when left out.",
                },
                "slide": { "type": "string", "description": "The id of the slide whose narration audio it is." },
            }, "required": ["slide"] }
        }, {
            "name": GENERATE_TOOL,
            "description": format!("Generate narration audio: the hosted text-to-speech service \
                the deck's narration provider meta names (OpenAI without one) reads \
                out the narration script (<aside class=\"narration\">) of one slide, of the \
                slides listed, or of every slide when `slides` is left out, in the deck's voice \
                and language. Only slides whose audio is missing or out of date (script, voice \
                or language changed) are said again; the user's own recordings, audio set with \
                {NARRATION_TOOL}, locked slides and slides without a script are left alone. It \
                takes a while (seconds per sentence), so ask for the slides you changed rather \
                than all of them. The service's API key must be entered in the Narration panel \
                (or set in the environment). Then call \
                {TIMELINE_TOOL} for when its words fall on the slides."),
            "inputSchema": { "type": "object", "properties": {
                "path": {
                    "type": "string",
                    "description": "The deck file, relative to the workspace root; deck.html when left out.",
                },
                "slides": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "The ids of the slides to say; every slide when left out.",
                },
            } }
        }, {
            "name": EXPORT_TOOL,
            "description": format!("Export a deck as the app's Export menu does, when the user \
                asks for an export: `html` (one standalone HTML file with its assets inlined), \
                `pdf` (one page per shown slide, selectable text), `pptx` (PowerPoint, one slide \
                per shown slide), `video` (an MP4 of the deck playing, with its animations and \
                narration audio, timed as {TIMELINE_TOOL} says; narration audio that is missing \
                is generated first) or `images` (a PNG of every slide, the canvas size, in a \
                folder). It goes to `dest` in the workspace, or to `{}/` next to the deck, named \
                after its title. Lint the deck first. A video takes a while (minutes for a long \
                deck); ask for it once. Then tell the user where it is, or show it with \
                {OPEN_TOOL}.", export::FOLDER),
            "inputSchema": { "type": "object", "properties": {
                "path": {
                    "type": "string",
                    "description": "The deck file, relative to the workspace root; deck.html when left out.",
                },
                "format": {
                    "type": "string",
                    "enum": export::Format::ALL.iter().map(|f| f.name()).collect::<Vec<_>>(),
                    "description": "What to export the deck as.",
                },
                "dest": {
                    "type": "string",
                    "description": "Where it goes, relative to the workspace root: the file (its extension is added when left out), or the folder for images.",
                },
                "overwrite": {
                    "type": "boolean",
                    "description": "Replace an existing file, or write images into a folder that is not empty; only when the user agreed.",
                },
                "seconds_per_slide": {
                    "type": "number",
                    "description": format!("video: how long each slide shows, in seconds ({} to {}); with narration, at least. Default {}.", video::MIN_SECONDS, video::MAX_SECONDS, narration::timeline::DEFAULTS.seconds_per_slide),
                },
                "fps": {
                    "type": "integer",
                    "enum": video::FRAME_RATES,
                    "description": format!("video: frames per second. Default {}.", narration::timeline::DEFAULTS.fps),
                },
                "animate": {
                    "type": "boolean",
                    "description": "video: play animations, slide fades and morphs; false for still slides. Default true.",
                },
                "narration": {
                    "type": "boolean",
                    "description": "video: say each slide's narration over it. Default true.",
                },
                "pause_before": {
                    "type": "number",
                    "description": format!("video: seconds of silence before a slide's narration, 0 to {}. Default {}.", video::MAX_PAUSE, narration::timeline::DEFAULTS.pause_before),
                },
                "pause_after": {
                    "type": "number",
                    "description": format!("video: seconds the slide stays after its narration, 0 to {}. Default {}.", video::MAX_PAUSE, narration::timeline::DEFAULTS.pause_after),
                },
            }, "required": ["format"] }
        }]}),
        "tools/call" if request["params"]["name"] == TOOL => {
            let rel = request["params"]["arguments"]["path"]
                .as_str()
                .filter(|p| !p.is_empty())
                .unwrap_or(deck::DECK_FILE);
            let linted = crate::workspace::resolve(dir, rel).and_then(|file| {
                let session = session(&file);
                deck::lint(&file, session.as_deref())
            });
            let (text, failed) = match linted {
                Ok(issues) => (lint::format_report(&issues), false),
                Err(e) => (format!("Could not lint {rel}: {e}"), true),
            };
            json!({ "content": [{ "type": "text", "text": text }], "isError": failed })
        }
        "tools/call" if request["params"]["name"] == OPEN_TOOL => {
            let opened = (|| -> crate::error::Result<String> {
                let rel = request["params"]["arguments"]["path"]
                    .as_str()
                    .filter(|p| !p.is_empty())
                    .ok_or_else(|| crate::error::Error::msg("path is required"))?;
                let file = crate::workspace::open_file(dir, rel)?;
                if file.kind == crate::workspace::FileKind::Directory {
                    return Err(crate::error::Error::msg("expected a file"));
                }
                let session =
                    session(dir).ok_or_else(|| crate::error::Error::msg("no workspace session"))?;
                let inbox = session.join(OPEN_REQUESTS);
                std::fs::create_dir_all(&inbox)?;
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos();
                let name = format!("{stamp:025}-{}", uuid::Uuid::new_v4());
                let temp = inbox.join(format!("{name}.tmp"));
                std::fs::write(&temp, json!({"path": rel}).to_string())?;
                std::fs::rename(temp, inbox.join(format!("{name}.json")))?;
                Ok(format!("Requested opening {rel} in SlopSlide."))
            })();
            let (text, failed) = match opened {
                Ok(text) => (text, false),
                Err(e) => (e.to_string(), true),
            };
            json!({ "content": [{ "type": "text", "text": text }], "isError": failed })
        }
        "tools/call" if request["params"]["name"] == RENDER_TOOL => {
            let rendered = (|| -> crate::error::Result<Vec<Value>> {
                let arguments = &request["params"]["arguments"];
                let rel = arguments["path"]
                    .as_str()
                    .filter(|p| !p.is_empty())
                    .unwrap_or(deck::DECK_FILE);
                crate::workspace::open_file(dir, rel)?;
                let slides: Vec<String> = arguments["slides"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|slide| slide.as_str().map(str::to_string))
                    .collect();
                render::check_slides(&slides)?;
                let at = match &arguments["at"] {
                    Value::Null => None,
                    at => Some(at.as_f64().ok_or_else(|| {
                        crate::error::Error::msg("at is seconds after the slide shows, a number")
                    })?),
                };
                render::check_at(at)?;
                let session =
                    session(dir).ok_or_else(|| crate::error::Error::msg("no workspace session"))?;
                let slides = render::ask(&session, rel, slides, at, render::WAIT)?;
                Ok(render_content(&slides))
            })();
            let (content, failed) = match rendered {
                Ok(content) => (content, false),
                Err(e) => (vec![json!({ "type": "text", "text": e.to_string() })], true),
            };
            json!({ "content": content, "isError": failed })
        }
        "tools/call" if request["params"]["name"] == NARRATION_TOOL => {
            let arguments = &request["params"]["arguments"];
            let session = session(dir);
            text_result(
                crate::files::app_home().and_then(|home| {
                    set_narration_audio(dir, arguments, &home, session.as_deref())
                }),
            )
        }
        "tools/call" if request["params"]["name"] == TIMELINE_TOOL => {
            let arguments = &request["params"]["arguments"];
            let session = session(dir);
            text_result(
                crate::files::app_home()
                    .and_then(|home| narration_timeline(dir, arguments, &home, session.as_deref())),
            )
        }
        "tools/call" if request["params"]["name"] == BEATS_TOOL => {
            let session = session(dir);
            text_result(narration_beats(
                dir,
                &request["params"]["arguments"],
                session.as_deref(),
            ))
        }
        "tools/call" if request["params"]["name"] == GENERATE_TOOL => {
            let arguments = &request["params"]["arguments"];
            let session = session(dir);
            text_result(crate::files::app_home().and_then(|home| {
                generate_narration_audio(dir, arguments, &home, session.as_deref())
            }))
        }
        "tools/call" if request["params"]["name"] == EXPORT_TOOL => {
            let session = session(dir);
            text_result(export_deck(
                dir,
                &request["params"]["arguments"],
                session.as_deref(),
                export::WAIT,
            ))
        }
        "tools/call" => return Some(error(id, -32602, "unknown tool")),
        method => return Some(error(id, -32601, &format!("method not found: {method}"))),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

/// A tool result of `text`, or of what went wrong.
fn text_result(text: Result<String>) -> Value {
    let (text, failed) = match text {
        Ok(text) => (text, false),
        Err(e) => (e.to_string(), true),
    };
    json!({ "content": [{ "type": "text", "text": text }], "isError": failed })
}

/// The speech-to-text model, kept loaded between calls.
static VOICE: std::sync::OnceLock<voice::Voice> = std::sync::OnceLock::new();

/// The deck file `path` of `arguments` names (deck.html when left out): its workspace-relative
/// path and where it is.
fn deck_argument(dir: &Path, arguments: &Value) -> Result<(String, PathBuf)> {
    let rel = arguments["path"]
        .as_str()
        .filter(|v| !v.is_empty())
        .unwrap_or(deck::DECK_FILE);
    let file = crate::workspace::open_file(dir, rel)?;
    Ok((rel.to_string(), PathBuf::from(file.absolute)))
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
fn set_narration_audio(
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

/// The slide ids `slides` of `arguments` lists; None when left out, for every slide.
fn slides_argument(arguments: &Value) -> Result<Option<Vec<String>>> {
    let ids = match &arguments["slides"] {
        Value::Null => return Ok(None),
        Value::Array(ids) if ids.is_empty() => {
            return Err(Error::msg(
                "slides is empty: list slide ids, or leave it out for every slide",
            ))
        }
        Value::Array(ids) => ids,
        _ => return Err(Error::msg("slides is a list of slide ids")),
    };
    ids.iter()
        .map(|id| {
            id.as_str()
                .filter(|id| !id.is_empty())
                .map(str::to_string)
                .ok_or_else(|| Error::msg("slides is a list of slide ids"))
        })
        .collect::<Result<_>>()
        .map(Some)
}

/// Has the deck's narration service, with the API key in `home`, say the narration of the deck at `path` (`arguments`): of its
/// `slides`, or all of them, whose audio is missing or out of date. Slides locked in the deck,
/// or in the turn's guard in the workspace's `session`, are left alone. What it did, for the
/// agent, slide by slide.
fn generate_narration_audio(
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

/// The video options `arguments` give, over the narration timeline's defaults.
fn video_options(arguments: &Value) -> Result<video::Options> {
    let mut options = narration::timeline::DEFAULTS;
    let number = |key: &str, into: &mut f64| -> Result<()> {
        match &arguments[key] {
            Value::Null => Ok(()),
            value => {
                *into = value
                    .as_f64()
                    .ok_or_else(|| Error::msg(format!("{key} is a number of seconds")))?;
                Ok(())
            }
        }
    };
    let flag = |key: &str, into: &mut bool| -> Result<()> {
        match &arguments[key] {
            Value::Null => Ok(()),
            value => {
                *into = value
                    .as_bool()
                    .ok_or_else(|| Error::msg(format!("{key} is true or false")))?;
                Ok(())
            }
        }
    };
    number("seconds_per_slide", &mut options.seconds_per_slide)?;
    number("pause_before", &mut options.pause_before)?;
    number("pause_after", &mut options.pause_after)?;
    flag("animate", &mut options.animate)?;
    flag("narration", &mut options.narration)?;
    if !arguments["fps"].is_null() {
        options.fps = arguments["fps"]
            .as_u64()
            .and_then(|fps| u32::try_from(fps).ok())
            .ok_or_else(|| Error::msg("fps is a whole number of frames per second"))?;
    }
    options.check()?;
    Ok(options)
}

/// Exports the deck at `path` (`arguments`) as its `format` asks: a standalone HTML file here,
/// anything else by the app serving the workspace's `session`, waiting at most `wait`. What it
/// made, for the agent.
fn export_deck(
    dir: &Path,
    arguments: &Value,
    session: Option<&Path>,
    wait: std::time::Duration,
) -> Result<String> {
    let format = export::Format::parse(
        arguments["format"]
            .as_str()
            .ok_or_else(|| Error::msg("format is required"))?,
    )?;
    let video = match format {
        export::Format::Video => Some(video_options(arguments)?),
        _ => None,
    };
    let (rel, file) = deck_argument(dir, arguments)?;
    let deck = deck::load(&file)?;
    let dest = export::destination(
        dir,
        &rel,
        &deck.title,
        format,
        arguments["dest"].as_str(),
        arguments["overwrite"].as_bool() == Some(true),
    )?;
    let request = export::Request {
        path: rel,
        format,
        dest,
        video,
    };
    if format == export::Format::Html {
        let path = dir.join(&request.dest);
        deck::export(&file, &path)?;
        return Ok(export::report(&request, None, &path));
    }
    let session = session.ok_or_else(|| Error::msg("no workspace session"))?;
    export::ask(session, &request, wait)
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
fn saved(session: Option<&Path>, rel: &str, what: &str, data: &Value) -> String {
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
fn narration_timeline(
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

/// A tool result for rendered `slides`: what was found on each, followed by its image.
fn render_content(slides: &[render::Rendered]) -> Vec<Value> {
    let mut content = Vec::new();
    for slide in slides {
        content.push(json!({ "type": "text", "text": slide.report() }));
        if let Some(png) = &slide.png {
            content.push(json!({ "type": "image", "data": png, "mimeType": "image/png" }));
        }
    }
    content
}

/// Drain the session inbox. Validate again before forwarding a request to the UI.
pub fn take_open_requests(root: &Path, session: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(session.join(OPEN_REQUESTS)) else {
        return Vec::new();
    };
    let mut requests = Vec::new();
    let mut files: Vec<_> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    for file in files {
        let request = std::fs::read_to_string(&file)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
        let _ = std::fs::remove_file(file);
        if let Some(path) = request.as_ref().and_then(|r| r["path"].as_str()) {
            if crate::workspace::open_file(root, path)
                .is_ok_and(|f| f.kind != crate::workspace::FileKind::Directory)
            {
                requests.push(path.to_string());
            }
        }
    }
    requests
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::html;

    fn temp_deck(html: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("slopslide-mcp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(deck::DECK_FILE), html).unwrap();
        dir
    }

    fn call(dir: &Path, method: &str, params: Value) -> Value {
        let session = dir.join("session");
        handle(
            &json!({"jsonrpc":"2.0","id":7,"method":method,"params":params}),
            dir,
            &|_| Some(session.clone()),
        )
        .unwrap()
    }

    #[test]
    fn initializes_with_the_clients_protocol_version() {
        let dir = Path::new("/nonexistent");
        let res = call(dir, "initialize", json!({"protocolVersion":"2025-06-18"}));
        assert_eq!(res["id"], 7);
        assert_eq!(res["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(res["result"]["serverInfo"]["name"], SERVER);
        assert!(res["result"]["capabilities"]["tools"].is_object());
        let res = call(dir, "initialize", json!({}));
        assert_eq!(res["result"]["protocolVersion"], DEFAULT_PROTOCOL);
    }

    #[test]
    fn ignores_notifications_and_rejects_unknown_methods() {
        let dir = Path::new("/nonexistent");
        assert!(handle(
            &json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            dir,
            &|_| None
        )
        .is_none());
        assert_eq!(
            call(dir, "resources/list", json!({}))["error"]["code"],
            -32601
        );
        assert_eq!(
            call(dir, "tools/call", json!({"name":"rm"}))["error"]["code"],
            -32602
        );
        assert_eq!(call(dir, "ping", json!({}))["result"], json!({}));
    }

    #[test]
    fn lists_the_lint_tool() {
        let res = call(Path::new("/nonexistent"), "tools/list", json!({}));
        let tools = res["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 8);
        assert_eq!(tools[7]["name"], EXPORT_TOOL);
        assert_eq!(tools[7]["inputSchema"]["required"], json!(["format"]));
        assert_eq!(
            tools[7]["inputSchema"]["properties"]["format"]["enum"],
            json!(["html", "pdf", "pptx", "video", "images"])
        );
        assert!(crate::agent::SYSTEM_PROMPT.contains(EXPORT_TOOL));
        assert_eq!(tools[4]["name"], TIMELINE_TOOL);
        assert_eq!(tools[5]["name"], BEATS_TOOL);
        assert_eq!(tools[5]["inputSchema"]["required"], json!(["slide"]));
        assert_eq!(tools[6]["name"], GENERATE_TOOL);
        assert_eq!(tools[6]["inputSchema"]["required"], Value::Null);
        for tool in [TIMELINE_TOOL, BEATS_TOOL, GENERATE_TOOL] {
            assert!(crate::agent::SYSTEM_PROMPT.contains(tool), "{tool}");
        }
        assert_eq!(tools[3]["name"], NARRATION_TOOL);
        assert_eq!(
            tools[3]["inputSchema"]["required"],
            json!(["slide", "audio"])
        );
        assert!(crate::agent::SYSTEM_PROMPT.contains(NARRATION_TOOL));
        assert_eq!(tools[2]["name"], RENDER_TOOL);
        assert_eq!(tools[2]["inputSchema"]["required"], json!(["slides"]));
        assert!(crate::agent::SYSTEM_PROMPT.contains(RENDER_TOOL));
        assert_eq!(tools[1]["name"], OPEN_TOOL);
        assert_eq!(tools[0]["name"], TOOL);
        assert_eq!(CLAUDE_TOOLS, format!("mcp__{SERVER}"));
    }

    #[test]
    fn recognizes_its_claude_tool_names() {
        assert!(is_claude_tool("mcp__slopslide__lint_deck"));
        assert!(is_claude_tool("mcp__slopslide__open_file"));
        assert!(is_claude_tool("mcp__slopslide__render_slide"));
        assert!(is_claude_tool("mcp__slopslide__set_narration_audio"));
        assert!(is_claude_tool("mcp__slopslide__narration_timeline"));
        assert!(is_claude_tool("mcp__slopslide__narration_beats"));
        assert!(is_claude_tool("mcp__slopslide__export_deck"));
        assert!(!is_claude_tool("mcp__slopslide__"));
        assert!(!is_claude_tool("mcp__slopslides__lint_deck"));
        assert!(!is_claude_tool("mcp__github__push"));
        assert!(!is_claude_tool("Bash"));
    }

    #[test]
    fn shows_its_tools_alike_for_every_provider() {
        assert_eq!(display_name("mcp__slopslide__lint_deck"), TOOL);
        assert_eq!(display_name("slopslide-lint_deck"), TOOL);
        assert_eq!(display_name("slopslide-open_file"), OPEN_TOOL);
        assert_eq!(display_name("mcp__slopslide__render_slide"), RENDER_TOOL);
        assert_eq!(display_name("slopslide-render_slide"), RENDER_TOOL);
        assert_eq!(
            display_name("slopslide-set_narration_audio"),
            NARRATION_TOOL
        );
        assert_eq!(display_name("lint_deck"), TOOL);
        assert_eq!(display_name("mcp__github__push"), "mcp__github__push");
        assert_eq!(display_name("github-push"), "github-push");
        assert_eq!(display_name("slopslide-"), "slopslide-");
    }

    #[test]
    fn lint_tool_reports_issues_in_the_deck() {
        let dir = temp_deck("<html><body><main class=\"deck\"><section class=\"slide\" id=\"a\"><div></section></main></body></html>");
        let res = call(&dir, "tools/call", json!({"name": TOOL, "arguments": {}}));
        assert_eq!(res["result"]["isError"], false);
        let text = res["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("[unclosed-tag]"), "{text}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn lint_tool_reports_slide_id_styles_for_agent_repair_without_modifying_the_deck() {
        let source = html::ensure_runtime(
            "<!DOCTYPE html><html><head><title>Pitch</title>\n<style>\n#title .card { color: red; }\n</style></head><body><main class=\"deck\"><section class=\"slide\" id=\"title\"><div class=\"card\">AI-KIT</div></section></main></body></html>",
        );
        let dir = temp_deck(&source);
        let report = || {
            let res = call(&dir, "tools/call", json!({"name": TOOL, "arguments": {}}));
            assert_eq!(res["result"]["isError"], false);
            res["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        let text = report();
        assert!(
            text.starts_with("The deck has 1 error(s) and 0 warning(s):"),
            "{text}"
        );
        assert!(
            text.contains("error [slide-id-style] (slide `title`)"),
            "{text}"
        );
        assert!(text.contains("reusable layout class"), "{text}");
        assert_eq!(
            std::fs::read_to_string(dir.join(deck::DECK_FILE)).unwrap(),
            source
        );

        let repaired = source
            .replace("class=\"slide\"", "class=\"slide layout-title\"")
            .replace("#title .card", ".layout-title .card");
        std::fs::write(dir.join(deck::DECK_FILE), repaired).unwrap();
        assert_eq!(report(), "The deck passes lint: no issues.");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn lint_tool_reports_locked_slides_changed_during_a_turn() {
        let html = "<html><body><main class=\"deck\"><section class=\"slide\" id=\"a\" data-locked>A</section></main></body></html>";
        let dir = temp_deck(html);
        crate::guard::guard_locked(&dir.join(deck::DECK_FILE), &dir.join("session")).unwrap();
        std::fs::write(dir.join(deck::DECK_FILE), html.replace(">A<", ">B<")).unwrap();
        let res = call(&dir, "tools/call", json!({"name": TOOL, "arguments": {}}));
        let text = res["result"]["content"][0]["text"].as_str().unwrap();
        assert!(
            text.contains("[locked-slide-changed] (slide `a`)"),
            "{text}"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn lint_tool_lints_the_deck_file_named_by_path() {
        let dir = temp_deck(&html::ensure_runtime(
            "<html><body><main class=\"deck\"></main></body></html>",
        ));
        std::fs::write(dir.join("q3.html"), "<html><body><main class=\"deck\"><section class=\"slide\" id=\"a\"><div></section></main></body></html>").unwrap();
        let text = |args: Value| {
            let res = call(&dir, "tools/call", json!({"name": TOOL, "arguments": args}));
            res["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .to_string()
        };
        assert!(
            !text(json!({})).contains("[unclosed-tag]"),
            "deck.html by default"
        );
        assert!(text(json!({"path": "q3.html"})).contains("[unclosed-tag]"));
        let res = call(
            &dir,
            "tools/call",
            json!({"name": TOOL, "arguments": {"path": "../x.html"}}),
        );
        assert_eq!(res["result"]["isError"], true, "only files in the folder");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn opens_workspace_files_through_the_session_inbox_and_rejects_escapes() {
        let dir = temp_deck("<main class=\"deck\"></main>");
        std::fs::create_dir_all(dir.join("talks")).unwrap();
        std::fs::write(dir.join("talks/q3.html"), "<main class=\"deck\"></main>").unwrap();
        let res = call(
            &dir,
            "tools/call",
            json!({"name":OPEN_TOOL,"arguments":{"path":"talks/q3.html"}}),
        );
        assert_eq!(res["result"]["isError"], false);
        assert_eq!(
            take_open_requests(&dir, &dir.join("session")),
            ["talks/q3.html"]
        );
        assert!(take_open_requests(&dir, &dir.join("session")).is_empty());
        for path in ["../outside.html", "/etc/passwd", "talks", "missing.html"] {
            assert_eq!(
                call(
                    &dir,
                    "tools/call",
                    json!({"name":OPEN_TOOL,"arguments":{"path":path}})
                )["result"]["isError"],
                true
            );
        }
        let res = call(
            &dir,
            "tools/call",
            json!({"name":TOOL,"arguments":{"path":"talks/q3.html"}}),
        );
        assert_eq!(res["result"]["isError"], false);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(std::env::temp_dir(), dir.join("outside")).unwrap();
            for tool in [TOOL, OPEN_TOOL] {
                assert_eq!(
                    call(
                        &dir,
                        "tools/call",
                        json!({"name":tool,"arguments":{"path":"outside"}})
                    )["result"]["isError"],
                    true
                );
            }
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn render_tool_returns_what_the_app_rendered_as_images() {
        let dir = temp_deck("<main class=\"deck\"></main>");
        std::fs::create_dir_all(dir.join("talks")).unwrap();
        std::fs::write(dir.join("talks/q3.html"), "<main class=\"deck\"></main>").unwrap();
        let session = dir.join("session");
        let app = {
            let session = session.clone();
            std::thread::spawn(move || loop {
                if let Some((name, request)) = render::take_requests(&session).pop() {
                    assert_eq!(request.path, "talks/q3.html");
                    assert_eq!(request.slides, ["title", "gone"]);
                    let title = render::Rendered {
                        id: "title".into(),
                        png: Some("cG5n".into()),
                        overflow: vec!["<h1> \"Big\" runs past the right edge by 40px".into()],
                    };
                    let gone = render::Rendered {
                        id: "gone".into(),
                        png: None,
                        overflow: Vec::new(),
                    };
                    render::answer(&session, &name, &Ok(vec![title, gone])).unwrap();
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            })
        };
        let res = call(
            &dir,
            "tools/call",
            json!({"name": RENDER_TOOL, "arguments": {"path": "talks/q3.html", "slides": ["title", "gone"]}}),
        );
        app.join().unwrap();
        assert_eq!(res["result"]["isError"], false);
        let content = res["result"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 3);
        let text = content[0]["text"].as_str().unwrap();
        assert!(text.contains("slide `title`"), "{text}");
        assert!(text.contains("runs past the right edge by 40px"), "{text}");
        assert_eq!(
            content[1],
            json!({"type": "image", "data": "cG5n", "mimeType": "image/png"})
        );
        assert!(content[2]["text"].as_str().unwrap().contains("no slide"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    const TITLED: &str = "<!DOCTYPE html><html><head><title>Q3 Plan</title></head><body><main class=\"deck\"><section class=\"slide\" id=\"a\">A</section></main></body></html>";

    #[test]
    fn export_tool_writes_standalone_html_itself() {
        let dir = temp_deck(TITLED);
        let res = call(
            &dir,
            "tools/call",
            json!({"name": EXPORT_TOOL, "arguments": {"format": "html"}}),
        );
        assert_eq!(res["result"]["isError"], false, "{res}");
        let text = res["result"]["content"][0]["text"].as_str().unwrap();
        assert!(
            text.starts_with(
                "Exported deck.html as a standalone HTML file to exports/Q3 Plan.html ("
            ),
            "{text}"
        );
        let written = std::fs::read_to_string(dir.join("exports/Q3 Plan.html")).unwrap();
        assert!(written.contains("id=\"a\""), "{written}");
        // Exported again, it is not replaced unless asked.
        let again = call(
            &dir,
            "tools/call",
            json!({"name": EXPORT_TOOL, "arguments": {"format": "html"}}),
        );
        assert_eq!(again["result"]["isError"], true);
        let replaced = call(
            &dir,
            "tools/call",
            json!({"name": EXPORT_TOOL, "arguments": {"format": "html", "overwrite": true}}),
        );
        assert_eq!(replaced["result"]["isError"], false);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn export_tool_asks_the_app_for_other_formats() {
        let dir = temp_deck(TITLED);
        let session = dir.join("session");
        let app = {
            let session = session.clone();
            std::thread::spawn(move || {
                let mut seen = Vec::new();
                while seen.len() < 2 {
                    for (name, request) in export::take_requests(&session) {
                        export::answer(&session, &name, &Ok(format!("made {}", request.dest)))
                            .unwrap();
                        seen.push(request);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                seen
            })
        };
        let pdf = call(
            &dir,
            "tools/call",
            json!({"name": EXPORT_TOOL, "arguments": {"format": "pdf", "dest": "out/handout"}}),
        );
        assert_eq!(pdf["result"]["content"][0]["text"], "made out/handout.pdf");
        let video = call(
            &dir,
            "tools/call",
            json!({"name": EXPORT_TOOL, "arguments": {"format": "video", "fps": 60, "narration": false}}),
        );
        assert_eq!(video["result"]["isError"], false, "{video}");
        let seen = app.join().unwrap();
        assert_eq!(seen[0].format, export::Format::Pdf);
        assert_eq!(seen[0].video, None);
        assert_eq!(seen[1].dest, "exports/Q3 Plan.mp4");
        assert_eq!(
            seen[1].video,
            Some(video::Options {
                fps: 60,
                narration: false,
                ..narration::timeline::DEFAULTS
            })
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn export_tool_refuses_bad_requests_without_asking_the_app() {
        let dir = temp_deck(TITLED);
        for (arguments, expected) in [
            (json!({}), "format is required"),
            (json!({"format": "gif"}), "format is one of"),
            (json!({"format": "pdf", "path": "missing.html"}), "missing"),
            (
                json!({"format": "pdf", "dest": "../out.pdf"}),
                "invalid path",
            ),
            (
                json!({"format": "pptx", "dest": "out.pdf"}),
                "is a .pptx file",
            ),
            (
                json!({"format": "video", "fps": 25}),
                "unsupported frame rate",
            ),
            (
                json!({"format": "video", "seconds_per_slide": "long"}),
                "is a number",
            ),
            (json!({"format": "video", "animate": 1}), "true or false"),
            (
                json!({"format": "html", "dest": "deck.html", "overwrite": true}),
                "the deck itself",
            ),
        ] {
            let res = call(
                &dir,
                "tools/call",
                json!({"name": EXPORT_TOOL, "arguments": arguments}),
            );
            assert_eq!(res["result"]["isError"], true, "{arguments}");
            let text = res["result"]["content"][0]["text"].as_str().unwrap();
            assert!(text.contains(expected), "{arguments}: {text}");
        }
        assert!(export::take_requests(&dir.join("session")).is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn without_the_app_an_export_times_out() {
        let dir = temp_deck(TITLED);
        let session = dir.join("session");
        let arguments = json!({"format": "pdf"});
        let error = export_deck(
            &dir,
            &arguments,
            Some(&session),
            std::time::Duration::from_millis(20),
        )
        .unwrap_err();
        assert!(error.to_string().contains("did not finish"), "{error}");
        let error = export_deck(&dir, &arguments, None, export::WAIT).unwrap_err();
        assert_eq!(error.to_string(), "no workspace session");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn render_tool_refuses_bad_requests_without_asking_the_app() {
        let dir = temp_deck("<main class=\"deck\"></main>");
        let too_many: Vec<String> = (0..=render::MAX_SLIDES).map(|n| n.to_string()).collect();
        for arguments in [
            json!({"slides": []}),
            json!({}),
            json!({"slides": too_many}),
            json!({"path": "../x.html", "slides": ["a"]}),
            json!({"path": "missing.html", "slides": ["a"]}),
            json!({"path": "/etc/passwd", "slides": ["a"]}),
        ] {
            let res = call(
                &dir,
                "tools/call",
                json!({"name": RENDER_TOOL, "arguments": arguments}),
            );
            assert_eq!(res["result"]["isError"], true, "{arguments}");
        }
        assert!(render::take_requests(&dir.join("session")).is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn narrated_deck() -> PathBuf {
        let dir = temp_deck(
            r#"<main class="deck"><section class="slide" id="intro"><aside class="narration">Hi.</aside></section></main>"#,
        );
        std::fs::create_dir_all(dir.join("talks/sound")).unwrap();
        std::fs::write(
            dir.join("talks/q3.html"),
            r#"<main class="deck"><section class="slide" id="intro"></section></main>"#,
        )
        .unwrap();
        narration::audio::write_wav(&dir.join("talks/sound/quiet.wav"), &[0.0; 16_000], 16_000)
            .unwrap();
        let tone: Vec<f32> = (0..16_000).map(|i| (i as f32 / 20.0).sin() * 0.3).collect();
        narration::audio::write_wav(&dir.join("talks/sound/talk.wav"), &tone, 16_000).unwrap();
        std::fs::write(dir.join("talks/sound/notes.txt"), "not audio").unwrap();
        dir
    }

    #[test]
    fn narration_tool_makes_audio_the_slides_narration_and_times_its_words() {
        let dir = narrated_deck();
        // Silence is timed as no words, with no speech model needed.
        let res = call(
            &dir,
            "tools/call",
            json!({"name": NARRATION_TOOL, "arguments": {"slide": "intro", "audio": "talks/sound/quiet.wav"}}),
        );
        assert_eq!(res["result"]["isError"], false, "{res}");
        let text = res["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("Slide `intro` is narrated by talks/sound/quiet.wav now (1.00 s, kept as narration/intro.wav)."), "{text}");
        assert!(
            text.contains("It starts as the slide shows (data-narration-start=\"0\")."),
            "{text}"
        );
        assert!(
            text.contains("No words are heard in it. Call narration_timeline"),
            "{text}"
        );
        let file = dir.join(deck::DECK_FILE);
        let deck = deck::load(&file).unwrap();
        assert_eq!(deck.slides[0].narration_start, Some(0.0));
        assert_eq!(
            deck.slides[0].duration, None,
            "its length is left as it was"
        );
        assert_eq!(narration::words(&file, "intro"), Some(vec![]));
        let manifest = std::fs::read_to_string(dir.join("narration/manifest.json")).unwrap();
        assert!(manifest.contains("\"recorded\": true"), "{manifest}");

        // Speech without the model is kept, untimed; another deck keeps its audio apart.
        let args =
            json!({"path": "talks/q3.html", "slide": "intro", "audio": "talks/sound/talk.wav"});
        let text = set_narration_audio(&dir, &args, Path::new("/nonexistent"), None).unwrap();
        assert!(
            text.contains("kept as talks/narration/q3/intro.wav"),
            "{text}"
        );
        assert!(
            text.contains("Its words are not timed: Slide intro: The speech model is not downloaded. The user can time them in the Narration panel."),
            "{text}"
        );
        assert_eq!(narration::words(&dir.join("talks/q3.html"), "intro"), None);
        assert_eq!(narration::words(&file, "intro"), Some(vec![]));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn narration_tool_leaves_a_locked_slides_audio_alone() {
        let dir = temp_deck(
            r#"<main class="deck"><section class="slide" id="intro" data-locked><aside class="narration">Hi.</aside></section></main>"#,
        );
        narration::audio::write_wav(&dir.join("quiet.wav"), &[0.0; 16_000], 16_000).unwrap();
        let res = call(
            &dir,
            "tools/call",
            json!({"name": NARRATION_TOOL, "arguments": {"slide": "intro", "audio": "quiet.wav"}}),
        );
        assert_eq!(res["result"]["isError"], true, "{res}");
        assert!(
            text_of(&res).contains("The slide `intro` is locked"),
            "{res}"
        );
        // Nothing was replaced: no audio, no manifest, no pinned start.
        assert!(!dir.join("narration").exists());
        let deck = deck::load(&dir.join(deck::DECK_FILE)).unwrap();
        assert_eq!(deck.slides[0].narration_start, None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn narration_tool_replaces_the_users_own_recording_only_when_asked() {
        let dir = narrated_deck();
        let file = dir.join(deck::DECK_FILE);
        let take: Vec<f32> = (0..8_000).map(|i| (i as f32 / 30.0).sin() * 0.2).collect();
        narration::append_recording(&file, "intro", &take, 16_000).unwrap();
        let recording = std::fs::read(narration::audio_file(&file, "intro")).unwrap();
        let args = json!({"name": NARRATION_TOOL, "arguments": {"slide": "intro", "audio": "talks/sound/quiet.wav"}});
        let res = call(&dir, "tools/call", args.clone());
        assert_eq!(res["result"]["isError"], true, "{res}");
        assert!(
            text_of(&res).contains("the user's own recording, which would be lost"),
            "{res}"
        );
        assert_eq!(
            std::fs::read(narration::audio_file(&file, "intro")).unwrap(),
            recording,
            "the take is kept"
        );
        // Asked to, it replaces it; audio brought in before is replaced without asking.
        let mut replace = args.clone();
        replace["arguments"]["replace"] = json!(true);
        let res = call(&dir, "tools/call", replace);
        assert_eq!(res["result"]["isError"], false, "{res}");
        assert!(!narration::has_own_recording(&file, "intro"));
        let res = call(&dir, "tools/call", args);
        assert_eq!(res["result"]["isError"], false, "{res}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn timing_data_saved_for_a_slide_stays_in_the_sessions_timing_folder() {
        let session =
            std::env::temp_dir().join(format!("slopslide-saved-{}", uuid::Uuid::new_v4()));
        let data = json!({"beats": []});
        // Slide ids are written by the agent; none may lead out of the folder or name a stream
        // (`:` on Windows) or a folder (`/`, `\`).
        for id in ["../../escape", "a/b", "a\\b", "c:x", "intro"] {
            let text = saved(
                Some(&session),
                "talks/deck.html",
                &format!("beats-{id}"),
                &data,
            );
            assert!(!text.contains("could not be saved"), "{id}: {text}");
        }
        let names: Vec<String> = std::fs::read_dir(session.join("timing"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 5, "{names:?}");
        assert!(names.contains(&"talks_deck.html.beats-intro.json".to_string()));
        assert!(names
            .iter()
            .all(|n| n.starts_with("talks_deck.html.") && n.ends_with(".json")));
        assert!(!session.parent().unwrap().join("escape.json").exists());
        std::fs::remove_dir_all(session).unwrap();
    }

    /// `seconds` of a kick drum at 120 BPM, at `rate`.
    fn drums(seconds: f64, rate: u32) -> Vec<f32> {
        (0..(seconds * f64::from(rate)) as usize)
            .map(|i| {
                let t = i as f64 / f64::from(rate);
                let since = t % 0.5;
                ((-since * 25.0).exp()
                    * (std::f64::consts::TAU * (50.0 + 120.0 * (-since * 40.0).exp()) * t).sin()
                    * 0.8) as f32
            })
            .collect()
    }

    fn text_of(res: &Value) -> String {
        res["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_string()
    }

    /// A deck whose short first slide `song` has 8 s of drums that play on over `verse`.
    fn song_deck() -> PathBuf {
        let dir = temp_deck(concat!(
            r#"<main class="deck">"#,
            r#"<section class="slide" id="song" data-duration="2"></section>"#,
            r#"<section class="slide" id="verse" data-duration="10"></section>"#,
            r#"<section class="slide" id="outro"><aside class="narration">Bye.</aside></section>"#,
            r#"</main>"#,
        ));
        narration::audio::write_wav(&dir.join("song.wav"), &drums(8.0, 22_050), 22_050).unwrap();
        let args = json!({"slide": "song", "audio": "song.wav"});
        set_narration_audio(&dir, &args, Path::new("/nonexistent"), None).unwrap();
        dir
    }

    #[test]
    fn timeline_tool_places_slides_narration_and_words_on_the_show() {
        let dir = song_deck();
        // Words as the model timed them.
        let manifest = dir.join("narration/manifest.json");
        let json = std::fs::read_to_string(&manifest).unwrap().replace(
            "\"recorded\": true",
            r#""recorded": true, "timing": 3, "words": [{"text": "One,", "start": 1.0, "end": 1.4}, {"text": "two.", "start": 3.25, "end": 3.5}]"#,
        );
        std::fs::write(&manifest, json).unwrap();
        let res = call(
            &dir,
            "tools/call",
            json!({"name": TIMELINE_TOOL, "arguments": {}}),
        );
        assert_eq!(res["result"]["isError"], false, "{res}");
        let text = text_of(&res);
        for line in [
            "1. `song` shows 0.00–2.00 (2.00 s, pinned)",
            "narration (imported audio, 8.00 s) plays 0.00–8.00, starting 0.00 s into the slide (pinned); plays on over `verse`",
            "2. `verse` shows 2.00–12.00 (10.00 s, pinned)",
            "3. `outro` shows 12.00–17.00 (5.00 s, default)",
            "narration script without up-to-date audio",
            "Words of `song`'s narration: start–end in the show",
            "\n1.00–1.40 song +1.00 One,",
            "\n3.25–3.50 verse +1.25 two.",
        ] {
            assert!(text.contains(line), "{line}\n{text}");
        }
        assert!(!text.contains("Words of `outro`"), "{text}");
        // The same as JSON in the session, for scripts.
        let saved = dir
            .join("session")
            .join("timing")
            .join("deck.html.timeline.json");
        assert!(text.ends_with(&saved.display().to_string()), "{text}");
        let data: Value = serde_json::from_str(&std::fs::read_to_string(&saved).unwrap()).unwrap();
        assert_eq!(data["slides"][0]["id"], "song");
        assert_eq!(data["slides"][0]["narration"]["source"], "imported");
        assert_eq!(data["slides"][1]["start"], 2.0);
        assert_eq!(data["slides"][2]["unspoken"], true);
        assert_eq!(
            data["words"][1],
            json!({"audio": "song", "text": "two.", "start": 3.25, "end": 3.5, "slide": "verse", "intoSlide": 1.25})
        );
        assert_eq!(data["end"], 17.0);
        // Without words, just the slides.
        let res = call(
            &dir,
            "tools/call",
            json!({"name": TIMELINE_TOOL, "arguments": {"words": false}}),
        );
        assert!(!text_of(&res).contains("Words of"));
        let res = call(
            &dir,
            "tools/call",
            json!({"name": TIMELINE_TOOL, "arguments": {"path": "nope.html"}}),
        );
        assert_eq!(res["result"]["isError"], true);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn timeline_tool_says_why_words_are_not_timed() {
        let dir = song_deck();
        let text = narration_timeline(&dir, &json!({}), Path::new("/nonexistent"), None).unwrap();
        assert!(
            text.contains("Words of `song`'s narration: not timed (Slide song: The speech model is not downloaded; the user can time them in the Narration panel)."),
            "{text}"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn beats_tool_finds_the_beat_on_the_show() {
        let dir = song_deck();
        let res = call(
            &dir,
            "tools/call",
            json!({"name": BEATS_TOOL, "arguments": {"slide": "song"}}),
        );
        assert_eq!(res["result"]["isError"], false, "{res}");
        let text = text_of(&res);
        assert!(
            text.starts_with("Slide `song`'s narration has a beat of 12"),
            "{text}"
        );
        assert!(text.contains("(one every 0.50 s)"), "{text}");
        // Beats after the first slide fall on `verse`, counted from its start.
        let line = text
            .lines()
            .find(|l| l.starts_with("2.50 "))
            .unwrap_or_default();
        assert!(line.starts_with("2.50 verse +0.50 "), "{text}");
        // Each ends in its bar and beat.
        assert!(
            line.rsplit(' ').next().is_some_and(|b| b.contains('.')),
            "{line}"
        );
        let saved = dir.join("session/timing/deck.html.beats-song.json");
        let data: Value = serde_json::from_str(&std::fs::read_to_string(saved).unwrap()).unwrap();
        assert!(
            (data["tempo"].as_f64().unwrap() - 120.0).abs() < 2.0,
            "{data}"
        );
        let beat = data["beats"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| (b["at"].as_f64().unwrap() - 2.5).abs() < 0.01)
            .unwrap();
        assert_eq!(beat["slide"], "verse");
        assert!((beat["intoSlide"].as_f64().unwrap() - 0.5).abs() < 0.01);
        assert!((1..=4).contains(&beat["beat"].as_u64().unwrap()));
        for (arguments, why) in [
            (json!({}), "slide is required"),
            (
                json!({"slide": "chorus"}),
                "deck.html has no slide `chorus`",
            ),
            (
                json!({"slide": "verse"}),
                "slide `verse` has no up-to-date narration audio",
            ),
        ] {
            let res = call(
                &dir,
                "tools/call",
                json!({"name": BEATS_TOOL, "arguments": arguments}),
            );
            assert_eq!(res["result"]["isError"], true, "{arguments}");
            assert!(
                text_of(&res).contains(why),
                "{arguments}: {}",
                text_of(&res)
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn narration_tool_refuses_what_it_cannot_use() {
        let dir = narrated_deck();
        for (arguments, why) in [
            (
                json!({"audio": "talks/sound/quiet.wav"}),
                "slide is required",
            ),
            (json!({"slide": "intro"}), "audio is required"),
            (
                json!({"slide": "outro", "audio": "talks/sound/quiet.wav"}),
                "deck.html has no slide `outro`",
            ),
            (
                json!({"slide": "intro", "audio": "talks/sound/missing.wav"}),
                "missing: talks/sound/missing.wav",
            ),
            (
                json!({"slide": "intro", "audio": "../outside.wav"}),
                "invalid path",
            ),
            (
                json!({"slide": "intro", "audio": "/etc/hosts"}),
                "invalid path",
            ),
            (
                json!({"slide": "intro", "audio": "talks/sound"}),
                "is a folder",
            ),
            (
                json!({"slide": "intro", "audio": "talks/sound/notes.txt"}),
                "is no usable audio",
            ),
            (
                json!({"path": "missing.html", "slide": "intro", "audio": "talks/sound/quiet.wav"}),
                "missing.html",
            ),
        ] {
            let res = call(
                &dir,
                "tools/call",
                json!({"name": NARRATION_TOOL, "arguments": arguments}),
            );
            assert_eq!(res["result"]["isError"], true, "{arguments}");
            let text = res["result"]["content"][0]["text"].as_str().unwrap();
            assert!(text.contains(why), "{arguments}: {text}");
        }
        assert!(!dir.join("narration").exists(), "nothing was kept");
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn speaking_deck() -> PathBuf {
        temp_deck(
            r#"<main class="deck">
<section class="slide" id="intro" data-locked><aside class="narration">Hi.</aside></section>
<section class="slide" id="plain"><h1>No script</h1></section>
<section class="slide" id="own"><aside class="narration">Mine.</aside></section>
<section class="slide" id="talk"><aside class="narration">Say this.</aside></section>
</main>"#,
        )
    }

    #[test]
    fn generate_tool_reports_slides_it_leaves_alone_without_an_api_key() {
        let dir = speaking_deck();
        let file = dir.join(deck::DECK_FILE);
        let take: Vec<f32> = (0..8_000).map(|i| (i as f32 / 30.0).sin() * 0.2).collect();
        narration::append_recording(&file, "own", &take, 16_000).unwrap();
        let args = json!({"slides": ["intro", "plain", "own"]});
        let text = generate_narration_audio(&dir, &args, Path::new("/nonexistent"), None).unwrap();
        assert!(
            text.starts_with("Narration audio of deck.html: 0 slides said."),
            "{text}"
        );
        assert!(
            text.contains("- `intro`: locked, its audio is left as it was"),
            "{text}"
        );
        assert!(
            text.contains("- `plain`: has no narration script; nothing to say"),
            "{text}"
        );
        assert!(
            text.contains("- `own`: keeps the user's own recording (0.50 s)"),
            "{text}"
        );
        assert!(
            !text.contains("`talk`"),
            "only the slides asked for: {text}"
        );
        assert!(text.contains("Call narration_timeline"), "{text}");
        assert!(
            !narration::audio_file(&file, "intro").exists(),
            "a locked slide gets no audio"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn generate_tool_needs_an_api_key_to_say_a_script() {
        if std::env::var_os("OPENAI_API_KEY").is_some() {
            return;
        }
        let dir = speaking_deck();
        let file = dir.join(deck::DECK_FILE);
        // Every slide, as when `slides` is left out: `talk` has a script to say.
        let err = generate_narration_audio(&dir, &json!({}), Path::new("/nonexistent"), None)
            .unwrap_err()
            .to_string();
        assert!(
            err.starts_with("Generating the narration audio failed: "),
            "{err}"
        );
        assert!(err.contains("Add your OpenAI API key"), "{err}");
        assert!(!narration::audio_file(&file, "talk").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn generate_tool_leaves_slides_locked_in_the_turn_alone() {
        let dir = speaking_deck();
        let file = dir.join(deck::DECK_FILE);
        let session = dir.join("session");
        std::fs::create_dir_all(&session).unwrap();
        let html = std::fs::read_to_string(&file).unwrap();
        let html = html.replace(r#"id="talk">"#, r#"id="talk" data-locked>"#);
        std::fs::write(&file, &html).unwrap();
        crate::guard::guard_locked(&file, &session).unwrap();
        std::fs::write(
            &file,
            html.replace(r#"id="talk" data-locked>"#, r#"id="talk">"#),
        )
        .unwrap();
        let args = json!({"slides": ["talk"]});
        let text = generate_narration_audio(&dir, &args, Path::new("/nonexistent"), Some(&session))
            .unwrap();
        assert!(
            text.contains("- `talk`: locked, its audio is left as it was"),
            "{text}"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn generate_tool_refuses_what_it_cannot_use() {
        let dir = speaking_deck();
        for (arguments, why) in [
            (json!({"slides": ["gone"]}), "deck.html has no slide `gone`"),
            (json!({"slides": []}), "slides is empty"),
            (json!({"slides": "talk"}), "slides is a list of slide ids"),
            (json!({"slides": [3]}), "slides is a list of slide ids"),
            (json!({"path": "../x.html"}), "invalid path"),
            (json!({"path": "missing.html"}), "missing.html"),
        ] {
            let res = call(
                &dir,
                "tools/call",
                json!({"name": GENERATE_TOOL, "arguments": arguments}),
            );
            assert_eq!(res["result"]["isError"], true, "{arguments}");
            assert!(
                text_of(&res).contains(why),
                "{arguments}: {}",
                text_of(&res)
            );
        }
        assert!(!dir.join("narration").exists(), "nothing was said");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn lint_tool_reports_a_missing_deck_as_an_error() {
        let res = call(
            Path::new("/nonexistent"),
            "tools/call",
            json!({"name": TOOL}),
        );
        assert_eq!(res["result"]["isError"], true);
    }
}
