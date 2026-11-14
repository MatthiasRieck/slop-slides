//! Single-file deck format. A deck is one HTML document whose top-level
//! `<section class="slide" id="…">` elements are the slides, in order. This module finds
//! those sections without a full HTML parser (it skips comments, `<script>`, `<style>`
//! and quoted attributes) and rewrites the document for slide-level operations.
//!
//! Between slides, `<div class="deck-section" data-title="…"></div>` markers start a named
//! section. They are shown in the editor's slide rail but are not slides: the player hides
//! them and nothing counts them.
//!
//! The parts, each in a file of its own:
//! - [`scan`]: the tag scanner everything else reads the document with;
//! - [`spans`]: where the slides and section markers are, and hashes of them;
//! - [`slides`] and [`sections`]: adding, removing, moving and copying them;
//! - [`single`]: the deck cut down to one slide, for a preview;
//! - [`slide_attrs`]: a slide's own attributes (hidden, locked, timing);
//! - [`batch`]: one change to many slides at once;
//! - [`locked`]: putting locked slides back after the agent changed them;
//! - [`asides`]: a slide's narration and speaker notes;
//! - [`content`]: what the app shows of a slide, read in one pass;
//! - [`meta`]: the document's `<title>` and the app's settings in `<meta>` tags;
//! - [`runtime`]: the player runtime blocks the app manages;
//! - [`placeholder`]: placeholder text for turning a deck into a template;
//! - [`assets`]: the deck's `assets/…` references;
//! - [`attrs`]: the classes and attributes the deck format and the editor use.

mod asides;
mod assets;
mod attrs;
mod batch;
mod content;
mod edit;
mod entities;
mod locked;
mod meta;
mod placeholder;
mod runtime;
mod scan;
mod sections;
mod single;
mod slide_attrs;
mod slides;
mod spans;

#[cfg(test)]
pub(crate) mod fixtures;

pub use asides::{append_narration, narration, narration_spans, notes, set_narration, set_notes};
pub use assets::{asset_refs, inline_assets};
pub use attrs::*;
pub use batch::edit_slides;
pub use content::{slide_content, SlideContent};
pub(crate) use edit::{end_of_deck, indent_before, remove, with_indent};
pub(crate) use entities::escape;
pub use locked::{changed_locked, changed_locked_in, locked_slides, restore_locked, LockedSlide};
pub(crate) use meta::app_meta_content;
#[cfg(test)]
pub use meta::template;
pub use meta::{
    narration_provider, narration_voice, set_narration_language, set_narration_provider,
    set_narration_voice, set_slide_size, set_template, set_title, slide_size, title, AppMetas,
    NARRATION_LANGUAGE_META, NARRATION_PROVIDER_META, NARRATION_VOICE_META, TEMPLATE_META,
};
pub use placeholder::with_placeholder_text;
#[cfg(test)]
pub(crate) use runtime::PLAYER_FLAG;
pub use runtime::{ensure_runtime, without_runtime};
pub(crate) use runtime::{CSS_START, JS_START};
pub(crate) use scan::{find_ci, has_class, parse_tag, Attr, Tag, VOID_ELEMENTS};
pub use sections::{add_section, delete_section, rename_section};
pub use single::{single_slide, Others};
pub use slide_attrs::{is_locked, parse_duration, parse_narration_start, parse_time, set_time};
#[cfg(test)]
pub use slide_attrs::{set_duration, set_hidden, set_narration_start};
pub use slides::{
    copy_slide, insert, normalize_ids, paste_slide, reorder, replace_slide, replace_slide_at,
    slide_markup, slugify, strip_slides,
};
#[cfg(test)]
pub use slides::{delete, duplicate, has_moved};
pub(crate) use spans::has_deck_container;
#[cfg(test)]
pub(crate) use spans::scans;
pub use spans::{
    content_hash, find_sections, find_slides, find_spans, shell_hash, SectionSpan, SlideSpan,
};
