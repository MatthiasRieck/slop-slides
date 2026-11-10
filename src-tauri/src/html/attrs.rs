//! The classes and attributes of the deck format, and those the editor puts on elements.

/// Marks a slide the player skips. The editor still shows it, muted.
pub const HIDDEN_ATTR: &str = "data-hidden";

/// Marks a slide neither the user nor the agent may change. The editor refuses edits to it,
/// and the app puts it back as it was if the agent changes or removes it in a turn.
pub const LOCKED_ATTR: &str = "data-locked";

/// How long the presenter expects to spend on a slide, in whole seconds. The presenter view
/// counts it against the time on the slide.
pub const TIME_ATTR: &str = "data-time";

/// How long the narration timeline shows a slide, in seconds: a video export and the show
/// playing by itself keep to it instead of working it out from the slide's narration.
pub const DURATION_ATTR: &str = "data-duration";

/// When the slide's narration starts on the timeline, in seconds after the slide starts; before
/// it, when negative. Moving a slide across the audio leaves the audio where it was, so it can
/// run into the slides around its own.
pub const NARRATION_START_ATTR: &str = "data-narration-start";

/// The shortest and longest `data-duration`, in seconds.
pub const MIN_DURATION: f64 = 0.5;
pub const MAX_DURATION: f64 = 3600.0;

/// Marks an element the user moved, rotated or scaled by hand in the editor; it carries inline
/// `translate` / `rotate` / `scale` styles until the agent tidies the slide's layout.
pub const MOVED_ATTR: &str = "data-moved";

/// Marks an element the user added in the editor: a text box (`text`), shape (`shape`) or
/// freehand drawing (`drawing`), absolutely positioned on the slide with inline styles until
/// the agent tidies the slide's layout.
pub const ADDED_ATTR: &str = "data-added";

/// Marks the one block (`<div data-text-body>`) that holds the text of a text box or shape the
/// user added: the box is a flex column, which would lay out each formatted run of text directly
/// in it as an item on a line of its own. The editor selects, moves and edits the box and
/// everything in the body as one text (see `assets/editor/`).
pub const TEXT_BODY_ATTR: &str = "data-text-body";

/// Marks an image the user dropped onto a slide in the editor. It sits on top of the slide,
/// placed with inline `position: absolute; left: 0; top: 0; width` (and moved with
/// [`MOVED_ATTR`]'s `translate`) until the agent gives it a place in the layout.
pub const DROPPED_ATTR: &str = "data-dropped";

/// How a text box handles text that does not fit: `shrink` (the player shrinks its text until
/// it fits, see `assets/runtime.js`) or `grow` (the editor turned its height into a
/// `min-height`, so it grows with its text).
pub const AUTOFIT_ATTR: &str = "data-autofit";
/// The kind of figure a shape the user added is (a triangle, a diamond…), which an SVG in its
/// `background-image` draws (see `FIGURES` in assets/editor/).
pub const SHAPE_ATTR: &str = "data-shape";
/// The figures the editor draws, by their `data-shape`.
pub const SHAPE_KINDS: &[&str] = &[
    "triangle",
    "star",
    "bubble",
    "diamond",
    "chevron",
    "block-arrow",
    "double-arrow",
    "hexagon",
    "octagon",
    "pentagon",
    "parallelogram",
    "trapezoid",
    "plus",
    "cylinder",
    "document",
    "heart",
];
/// A figure's proportions (a chevron's point, an arrow's head, a star's points), a number.
pub const ADJUST_ATTR: &str = "data-adjust";
/// A line's head, on a `<path>` of its own in it: which end, and what kind (`end arrow`).
pub const HEAD_ATTR: &str = "data-head";
/// The heads a line can end in.
pub const HEAD_KINDS: &[&str] = &["arrow", "triangle", "bar", "dot"];
/// How a connector goes between its ends, instead of straight or curved through its points.
pub const ROUTE_ATTR: &str = "data-route";
/// The routes the editor draws.
pub const ROUTES: &[&str] = &["elbow", "curved"];

/// Marks the invisible, inert copy the editor leaves where an element the user resized (the one
/// right before it), or moved into a group, was, so that the layout around it does not shift.
pub const RESIZE_PLACEHOLDER_ATTR: &str = "data-resize-placeholder";
/// Marks the invisible, inert copy the editor leaves where the user deleted an element, so that
/// the layout around it does not shift.
pub const DELETE_PLACEHOLDER_ATTR: &str = "data-delete-placeholder";

/// Attributes the in-editor slide editor puts on elements while it works. They never belong
/// in deck.html; the editor strips them before saving.
pub const EDITOR_ATTRS: &[&str] = &[
    "contenteditable",
    "spellcheck",
    "data-slop-selected",
    "data-slop-hover",
    "data-slop-editing",
    "data-slop-typing",
];

/// Class of the marker element that starts a section; its title is the `data-title` attribute.
pub const SECTION_CLASS: &str = "deck-section";
pub const SECTION_TITLE_ATTR: &str = "data-title";

/// A slide's narration, the script read out over it (say, by text to speech): Markdown text in
/// one `<aside class="narration">` that is a direct child of the slide. The player never shows it.
pub const NARRATION_CLASS: &str = "narration";

/// A slide's speaker notes: Markdown text in one `<aside class="notes">`, for the presenter alone.
/// The app reads and writes them the way it does narration; the player never shows them.
pub const NOTES_CLASS: &str = "notes";
