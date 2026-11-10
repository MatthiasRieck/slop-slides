//! Converts a `.pptx` into a new deck. The file is only read: every slide becomes ordinary deck
//! markup (absolutely positioned elements, as the slide stood in PowerPoint) with its images in
//! the deck's `assets/`, and from then on the deck is the document.
//!
//! A slide's look is spread over the slide, its layout, its master and the theme, so each shape
//! is resolved through that chain here. The file is untrusted: text is escaped, links are limited
//! to safe schemes, sizes are capped, and part names never reach the file system.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::xml::{self, Node};
use super::{CANVAS_LONG_SIDE, DEFAULT_SECTION};
use crate::deck;
use crate::error::{Error, Result};
use crate::html;

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
    /// What could not come along, for the user, one short phrase per kind.
    pub skipped: Vec<String>,
}

/// Converts the PowerPoint file at `source` into `<root>/<slug>/deck.html` and opens it.
pub fn import(source: &Path, root: &Path) -> Result<Imported> {
    let bytes = fs::read(source)?;
    let name = source
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let converted = convert(bytes, &name)?;
    let dir = crate::files::unique_dir(root, &html::slugify(&converted.title));
    let written = write_deck(&dir, &converted);
    match written.and_then(|file| deck::open(&file, None, true)) {
        Ok(deck) => Ok(Imported {
            deck,
            skipped: converted.skipped,
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
    pub skipped: Vec<String>,
}

/// The file's parts, read on demand.
struct Package {
    archive: zip::ZipArchive<Cursor<Vec<u8>>>,
    read_so_far: u64,
}

/// A part's relationships: id to target (a part path, or a URL when external).
#[derive(Default, Clone)]
struct Rels(HashMap<String, Rel>);

#[derive(Clone)]
struct Rel {
    kind: String,
    target: String,
    external: bool,
}

impl Rels {
    fn get(&self, id: &str) -> Option<&Rel> {
        self.0.get(id)
    }

    /// The first target whose type ends in `/<kind>`.
    fn of_kind(&self, kind: &str) -> Option<&str> {
        let suffix = format!("/{kind}");
        let mut matches: Vec<&Rel> = self
            .0
            .values()
            .filter(|r| r.kind.ends_with(&suffix))
            .collect();
        matches.sort_by(|a, b| a.target.cmp(&b.target));
        matches.first().map(|r| r.target.as_str())
    }
}

/// `target` of a relationship from the part `from`, as a path in the package.
fn resolve_target(from: &str, target: &str) -> String {
    if let Some(absolute) = target.strip_prefix('/') {
        return absolute.to_string();
    }
    let mut parts: Vec<&str> = from.split('/').collect();
    parts.pop();
    for piece in target.split('/') {
        match piece {
            "." | "" => {}
            ".." => {
                parts.pop();
            }
            piece => parts.push(piece),
        }
    }
    parts.join("/")
}

impl Package {
    fn open(bytes: Vec<u8>) -> Result<Package> {
        let archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| {
            Error::msg(
                "This is not a PowerPoint .pptx file. Older .ppt files must be saved as .pptx first.",
            )
        })?;
        Ok(Package {
            archive,
            read_so_far: 0,
        })
    }

    fn read(&mut self, path: &str) -> Option<Vec<u8>> {
        let entry = self.archive.by_name(path).ok()?;
        let room = MAX_PART.min(MAX_TOTAL.saturating_sub(self.read_so_far));
        let mut bytes = Vec::new();
        entry.take(room + 1).read_to_end(&mut bytes).ok()?;
        if bytes.len() as u64 > room {
            return None;
        }
        self.read_so_far += bytes.len() as u64;
        Some(bytes)
    }

    fn xml(&mut self, path: &str) -> Option<Node> {
        xml::parse(&self.read(path)?)
    }

    fn rels(&mut self, part: &str) -> Rels {
        let (dir, name) = part.rsplit_once('/').unwrap_or(("", part));
        let path = format!("{dir}/_rels/{name}.rels");
        let Some(root) = self.xml(path.trim_start_matches('/')) else {
            return Rels::default();
        };
        Rels(
            root.all("Relationship")
                .filter_map(|r| {
                    let external = r.attr("TargetMode") == Some("External");
                    let target = r.attr("Target")?;
                    let rel = Rel {
                        kind: r.attr("Type").unwrap_or_default().to_string(),
                        target: if external {
                            target.to_string()
                        } else {
                            resolve_target(part, target)
                        },
                        external,
                    };
                    Some((r.attr("Id")?.to_string(), rel))
                })
                .collect(),
        )
    }

    fn part(&mut self, path: &str) -> Option<Part> {
        let root = self.xml(path)?;
        Some(Part {
            path: path.to_string(),
            rels: self.rels(path),
            root,
        })
    }
}

/// An XML part with its relationships.
#[derive(Clone)]
struct Part {
    path: String,
    root: Node,
    rels: Rels,
}

// --- Colours ------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
struct Color {
    r: u8,
    g: u8,
    b: u8,
    /// 0 to 1.
    a: f64,
}

impl Color {
    fn hex(text: &str) -> Option<Color> {
        if text.len() != 6 || !text.is_ascii() {
            return None;
        }
        let byte = |at: usize| u8::from_str_radix(&text[at..at + 2], 16).ok();
        Some(Color {
            r: byte(0)?,
            g: byte(2)?,
            b: byte(4)?,
            a: 1.0,
        })
    }

    fn css(self) -> String {
        if self.a >= 0.999 {
            format!("#{:02x}{:02x}{:02x}", self.r, self.g, self.b)
        } else {
            format!(
                "rgba({}, {}, {}, {})",
                self.r,
                self.g,
                self.b,
                round(self.a, 3)
            )
        }
    }

    fn to_hsl(self) -> (f64, f64, f64) {
        let (r, g, b) = (
            f64::from(self.r) / 255.0,
            f64::from(self.g) / 255.0,
            f64::from(self.b) / 255.0,
        );
        let max = r.max(g).max(b);
        let min = r.min(g).min(b);
        let l = (max + min) / 2.0;
        if max - min < 1e-9 {
            return (0.0, 0.0, l);
        }
        let d = max - min;
        let s = if l > 0.5 {
            d / (2.0 - max - min)
        } else {
            d / (max + min)
        };
        let h = if max == r {
            ((g - b) / d).rem_euclid(6.0)
        } else if max == g {
            (b - r) / d + 2.0
        } else {
            (r - g) / d + 4.0
        };
        (h / 6.0, s, l)
    }

    fn from_hsl(h: f64, s: f64, l: f64, a: f64) -> Color {
        let q = if l < 0.5 {
            l * (1.0 + s)
        } else {
            l + s - l * s
        };
        let p = 2.0 * l - q;
        let channel = |t: f64| {
            let t = t.rem_euclid(1.0);
            let v = if t < 1.0 / 6.0 {
                p + (q - p) * 6.0 * t
            } else if t < 0.5 {
                q
            } else if t < 2.0 / 3.0 {
                p + (q - p) * (2.0 / 3.0 - t) * 6.0
            } else {
                p
            };
            (v.clamp(0.0, 1.0) * 255.0).round() as u8
        };
        Color {
            r: channel(h + 1.0 / 3.0),
            g: channel(h),
            b: channel(h - 1.0 / 3.0),
            a,
        }
    }

    /// Applies the modifiers under a colour element, such as `lumMod` and `alpha`.
    fn modified(mut self, node: &Node) -> Color {
        for m in &node.children {
            let value = m.num("val").unwrap_or(0.0) / 100_000.0;
            match m.name.as_str() {
                "alpha" => self.a = value.clamp(0.0, 1.0),
                "alphaMod" => self.a = (self.a * value).clamp(0.0, 1.0),
                "lumMod" | "lumOff" | "satMod" => {
                    let (h, mut s, mut l) = self.to_hsl();
                    match m.name.as_str() {
                        "lumMod" => l *= value,
                        "lumOff" => l += value,
                        _ => s *= value,
                    }
                    self = Color::from_hsl(h, s.clamp(0.0, 1.0), l.clamp(0.0, 1.0), self.a);
                }
                "tint" | "shade" => {
                    let target = if m.name == "tint" { 255.0 } else { 0.0 };
                    let mix = |c: u8| {
                        (f64::from(c) * value + target * (1.0 - value))
                            .round()
                            .clamp(0.0, 255.0) as u8
                    };
                    self = Color {
                        r: mix(self.r),
                        g: mix(self.g),
                        b: mix(self.b),
                        a: self.a,
                    };
                }
                _ => {}
            }
        }
        self
    }
}

/// The named colours that show up in real files; others read as black.
fn preset_color(name: &str) -> Color {
    let hex = match name {
        "white" => "ffffff",
        "red" => "ff0000",
        "green" => "008000",
        "blue" => "0000ff",
        "yellow" => "ffff00",
        "gray" | "grey" => "808080",
        "orange" => "ffa500",
        _ => "000000",
    };
    Color::hex(hex).unwrap_or(Color {
        r: 0,
        g: 0,
        b: 0,
        a: 1.0,
    })
}

// --- Theme --------------------------------------------------------------------------------

#[derive(Default, Clone)]
struct Theme {
    colors: HashMap<String, Color>,
    major_font: String,
    minor_font: String,
}

impl Theme {
    fn parse(root: Option<&Node>) -> Theme {
        let mut theme = Theme {
            major_font: "Calibri Light".into(),
            minor_font: "Calibri".into(),
            ..Theme::default()
        };
        let Some(root) = root else {
            return theme;
        };
        if let Some(scheme) = root.find("clrScheme") {
            for entry in &scheme.children {
                let Some(value) = entry.children.first() else {
                    continue;
                };
                let hex = value.attr("lastClr").or(value.attr("val")).unwrap_or("");
                if let Some(color) = Color::hex(hex) {
                    theme.colors.insert(entry.name.clone(), color);
                }
            }
        }
        let font = |kind: &str| {
            root.find(kind)
                .and_then(|f| f.at(&["latin"]))
                .and_then(|l| l.attr("typeface"))
                .filter(|f| !f.is_empty())
                .map(str::to_string)
        };
        if let Some(major) = font("majorFont") {
            theme.major_font = major;
        }
        if let Some(minor) = font("minorFont") {
            theme.minor_font = minor;
        }
        theme
    }

    fn font(&self, typeface: &str) -> String {
        match typeface {
            "+mj-lt" | "+mj-ea" | "+mj-cs" => self.major_font.clone(),
            "+mn-lt" | "+mn-ea" | "+mn-cs" => self.minor_font.clone(),
            other => other.to_string(),
        }
    }
}

// --- Inherited text properties ---------------------------------------------------------------

/// Character properties, resolved over the inheritance chain.
#[derive(Default, Clone)]
struct RunStyle {
    /// In points.
    size: Option<f64>,
    bold: Option<bool>,
    italic: Option<bool>,
    underline: Option<bool>,
    strike: Option<bool>,
    caps: Option<bool>,
    /// Letter spacing in points.
    spacing: Option<f64>,
    /// Percent of the size raised (or lowered).
    baseline: Option<f64>,
    color: Option<Color>,
    /// The colour behind the text.
    highlight: Option<Color>,
    font: Option<String>,
}

#[derive(Clone, PartialEq)]
enum Bullet {
    None,
    Char(String),
    Number { css_type: &'static str, start: u32 },
}

/// Paragraph properties, resolved over the inheritance chain.
#[derive(Default, Clone)]
struct ParaStyle {
    align: Option<String>,
    /// In EMU.
    margin_left: Option<f64>,
    indent: Option<f64>,
    bullet: Option<Bullet>,
    /// A multiple of the normal line height, or exact points.
    line_multiple: Option<f64>,
    line_points: Option<f64>,
    before_percent: Option<f64>,
    before_points: Option<f64>,
    after_percent: Option<f64>,
    after_points: Option<f64>,
    run: RunStyle,
}

/// Unicode for bullets drawn from symbol fonts, which the webview does not have.
fn bullet_char(text: &str, font: Option<&str>) -> String {
    let symbol = font.is_some_and(|f| f.contains("Wingdings") || f == "Symbol");
    if !symbol {
        return text.to_string();
    }
    match text {
        "§" => "▪",
        "Ø" => "➢",
        "ü" => "✓",
        "v" => "❖",
        "q" => "❑",
        "n" => "■",
        "l" => "●",
        _ => "•",
    }
    .to_string()
}

fn number_type(kind: &str) -> &'static str {
    if kind.starts_with("alphaLc") {
        "lower-alpha"
    } else if kind.starts_with("alphaUc") {
        "upper-alpha"
    } else if kind.starts_with("romanLc") {
        "lower-roman"
    } else if kind.starts_with("romanUc") {
        "upper-roman"
    } else {
        "decimal"
    }
}

fn apply_run(style: &mut RunStyle, node: &Node, ctx: &Palette) {
    if let Some(size) = node.num("sz") {
        style.size = Some(size / 100.0);
    }
    if let Some(bold) = node.flag("b") {
        style.bold = Some(bold);
    }
    if let Some(italic) = node.flag("i") {
        style.italic = Some(italic);
    }
    if let Some(underline) = node.attr("u") {
        style.underline = Some(underline != "none");
    }
    if let Some(strike) = node.attr("strike") {
        style.strike = Some(strike != "noStrike");
    }
    if let Some(caps) = node.attr("cap") {
        style.caps = Some(caps == "all");
    }
    if let Some(spacing) = node.num("spc") {
        style.spacing = Some(spacing / 100.0);
    }
    if let Some(baseline) = node.num("baseline") {
        style.baseline = Some(baseline / 1000.0);
    }
    if let Some(fill) = node.child("solidFill") {
        if let Some(color) = ctx.color(fill) {
            style.color = Some(color);
        }
    }
    if let Some(color) = node.child("highlight").and_then(|h| ctx.color(h)) {
        style.highlight = Some(color);
    }
    if let Some(fill) = node.child("gradFill") {
        if let Some(color) = fill.find("gs").and_then(|gs| ctx.color(gs)) {
            style.color = Some(color);
        }
    }
    if let Some(face) = node
        .child("latin")
        .and_then(|l| l.attr("typeface"))
        .filter(|f| !f.is_empty())
    {
        style.font = Some(ctx.theme.font(face));
    }
}

fn apply_para(style: &mut ParaStyle, node: &Node, ctx: &Palette) {
    if let Some(align) = node.attr("algn") {
        style.align = Some(align.to_string());
    }
    if let Some(margin) = node.num("marL") {
        style.margin_left = Some(margin);
    }
    if let Some(indent) = node.num("indent") {
        style.indent = Some(indent);
    }
    let spacing = |name: &str| -> (Option<f64>, Option<f64>) {
        let Some(n) = node.child(name) else {
            return (None, None);
        };
        (
            n.child("spcPct")
                .and_then(|p| p.num("val"))
                .map(|v| v / 100_000.0),
            n.child("spcPts")
                .and_then(|p| p.num("val"))
                .map(|v| v / 100.0),
        )
    };
    let (percent, points) = spacing("lnSpc");
    if percent.is_some() || points.is_some() {
        style.line_multiple = percent;
        style.line_points = points;
    }
    let (percent, points) = spacing("spcBef");
    if percent.is_some() || points.is_some() {
        style.before_percent = percent;
        style.before_points = points;
    }
    let (percent, points) = spacing("spcAft");
    if percent.is_some() || points.is_some() {
        style.after_percent = percent;
        style.after_points = points;
    }
    let font = node
        .child("buFont")
        .and_then(|f| f.attr("typeface"))
        .map(str::to_string);
    if node.child("buNone").is_some() {
        style.bullet = Some(Bullet::None);
    } else if let Some(c) = node.child("buChar").and_then(|b| b.attr("char")) {
        style.bullet = Some(Bullet::Char(bullet_char(c, font.as_deref())));
    } else if let Some(number) = node.child("buAutoNum") {
        style.bullet = Some(Bullet::Number {
            css_type: number_type(number.attr("type").unwrap_or("")),
            start: number.num("startAt").unwrap_or(1.0).clamp(1.0, 32767.0) as u32,
        });
    }
    if let Some(def) = node.child("defRPr") {
        apply_run(&mut style.run, def, ctx);
    }
}

/// A shape's place in the master's text styles.
#[derive(Clone, Copy, PartialEq)]
enum TextClass {
    Title,
    Body,
    Other,
}

// --- Slide context ---------------------------------------------------------------------------

/// How the master maps logical colours to the theme.
struct Palette<'a> {
    theme: &'a Theme,
    map: &'a HashMap<String, String>,
}

impl Palette<'_> {
    fn scheme(&self, name: &str) -> Option<Color> {
        let key = self.map.get(name).map_or(name, String::as_str);
        self.theme.colors.get(key).copied()
    }

    /// The colour held by `node`'s first colour child, with its modifiers.
    fn color(&self, node: &Node) -> Option<Color> {
        node.children.iter().find_map(|c| {
            let base = match c.name.as_str() {
                "srgbClr" => Color::hex(c.attr("val")?)?,
                "schemeClr" => self.scheme(c.attr("val")?)?,
                "sysClr" => Color::hex(c.attr("lastClr").unwrap_or("000000"))?,
                "prstClr" => preset_color(c.attr("val")?),
                "scrgbClr" => Color {
                    r: (c.num("r")? / 100_000.0 * 255.0).clamp(0.0, 255.0) as u8,
                    g: (c.num("g")? / 100_000.0 * 255.0).clamp(0.0, 255.0) as u8,
                    b: (c.num("b")? / 100_000.0 * 255.0).clamp(0.0, 255.0) as u8,
                    a: 1.0,
                },
                _ => return None,
            };
            Some(base.modified(c))
        })
    }
}

/// A linear map from a group's child coordinates to slide coordinates, in EMU.
#[derive(Clone, Copy)]
struct Frame {
    sx: f64,
    sy: f64,
    tx: f64,
    ty: f64,
    /// Accumulated group rotation, in degrees.
    rotation: f64,
}

impl Frame {
    const IDENTITY: Frame = Frame {
        sx: 1.0,
        sy: 1.0,
        tx: 0.0,
        ty: 0.0,
        rotation: 0.0,
    };

    fn nested(self, xfrm: &Node) -> Frame {
        let get = |name: &str, a: &str, b: &str| {
            let n = xfrm.child(name)?;
            Some((n.num(a)?, n.num(b)?))
        };
        let (Some(off), Some(ext), Some(ch_off), Some(ch_ext)) = (
            get("off", "x", "y"),
            get("ext", "cx", "cy"),
            get("chOff", "x", "y"),
            get("chExt", "cx", "cy"),
        ) else {
            return self;
        };
        let scale = |outer: f64, inner: f64| {
            if inner.abs() < 1.0 {
                1.0
            } else {
                outer / inner
            }
        };
        let (sx, sy) = (scale(ext.0, ch_ext.0), scale(ext.1, ch_ext.1));
        Frame {
            sx: self.sx * sx,
            sy: self.sy * sy,
            tx: self.tx + self.sx * (off.0 - ch_off.0 * sx),
            ty: self.ty + self.sy * (off.1 - ch_off.1 * sy),
            rotation: self.rotation + xfrm.num("rot").unwrap_or(0.0) / 60_000.0,
        }
    }
}

/// A shape's box in EMU on the slide.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Box2 {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    rotation: f64,
    flip_h: bool,
    flip_v: bool,
}

fn read_box(xfrm: &Node, frame: Frame) -> Option<Box2> {
    let off = xfrm.child("off")?;
    let ext = xfrm.child("ext")?;
    Some(Box2 {
        x: frame.tx + off.num("x")? * frame.sx,
        y: frame.ty + off.num("y")? * frame.sy,
        w: ext.num("cx")? * frame.sx,
        h: ext.num("cy")? * frame.sy,
        rotation: frame.rotation + xfrm.num("rot").unwrap_or(0.0) / 60_000.0,
        flip_h: xfrm.flag("flipH").unwrap_or(false),
        flip_v: xfrm.flag("flipV").unwrap_or(false),
    })
}

/// A fill, ready for CSS or SVG.
#[derive(Clone, Debug, PartialEq)]
enum Fill {
    None,
    Solid(Color),
    Linear {
        /// CSS angle in degrees.
        angle: f64,
        /// Position 0 to 1, and colour.
        stops: Vec<(f64, Color)>,
    },
    Radial {
        stops: Vec<(f64, Color)>,
    },
    Image {
        asset: String,
        alpha: f64,
    },
}

impl Fill {
    fn css(&self) -> Option<String> {
        let stops = |stops: &[(f64, Color)]| {
            stops
                .iter()
                .map(|(at, c)| format!("{} {}%", c.css(), round(at * 100.0, 2)))
                .collect::<Vec<_>>()
                .join(", ")
        };
        match self {
            Fill::None => None,
            Fill::Solid(c) => Some(format!("background-color: {}", c.css())),
            Fill::Linear { angle, stops: s } => Some(format!(
                "background-image: linear-gradient({}deg, {})",
                round(*angle, 2),
                stops(s)
            )),
            Fill::Radial { stops: s } => {
                Some(format!("background-image: radial-gradient({})", stops(s)))
            }
            Fill::Image { asset, .. } => Some(format!(
                "background: url(assets/{asset}) center / cover no-repeat"
            )),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
struct Line {
    color: Color,
    /// In EMU.
    width: f64,
    dash: Option<&'static str>,
    head_arrow: bool,
    tail_arrow: bool,
}

/// The chain a slide inherits from, and everything gathered while converting.
struct Converter {
    package: Package,
    /// Assets written so far, by file name.
    assets: Vec<(String, Vec<u8>)>,
    /// Asset name of each media part already taken.
    media: HashMap<String, String>,
    skipped: Vec<String>,
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
        round(points * 12_700.0 * self.px, 2)
    }

    fn skip(&mut self, what: &str) {
        if !self.skipped.iter().any(|s| s == what) {
            self.skipped.push(what.to_string());
        }
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
                        .filter_map(|gs| Some((gs.num("pos")? / 100_000.0, palette.color(gs)?)))
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
                        / 60_000.0
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
                        .map_or(1.0, |a| a / 100_000.0);
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

    /// Resolves the text style stack for a paragraph at `level` of `shape`.
    #[allow(clippy::too_many_arguments)]
    fn para_style(
        &self,
        chain: &Chain,
        shape: &Node,
        class: TextClass,
        inherited: &[&Node],
        level: usize,
        placeholder: bool,
        reference_color: Option<Color>,
    ) -> ParaStyle {
        let palette = chain.palette();
        let key = level_key(level);
        let mut style = ParaStyle::default();
        let mut merge = |node: Option<&Node>| {
            if let Some(n) = node {
                apply_para(&mut style, n, &palette);
            }
        };
        if !placeholder {
            merge(self.default_text.as_ref().and_then(|d| d.child(&key)));
        }
        // A shape's own theme reference outranks the presentation's defaults.
        if let Some(color) = reference_color {
            style.run.color = Some(color);
        }
        let mut merge = |node: Option<&Node>| {
            if let Some(n) = node {
                apply_para(&mut style, n, &palette);
            }
        };
        if let Some(master) = chain.master {
            let name = match class {
                TextClass::Title => "titleStyle",
                TextClass::Body => "bodyStyle",
                TextClass::Other => "otherStyle",
            };
            if placeholder {
                merge(master.root.at(&["txStyles", name, &key]));
            }
        }
        for node in inherited {
            merge(node.find("lstStyle").and_then(|l| l.child(&key)));
        }
        merge(shape.find("lstStyle").and_then(|l| l.child(&key)));
        style
    }

    fn run_css(&self, style: &RunStyle, scale: f64) -> String {
        let mut css = Vec::new();
        let raised = style.baseline.filter(|b| *b != 0.0);
        // PowerPoint draws raised text smaller, at two thirds of its size.
        let shrink = if raised.is_some() { 2.0 / 3.0 } else { 1.0 };
        if let Some(size) = style.size {
            let px = self.pt(size * scale * shrink);
            css.push(format!("font-size: {px}px"));
        }
        if let Some(bold) = style.bold {
            css.push(format!("font-weight: {}", if bold { 700 } else { 400 }));
        }
        if style.italic == Some(true) {
            css.push("font-style: italic".to_string());
        }
        let mut lines = Vec::new();
        if style.underline == Some(true) {
            lines.push("underline");
        }
        if style.strike == Some(true) {
            lines.push("line-through");
        }
        if !lines.is_empty() {
            css.push(format!("text-decoration-line: {}", lines.join(" ")));
        }
        if style.caps == Some(true) {
            css.push("text-transform: uppercase".to_string());
        }
        if let Some(spacing) = style.spacing.filter(|s| *s != 0.0) {
            css.push(format!("letter-spacing: {}px", self.pt(spacing)));
        }
        if let Some(color) = style.color {
            css.push(format!("color: {}", color.css()));
        }
        if let Some(font) = &style.font {
            css.push(format!("font-family: {}", font_family(font)));
        }
        if let Some(color) = style.highlight {
            css.push(format!("background-color: {}", color.css()));
        }
        // No line height, so that the raised text does not make its line taller.
        if let Some(baseline) = raised {
            css.push(format!(
                "vertical-align: {}em; line-height: 0",
                round(baseline / 100.0 / shrink, 3)
            ));
        }
        css.join("; ")
    }

    /// The runs of a paragraph as HTML, and the style of its first run.
    fn runs_html(
        &self,
        chain: &Chain,
        paragraph: &Node,
        base: &RunStyle,
        scale: f64,
    ) -> (String, RunStyle) {
        let palette = chain.palette();
        let mut out = String::new();
        let mut first: Option<RunStyle> = None;
        for child in &paragraph.children {
            let (text, props) = match child.name.as_str() {
                "r" => (
                    child.child("t").map_or("", |t| t.text.as_str()).to_string(),
                    child.child("rPr"),
                ),
                "fld" => {
                    let number = child.attr("type") == Some("slidenum");
                    let text = if number {
                        chain.number.to_string()
                    } else {
                        child.child("t").map_or("", |t| t.text.as_str()).to_string()
                    };
                    (text, child.child("rPr"))
                }
                "br" => {
                    out.push_str("<br>");
                    continue;
                }
                _ => continue,
            };
            let mut style = base.clone();
            if let Some(props) = props {
                apply_run(&mut style, props, &palette);
            }
            if first.is_none() {
                first = Some(style.clone());
            }
            let css = self.run_css(&style, scale);
            let body = escape(&text);
            let run = if css.is_empty() {
                format!("<span>{body}</span>")
            } else {
                format!("<span style=\"{css}\">{body}</span>")
            };
            match props.and_then(|p| self.link(chain, p)) {
                Some(link) => out.push_str(&format!("<a {link}>{run}</a>")),
                None => out.push_str(&run),
            }
        }
        (out, first.unwrap_or_else(|| base.clone()))
    }

    /// The attributes of a link on a run, when it goes somewhere safe.
    fn link(&self, chain: &Chain, props: &Node) -> Option<String> {
        let click = props.child("hlinkClick")?;
        let rel = chain.slide.rels.get(click.attr("r:id")?)?;
        if rel.external {
            let url = safe_url(&rel.target)?;
            return Some(format!(
                "href=\"{}\" target=\"_blank\" rel=\"noopener\"",
                escape(url)
            ));
        }
        let id = self.slide_ids.get(&rel.target)?;
        Some(format!("href=\"#{}\"", escape(id)))
    }

    /// The paragraphs of a text body as HTML.
    #[allow(clippy::too_many_arguments)]
    fn text_html(
        &self,
        chain: &Chain,
        shape: &Node,
        body: &Node,
        class: TextClass,
        inherited: &[&Node],
        base_run: &RunStyle,
        placeholder: bool,
    ) -> String {
        let palette = chain.palette();
        let fit = body.at(&["bodyPr", "normAutofit"]);
        let font_scale = fit
            .and_then(|f| f.num("fontScale"))
            .map_or(1.0, |s| s / 100_000.0);
        let line_reduction = fit
            .and_then(|f| f.num("lnSpcReduction"))
            .map_or(0.0, |s| s / 100_000.0);
        let mut out = String::new();
        // The list being written: its opening kind and level, to close and continue it.
        let mut open_list: Option<(Bullet, usize, &'static str)> = None;
        let mut counters = [0u32; 9];
        let close = |out: &mut String, open: &mut Option<(Bullet, usize, &'static str)>| {
            if let Some((.., tag)) = open.take() {
                out.push_str(&format!("</{tag}>"));
            }
        };
        for paragraph in body.all("p") {
            let props = paragraph.child("pPr");
            let level = props
                .and_then(|p| p.num("lvl"))
                .unwrap_or(0.0)
                .clamp(0.0, 8.0) as usize;
            let mut style = self.para_style(
                chain,
                shape,
                class,
                inherited,
                level,
                placeholder,
                base_run.color,
            );
            style.run.bold = style.run.bold.or(base_run.bold);
            if let Some(props) = props {
                apply_para(&mut style, props, &palette);
            }
            let (runs, first) = self.runs_html(chain, paragraph, &style.run, font_scale);
            let empty = runs.is_empty();
            let mut css = Vec::new();
            match style.align.as_deref() {
                Some("ctr") => css.push("text-align: center".to_string()),
                Some("r") => css.push("text-align: right".to_string()),
                Some("just") | Some("dist") => css.push("text-align: justify".to_string()),
                _ => {}
            }
            let size = first.size.unwrap_or(18.0) * font_scale;
            if let Some(multiple) = style.line_multiple {
                css.push(format!(
                    "line-height: {}",
                    round((multiple - line_reduction).max(0.5) * 1.2, 3)
                ));
            } else if let Some(points) = style.line_points {
                css.push(format!("line-height: {}px", self.pt(points)));
            }
            let spacing = |percent: Option<f64>, points: Option<f64>| {
                points.or(percent.map(|p| p * size * 1.2)).unwrap_or(0.0)
            };
            let before = spacing(style.before_percent, style.before_points);
            if before > 0.0 {
                css.push(format!("margin-top: {}px", self.pt(before)));
            }
            let after = spacing(style.after_percent, style.after_points);
            if after > 0.0 {
                css.push(format!("margin-bottom: {}px", self.pt(after)));
            }

            // The block is sized like its text, or its strut would make wrapped lines taller.
            let strut = self.run_css(
                &RunStyle {
                    size: first.size,
                    font: first.font.clone(),
                    ..RunStyle::default()
                },
                font_scale,
            );

            let bullet = style
                .bullet
                .clone()
                .filter(|b| *b != Bullet::None && !empty);
            let Some(bullet) = bullet else {
                close(&mut out, &mut open_list);
                let margin = style.margin_left.unwrap_or(0.0);
                if margin > 0.0 {
                    css.push(format!("margin-left: {}px", self.px(margin)));
                }
                let indent = style.indent.unwrap_or(0.0);
                if indent != 0.0 {
                    css.push(format!("text-indent: {}px", self.px(indent)));
                }
                if empty {
                    css.push(format!("font-size: {}px", self.pt(size)));
                } else if !strut.is_empty() {
                    css.push(strut);
                }
                let attr = if css.is_empty() {
                    String::new()
                } else {
                    format!(" style=\"{}\"", css.join("; "))
                };
                let content = if empty { "<br>" } else { runs.as_str() };
                out.push_str(&format!("<p{attr}>{content}</p>"));
                continue;
            };

            let same = open_list
                .as_ref()
                .is_some_and(|(b, l, _)| *b == bullet && *l == level);
            if !same {
                close(&mut out, &mut open_list);
                let (tag, type_css, extra) = match &bullet {
                    Bullet::Char(c) => ("ul", format!("&quot;{} &quot;", escape(c)), String::new()),
                    Bullet::Number { css_type, start } => {
                        // A list continues over deeper items between its own.
                        let number = if counters[level] > 0 {
                            counters[level] + 1
                        } else {
                            *start
                        };
                        (
                            "ol",
                            (*css_type).to_string(),
                            if number > 1 {
                                format!(" start=\"{number}\"")
                            } else {
                                String::new()
                            },
                        )
                    }
                    Bullet::None => unreachable!("filtered out"),
                };
                out.push_str(&format!(
                    "<{tag}{extra} style=\"list-style-type: {type_css}; list-style-position: outside\">"
                ));
                open_list = Some((bullet.clone(), level, tag));
            }
            match bullet {
                Bullet::Number { start, .. } => {
                    counters[level] = if counters[level] > 0 {
                        counters[level] + 1
                    } else {
                        start
                    };
                    counters[level + 1..].iter_mut().for_each(|c| *c = 0);
                }
                _ => counters[level..].iter_mut().for_each(|c| *c = 0),
            }
            css.push(format!(
                "margin-left: {}px",
                self.px(style.margin_left.unwrap_or(0.0))
            ));
            // The marker takes the colour and size of the text.
            let marker = self.run_css(
                &RunStyle {
                    size: first.size,
                    color: first.color,
                    font: first.font.clone(),
                    ..RunStyle::default()
                },
                font_scale,
            );
            if !marker.is_empty() {
                css.push(marker);
            }
            out.push_str(&format!("<li style=\"{}\">{runs}</li>", css.join("; ")));
        }
        close(&mut out, &mut open_list);
        out
    }

    fn line_of(
        &mut self,
        spec: Option<&Node>,
        reference: Option<&Node>,
        palette: &Palette,
    ) -> Option<Line> {
        let from_reference = reference.and_then(|r| {
            let index = r.num("idx")?;
            (index > 0.0).then(|| (palette.color(r), index * 6350.0))
        });
        if spec.is_some_and(|l| l.child("noFill").is_some()) {
            return None;
        }
        let color = spec
            .and_then(|l| l.child("solidFill"))
            .and_then(|f| palette.color(f))
            .or(from_reference.and_then(|r| r.0))?;
        let width = spec
            .and_then(|l| l.num("w"))
            .or(from_reference.map(|r| r.1))
            .unwrap_or(9525.0);
        let dash = spec
            .and_then(|l| l.child("prstDash"))
            .and_then(|d| d.attr("val"))
            .and_then(|kind| match kind {
                "solid" => None,
                "dot" | "sysDot" => Some("dotted"),
                _ => Some("dashed"),
            });
        let arrow = |name: &str| {
            spec.and_then(|l| l.child(name))
                .and_then(|e| e.attr("type"))
                .is_some_and(|t| t != "none")
        };
        Some(Line {
            color,
            width,
            dash,
            head_arrow: arrow("headEnd"),
            tail_arrow: arrow("tailEnd"),
        })
    }

    fn box_css(&self, b: Box2) -> String {
        let mut css = format!(
            "left: {}px; top: {}px; width: {}px; height: {}px",
            self.px(b.x),
            self.px(b.y),
            self.px(b.w),
            self.px(b.h)
        );
        let mut transforms = Vec::new();
        if b.rotation.rem_euclid(360.0) > 0.01 {
            transforms.push(format!("rotate({}deg)", round(b.rotation, 2)));
        }
        if b.flip_h {
            transforms.push("scaleX(-1)".to_string());
        }
        if b.flip_v {
            transforms.push("scaleY(-1)".to_string());
        }
        if !transforms.is_empty() {
            css.push_str(&format!("; transform: {}", transforms.join(" ")));
        }
        css
    }

    /// An `<svg>` drawing `d` over the box, in a viewBox of the box's size in pixels.
    fn svg_shape(
        &self,
        b: Box2,
        d: &str,
        fill: &Fill,
        line: Option<&Line>,
        gradient_id: &str,
    ) -> String {
        let (defs, paint) = match fill {
            Fill::Solid(c) => (String::new(), c.css()),
            Fill::Linear { angle, stops } => {
                let radians = (angle - 90.0).to_radians();
                let (dx, dy) = (radians.cos() / 2.0, radians.sin() / 2.0);
                let stops: String = stops
                    .iter()
                    .map(|(at, c)| {
                        format!(
                            "<stop offset=\"{}\" stop-color=\"{}\"/>",
                            round(*at, 4),
                            c.css()
                        )
                    })
                    .collect();
                (
                    format!(
                        "<defs><linearGradient id=\"{gradient_id}\" x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\">{stops}</linearGradient></defs>",
                        round(0.5 - dx, 4),
                        round(0.5 - dy, 4),
                        round(0.5 + dx, 4),
                        round(0.5 + dy, 4)
                    ),
                    format!("url(#{gradient_id})"),
                )
            }
            Fill::Radial { stops } => (
                String::new(),
                stops.first().map_or("none".to_string(), |(_, c)| c.css()),
            ),
            _ => (String::new(), "none".to_string()),
        };
        let stroke = line.map_or(String::new(), |l| {
            let dash = match l.dash {
                Some("dotted") => " stroke-dasharray=\"2 4\" stroke-linecap=\"round\"",
                Some(_) => " stroke-dasharray=\"10 6\"",
                None => "",
            };
            format!(
                " stroke=\"{}\" stroke-width=\"{}\"{dash} vector-effect=\"non-scaling-stroke\"",
                l.color.css(),
                self.px(l.width).max(0.5)
            )
        });
        let (w, h) = (self.px(b.w).max(0.01), self.px(b.h).max(0.01));
        format!(
            "<svg class=\"ppt-el\" style=\"{}; overflow: visible\" viewBox=\"0 0 {w} {h}\" preserveAspectRatio=\"none\" aria-hidden=\"true\">{defs}<path d=\"{d}\" fill=\"{paint}\"{stroke}/></svg>\n",
            self.box_css(b)
        )
    }

    /// The path of a custom geometry, in a space of the box's size in pixels.
    fn custom_path(&self, geometry: &Node, b: Box2) -> Option<String> {
        let mut d = String::new();
        let list = geometry.child("pathLst")?;
        for path in list.all("path") {
            let (pw, ph) = (path.num("w").unwrap_or(0.0), path.num("h").unwrap_or(0.0));
            let (sx, sy) = (
                if pw > 0.0 { b.w / pw } else { 1.0 } * self.px,
                if ph > 0.0 { b.h / ph } else { 1.0 } * self.px,
            );
            let point = |pt: &Node| {
                Some(format!(
                    "{} {}",
                    round(pt.num("x")? * sx, 2),
                    round(pt.num("y")? * sy, 2)
                ))
            };
            for step in &path.children {
                let points: Vec<String> = step.all("pt").filter_map(point).collect();
                match (step.name.as_str(), points.len()) {
                    ("moveTo", 1) => d.push_str(&format!("M{} ", points[0])),
                    ("lnTo", 1) => d.push_str(&format!("L{} ", points[0])),
                    ("quadBezTo", 2) => d.push_str(&format!("Q{} {} ", points[0], points[1])),
                    ("cubicBezTo", 3) => {
                        d.push_str(&format!("C{} {} {} ", points[0], points[1], points[2]))
                    }
                    ("close", _) => d.push_str("Z "),
                    _ => {}
                }
            }
        }
        (!d.is_empty()).then(|| d.trim_end().to_string())
    }

    /// A shape's HTML: its geometry and fill, then its text on top.
    fn shape_html(
        &mut self,
        chain: &Chain,
        part: &Part,
        shape: &Node,
        frame: Frame,
        out: &mut String,
        on_slide: bool,
    ) {
        let ph = placeholder_of(shape);
        if ph.is_some() && !on_slide {
            return; // Prompts of layouts and masters are not content.
        }
        let palette = chain.palette();
        let layout_shape = ph.and_then(|p| chain.layout.and_then(|l| matching_placeholder(l, p)));
        let master_shape = ph.and_then(|p| chain.master.and_then(|m| matching_placeholder(m, p)));
        let inherited: Vec<&Node> = [master_shape, layout_shape].into_iter().flatten().collect();

        let Some(props) = shape.child("spPr") else {
            return;
        };
        let bx = [Some(shape), layout_shape, master_shape]
            .into_iter()
            .flatten()
            .find_map(|s| s.at(&["spPr", "xfrm"]).and_then(|x| read_box(x, frame)));

        let style_node = shape.child("style");
        let reference_fill = style_node
            .and_then(|s| s.child("fillRef"))
            .filter(|r| r.num("idx").unwrap_or(0.0) > 0.0)
            .and_then(|r| palette.color(r))
            .map(Fill::Solid);
        let fill = self
            .fill_of(props, part, &palette)
            .or(reference_fill)
            .unwrap_or(Fill::None);
        let line = self.line_of(
            props.child("ln"),
            style_node.and_then(|s| s.child("lnRef")),
            &palette,
        );

        let body = shape.child("txBody");
        let has_text = body.is_some_and(|b| {
            let mut runs = Vec::new();
            b.find_all("t", &mut runs);
            runs.iter().any(|t| !t.text.trim().is_empty())
        });
        if ph.is_some() && !has_text && fill == Fill::None && line.is_none() {
            return; // An empty placeholder shows nothing on a slide.
        }
        let Some(bx) = bx else {
            return;
        };

        let geometry = props.child("prstGeom").and_then(|g| g.attr("prst"));
        let custom = props.child("custGeom");
        self.gradients += 1;
        let gradient_id = format!("ppt-gradient-{}", self.gradients);
        let has_paint = fill != Fill::None || line.is_some();
        let mut css_extra = String::new();
        let mut has_css_border = false;
        if has_paint {
            let svg_path = match (geometry, custom) {
                (_, Some(c)) => self.custom_path(c, bx),
                (Some(kind), _) => preset_path(kind, self.px(bx.w), self.px(bx.h), props),
                _ => None,
            };
            let unknown = custom.is_none()
                && svg_path.is_none()
                && !matches!(
                    geometry,
                    Some("rect") | Some("roundRect") | Some("ellipse") | None
                );
            if unknown {
                self.skip("some shapes' exact outlines (drawn as rectangles)");
            }
            if let Some(d) = svg_path {
                out.push_str(&self.svg_shape(bx, &d, &fill, line.as_ref(), &gradient_id));
                let arrows = line
                    .as_ref()
                    .filter(|l| l.head_arrow || l.tail_arrow)
                    .map(|l| self.arrow_heads(bx, l));
                if let Some(arrows) = arrows {
                    out.push_str(&arrows);
                }
            } else {
                if let Some(fill_css) = fill.css() {
                    css_extra.push_str(&format!("; {fill_css}"));
                }
                if let Fill::Image { alpha, .. } = &fill {
                    if *alpha < 0.999 {
                        css_extra.push_str(&format!("; opacity: {}", round(*alpha, 3)));
                    }
                }
                if let Some(l) = &line {
                    has_css_border = true;
                    css_extra.push_str(&format!(
                        "; border: {}px {} {}",
                        self.px(l.width).max(1.0),
                        l.dash.unwrap_or("solid"),
                        l.color.css()
                    ));
                }
                match geometry {
                    Some("ellipse") => css_extra.push_str("; border-radius: 50%"),
                    Some("roundRect") => {
                        let adjust = props
                            .find("gd")
                            .and_then(|g| g.attr("fmla"))
                            .and_then(|f| f.strip_prefix("val "))
                            .and_then(|v| v.parse::<f64>().ok())
                            .unwrap_or(16667.0);
                        let radius = bx.w.abs().min(bx.h.abs()) * adjust / 100_000.0;
                        css_extra.push_str(&format!("; border-radius: {}px", self.px(radius)));
                    }
                    _ => {}
                }
            }
        }

        let kind = ph.and_then(|p| p.attr("type")).unwrap_or("body");
        let class = if ph.is_some() {
            placeholder_class(kind)
        } else {
            TextClass::Other
        };
        let mut text_html = String::new();
        let mut text_css = String::new();
        if let (true, Some(body)) = (has_text, body) {
            let base_run = RunStyle {
                color: style_node
                    .and_then(|s| s.child("fontRef"))
                    .and_then(|f| palette.color(f)),
                ..RunStyle::default()
            };
            text_html = self.text_html(
                chain,
                shape,
                body,
                class,
                &inherited,
                &base_run,
                ph.is_some(),
            );
            let body_props = [Some(shape), layout_shape, master_shape]
                .into_iter()
                .flatten()
                .filter_map(|s| s.at(&["txBody", "bodyPr"]))
                .collect::<Vec<_>>();
            let body_attr = |name: &str| body_props.iter().find_map(|b| b.num(name));
            let inset = |name: &str, default: f64| self.px(body_attr(name).unwrap_or(default));
            text_css = format!(
                "padding: {}px {}px {}px {}px",
                inset("tIns", 45720.0),
                inset("rIns", 91440.0),
                inset("bIns", 45720.0),
                inset("lIns", 91440.0)
            );
            match body_props.iter().find_map(|b| b.attr("anchor")) {
                Some("ctr") => text_css.push_str("; justify-content: center"),
                Some("b") => text_css.push_str("; justify-content: flex-end"),
                _ => {}
            }
            if body_props.iter().find_map(|b| b.attr("wrap")) == Some("none") {
                text_css.push_str("; white-space: pre");
            }
            if body_props.iter().find_map(|b| b.attr("vert")) == Some("vert") {
                text_css.push_str("; writing-mode: vertical-rl");
            }
        }

        // Boxes the CSS draws carry their text; shapes drawn as SVG have it as a sibling.
        let text_only = Box2 {
            flip_h: false,
            flip_v: false,
            ..bx
        };
        if !css_extra.is_empty() || !text_html.is_empty() {
            let class_list = if text_html.is_empty() {
                "ppt-el"
            } else {
                "ppt-el ppt-text"
            };
            // PowerPoint centres an outline on the shape's edge; CSS draws it inside the box.
            let outset = |b: Box2| match line
                .as_ref()
                .filter(|_| !css_extra.is_empty() && has_css_border)
            {
                Some(l) => Box2 {
                    x: b.x - l.width / 2.0,
                    y: b.y - l.width / 2.0,
                    w: b.w + l.width,
                    h: b.h + l.width,
                    ..b
                },
                None => b,
            };
            let mut css = self.box_css(outset(if text_html.is_empty() { bx } else { text_only }));
            css.push_str(&css_extra);
            if !text_css.is_empty() {
                css.push_str("; ");
                css.push_str(&text_css);
            }
            out.push_str(&format!(
                "<div class=\"{class_list}\" style=\"{css}\">{text_html}</div>\n"
            ));
        }
    }

    /// Solid triangles at a line's ends, drawn over it.
    fn arrow_heads(&self, b: Box2, line: &Line) -> String {
        let (w, h) = (self.px(b.w), self.px(b.h));
        let (x0, x1) = if b.flip_h { (w, 0.0) } else { (0.0, w) };
        let (y0, y1) = if b.flip_v { (h, 0.0) } else { (0.0, h) };
        let size = (self.px(line.width) * 4.0).max(10.0);
        let head = |tip: (f64, f64), from: (f64, f64)| {
            let angle = (tip.1 - from.1).atan2(tip.0 - from.0);
            let corner = |offset: f64| {
                let a = angle + std::f64::consts::PI + offset;
                format!(
                    "{},{}",
                    round(tip.0 + size * a.cos(), 2),
                    round(tip.1 + size * a.sin(), 2)
                )
            };
            format!(
                "<polygon points=\"{},{} {} {}\" fill=\"{}\"/>",
                round(tip.0, 2),
                round(tip.1, 2),
                corner(0.45),
                corner(-0.45),
                line.color.css()
            )
        };
        let mut shapes = String::new();
        if line.tail_arrow {
            shapes.push_str(&head((x1, y1), (x0, y0)));
        }
        if line.head_arrow {
            shapes.push_str(&head((x0, y0), (x1, y1)));
        }
        let plain = Box2 {
            rotation: b.rotation,
            flip_h: false,
            flip_v: false,
            ..b
        };
        format!(
            "<svg class=\"ppt-el\" style=\"{}; overflow: visible\" viewBox=\"0 0 {} {}\" aria-hidden=\"true\">{shapes}</svg>\n",
            self.box_css(plain),
            w.max(0.01),
            h.max(0.01)
        )
    }

    fn picture_html(
        &mut self,
        chain: &Chain,
        part: &Part,
        pic: &Node,
        frame: Frame,
        out: &mut String,
    ) {
        let ph = placeholder_of(pic);
        let layout_shape = ph.and_then(|p| chain.layout.and_then(|l| matching_placeholder(l, p)));
        let bx = [Some(pic), layout_shape]
            .into_iter()
            .flatten()
            .find_map(|s| s.at(&["spPr", "xfrm"]).and_then(|x| read_box(x, frame)));
        let (Some(bx), Some(fill)) = (bx, pic.child("blipFill")) else {
            return;
        };
        let Some(blip) = fill.child("blip") else {
            return;
        };
        let Some(asset) = self.blip_asset(blip, part) else {
            return;
        };
        if pic.find("videoFile").is_some() || pic.find("audioFile").is_some() {
            self.skip("audio and video (their poster images came along)");
        }
        let alt = pic
            .find("cNvPr")
            .and_then(|c| c.attr("descr"))
            .map(escape)
            .unwrap_or_default();
        let mut extra = String::new();
        if let Some(amount) = blip.child("alphaModFix").and_then(|a| a.num("amt")) {
            extra.push_str(&format!("; opacity: {}", round(amount / 100_000.0, 3)));
        }
        match pic.at(&["spPr", "prstGeom"]).and_then(|g| g.attr("prst")) {
            Some("ellipse") => extra.push_str("; border-radius: 50%"),
            Some("roundRect") => {
                let share = adjust(pic.child("spPr").unwrap_or(pic), "adj", 0.16667);
                let radius = bx.w.abs().min(bx.h.abs()) * share;
                extra.push_str(&format!("; border-radius: {}px", self.px(radius)));
            }
            _ => {}
        }
        let extra_css = Some(extra);
        let outline = {
            let palette = chain.palette();
            self.line_of(pic.at(&["spPr", "ln"]), None, &palette)
        };
        let mut bx = bx;
        if let Some(line) = &outline {
            // On the edge in PowerPoint; inside the box in CSS.
            bx = Box2 {
                x: bx.x - line.width / 2.0,
                y: bx.y - line.width / 2.0,
                w: bx.w + line.width,
                h: bx.h + line.width,
                ..bx
            };
        }
        let mut css = self.box_css(bx);
        if let Some(rest) = extra_css.as_deref() {
            css.push_str(rest);
        }
        if let Some(line) = &outline {
            css.push_str(&format!(
                "; border: {}px {} {}; box-sizing: border-box",
                self.px(line.width).max(1.0),
                line.dash.unwrap_or("solid"),
                line.color.css()
            ));
        }
        let crop = |name: &str| {
            fill.child("srcRect")
                .and_then(|c| c.num(name))
                .map_or(0.0, |v| v / 100_000.0)
        };
        let (l, t, r, b) = (crop("l"), crop("t"), crop("r"), crop("b"));
        if (l, t, r, b) == (0.0, 0.0, 0.0, 0.0) || l + r >= 1.0 || t + b >= 1.0 {
            out.push_str(&format!(
                "<img class=\"ppt-el\" src=\"assets/{asset}\" alt=\"{alt}\" style=\"{css}\">\n"
            ));
            return;
        }
        let (w, h) = (1.0 / (1.0 - l - r), 1.0 / (1.0 - t - b));
        out.push_str(&format!(
            "<div class=\"ppt-el ppt-crop\" style=\"{css}\"><img src=\"assets/{asset}\" alt=\"{alt}\" style=\"width: {}%; height: {}%; left: {}%; top: {}%\"></div>\n",
            round(w * 100.0, 3),
            round(h * 100.0, 3),
            round(-l * w * 100.0, 3),
            round(-t * h * 100.0, 3),
        ));
    }

    /// A table's cell border, from `a:lnL` and friends.
    fn cell_border(
        &mut self,
        cell: &Node,
        name: &str,
        side: &str,
        palette: &Palette,
    ) -> Option<String> {
        let line = self.line_of(cell.child(name), None, palette)?;
        Some(format!(
            "border-{side}: {}px {} {}",
            self.px(line.width).max(1.0),
            line.dash.unwrap_or("solid"),
            line.color.css()
        ))
    }

    fn table_html(&mut self, chain: &Chain, part: &Part, table: &Node, bx: Box2, out: &mut String) {
        let palette = chain.palette();
        let table_props = table.child("tblPr");
        let styled = table_props.is_some_and(|p| p.child("tableStyleId").is_some());
        if styled {
            self.skip("table styles (tables came along plain)");
        }
        let first_row_bold = table_props.and_then(|p| p.flag("firstRow")) == Some(true);
        let columns: Vec<f64> = table
            .at(&["tblGrid"])
            .map(|g| g.all("gridCol").filter_map(|c| c.num("w")).collect())
            .unwrap_or_default();
        let mut html = format!(
            "<table class=\"ppt-el ppt-table\" style=\"left: {}px; top: {}px; width: {}px\">\n<colgroup>",
            self.px(bx.x),
            self.px(bx.y),
            self.px(bx.w)
        );
        for width in &columns {
            html.push_str(&format!("<col style=\"width: {}px\">", self.px(*width)));
        }
        html.push_str("</colgroup>\n");
        for (row_index, row) in table.all("tr").enumerate() {
            let cell_run = RunStyle {
                bold: (row_index == 0 && first_row_bold).then_some(true),
                ..RunStyle::default()
            };
            html.push_str(&format!(
                "<tr style=\"height: {}px\">",
                self.px(row.num("h").unwrap_or(0.0))
            ));
            for cell in row.all("tc") {
                if cell.flag("hMerge") == Some(true) || cell.flag("vMerge") == Some(true) {
                    continue;
                }
                let props = cell.child("tcPr");
                let mut css = vec![format!(
                    "padding: {}px {}px {}px {}px",
                    self.px(props.and_then(|p| p.num("marT")).unwrap_or(45720.0)),
                    self.px(props.and_then(|p| p.num("marR")).unwrap_or(91440.0)),
                    self.px(props.and_then(|p| p.num("marB")).unwrap_or(45720.0)),
                    self.px(props.and_then(|p| p.num("marL")).unwrap_or(91440.0)),
                )];
                if let Some(props) = props {
                    if let Some(fill_css) =
                        self.fill_of(props, part, &palette).and_then(|f| f.css())
                    {
                        css.push(fill_css);
                    }
                    for (name, side) in [
                        ("lnL", "left"),
                        ("lnR", "right"),
                        ("lnT", "top"),
                        ("lnB", "bottom"),
                    ] {
                        css.extend(self.cell_border(props, name, side, &palette));
                    }
                    match props.attr("anchor") {
                        Some("ctr") => css.push("vertical-align: middle".to_string()),
                        Some("b") => css.push("vertical-align: bottom".to_string()),
                        _ => {}
                    }
                }
                let bordered = css.iter().any(|c| c.starts_with("border-"));
                if styled && !bordered {
                    // The look lived in the style; a hairline keeps the grid readable.
                    css.push("border: 1px solid rgba(128, 128, 128, 0.6)".to_string());
                }
                let mut spans = String::new();
                for (attr, html_attr) in [("gridSpan", "colspan"), ("rowSpan", "rowspan")] {
                    if let Some(span) = cell.num(attr).filter(|s| *s > 1.0) {
                        spans.push_str(&format!(" {html_attr}=\"{}\"", span.min(1000.0) as u32));
                    }
                }
                let text = cell.child("txBody").map_or(String::new(), |body| {
                    self.text_html(chain, cell, body, TextClass::Other, &[], &cell_run, false)
                });
                html.push_str(&format!(
                    "<td{spans} style=\"{}\">{text}</td>",
                    css.join("; ")
                ));
            }
            html.push_str("</tr>\n");
        }
        html.push_str("</table>\n");
        out.push_str(&html);
    }

    /// A chart's cached numbers, as a table: the data comes along, ready to be redrawn.
    fn chart_html(&mut self, part: &Part, id: &str, bx: Box2, out: &mut String) {
        self.skip("charts (their data came along as tables)");
        let Some(target) = part.rels.get(id).map(|r| r.target.clone()) else {
            return;
        };
        let Some(chart) = self.package.xml(&target) else {
            return;
        };
        let cached = |node: Option<&Node>| -> Vec<String> {
            let mut points = Vec::new();
            if let Some(node) = node {
                node.find_all("pt", &mut points);
            }
            let mut indexed: Vec<(usize, String)> = points
                .iter()
                .filter_map(|p| {
                    Some((
                        p.num("idx")? as usize,
                        p.child("v").map(|v| v.text.clone()).unwrap_or_default(),
                    ))
                })
                .collect();
            indexed.sort_by_key(|p| p.0);
            indexed.into_iter().map(|p| p.1).collect()
        };
        let mut series = Vec::new();
        chart.find_all("ser", &mut series);
        if series.is_empty() {
            return;
        }
        let categories = series
            .first()
            .map_or(Vec::new(), |s| cached(s.child("cat")));
        let columns: Vec<(String, Vec<String>)> = series
            .iter()
            .map(|s| {
                let name = cached(s.child("tx")).into_iter().next().unwrap_or_default();
                let values = cached(s.child("val").or(s.child("yVal")));
                (name, values)
            })
            .collect();
        let rows = columns.iter().map(|c| c.1.len()).max().unwrap_or(0);
        let size = self.pt(14.0);
        let mut html = format!(
            "<table class=\"ppt-el ppt-table\" style=\"left: {}px; top: {}px; width: {}px; font-size: {size}px\">\n<tr><td></td>",
            self.px(bx.x),
            self.px(bx.y),
            self.px(bx.w),
        );
        for (name, _) in &columns {
            html.push_str(&format!("<td>{}</td>", escape(name)));
        }
        html.push_str("</tr>\n");
        for row in 0..rows {
            let label = categories.get(row).map_or("", String::as_str);
            html.push_str(&format!("<tr><td>{}</td>", escape(label)));
            for (_, values) in &columns {
                let value = values.get(row).map_or("", String::as_str);
                html.push_str(&format!("<td>{}</td>", escape(value)));
            }
            html.push_str("</tr>\n");
        }
        html.push_str("</table>\n");
        out.push_str(&html);
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

// --- Preset shapes ------------------------------------------------------------------------

/// The value of the adjust handle `name` in `props`, as a fraction, or `default`.
fn adjust(props: &Node, name: &str, default: f64) -> f64 {
    props
        .at(&["prstGeom", "avLst"])
        .into_iter()
        .flat_map(|list| list.all("gd"))
        .find(|g| g.attr("name") == Some(name))
        .and_then(|g| g.attr("fmla"))
        .and_then(|f| f.strip_prefix("val "))
        .and_then(|v| v.parse::<f64>().ok())
        .map_or(default, |v| v / 100_000.0)
}

fn polygon(points: &[(f64, f64)]) -> String {
    let mut d = String::new();
    for (i, (x, y)) in points.iter().enumerate() {
        d.push_str(&format!(
            "{}{} {} ",
            if i == 0 { 'M' } else { 'L' },
            round(*x, 2),
            round(*y, 2)
        ));
    }
    d.push('Z');
    d
}

/// The outline of a preset shape in a `w` × `h` box; `None` for those CSS draws (or none known).
fn preset_path(kind: &str, w: f64, h: f64, props: &Node) -> Option<String> {
    let side = w.min(h);
    Some(match kind {
        "line" | "straightConnector1" | "bentConnector2" | "bentConnector3"
        | "curvedConnector3" => {
            format!("M0 0 L{w} {h}")
        }
        "triangle" | "flowChartExtract" => {
            let tip = adjust(props, "adj", 0.5) * w;
            polygon(&[(tip, 0.0), (w, h), (0.0, h)])
        }
        "rtTriangle" => polygon(&[(0.0, 0.0), (w, h), (0.0, h)]),
        "diamond" | "flowChartDecision" => {
            polygon(&[(w / 2.0, 0.0), (w, h / 2.0), (w / 2.0, h), (0.0, h / 2.0)])
        }
        "parallelogram" | "flowChartInputOutput" => {
            let x = adjust(props, "adj", 0.25) * side;
            polygon(&[(x, 0.0), (w, 0.0), (w - x, h), (0.0, h)])
        }
        "trapezoid" => {
            let x = adjust(props, "adj", 0.25) * side;
            polygon(&[(x, 0.0), (w - x, 0.0), (w, h), (0.0, h)])
        }
        "pentagon" => polygon(&[
            (w / 2.0, 0.0),
            (w, h * 0.382),
            (w * 0.809, h),
            (w * 0.191, h),
            (0.0, h * 0.382),
        ]),
        "homePlate" => {
            let x = w - adjust(props, "adj", 0.5) * side;
            polygon(&[(0.0, 0.0), (x, 0.0), (w, h / 2.0), (x, h), (0.0, h)])
        }
        "chevron" => {
            let x = adjust(props, "adj", 0.5) * side;
            polygon(&[
                (0.0, 0.0),
                (w - x, 0.0),
                (w, h / 2.0),
                (w - x, h),
                (0.0, h),
                (x, h / 2.0),
            ])
        }
        "hexagon" => {
            let x = adjust(props, "adj", 0.25) * side;
            polygon(&[
                (x, 0.0),
                (w - x, 0.0),
                (w, h / 2.0),
                (w - x, h),
                (x, h),
                (0.0, h / 2.0),
            ])
        }
        "octagon" => {
            let x = adjust(props, "adj", 0.29289) * side;
            polygon(&[
                (x, 0.0),
                (w - x, 0.0),
                (w, x),
                (w, h - x),
                (w - x, h),
                (x, h),
                (0.0, h - x),
                (0.0, x),
            ])
        }
        "plus" | "mathPlus" | "flowChartSummingJunction" => {
            let x = adjust(props, "adj", 0.25) * side;
            polygon(&[
                (x, 0.0),
                (w - x, 0.0),
                (w - x, x),
                (w, x),
                (w, h - x),
                (w - x, h - x),
                (w - x, h),
                (x, h),
                (x, h - x),
                (0.0, h - x),
                (0.0, x),
                (x, x),
            ])
        }
        "rightArrow" | "leftArrow" => {
            let body = adjust(props, "adj1", 0.5) * h;
            let head = adjust(props, "adj2", 0.5) * side;
            let top = (h - body) / 2.0;
            let shape = [
                (0.0, top),
                (w - head, top),
                (w - head, 0.0),
                (w, h / 2.0),
                (w - head, h),
                (w - head, h - top),
                (0.0, h - top),
            ];
            if kind == "rightArrow" {
                polygon(&shape)
            } else {
                polygon(&shape.map(|(x, y)| (w - x, y)))
            }
        }
        "upArrow" | "downArrow" => {
            let body = adjust(props, "adj1", 0.5) * w;
            let head = adjust(props, "adj2", 0.5) * side;
            let left = (w - body) / 2.0;
            let shape = [
                (left, h),
                (left, head),
                (0.0, head),
                (w / 2.0, 0.0),
                (w, head),
                (w - left, head),
                (w - left, h),
            ];
            if kind == "upArrow" {
                polygon(&shape)
            } else {
                polygon(&shape.map(|(x, y)| (x, h - y)))
            }
        }
        "star5" => {
            let mut points = Vec::with_capacity(10);
            for i in 0..10 {
                let radius = if i % 2 == 0 { 0.5 } else { 0.19 };
                let angle = (f64::from(i) * 36.0 - 90.0).to_radians();
                points.push((
                    w / 2.0 + w * radius * angle.cos(),
                    h / 2.0 + h * radius * angle.sin(),
                ));
            }
            polygon(&points)
        }
        _ => return None,
    })
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

/// Reads the whole presentation and writes it as deck HTML. `fallback` titles a file with none.
pub(super) fn convert(bytes: Vec<u8>, fallback: &str) -> Result<Converted> {
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

    let theme = first_theme.unwrap_or_else(|| Theme::parse(None));
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
        major = font_family(&theme.major_font).replace("&quot;", "\""),
        minor = font_family(&theme.minor_font).replace("&quot;", "\""),
        css = SHELL_CSS,
    );
    Ok(Converted {
        title,
        html,
        assets: converter.assets,
        skipped: converter.skipped,
    })
}
