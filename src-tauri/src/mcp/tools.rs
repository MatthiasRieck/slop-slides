//! The server's tools, as a table: what `tools/list` says about each and what `tools/call`
//! runs. The workspace tools are here, the narration tools in [`super::narration_tools`].

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::narration_tools;
use super::{EXPORT_TOOL, OPEN_TOOL, RENDER_TOOL, TIMELINE_TOOL, TOOL};
use crate::deck;
use crate::error::{Error, Result};
use crate::export;
use crate::lint;
use crate::narration;
use crate::render;
use crate::video;

/// Where the open_file tool queues requests in the workspace's session, for the app.
const OPEN_REQUESTS: &str = "open-requests";

/// One `tools/call`: its arguments, the workspace root, and how to find the workspace's
/// current session.
pub(super) struct Call<'a> {
    pub arguments: &'a Value,
    pub dir: &'a Path,
    pub session: &'a dyn Fn(&Path) -> Option<PathBuf>,
}

impl Call<'_> {
    /// The workspace's current session.
    pub fn session(&self) -> Option<PathBuf> {
        (self.session)(self.dir)
    }
}

/// One tool of the server.
pub(super) struct Tool {
    pub name: &'static str,
    /// Its description and input schema, for `tools/list`.
    pub describe: fn() -> (String, Value),
    /// Runs it: the `tools/call` result.
    pub call: fn(&Call) -> Value,
}

/// Every tool, in the order `tools/list` gives them.
const TOOLS: [Tool; 8] = [
    LINT,
    OPEN,
    RENDER,
    narration_tools::SET_AUDIO,
    narration_tools::TIMELINE,
    narration_tools::BEATS,
    narration_tools::GENERATE,
    EXPORT,
];

/// The `tools/list` entries.
pub(super) fn definitions() -> Vec<Value> {
    TOOLS
        .iter()
        .map(|tool| {
            let (description, schema) = (tool.describe)();
            json!({ "name": tool.name, "description": description, "inputSchema": schema })
        })
        .collect()
}

/// Runs the tool named `name`; None when there is none of that name.
pub(super) fn call(name: &str, call: &Call) -> Option<Value> {
    let tool = TOOLS.iter().find(|tool| tool.name == name)?;
    Some((tool.call)(call))
}

/// A tool result of `text`, or of what went wrong.
pub(super) fn text_result(text: Result<String>) -> Value {
    let (text, failed) = match text {
        Ok(text) => (text, false),
        Err(e) => (e.to_string(), true),
    };
    json!({ "content": [{ "type": "text", "text": text }], "isError": failed })
}

/// The schema of the `path` argument most tools take.
pub(super) fn deck_path_property() -> Value {
    json!({
        "type": "string",
        "description": "The deck file, relative to the workspace root; deck.html when left out.",
    })
}

/// The deck file the `path` of `arguments` names, relative to the workspace root: deck.html
/// when left out.
fn deck_path(arguments: &Value) -> &str {
    arguments["path"]
        .as_str()
        .filter(|p| !p.is_empty())
        .unwrap_or(deck::DECK_FILE)
}

/// The deck file `path` of `arguments` names (deck.html when left out): its workspace-relative
/// path and where it is.
pub(super) fn deck_argument(dir: &Path, arguments: &Value) -> Result<(String, PathBuf)> {
    let rel = deck_path(arguments);
    let file = crate::workspace::open_file(dir, rel)?;
    Ok((rel.to_string(), PathBuf::from(file.absolute)))
}

/// The slide ids `slides` of `arguments` lists; None when left out, for every slide.
pub(super) fn slides_argument(arguments: &Value) -> Result<Option<Vec<String>>> {
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

const LINT: Tool = Tool {
    name: TOOL,
    describe: || {
        (
            "Lint the deck file (deck.html unless `path` names another): \
                checks that the HTML is well formed (all elements \
                closed, no stray end tags) and follows the deck format (slides are \
                <section class=\"slide\" id=\"…\"> in <main class=\"deck\">, unique kebab-case \
                ids, attached assets exist, images have alt text) and that locked slides \
                (data-locked) are unchanged. Run it after editing the deck and fix every \
                issue it reports."
                .into(),
            json!({ "type": "object", "properties": {
                "path": deck_path_property(),
            } }),
        )
    },
    call: |call| text_result(lint_deck(call)),
};

/// The lint report of the deck the call names, checking locked slides against the session.
fn lint_deck(call: &Call) -> Result<String> {
    let rel = deck_path(call.arguments);
    let linted = crate::workspace::resolve(call.dir, rel).and_then(|file| {
        let session = (call.session)(&file);
        deck::lint(&file, session.as_deref())
    });
    match linted {
        Ok(issues) => Ok(lint::format_report(&issues)),
        Err(e) => Err(Error::msg(format!("Could not lint {rel}: {e}"))),
    }
}

const OPEN: Tool = Tool {
    name: OPEN_TOOL,
    describe: || {
        (
            "Show a workspace file in SlopSlide. Use after creating a deck or to show the user another file.".into(),
            json!({ "type": "object", "properties": {
                "path": { "type": "string", "description": "Workspace-relative file path." }
            }, "required": ["path"] }),
        )
    },
    call: |call| text_result(open_file(call)),
};

/// Queues a request in the workspace's session for the app to show the file the call names
/// (see [`take_open_requests`]).
fn open_file(call: &Call) -> Result<String> {
    let rel = call.arguments["path"]
        .as_str()
        .filter(|p| !p.is_empty())
        .ok_or_else(|| Error::msg("path is required"))?;
    let file = crate::workspace::open_file(call.dir, rel)?;
    if file.kind == crate::workspace::FileKind::Directory {
        return Err(Error::msg("expected a file"));
    }
    let session = call
        .session()
        .ok_or_else(|| Error::msg("no workspace session"))?;
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

const RENDER: Tool = Tool {
    name: RENDER_TOOL,
    describe: || {
        (
            format!(
                "See slides of a deck as the app renders them: returns an \
                image of each slide, hidden ones too, with every animation finished, and lists \
                the elements that run past the slide or are cut off by their own box. With \
                `at`, each slide is shown that many seconds after it shows instead, its \
                animations where they are then, as that frame of a video export: use it to \
                check timed animations (what is on screen when a word is sung, say). The images \
                are what video exports and PDFs draw. Use it to check the look after building \
                or reworking slides, instead of a browser or screenshots from the shell. Takes \
                at most {} slides per call.",
                render::MAX_SLIDES
            ),
            json!({ "type": "object", "properties": {
                "path": deck_path_property(),
                "slides": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "The ids of the slides to render.",
                },
                "at": {
                    "type": "number",
                    "description": "Seconds after each slide shows to render it at (the time into the slide, as narration_timeline gives it); every animation finished when left out.",
                },
            }, "required": ["slides"] }),
        )
    },
    call: |call| {
        let (content, failed) = match render_slides(call) {
            Ok(content) => (content, false),
            Err(e) => (vec![json!({ "type": "text", "text": e.to_string() })], true),
        };
        json!({ "content": content, "isError": failed })
    },
};

/// Asks the app, through the workspace's session, for images of the slides the call lists:
/// what was found on each, followed by its image.
fn render_slides(call: &Call) -> Result<Vec<Value>> {
    let arguments = call.arguments;
    let rel = deck_path(arguments);
    crate::workspace::open_file(call.dir, rel)?;
    let slides: Vec<String> = arguments["slides"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|slide| slide.as_str().map(str::to_string))
        .collect();
    render::check_slides(&slides)?;
    let at = match &arguments["at"] {
        Value::Null => None,
        at => Some(
            at.as_f64()
                .ok_or_else(|| Error::msg("at is seconds after the slide shows, a number"))?,
        ),
    };
    render::check_at(at)?;
    let session = call
        .session()
        .ok_or_else(|| Error::msg("no workspace session"))?;
    let slides = render::ask(&session, rel, slides, at, render::WAIT)?;
    let mut content = Vec::new();
    for slide in &slides {
        content.push(json!({ "type": "text", "text": slide.report() }));
        if let Some(png) = &slide.png {
            content.push(json!({ "type": "image", "data": png, "mimeType": "image/png" }));
        }
    }
    Ok(content)
}

const EXPORT: Tool = Tool {
    name: EXPORT_TOOL,
    describe: || {
        (
            format!(
                "Export a deck as the app's Export menu does, when the user \
                asks for an export: `html` (one standalone HTML file with its assets inlined), \
                `pdf` (one page per shown slide, selectable text), `pptx` (PowerPoint, one slide \
                per shown slide), `video` (an MP4 of the deck playing, with its animations and \
                narration audio, timed as {TIMELINE_TOOL} says; narration audio that is missing \
                is generated first) or `images` (a PNG of every slide, the canvas size, in a \
                folder). It goes to `dest` in the workspace, or to `{}/` next to the deck, named \
                after its title. Lint the deck first. A video takes a while (minutes for a long \
                deck); ask for it once. Then tell the user where it is, or show it with \
                {OPEN_TOOL}.",
                export::FOLDER
            ),
            json!({ "type": "object", "properties": {
                "path": deck_path_property(),
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
            }, "required": ["format"] }),
        )
    },
    call: |call| {
        let session = call.session();
        text_result(export_deck(
            call.dir,
            call.arguments,
            session.as_deref(),
            export::WAIT,
        ))
    },
};

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
pub(super) fn export_deck(
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
