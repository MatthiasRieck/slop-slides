//! Commands for the user's templates and decks made from them.

use tauri::Window;

use super::{changing, session, CreatedSlide};
use crate::deck::{self, Deck};
use crate::error::Result;
use crate::history::{Change, Source};
use crate::templates;

#[tauri::command]
pub fn list_templates() -> Result<Vec<templates::TemplateSummary>> {
    Ok(templates::list(&templates::user_root()?))
}

/// Copies a template into the deck's session for the agent; returns its absolute path.
#[tauri::command]
pub fn stage_template(window: Window, id: String, template: String) -> Result<String> {
    deck::deck_file(&id)?;
    templates::stage(&session(&window)?, &templates::user_root()?, &template)
}

/// Gives a deck without slides the template's styles.
#[tauri::command]
pub fn apply_template(id: String, template: String) -> Result<Deck> {
    let root = templates::user_root()?;
    let html = templates::source(&root, &template)?;
    let source = deck::TemplateSource {
        id: &template,
        html: &html,
    };
    changing(&id, Change::new(Source::Deck, "Apply template"), |file| {
        deck::apply_template(file, source)
    })
}

/// Adds a copy of one of the template's slides after `after`.
#[tauri::command]
pub fn add_template_slide(
    id: String,
    template: String,
    slide: String,
    after: Option<String>,
) -> Result<CreatedSlide> {
    let html = templates::source(&templates::user_root()?, &template)?;
    let (deck, slide) = changing(&id, Change::new(Source::Rail, "Add slide"), |file| {
        deck::add_template_slide(file, after, &html, &slide)
    })?;
    Ok(CreatedSlide { deck, slide })
}

/// Saves the deck as a new user template, with placeholder text in place of its content.
#[tauri::command]
pub fn create_template(id: String, name: String) -> Result<templates::TemplateSummary> {
    templates::create_from_deck(&deck::deck_file(&id)?, &templates::user_root()?, &name)
}
