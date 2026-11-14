//! Converts a `.pptx` into a new deck. The file is only read: every slide becomes ordinary deck
//! markup (absolutely positioned elements, as the slide stood in PowerPoint) with its images in
//! the deck's `assets/`, and from then on the deck is the document.
//!
//! A slide's look is spread over the slide, its layout, its master and the theme, so each shape
//! is resolved through that chain here. The file is untrusted: text is escaped, links are limited
//! to safe schemes, sizes are capped, and part names never reach the file system.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use serde::Serialize;

mod color;
mod context;
mod package;
mod presets;
mod shapes;
mod style;
mod tables;
mod text;

use super::xml::{self, Node};
use super::{Change, CANVAS_LONG_SIDE, DEFAULT_SECTION, DEGREE, EMU_PER_POINT, WHOLE};
use crate::deck;
use crate::error::{Error, Result};
use crate::html;
use color::*;
use context::*;
use package::*;
use presets::*;
use style::*;

/// The largest single part read from a file. Compressed sizes prove nothing about this.
const MAX_PART: u64 = 512 * 1024 * 1024;
/// The most read from a file altogether.
const MAX_TOTAL: u64 = 2 * 1024 * 1024 * 1024;
/// Groups nested deeper than this are left out; the tree is walked recursively.
const MAX_GROUP_DEPTH: usize = 32;

const SHELL_CSS: &str = r#"
    .slide {
      overflow: hidden;
      background: var(--slide-bg);
      color: var(--slide-ink);
      font-family: var(--font-body);
    }

    /* Elements stand where they stood in PowerPoint. */
    .ppt-el { position: absolute; box-sizing: border-box; margin: 0; }
    .ppt-text { display: flex; flex-direction: column; overflow-wrap: break-word; white-space: pre-wrap; }
    .ppt-text p { margin: 0; }
    .ppt-text ul, .ppt-text ol { margin: 0; padding: 0; }
    .ppt-text a { color: inherit; }
    .ppt-crop { overflow: hidden; }
    .ppt-crop img { position: absolute; max-width: none; max-height: none; }
    .ppt-table { border-collapse: collapse; table-layout: fixed; }
    .ppt-table td { vertical-align: top; overflow-wrap: break-word; }
    .ppt-table p { margin: 0; }
"#;

/// What [`import`] made.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    pub deck: deck::Deck,
    /// What could not come along as it was, for the user: one entry per kind, with the slides
    /// it is about.
    pub changes: Vec<Change>,
    /// The fonts the presentation names, for the app to say which this computer does not have.
    pub fonts: Vec<FontUse>,
}

/// A font the presentation is set in, and the slides that use it; none when it is the
/// presentation's own, used wherever a slide names no other.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FontUse {
    pub name: String,
    pub slides: Vec<usize>,
}

/// How far an import has got: reading slide `slide` of `slides`, from 1.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Progress {
    pub slide: usize,
    pub slides: usize,
}

/// Converts the PowerPoint file at `source` into `<root>/<slug>/deck.html` and opens it,
/// telling `progress` which slide it is reading.
pub fn import(source: &Path, root: &Path, progress: impl Fn(Progress)) -> Result<Imported> {
    let bytes = fs::read(source)?;
    let name = source
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let converted = convert_with(bytes, &name, &progress)?;
    let dir = crate::files::unique_dir(root, &html::slugify(&converted.title));
    let written = write_deck(&dir, &converted);
    match written.and_then(|file| deck::open(&file, None, true)) {
        Ok(deck) => Ok(Imported {
            deck,
            changes: converted.skipped,
            fonts: converted.fonts,
        }),
        Err(error) => {
            let _ = fs::remove_dir_all(&dir);
            Err(error)
        }
    }
}

fn write_deck(dir: &Path, converted: &Converted) -> Result<PathBuf> {
    fs::create_dir_all(dir.join("assets"))?;
    for (name, bytes) in &converted.assets {
        fs::write(dir.join("assets").join(name), bytes)?;
    }
    let file = dir.join(deck::DECK_FILE);
    fs::write(&file, &converted.html)?;
    Ok(file)
}

/// A converted presentation, not yet on disk.
pub(super) struct Converted {
    pub title: String,
    pub html: String,
    /// File name in `assets/`, and contents.
    pub assets: Vec<(String, Vec<u8>)>,
    /// What could not come along as it was, with the slides it is about.
    pub skipped: Vec<Change>,
    /// The fonts the presentation names.
    pub fonts: Vec<FontUse>,
}

/// The chain a slide inherits from, and everything gathered while converting.
struct Converter {
    package: Package,
    /// Assets written so far, by file name.
    assets: Vec<(String, Vec<u8>)>,
    /// Asset name of each media part already taken.
    media: HashMap<String, String>,
    skipped: Vec<Change>,
    /// The slide being converted, from 1; 0 before the first.
    slide: usize,
    /// The fonts named so far, with the slides naming them. Text is styled without changing
    /// the converter, hence the cell.
    fonts: RefCell<BTreeMap<String, BTreeSet<usize>>>,
    /// Canvas pixels per EMU.
    px: f64,
    default_text: Option<Node>,
    /// Slide part to slide id, for links between slides.
    slide_ids: HashMap<String, String>,
    /// Gradients defined in SVG so far, which need document-wide ids.
    gradients: usize,
}

/// One slide's inheritance chain.
struct Chain<'a> {
    slide: &'a Part,
    layout: Option<&'a Part>,
    master: Option<&'a Part>,
    theme: &'a Theme,
    map: &'a HashMap<String, String>,
    number: usize,
}

impl Chain<'_> {
    fn palette(&self) -> Palette<'_> {
        Palette {
            theme: self.theme,
            map: self.map,
        }
    }
}

/// Default colour mapping, for parts that leave it out.
fn default_map() -> HashMap<String, String> {
    [
        ("bg1", "lt1"),
        ("tx1", "dk1"),
        ("bg2", "lt2"),
        ("tx2", "dk2"),
    ]
    .iter()
    .map(|(a, b)| (a.to_string(), b.to_string()))
    .collect()
}

fn round(value: f64, places: i32) -> f64 {
    let factor = 10f64.powi(places);
    // Adding zero turns -0 into 0, which reads better in the markup.
    (value * factor).round() / factor + 0.0
}

/// Text for HTML content and attribute values.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c if c.is_control() && c != '\n' && c != '\t' => {}
            c => out.push(c),
        }
    }
    out
}

/// `font-family` for a font PowerPoint names, safe inside a `style="…"` value.
fn font_family(name: &str) -> String {
    let clean: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || " -_".contains(*c))
        .collect();
    let clean = clean.trim();
    if clean.is_empty() {
        "sans-serif".to_string()
    } else {
        format!("&quot;{clean}&quot;, sans-serif")
    }
}

/// A URL a link may go to; anything that could run or read files is dropped.
fn safe_url(url: &str) -> Option<&str> {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    ["http://", "https://", "mailto:"]
        .iter()
        .any(|s| lower.starts_with(s))
        .then_some(url)
}

/// Placeholder kinds that share a master style, as their `type` names them.
fn placeholder_class(kind: &str) -> TextClass {
    match kind {
        "title" | "ctrTitle" => TextClass::Title,
        "dt" | "ftr" | "sldNum" => TextClass::Other,
        _ => TextClass::Body,
    }
}

fn placeholder_of(shape: &Node) -> Option<&Node> {
    shape
        .children
        .iter()
        .find(|c| c.name.starts_with("nv"))?
        .at(&["nvPr", "ph"])
}

/// The shape in `part` that `ph` inherits from: the same `idx`, else the same kind.
fn matching_placeholder<'a>(part: &'a Part, ph: &Node) -> Option<&'a Node> {
    let tree = part.root.at(&["cSld", "spTree"])?;
    let kind = ph.attr("type").unwrap_or("body");
    let same_kind = |a: &str, b: &str| {
        let group = |k: &'_ str| match k {
            "ctrTitle" => "title".to_string(),
            "subTitle" | "obj" | "tx" => "body".to_string(),
            k => k.to_string(),
        };
        group(a) == group(b)
    };
    let shapes = || {
        tree.children
            .iter()
            .filter_map(|c| placeholder_of(c).map(|p| (c, p)))
    };
    if let Some(idx) = ph.attr("idx") {
        if let Some((shape, _)) = shapes().find(|(_, p)| p.attr("idx") == Some(idx)) {
            return Some(shape);
        }
    }
    shapes()
        .find(|(_, p)| same_kind(p.attr("type").unwrap_or("body"), kind))
        .map(|(shape, _)| shape)
}

/// `name` of `a:lvlNpPr` for a paragraph level.
fn level_key(level: usize) -> String {
    format!("lvl{}pPr", level + 1)
}

impl Converter {
    fn px(&self, emu: f64) -> f64 {
        round(emu * self.px, 2)
    }

    /// A font size or other length in points, as canvas pixels.
    fn pt(&self, points: f64) -> f64 {
        round(points * EMU_PER_POINT * self.px, 2)
    }

    /// Notes that `what` could not come along on the slide being converted.
    fn skip(&mut self, what: &str) {
        let at = match self.skipped.iter().position(|s| s.what == what) {
            Some(at) => at,
            None => {
                self.skipped.push(Change {
                    what: what.to_string(),
                    slides: Vec::new(),
                });
                self.skipped.len() - 1
            }
        };
        let slides = &mut self.skipped[at].slides;
        if self.slide > 0 && slides.last() != Some(&self.slide) {
            slides.push(self.slide);
        }
    }

    /// `font-family` for a font the slide being converted names (see [`font_family`]), which
    /// is noted as used there.
    fn font(&self, name: &str) -> String {
        let name = name.trim();
        if !name.is_empty() && !name.starts_with('+') {
            let mut fonts = self.fonts.borrow_mut();
            let slides = fonts.entry(name.to_string()).or_default();
            if self.slide > 0 {
                slides.insert(self.slide);
            }
        }
        font_family(name)
    }

    /// Copies a media part into the deck; its file name in `assets/`, once per part.
    fn asset(&mut self, part: &str) -> Option<String> {
        if let Some(name) = self.media.get(part) {
            return Some(name.clone());
        }
        let bytes = self.package.read(part)?;
        let file = part.rsplit('/').next().unwrap_or("image");
        let (stem, ext) = file.rsplit_once('.').unwrap_or((file, ""));
        let ext: String = ext
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .collect::<String>()
            .to_lowercase();
        let stem = match html::slugify(stem) {
            s if s.is_empty() => "image".to_string(),
            s => s,
        };
        let name = std::iter::once(format!("{stem}.{ext}"))
            .chain((2..).map(|n| format!("{stem}-{n}.{ext}")))
            .find(|n| !self.assets.iter().any(|(taken, _)| taken == n))
            .expect("unbounded");
        self.assets.push((name.clone(), bytes));
        self.media.insert(part.to_string(), name.clone());
        Some(name)
    }

    /// The image of `blip` as an asset. Formats a webview cannot show are left out.
    fn blip_asset(&mut self, blip: &Node, part: &Part) -> Option<String> {
        // Office keeps vector art beside a fallback bitmap, in an extension.
        let vector = blip
            .find("svgBlip")
            .and_then(|s| s.attr("r:embed"))
            .and_then(|id| part.rels.get(id));
        let rel = vector.or_else(|| part.rels.get(blip.attr("r:embed")?))?;
        if rel.external {
            self.skip("linked images");
            return None;
        }
        let ext = rel.target.rsplit('.').next().unwrap_or("").to_lowercase();
        if !matches!(
            ext.as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "svg" | "webp" | "bmp"
        ) {
            self.skip("images in EMF, WMF or TIFF format");
            return None;
        }
        let target = rel.target.clone();
        self.asset(&target)
    }

    fn fill_of(&mut self, node: &Node, part: &Part, palette: &Palette) -> Option<Fill> {
        for child in &node.children {
            match child.name.as_str() {
                "noFill" => return Some(Fill::None),
                "solidFill" => return palette.color(child).map(Fill::Solid),
                "pattFill" => {
                    // Patterns have no CSS counterpart worth the markup; their main colour stands in.
                    return child
                        .child("fgClr")
                        .and_then(|c| palette.color(c))
                        .map(Fill::Solid);
                }
                "gradFill" => {
                    let mut stops: Vec<(f64, Color)> = child
                        .at(&["gsLst"])?
                        .all("gs")
                        .filter_map(|gs| Some((gs.num("pos")? / WHOLE, palette.color(gs)?)))
                        .collect();
                    stops.sort_by(|a, b| a.0.total_cmp(&b.0));
                    if stops.is_empty() {
                        return None;
                    }
                    if child.child("path").is_some() {
                        return Some(Fill::Radial { stops });
                    }
                    // OOXML angles run clockwise from the x axis; CSS's from the top.
                    let angle = child.child("lin").and_then(|l| l.num("ang")).unwrap_or(0.0)
                        / DEGREE
                        + 90.0;
                    return Some(Fill::Linear {
                        angle: angle.rem_euclid(360.0),
                        stops,
                    });
                }
                "blipFill" => {
                    let blip = child.child("blip")?;
                    let asset = self.blip_asset(blip, part)?;
                    let alpha = blip
                        .child("alphaModFix")
                        .and_then(|a| a.num("amt"))
                        .map_or(1.0, |a| a / WHOLE);
                    return Some(Fill::Image { asset, alpha });
                }
                _ => {}
            }
        }
        None
    }

    /// The fill of the slide's background: its own, its layout's, or its master's.
    fn background(&mut self, chain: &Chain) -> Option<Fill> {
        let palette = chain.palette();
        let parts = [Some(chain.slide), chain.layout, chain.master];
        for part in parts.into_iter().flatten() {
            let Some(bg) = part.root.at(&["cSld", "bg"]) else {
                continue;
            };
            if let Some(props) = bg.child("bgPr") {
                if let Some(fill) = self.fill_of(props, part, &palette) {
                    return Some(fill);
                }
            }
            if let Some(reference) = bg.child("bgRef") {
                if let Some(color) = palette.color(reference) {
                    return Some(Fill::Solid(color));
                }
            }
        }
        None
    }

    fn frame_html(
        &mut self,
        chain: &Chain,
        part: &Part,
        node: &Node,
        frame: Frame,
        out: &mut String,
        depth: usize,
    ) {
        let Some(bx) = node.child("xfrm").and_then(|x| read_box(x, frame)) else {
            return;
        };
        if let Some(table) = node.find("tbl") {
            self.table_html(chain, part, table, bx, out);
            return;
        }
        if let Some(id) = node.find("chart").and_then(|c| c.attr("r:id")) {
            self.chart_html(part, id, bx, out);
            return;
        }
        // SmartArt keeps a ready-made drawing of itself, in a part of its own.
        if let Some(target) = part.rels.of_kind("diagramDrawing").map(str::to_string) {
            if node.find("relIds").is_some() {
                if let Some(drawing) = self.package.part(&target) {
                    if let Some(tree) = drawing.root.child("spTree") {
                        let inner = Frame {
                            tx: bx.x,
                            ty: bx.y,
                            ..frame
                        };
                        self.tree_html(chain, &drawing, tree, inner, out, true, depth + 1);
                        return;
                    }
                }
            }
        }
        // OLE objects and the like carry a picture of themselves.
        if let Some(pic) = node.find("pic") {
            let mut fake = pic.clone();
            if fake.at(&["spPr", "xfrm"]).is_none() {
                if let (Some(xfrm), Some(props)) = (
                    node.child("xfrm").cloned(),
                    fake.children.iter_mut().find(|c| c.name == "spPr"),
                ) {
                    props.children.insert(0, xfrm);
                }
            }
            self.picture_html(chain, part, &fake, frame, out);
            return;
        }
        self.skip("embedded objects");
    }

    /// The shapes under `tree`, in order.
    #[allow(clippy::too_many_arguments)]
    fn tree_html(
        &mut self,
        chain: &Chain,
        part: &Part,
        tree: &Node,
        frame: Frame,
        out: &mut String,
        on_slide: bool,
        depth: usize,
    ) {
        if depth > MAX_GROUP_DEPTH {
            return;
        }
        for child in &tree.children {
            self.node_html(chain, part, child, frame, out, on_slide, depth);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn node_html(
        &mut self,
        chain: &Chain,
        part: &Part,
        node: &Node,
        frame: Frame,
        out: &mut String,
        on_slide: bool,
        depth: usize,
    ) {
        match node.name.as_str() {
            "sp" | "cxnSp" => self.shape_html(chain, part, node, frame, out, on_slide),
            "pic" => self.picture_html(chain, part, node, frame, out),
            "grpSp" => {
                let inner = node
                    .at(&["grpSpPr", "xfrm"])
                    .map_or(frame, |x| frame.nested(x));
                self.tree_html(chain, part, node, inner, out, on_slide, depth + 1);
            }
            "graphicFrame" => self.frame_html(chain, part, node, frame, out, depth),
            "AlternateContent" => {
                // Newer content, unless it is math: a webview shows only the picture of that.
                let choice = node
                    .child("Choice")
                    .filter(|c| c.attr("Requires") != Some("a14"));
                if let Some(content) = choice.or(node.child("Fallback")) {
                    for child in &content.children {
                        self.node_html(chain, part, child, frame, out, on_slide, depth + 1);
                    }
                }
            }
            _ => {}
        }
    }

    fn notes_of(&mut self, slide: &Part) -> String {
        let Some(path) = slide.rels.of_kind("notesSlide").map(str::to_string) else {
            return String::new();
        };
        let Some(root) = self.package.xml(&path) else {
            return String::new();
        };
        let Some(tree) = root.at(&["cSld", "spTree"]) else {
            return String::new();
        };
        let body = tree
            .all("sp")
            .find(|s| placeholder_of(s).is_some_and(|p| p.attr("type") == Some("body")));
        let Some(body) = body.and_then(|s| s.child("txBody")) else {
            return String::new();
        };
        let lines: Vec<String> = body
            .all("p")
            .map(|p| {
                let mut runs = Vec::new();
                p.find_all("t", &mut runs);
                runs.iter().map(|t| t.text.as_str()).collect::<String>()
            })
            .filter(|line| !line.trim().is_empty())
            .collect();
        lines.join("\n\n")
    }
}

// --- The deck --------------------------------------------------------------------------------

/// The text of a slide's title placeholder.
fn title_text(slide: &Part) -> Option<String> {
    let tree = slide.root.at(&["cSld", "spTree"])?;
    let shape = tree.all("sp").find(|s| {
        placeholder_of(s)
            .and_then(|p| p.attr("type"))
            .is_some_and(|k| k == "title" || k == "ctrTitle")
    })?;
    let mut runs = Vec::new();
    shape.child("txBody")?.find_all("t", &mut runs);
    let text = runs.iter().map(|t| t.text.as_str()).collect::<String>();
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// A unique kebab-case id for each slide, from its title where it has one.
fn slide_ids(titles: &[Option<String>]) -> Vec<String> {
    let mut used = HashSet::new();
    titles
        .iter()
        .enumerate()
        .map(|(i, title)| {
            let slug = title.as_deref().map(html::slugify).unwrap_or_default();
            let slug: String = slug.chars().take(40).collect();
            let slug = slug.trim_matches('-');
            let starts_ok = slug.chars().next().is_some_and(|c| c.is_ascii_lowercase());
            let base = if starts_ok {
                slug.to_string()
            } else {
                format!("slide-{}", i + 1)
            };
            let id = std::iter::once(base.clone())
                .chain((2..).map(|n| format!("{base}-{n}")))
                .find(|id| !used.contains(id))
                .expect("unbounded");
            used.insert(id.clone());
            id
        })
        .collect()
}

/// The canvas for a slide `cx` × `cy` EMU, and canvas pixels per EMU: the long side at 1920.
fn canvas(cx: f64, cy: f64) -> (u32, u32, f64) {
    let scale = CANVAS_LONG_SIDE / cx.max(cy);
    let side = |v: f64| {
        (v * scale).round().clamp(
            f64::from(crate::size::MIN_PX),
            f64::from(crate::size::MAX_PX),
        ) as u32
    };
    (side(cx), side(cy), scale)
}

/// Sections as slide parts' `sldId` values to the name of the section they start.
fn section_starts(presentation: &Node) -> HashMap<String, String> {
    let mut sections = Vec::new();
    presentation.find_all("section", &mut sections);
    sections
        .iter()
        .filter_map(|s| {
            let first = s.find("sldId")?.attr("id")?.to_string();
            Some((first, s.attr("name").unwrap_or("Section").to_string()))
        })
        .collect()
}

/// Whether a slide has animations: its timing holds something that moves or shows an element.
fn has_animations(slide: &Node) -> bool {
    let Some(timing) = slide.child("timing") else {
        return false;
    };
    [
        "anim",
        "animEffect",
        "animMotion",
        "animScale",
        "animRot",
        "animClr",
        "set",
    ]
    .iter()
    .any(|name| timing.find(name).is_some())
}

/// Reads the whole presentation and writes it as deck HTML. `fallback` titles a file with none.
#[cfg(test)]
pub(super) fn convert(bytes: Vec<u8>, fallback: &str) -> Result<Converted> {
    convert_with(bytes, fallback, &|_| {})
}

/// [`convert`], telling `progress` which slide it is reading.
pub(super) fn convert_with(
    bytes: Vec<u8>,
    fallback: &str,
    progress: &dyn Fn(Progress),
) -> Result<Converted> {
    let mut package = Package::open(bytes)?;
    let not_powerpoint = || Error::msg("This file has no PowerPoint presentation in it.");
    let root_rels = package.rels("");
    let presentation_path = root_rels
        .of_kind("officeDocument")
        .map_or("ppt/presentation.xml".to_string(), str::to_string);
    let presentation = package
        .part(&presentation_path)
        .ok_or_else(not_powerpoint)?;
    if presentation.root.name != "presentation" {
        return Err(not_powerpoint());
    }
    let size = presentation.root.child("sldSz");
    let (cx, cy) = (
        size.and_then(|s| s.num("cx"))
            .filter(|v| *v > 0.0)
            .unwrap_or(12_192_000.0),
        size.and_then(|s| s.num("cy"))
            .filter(|v| *v > 0.0)
            .unwrap_or(6_858_000.0),
    );
    let (width, height, px) = canvas(cx, cy);

    let core = root_rels
        .of_kind("core-properties")
        .map(str::to_string)
        .and_then(|p| package.xml(&p));
    let title = core
        .as_ref()
        .and_then(|c| c.child("title"))
        .map(|t| t.text.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| match fallback.trim() {
            "" => "Imported presentation".to_string(),
            name => name.to_string(),
        });

    let sections = section_starts(&presentation.root);
    let entries: Vec<(String, String)> = presentation
        .root
        .at(&["sldIdLst"])
        .into_iter()
        .flat_map(|l| l.all("sldId"))
        .filter_map(|s| {
            let rel = presentation.rels.get(s.attr("r:id")?)?;
            Some((s.attr("id")?.to_string(), rel.target.clone()))
        })
        .collect();
    if entries.is_empty() {
        return Err(Error::msg("This presentation has no slides."));
    }

    let mut slides = Vec::with_capacity(entries.len());
    for (sld_id, path) in entries {
        let part = package
            .part(&path)
            .ok_or_else(|| Error::msg(format!("Cannot read {path} in this presentation.")))?;
        slides.push((sld_id, part));
    }
    let titles: Vec<Option<String>> = slides.iter().map(|(_, s)| title_text(s)).collect();
    let ids = slide_ids(&titles);

    // Themes and masters are shared by slides; each is read once.
    let mut parts: HashMap<String, Part> = HashMap::new();
    let mut themes: HashMap<String, Theme> = HashMap::new();
    let load = |package: &mut Package, path: Option<String>, parts: &mut HashMap<String, Part>| {
        let path = path?;
        if !parts.contains_key(&path) {
            let part = package.part(&path)?;
            parts.insert(path.clone(), part);
        }
        Some(path)
    };

    let mut converter = Converter {
        package,
        assets: Vec::new(),
        media: HashMap::new(),
        skipped: Vec::new(),
        slide: 0,
        fonts: RefCell::new(BTreeMap::new()),
        px,
        gradients: 0,
        default_text: presentation.root.child("defaultTextStyle").cloned(),
        slide_ids: slides
            .iter()
            .zip(&ids)
            .map(|((_, s), id)| (s.path.clone(), id.clone()))
            .collect(),
    };

    let mut body = String::new();
    let mut first_theme: Option<Theme> = None;
    let mut first_ink: Option<Color> = None;
    let mut first_bg: Option<Color> = None;
    for (index, ((sld_id, slide), id)) in slides.iter().zip(&ids).enumerate() {
        converter.slide = index + 1;
        progress(Progress {
            slide: index + 1,
            slides: slides.len(),
        });
        // A deck has its own entrances and transitions; PowerPoint's do not map onto them.
        if has_animations(&slide.root) {
            converter.skip("animations (each slide shows as it ends)");
        }
        if slide.root.find("transition").is_some() {
            converter.skip("slide transitions");
        }
        let layout_path = slide.rels.of_kind("slideLayout").map(str::to_string);
        let layout_path = load(&mut converter.package, layout_path, &mut parts);
        let master_path = layout_path
            .as_ref()
            .and_then(|p| parts.get(p))
            .and_then(|l| l.rels.of_kind("slideMaster"))
            .map(str::to_string);
        let master_path = load(&mut converter.package, master_path, &mut parts);
        let layout = layout_path.as_ref().and_then(|p| parts.get(p));
        let master = master_path.as_ref().and_then(|p| parts.get(p));

        let theme_path = master
            .and_then(|m| m.rels.of_kind("theme"))
            .map(str::to_string);
        if let Some(path) = &theme_path {
            if !themes.contains_key(path) {
                let root = converter.package.xml(path);
                themes.insert(path.clone(), Theme::parse(root.as_ref()));
            }
        }
        let fallback_theme = Theme::parse(None);
        let theme = theme_path
            .as_ref()
            .and_then(|p| themes.get(p))
            .unwrap_or(&fallback_theme);
        let map = master
            .and_then(|m| m.root.child("clrMap"))
            .map_or_else(default_map, |c| {
                c.attrs.iter().cloned().collect::<HashMap<_, _>>()
            });
        let chain = Chain {
            slide,
            layout,
            master,
            theme,
            map: &map,
            number: index + 1,
        };
        if first_theme.is_none() {
            first_theme = Some(theme.clone());
            first_ink = chain.palette().scheme("tx1");
            first_bg = chain.palette().scheme("bg1");
        }

        let mut shapes = String::new();
        let show_master = slide.root.flag("showMasterSp") != Some(false);
        if show_master {
            if layout.map_or(true, |l| l.root.flag("showMasterSp") != Some(false)) {
                if let Some(tree) = master.and_then(|m| m.root.at(&["cSld", "spTree"])) {
                    let part = master.expect("the tree came from it");
                    converter.tree_html(&chain, part, tree, Frame::IDENTITY, &mut shapes, false, 0);
                }
            }
            if let Some(tree) = layout.and_then(|l| l.root.at(&["cSld", "spTree"])) {
                let part = layout.expect("the tree came from it");
                converter.tree_html(&chain, part, tree, Frame::IDENTITY, &mut shapes, false, 0);
            }
        }
        if let Some(tree) = slide.root.at(&["cSld", "spTree"]) {
            converter.tree_html(&chain, slide, tree, Frame::IDENTITY, &mut shapes, true, 0);
        }

        let section = sections
            .get(sld_id)
            .filter(|name| index > 0 || name.as_str() != DEFAULT_SECTION);
        if let Some(name) = section {
            body.push_str(&format!(
                "    <div class=\"deck-section\" data-title=\"{}\"></div>\n",
                escape(name)
            ));
        }
        let hidden = if slide.root.flag("show") == Some(false) {
            " data-hidden"
        } else {
            ""
        };
        let style = converter
            .background(&chain)
            .and_then(|f| f.css())
            .map_or(String::new(), |css| format!(" style=\"{css}\""));
        body.push_str(&format!(
            "    <section class=\"slide\" id=\"{id}\"{hidden}{style}>\n{shapes}"
        ));
        let notes = converter.notes_of(slide);
        if !notes.is_empty() {
            let escaped = notes.replace('&', "&amp;").replace('<', "&lt;");
            body.push_str(&format!("<aside class=\"notes\">{escaped}</aside>\n"));
        }
        body.push_str("    </section>\n");
    }

    converter.slide = 0;
    let theme = first_theme.unwrap_or_else(|| Theme::parse(None));
    // The presentation's own fonts are used wherever a slide names no other.
    let (major, minor) = (
        converter.font(&theme.major_font).replace("&quot;", "\""),
        converter.font(&theme.minor_font).replace("&quot;", "\""),
    );
    let black = Color {
        r: 0,
        g: 0,
        b: 0,
        a: 1.0,
    };
    let white = Color {
        r: 255,
        g: 255,
        b: 255,
        a: 1.0,
    };
    let size_meta = if (width, height) == (1920, 1080) {
        String::new()
    } else {
        format!(
            "  <meta name=\"{}\" content=\"{width}x{height}\">\n",
            crate::size::SIZE_META
        )
    };
    let html = format!(
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n  <title>{title}</title>\n{size_meta}  <style>\n    :root {{\n      --slide-bg: {bg};\n      --slide-ink: {ink};\n      --font-display: {major};\n      --font-body: {minor};\n    }}\n{css}  </style>\n</head>\n<body>\n  <main class=\"deck\">\n{body}  </main>\n</body>\n</html>\n",
        title = escape(&title),
        bg = first_bg.unwrap_or(white).css(),
        ink = first_ink.unwrap_or(black).css(),
        major = major,
        minor = minor,
        css = SHELL_CSS,
    );
    let fonts = converter
        .fonts
        .into_inner()
        .into_iter()
        .map(|(name, slides)| FontUse {
            name,
            slides: slides.into_iter().collect(),
        })
        .collect();
    Ok(Converted {
        title,
        html,
        assets: converter.assets,
        skipped: converter.skipped,
        fonts,
    })
}
