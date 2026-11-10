//! Commands that open and change a deck, each change going into its history.

use std::path::Path;

use tauri::{State, Window};

use super::{changing, current_session, workspace_root, CreatedSlide};
use crate::agent::AgentManager;
use crate::assets;
use crate::comments;
use crate::deck::{self, Deck, RailEdit};
use crate::error::{self, Result};
use crate::files;
use crate::find;
use crate::history::{self, Change, Source};
use crate::lint;
use crate::pptx;
use crate::review;
use crate::size;
use crate::templates;

/// Creates a deck in its own folder at the root of the open workspace.
#[tauri::command]
pub fn create_deck(window: Window, title: String, template: Option<String>) -> Result<Deck> {
    let root = templates::user_root()?;
    let source = template
        .as_deref()
        .map(|t| templates::source(&root, t))
        .transpose()?;
    let template = template
        .as_deref()
        .zip(source.as_deref())
        .map(|(id, html)| deck::TemplateSource { id, html });
    deck::create(&workspace_root(&window)?, &title, template)
}

/// Converts the PowerPoint file at `path` into a new deck in the open workspace.
#[tauri::command]
pub async fn import_pptx(window: Window, path: String) -> Result<pptx::Imported> {
    let root = workspace_root(&window)?;
    // Not on the main thread: a big file takes a moment, and the window must stay alive.
    tauri::async_runtime::spawn_blocking(move || pptx::import(Path::new(&path), &root))
        .await
        .map_err(|e| error::Error::msg(format!("the import failed: {e}")))?
}

#[tauri::command]
pub fn open_deck(window: Window, agent: State<AgentManager>, id: String) -> Result<Deck> {
    let file = deck::deck_file(&id)?;
    let session = current_session(&window)?;
    let idle = !agent.is_running(&workspace_root(&window)?.to_string_lossy());
    let deck = deck::open(&file, session.as_deref(), idle)?;
    if idle {
        history::checkpoint(&files::app_home()?, &file)?;
    }
    Ok(deck)
}

#[tauri::command]
pub fn load_deck(id: String) -> Result<Deck> {
    deck::load(&deck::deck_file(&id)?)
}

#[tauri::command]
pub fn save_review(id: String, review: review::Review) -> Result<()> {
    let change = Change::new(Source::Review, "Review marks").grouped("review");
    changing(&id, change, |file| deck::save_review(file, &review))
}

#[tauri::command]
pub fn save_comments(id: String, comments: comments::Comments) -> Result<()> {
    let change = Change::new(Source::Review, "Comments").grouped("comments");
    changing(&id, change, |file| deck::save_comments(file, &comments))
}

#[tauri::command]
pub fn rename_deck(id: String, title: String) -> Result<Deck> {
    changing(&id, Change::new(Source::Deck, "Rename deck"), |file| {
        deck::rename(file, &title)
    })
}

#[tauri::command]
pub fn reorder_slides(id: String, slides: Vec<String>) -> Result<RailEdit> {
    changing(&id, Change::new(Source::Rail, "Move slides"), |file| {
        deck::reorder(file, slides)
    })
}

#[tauri::command]
pub fn add_slide(id: String, after: Option<String>) -> Result<CreatedSlide> {
    let (deck, slide) = changing(&id, Change::new(Source::Rail, "Add slide"), |file| {
        deck::add_blank(file, after)
    })?;
    Ok(CreatedSlide { deck, slide })
}

#[tauri::command]
pub fn duplicate_slides(id: String, slides: Vec<String>) -> Result<RailEdit> {
    changing(&id, Change::new(Source::Rail, "Duplicate slides"), |file| {
        deck::duplicate_slides(file, &slides)
    })
}

#[tauri::command]
pub fn set_slides_hidden(
    window: Window,
    id: String,
    slides: Vec<String>,
    hidden: bool,
) -> Result<RailEdit> {
    let session = current_session(&window)?;
    let label = if hidden { "Hide slides" } else { "Show slides" };
    changing(&id, Change::new(Source::Rail, label), |file| {
        deck::set_slides_hidden(file, session.as_deref(), &slides, hidden)
    })
}

/// Sets what is said over a slide; empty `text` removes its narration.
#[tauri::command]
pub fn set_slide_narration(id: String, slide: String, text: String) -> Result<Deck> {
    let change =
        Change::new(Source::Narration, "Edit narration").grouped(format!("narration:{slide}"));
    changing(&id, change, |file| {
        deck::set_slide_narration(file, &slide, &text)
    })
}

/// Sets a slide's speaker notes; empty `text` removes them.
#[tauri::command]
pub fn set_slide_notes(id: String, slide: String, text: String) -> Result<Deck> {
    let change = Change::new(Source::Notes, "Edit notes").grouped(format!("notes:{slide}"));
    changing(&id, change, |file| {
        deck::set_slide_notes(file, &slide, &text)
    })
}

/// Sets the seconds the presenter expects to spend on a slide; 0 removes them.
#[tauri::command]
pub fn set_slide_time(id: String, slide: String, seconds: u32) -> Result<Deck> {
    let change = Change::new(Source::Notes, "Set slide time").grouped(format!("time:{slide}"));
    changing(&id, change, |file| {
        deck::set_slide_time(file, &slide, seconds)
    })
}

/// Sets the timing of slides on the narration timeline, all in one write.
#[tauri::command]
pub fn set_slide_timing(id: String, timing: Vec<deck::SlideTiming>) -> Result<RailEdit> {
    let change = Change::new(Source::Narration, "Change timing").grouped("timing");
    changing(&id, change, |file| deck::set_slide_timing(file, &timing))
}

/// Gives every slide of the deck the canvas `size`.
#[tauri::command]
pub fn set_slide_size(id: String, size: size::SlideSize) -> Result<Deck> {
    changing(
        &id,
        Change::new(Source::Deck, "Change slide size"),
        |file| deck::set_slide_size(file, size),
    )
}

#[tauri::command]
pub fn set_slide_locked(window: Window, id: String, slide: String, locked: bool) -> Result<Deck> {
    let session = current_session(&window)?;
    let label = if locked { "Lock slide" } else { "Unlock slide" };
    changing(&id, Change::new(Source::Rail, label), |file| {
        deck::set_slide_locked(file, session.as_deref(), &slide, locked)
    })
}

#[tauri::command]
pub fn add_section(id: String, before: Option<String>, title: String) -> Result<Deck> {
    changing(&id, Change::new(Source::Rail, "Add section"), |file| {
        deck::add_section(file, before, &title)
    })
}

#[tauri::command]
pub fn rename_section(id: String, index: usize, title: String) -> Result<Deck> {
    changing(&id, Change::new(Source::Rail, "Rename section"), |file| {
        deck::rename_section(file, index, &title)
    })
}

#[tauri::command]
pub fn delete_section(id: String, index: usize) -> Result<Deck> {
    changing(&id, Change::new(Source::Rail, "Delete section"), |file| {
        deck::delete_section(file, index)
    })
}

#[tauri::command]
pub fn delete_slides(id: String, slides: Vec<String>) -> Result<RailEdit> {
    changing(&id, Change::new(Source::Rail, "Delete slides"), |file| {
        deck::delete_slides(file, &slides)
    })
}

/// Slide `slide` of deck `id` as it is in the file, with its hash: what the SVG editor
/// changes an element of and saves back with `update_slide`.
#[tauri::command]
pub fn slide_source(id: String, slide: String) -> Result<deck::SlideSource> {
    deck::slide_source(&deck::deck_file(&id)?, &slide)
}

/// Saves a slide edited on the stage (text edits, moved elements). `base` is its hash when
/// the edit started.
#[tauri::command]
pub fn update_slide(id: String, slide: String, markup: String, base: String) -> Result<Deck> {
    let (deck, _) = changing(&id, Change::new(Source::Edit, "Edit slide"), |file| {
        deck::update_slide(file, &slide, &markup, &base)
    })?;
    Ok(deck)
}

#[tauri::command]
pub fn save_deck_source(
    window: Window,
    agent: State<AgentManager>,
    id: String,
    source: String,
    base: Option<String>,
) -> Result<Deck> {
    // Normalizing mid-turn could rewrite ids the agent is about to reference.
    let normalize = !agent.is_running(&workspace_root(&window)?.to_string_lossy());
    changing(&id, Change::new(Source::Code, "Edit source"), |file| {
        deck::save_source(file, &source, base.as_deref(), normalize)
    })
}

#[tauri::command]
pub fn import_assets(window: Window, id: String, paths: Vec<String>) -> Result<Vec<String>> {
    let target = assets::target(&workspace_root(&window)?, &id)?;
    assets::import_assets(&target, paths)
}

#[tauri::command]
pub fn save_asset(window: Window, id: String, name: String, data: String) -> Result<String> {
    let target = assets::target(&workspace_root(&window)?, &id)?;
    assets::save_asset(&target, &name, &data)
}

/// Where `query` is found in the text of deck `id`'s slides.
#[tauri::command]
pub fn find_in_deck(id: String, query: String, options: find::Options) -> Result<Vec<find::Match>> {
    deck::find_text(&deck::deck_file(&id)?, &query, options)
}

/// Replaces `query` with `replacement` in the text of deck `id`'s slides (or of `slides`).
#[tauri::command]
pub fn replace_in_deck(
    id: String,
    query: String,
    replacement: String,
    options: find::Options,
    slides: Option<Vec<String>>,
) -> Result<deck::ReplacedText> {
    changing(&id, Change::new(Source::Edit, "Replace text"), |file| {
        deck::replace_text(file, &query, &replacement, options, slides.as_deref())
    })
}

#[tauri::command]
pub fn lint_deck(window: Window, id: String) -> Result<Vec<lint::Issue>> {
    let file = deck::deck_file(&id)?;
    deck::lint(&file, current_session(&window)?.as_deref())
}
