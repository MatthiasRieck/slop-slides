//! PowerPoint files, in and out. Decks stay HTML: a `.pptx` is converted into a new deck once
//! ([`import`]), never kept or written back, and exporting ([`export`]) writes a new `.pptx`
//! from the slides as rendered.

mod export;
mod import;
mod xml;

pub use export::export;
pub use import::{import, Imported};

/// English Metric Units per inch, PowerPoint's unit of length.
const EMU_PER_INCH: f64 = 914_400.0;
/// The width of a standard widescreen PowerPoint slide (13.333 inches). A 1920 px wide deck maps
/// onto it, so sizes in points look as they do in any other presentation.
const WIDESCREEN_EMU: f64 = 12_192_000.0;
/// One CSS pixel in EMU, at 96 pixels per inch.
const EMU_PER_CSS_PX: f64 = EMU_PER_INCH / 96.0;
/// One typographic point in EMU.
const EMU_PER_POINT: f64 = EMU_PER_INCH / 72.0;
/// DrawingML's unit for fractions (percentages, alpha, positions along a gradient): a whole.
const WHOLE: f64 = 100_000.0;
/// DrawingML's unit for angles: a degree.
const DEGREE: f64 = 60_000.0;
/// PowerPoint's name for the section holding the slides before the first one the user named.
/// It wants every slide in a section; a deck does not, so this one is left out on import.
const DEFAULT_SECTION: &str = "Default Section";
/// The longest side of an imported slide's canvas, in pixels.
const CANVAS_LONG_SIDE: f64 = 1920.0;

#[cfg(test)]
mod tests;
