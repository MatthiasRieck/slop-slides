//! Commands that open and change a deck, each change going into its history.

use std::path::Path;

use tauri::{AppHandle, State, Window};

use super::{
    changing, current_session, focus, reading, saving, sessions, workspace_root, CreatedSlide,
};
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
use crate::workspace::{self, OpenWorkspace};

/// Creates a deck in its own folder at the root of the open workspace.
#[tauri::command(async)]
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

/// Creates the example deck (see [`templates::create_example`]) in the open workspace.
#[tauri::command(async)]
pub fn create_example_deck(window: Window) -> Result<Deck> {
    let file = templates::create_example(&workspace_root(&window)?)?;
    deck::open(&file, None, true)
}

/// Makes a copy of deck `id` beside it (see [`workspace::duplicate`]), which is not opened;
/// returns the copy's id. Off the main thread: the deck's folder is copied.
#[tauri::command(async)]
pub fn duplicate_deck(id: String) -> Result<String> {
    let copy = reading(&id, workspace::duplicate)?;
    Ok(copy.to_string_lossy().into_owned())
}

/// Moves deck `id` to the system's trash, with its folder when it has one of its own (see
/// [`workspace::trash_target`]), and forgets it: its place among the recent decks and its undo
/// history. Refused while the deck is open in a window, while a window has the folder that would
/// go open, and while the agent works on the deck.
#[tauri::command(async)]
pub fn trash_deck(
    agent: State<AgentManager>,
    open: State<OpenWorkspace>,
    id: String,
) -> Result<()> {
    let file = deck::deck_file(&id)?;
    let target = workspace::trash_target(&file);
    let name = workspace::display_name(&target);
    if agent.works_on(&file) {
        return Err(error::Error::msg(
            "The agent is still working on the deck; stop it or wait for it to finish first.",
        ));
    }
    // No window is called "": the deck open in any of them counts.
    if open.window_with_deck(&file, "").is_some() {
        return Err(error::Error::msg(format!(
            "{name} is open in a window. Close the deck first."
        )));
    }
    if target.is_dir() && open.window_inside(&target).is_some() {
        return Err(error::Error::msg(format!(
            "The folder {name} is open in a window. Close that folder first."
        )));
    }
    let home = files::app_home()?;
    let kept = history::place(&home, &file);
    {
        // Not while a change to the deck is being written.
        let _held = crate::deck_lock::hold(&file);
        workspace::move_to_trash(&target)?;
    }
    history::forget(&kept);
    workspace::forget_deck(&home, &id)
}

/// Converts the PowerPoint file at `path` into a new deck in the open workspace, with
/// `pptx-import-progress` events to the window saying which slide it is reading.
#[tauri::command]
pub async fn import_pptx(window: Window, path: String) -> Result<pptx::Imported> {
    use tauri::Emitter;
    let root = workspace_root(&window)?;
    // Not on the main thread: a big file takes a moment, and the window must stay alive.
    tauri::async_runtime::spawn_blocking(move || {
        pptx::import(Path::new(&path), &root, |progress: pptx::ImportProgress| {
            let _ = window.emit("pptx-import-progress", progress);
        })
    })
    .await
    .map_err(|e| error::Error::msg(format!("the import failed: {e}")))?
}

/// Opens deck `id` in the window, whose chat becomes the deck's. A deck open in another window
/// is shown there instead (unless `quiet`): two windows on one deck would share its chat. With
/// `keep_chat`, the folder's own chat stays: it made the deck and is still at work on it.
#[tauri::command(async)]
pub fn open_deck(
    app: AppHandle,
    window: Window,
    agent: State<AgentManager>,
    open: State<OpenWorkspace>,
    id: String,
    keep_chat: Option<bool>,
    quiet: Option<bool>,
) -> Result<Deck> {
    let file = deck::deck_file(&id)?;
    let label = window.label();
    let taken = |other: String| {
        if quiet != Some(true) {
            focus(&app, &other);
        }
        error::Error::msg(format!(
            "{} is already open in another window.",
            workspace::display_name(&file)
        ))
    };
    if let Some(other) = open.window_with_deck(&file, label) {
        return Err(taken(other));
    }
    let root = workspace_root(&window)?;
    let keep_chat = keep_chat == Some(true) && open.chat(label).as_ref() == Some(&root);
    let subject = if keep_chat { &root } else { &file };
    let session = sessions()?.current(subject);
    let idle = !agent.works_on(&file);
    // Normalizing writes the deck: not while a change to it is under way.
    let deck = reading(&id, |file| deck::open(file, session.as_deref(), idle))?;
    if idle {
        history::checkpoint(&files::app_home()?, &file)?;
    }
    workspace::remember_deck(&files::app_home()?, &root, &file, &deck.title)?;
    open.open_deck(label, &file, keep_chat).map_err(taken)?;
    Ok(deck)
}

/// Closes the window's deck: its chat is the folder's own again. Refused while another window
/// has the folder open without a deck, which is shown instead.
#[tauri::command]
pub fn close_deck(app: AppHandle, window: Window, open: State<OpenWorkspace>) -> Result<()> {
    let root = workspace_root(&window)?;
    open.close_deck(window.label()).map_err(|other| {
        focus(&app, &other);
        error::Error::msg(format!(
            "{} is already open without a deck in another window. Open the next file there.",
            workspace::display_name(&root)
        ))
    })
}

#[tauri::command(async)]
pub fn load_deck(id: String) -> Result<Deck> {
    reading(&id, deck::load)
}

#[tauri::command(async)]
pub fn save_review(id: String, review: review::Review) -> Result<()> {
    let change = Change::new(Source::Review, "Review marks").grouped("review");
    saving(&id, change, |file| deck::save_review(file, &review))
}

#[tauri::command(async)]
pub fn save_comments(id: String, comments: comments::Comments) -> Result<()> {
    let change = Change::new(Source::Review, "Comments").grouped("comments");
    saving(&id, change, |file| deck::save_comments(file, &comments))
}

#[tauri::command(async)]
pub fn rename_deck(id: String, title: String) -> Result<Deck> {
    let deck = changing(&id, Change::new(Source::Deck, "Rename deck"), |file| {
        deck::rename(file, &title)
    })?;
    // The start screen lists it under its new title.
    workspace::retitle_deck(&files::app_home()?, &deck::deck_file(&id)?, &deck.title)?;
    Ok(deck)
}

#[tauri::command(async)]
pub fn reorder_slides(id: String, slides: Vec<String>) -> Result<RailEdit> {
    changing(&id, Change::new(Source::Rail, "Move slides"), |file| {
        deck::reorder(file, slides)
    })
}

#[tauri::command(async)]
pub fn add_slide(id: String, after: Option<String>) -> Result<CreatedSlide> {
    let (deck, slide) = changing(&id, Change::new(Source::Rail, "Add slide"), |file| {
        deck::add_blank(file, after)
    })?;
    Ok(CreatedSlide { deck, slide })
}

#[tauri::command(async)]
pub fn duplicate_slides(id: String, slides: Vec<String>) -> Result<RailEdit> {
    changing(&id, Change::new(Source::Rail, "Duplicate slides"), |file| {
        deck::duplicate_slides(file, &slides)
    })
}

#[tauri::command(async)]
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
#[tauri::command(async)]
pub fn set_slide_narration(id: String, slide: String, text: String) -> Result<Deck> {
    let change =
        Change::new(Source::Narration, "Edit narration").grouped(format!("narration:{slide}"));
    changing(&id, change, |file| {
        deck::set_slide_narration(file, &slide, &text)
    })
}

/// Sets a slide's speaker notes; empty `text` removes them.
#[tauri::command(async)]
pub fn set_slide_notes(id: String, slide: String, text: String) -> Result<Deck> {
    let change = Change::new(Source::Notes, "Edit notes").grouped(format!("notes:{slide}"));
    changing(&id, change, |file| {
        deck::set_slide_notes(file, &slide, &text)
    })
}

/// Sets the seconds the presenter expects to spend on a slide; 0 removes them.
#[tauri::command(async)]
pub fn set_slide_time(id: String, slide: String, seconds: u32) -> Result<Deck> {
    let change = Change::new(Source::Notes, "Set slide time").grouped(format!("time:{slide}"));
    changing(&id, change, |file| {
        deck::set_slide_time(file, &slide, seconds)
    })
}

/// Sets the timing of slides on the narration timeline, all in one write.
#[tauri::command(async)]
pub fn set_slide_timing(id: String, timing: Vec<deck::SlideTiming>) -> Result<RailEdit> {
    let change = Change::new(Source::Narration, "Change timing").grouped("timing");
    changing(&id, change, |file| deck::set_slide_timing(file, &timing))
}

/// Gives every slide of the deck the canvas `size`.
#[tauri::command(async)]
pub fn set_slide_size(id: String, size: size::SlideSize) -> Result<Deck> {
    changing(
        &id,
        Change::new(Source::Deck, "Change slide size"),
        |file| deck::set_slide_size(file, size),
    )
}

#[tauri::command(async)]
pub fn set_slide_locked(window: Window, id: String, slide: String, locked: bool) -> Result<Deck> {
    let session = current_session(&window)?;
    let label = if locked { "Lock slide" } else { "Unlock slide" };
    changing(&id, Change::new(Source::Rail, label), |file| {
        deck::set_slide_locked(file, session.as_deref(), &slide, locked)
    })
}

/// Locks or unlocks `slides`, as one change in the deck's history and one write of the deck.
/// Each slide's guard is refreshed (see [`deck::set_slides_locked`]).
#[tauri::command(async)]
pub fn set_slides_locked(
    window: Window,
    id: String,
    slides: Vec<String>,
    locked: bool,
) -> Result<Deck> {
    let session = current_session(&window)?;
    let label = if locked {
        "Lock slides"
    } else {
        "Unlock slides"
    };
    changing(&id, Change::new(Source::Rail, label), |file| {
        deck::set_slides_locked(file, session.as_deref(), &slides, locked)
    })
}

#[tauri::command(async)]
pub fn add_section(id: String, before: Option<String>, title: String) -> Result<Deck> {
    changing(&id, Change::new(Source::Rail, "Add section"), |file| {
        deck::add_section(file, before, &title)
    })
}

#[tauri::command(async)]
pub fn rename_section(id: String, index: usize, title: String) -> Result<Deck> {
    changing(&id, Change::new(Source::Rail, "Rename section"), |file| {
        deck::rename_section(file, index, &title)
    })
}

#[tauri::command(async)]
pub fn delete_section(id: String, index: usize) -> Result<Deck> {
    changing(&id, Change::new(Source::Rail, "Delete section"), |file| {
        deck::delete_section(file, index)
    })
}

/// Takes section `index` out of deck `id` along with `slides`, the slides it holds, as one change.
#[tauri::command(async)]
pub fn delete_section_slides(id: String, index: usize, slides: Vec<String>) -> Result<RailEdit> {
    changing(
        &id,
        Change::new(Source::Rail, "Delete section and slides"),
        |file| deck::delete_section_slides(file, index, &slides),
    )
}

#[tauri::command(async)]
pub fn delete_slides(id: String, slides: Vec<String>) -> Result<RailEdit> {
    changing(&id, Change::new(Source::Rail, "Delete slides"), |file| {
        deck::delete_slides(file, &slides)
    })
}

/// Slide `slide` of deck `id` as it is in the file, with its hash: what the SVG editor
/// changes an element of and saves back with `update_slide`.
#[tauri::command(async)]
pub fn slide_source(id: String, slide: String) -> Result<deck::SlideSource> {
    reading(&id, |file| deck::slide_source(file, &slide))
}

/// Saves a slide edited on the stage (text edits, moved elements). `base` is its hash when
/// the edit started. `group` names a run of small edits that belong together (the editor's
/// arrow-key nudges of the same elements): their saves, close together, are one step to undo
/// instead of each pushing an older version out of the history.
#[tauri::command(async)]
pub fn update_slide(
    id: String,
    slide: String,
    markup: String,
    base: String,
    group: Option<String>,
) -> Result<Deck> {
    let (deck, _) = changing(&id, slide_edit(&slide, group.as_deref()), |file| {
        deck::update_slide(file, &slide, &markup, &base)
    })?;
    Ok(deck)
}

/// Gives every slide that is not locked `color` as its own background (None: the deck's own
/// again), as one change in the deck's history and one write of the deck.
#[tauri::command(async)]
pub fn set_background_of_all(id: String, color: Option<String>) -> Result<deck::BackgroundEdit> {
    changing(
        &id,
        Change::new(Source::Edit, "Background of all slides"),
        |file| deck::set_background_of_all(file, color.as_deref()),
    )
}

/// A slide's picture (see thumbnails.rs) is no longer shown where it was asked for at `url`:
/// unless it is shown elsewhere too, it is not made when its turn comes.
#[tauri::command]
pub fn forget_thumbnail(app: tauri::AppHandle, url: String) {
    crate::thumbnails::forget(&app, &url);
}

/// The history's entry for an edit of `slide` on the stage, one of the run `group` if any.
fn slide_edit(slide: &str, group: Option<&str>) -> Change {
    let change = Change::new(Source::Edit, "Edit slide");
    match group {
        Some(group) => change.grouped(format!("edit:{slide}:{group}")),
        None => change,
    }
}

#[tauri::command(async)]
pub fn save_deck_source(
    agent: State<AgentManager>,
    id: String,
    source: String,
    base: Option<String>,
) -> Result<Deck> {
    // Normalizing mid-turn could rewrite ids the agent is about to reference.
    let normalize = !agent.works_on(&deck::deck_file(&id)?);
    changing(&id, Change::new(Source::Code, "Edit source"), |file| {
        deck::save_source(file, &source, base.as_deref(), normalize)
    })
}

#[tauri::command(async)]
pub fn import_assets(window: Window, id: String, paths: Vec<String>) -> Result<Vec<String>> {
    let target = assets::target(&workspace_root(&window)?, &id)?;
    assets::import_assets(&target, paths)
}

#[tauri::command(async)]
pub fn save_asset(window: Window, id: String, name: String, data: String) -> Result<String> {
    let target = assets::target(&workspace_root(&window)?, &id)?;
    assets::save_asset(&target, &name, &data)
}

/// Where `query` is found in the text of deck `id`'s slides.
#[tauri::command(async)]
pub fn find_in_deck(id: String, query: String, options: find::Options) -> Result<Vec<find::Match>> {
    reading(&id, |file| deck::find_text(file, &query, options))
}

/// Replaces `query` with `replacement` in the text of deck `id`'s slides (or of `slides`).
#[tauri::command(async)]
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

/// Replaces one match of `query` in deck `id`: the `nth` on `slide`, from 0, in the order
/// `find_in_deck` lists that slide's matches.
#[tauri::command(async)]
pub fn replace_match_in_deck(
    id: String,
    query: String,
    replacement: String,
    options: find::Options,
    slide: String,
    nth: usize,
) -> Result<deck::ReplacedText> {
    changing(&id, Change::new(Source::Edit, "Replace text"), |file| {
        deck::replace_match(file, &query, &replacement, options, &slide, nth)
    })
}

#[tauri::command(async)]
pub fn lint_deck(window: Window, id: String) -> Result<Vec<lint::Issue>> {
    let session = current_session(&window)?;
    reading(&id, |file| deck::lint(file, session.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_of_small_edits_of_a_slide_is_one_group_in_its_history() {
        let alone = slide_edit("intro", None);
        assert_eq!(
            (alone.source, alone.label.as_str()),
            (Source::Edit, "Edit slide")
        );
        assert_eq!(
            alone.group, None,
            "an edit by itself is its own step to undo"
        );
        let nudge = slide_edit("intro", Some("nudge:0.2"));
        assert_eq!(nudge.group.as_deref(), Some("edit:intro:nudge:0.2"));
        assert_eq!(
            (nudge.source, nudge.label.as_str()),
            (Source::Edit, "Edit slide")
        );
        // The same elements on another slide, or other elements, are another run.
        assert_ne!(slide_edit("plan", Some("nudge:0.2")).group, nudge.group);
        assert_ne!(slide_edit("intro", Some("nudge:1")).group, nudge.group);
    }
}
