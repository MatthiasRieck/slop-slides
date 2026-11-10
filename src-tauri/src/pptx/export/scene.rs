//! The slides as the page helper reads them (`assets/pptx.js`): every shown slide's background
//! and items, as rendered, in canvas pixels.

use std::collections::HashMap;

use serde::Deserialize;

pub(super) type Rgba = [f64; 4];

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub(in crate::pptx) struct Scene {
    pub slides: Vec<SceneSlide>,
    pub shots: Vec<ShotInfo>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub(in crate::pptx) struct ShotInfo {
    /// The whole slide's background: nothing shows through, so one capture does.
    pub opaque: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub(in crate::pptx) struct SceneSlide {
    pub id: String,
    pub background: Background,
    pub items: Vec<Item>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub(in crate::pptx) struct Background {
    pub color: Option<Rgba>,
    pub gradient: Option<Gradient>,
    pub src: Option<String>,
    pub shot: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
pub(in crate::pptx) struct Gradient {
    /// CSS angle, in degrees.
    pub angle: f64,
    pub stops: Vec<Stop>,
}

#[derive(Debug, Clone, Deserialize)]
pub(in crate::pptx) struct Stop {
    pub at: f64,
    pub color: Rgba,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(in crate::pptx) enum Item {
    Box(BoxItem),
    Text(TextItem),
    Image(ImageItem),
    Shot(ShotItem),
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub(in crate::pptx) struct Fill {
    pub color: Option<Rgba>,
    pub gradient: Option<Gradient>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub(in crate::pptx) struct Border {
    pub color: Rgba,
    pub width: f64,
    pub dash: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub(in crate::pptx) struct Shadow {
    pub color: Rgba,
    pub x: f64,
    pub y: f64,
    pub blur: f64,
}

fn one() -> f64 {
    1.0
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(in crate::pptx) struct BoxItem {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub rotation: f64,
    #[serde(default)]
    pub fill: Option<Fill>,
    #[serde(default)]
    pub border: Option<Border>,
    #[serde(default)]
    pub shadow: Option<Shadow>,
    #[serde(default)]
    pub radius: f64,
    #[serde(default)]
    pub ellipse: bool,
    #[serde(default = "one")]
    pub opacity: f64,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(in crate::pptx) struct TextItem {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub rotation: f64,
    #[serde(default)]
    pub wrap: bool,
    pub paragraphs: Vec<Paragraph>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub(in crate::pptx) struct Paragraph {
    pub align: String,
    pub line_height: Option<f64>,
    pub space_before: Option<f64>,
    pub margin_left: Option<f64>,
    pub indent: Option<f64>,
    pub bullet: Option<Bullet>,
    pub runs: Vec<Run>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub(in crate::pptx) struct Bullet {
    pub char: Option<String>,
    /// The CSS `list-style-type` of a numbered list.
    pub number: Option<String>,
    pub start: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub(in crate::pptx) struct Run {
    pub text: String,
    pub line_break: bool,
    pub font: String,
    pub size: f64,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    pub color: Option<Rgba>,
    pub spacing: f64,
    pub highlight: Option<Rgba>,
    /// Percent raised; PowerPoint draws such text at two thirds of its size.
    pub baseline: f64,
    pub link: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub(in crate::pptx) struct Crop {
    pub l: f64,
    pub t: f64,
    pub r: f64,
    pub b: f64,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(in crate::pptx) struct ImageItem {
    pub src: String,
    #[serde(default)]
    pub alt: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub rotation: f64,
    #[serde(default)]
    pub flip_h: bool,
    #[serde(default)]
    pub border: Option<Border>,
    #[serde(default)]
    pub crop: Option<Crop>,
    #[serde(default)]
    pub radius: f64,
    #[serde(default)]
    pub ellipse: bool,
    #[serde(default = "one")]
    pub opacity: f64,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(in crate::pptx) struct ShotItem {
    pub shot: usize,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// What the file says beyond its slides.
pub(in crate::pptx) struct Meta {
    pub title: String,
    pub canvas: (u32, u32),
    /// Speaker notes by slide id.
    pub notes: HashMap<String, String>,
    /// A section's name and the id of the slide it starts with.
    pub sections: Vec<(String, String)>,
}
