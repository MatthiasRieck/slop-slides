//! The presentation's XML: each slide's items as DrawingML shapes, freeforms, text and pictures,
//! and the package of parts around them.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::io::{Cursor, Write as _};

use zip::write::SimpleFileOptions;

use super::super::{DEGREE, EMU_PER_CSS_PX, EMU_PER_INCH, EMU_PER_POINT, WHOLE, WIDESCREEN_EMU};
use super::scene::*;
use crate::error::{Error, Result};

/// PowerPoint's smallest slide side, in EMU.
const MIN_SLIDE_EMU: f64 = EMU_PER_INCH;

const NS_A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_P: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_RELS: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML_HEADER: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";

/// EMU per canvas pixel: a 1920 px canvas fills a widescreen slide; smaller canvases keep their
/// real size, at 96 pixels per inch.
fn emu_per_px(canvas: (u32, u32)) -> f64 {
    EMU_PER_CSS_PX.min(WIDESCREEN_EMU / f64::from(canvas.0.max(canvas.1)))
}

/// Text for XML content and attributes; what XML cannot hold is dropped.
fn esc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\t' | '\n' | '\r' => out.push(c),
            c if u32::from(c) < 0x20 || c == '\u{fffe}' || c == '\u{ffff}' => {}
            c => out.push(c),
        }
    }
    out
}

fn hex(color: Rgba) -> String {
    let channel = |v: f64| v.round().clamp(0.0, 255.0) as u8;
    format!(
        "{:02X}{:02X}{:02X}",
        channel(color[0]),
        channel(color[1]),
        channel(color[2])
    )
}

/// `<a:srgbClr>` of `color` with `opacity` on top of its own alpha.
fn color_xml(color: Rgba, opacity: f64) -> String {
    let alpha = (color[3] * opacity).clamp(0.0, 1.0);
    if alpha >= 0.999 {
        format!("<a:srgbClr val=\"{}\"/>", hex(color))
    } else {
        format!(
            "<a:srgbClr val=\"{}\"><a:alpha val=\"{}\"/></a:srgbClr>",
            hex(color),
            (alpha * WHOLE).round() as i64
        )
    }
}

fn solid_xml(color: Rgba, opacity: f64) -> String {
    format!("<a:solidFill>{}</a:solidFill>", color_xml(color, opacity))
}

fn gradient_xml(gradient: &Gradient, opacity: f64) -> String {
    let mut stops = String::new();
    for stop in &gradient.stops {
        let _ = write!(
            stops,
            "<a:gs pos=\"{}\">{}</a:gs>",
            (stop.at.clamp(0.0, 1.0) * WHOLE).round() as i64,
            color_xml(stop.color, opacity)
        );
    }
    // CSS angles run clockwise from the top; OOXML's from the x axis.
    let angle = (gradient.angle - 90.0).rem_euclid(360.0);
    format!(
        "<a:gradFill rotWithShape=\"1\"><a:gsLst>{stops}</a:gsLst><a:lin ang=\"{}\" scaled=\"0\"/></a:gradFill>",
        (angle * DEGREE).round() as i64
    )
}

/// An outline as the page helper writes it (`PathItem::d`): each segment's letter and its
/// numbers. `None` unless it is whole: a start, then lines, curves and closes.
fn path_segments(d: &str) -> Option<Vec<(char, Vec<f64>)>> {
    let mut segments: Vec<(char, Vec<f64>)> = Vec::new();
    for token in d.split_whitespace() {
        match token {
            "M" | "L" | "C" | "Z" => segments.push((token.chars().next()?, Vec::new())),
            number => {
                let value: f64 = number.parse().ok().filter(|v: &f64| v.is_finite())?;
                segments.last_mut()?.1.push(value);
            }
        }
    }
    let whole = segments.iter().all(|(kind, numbers)| {
        numbers.len()
            == match kind {
                'C' => 6,
                'Z' => 0,
                _ => 2,
            }
    });
    (whole && segments.len() > 1 && segments[0].0 == 'M').then_some(segments)
}

/// A slide's relationships as they are collected, with `rId1` its layout.
struct Rels {
    entries: Vec<String>,
}

impl Rels {
    fn new() -> Rels {
        Rels {
            entries: Vec::new(),
        }
    }

    fn add(&mut self, kind: &str, target: &str, external: bool) -> String {
        let id = format!("rId{}", self.entries.len() + 1);
        self.entries.push(format!(
            "<Relationship Id=\"{id}\" Type=\"{REL}/{kind}\" Target=\"{}\"{}/>",
            esc(target),
            if external {
                " TargetMode=\"External\""
            } else {
                ""
            }
        ));
        id
    }

    fn xml(&self) -> String {
        format!(
            "{XML_HEADER}<Relationships xmlns=\"{NS_RELS}\">{}</Relationships>",
            self.entries.concat()
        )
    }
}

/// The media parts of the file, by source.
#[derive(Default)]
struct Media {
    /// Part name (`image1.png`) and bytes, in order.
    parts: Vec<(String, Vec<u8>)>,
    by_source: HashMap<String, String>,
}

impl Media {
    fn add(&mut self, key: String, ext: &str, bytes: Vec<u8>) -> String {
        if let Some(name) = self.by_source.get(&key) {
            return name.clone();
        }
        let name = format!("image{}.{ext}", self.parts.len() + 1);
        self.parts.push((name.clone(), bytes));
        self.by_source.insert(key, name.clone());
        name
    }
}

/// One slide being written.
struct Writer<'a, F> {
    emu: f64,
    next_id: u32,
    rels: Rels,
    media: &'a mut Media,
    load: &'a F,
    shots: &'a HashMap<usize, Vec<u8>>,
    /// Slide id to its number, for links between slides.
    numbers: &'a HashMap<String, usize>,
}

impl<F: Fn(&str) -> Option<Vec<u8>>> Writer<'_, F> {
    fn emu(&self, px: f64) -> i64 {
        (px * self.emu).round() as i64
    }

    /// Points for a length in canvas pixels.
    fn points(&self, px: f64) -> f64 {
        px * self.emu / EMU_PER_POINT
    }

    fn id(&mut self) -> u32 {
        self.next_id += 1;
        self.next_id
    }

    fn xfrm(&self, x: f64, y: f64, w: f64, h: f64, rotation: f64, flip_h: bool) -> String {
        let mut attrs = String::new();
        let angle = rotation.rem_euclid(360.0);
        if angle > 0.01 && angle < 359.99 {
            let _ = write!(attrs, " rot=\"{}\"", (angle * DEGREE).round() as i64);
        }
        if flip_h {
            attrs.push_str(" flipH=\"1\"");
        }
        format!(
            "<a:xfrm{attrs}><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></a:xfrm>",
            self.emu(x),
            self.emu(y),
            self.emu(w).max(0),
            self.emu(h).max(0)
        )
    }

    fn geometry(&self, w: f64, h: f64, radius: f64, ellipse: bool) -> String {
        if ellipse {
            return "<a:prstGeom prst=\"ellipse\"><a:avLst/></a:prstGeom>".to_string();
        }
        if radius > 0.0 && w.min(h) > 0.0 {
            let adjust = ((radius / w.min(h)) * WHOLE).round().min(50_000.0) as i64;
            return format!(
                "<a:prstGeom prst=\"roundRect\"><a:avLst><a:gd name=\"adj\" fmla=\"val {adjust}\"/></a:avLst></a:prstGeom>"
            );
        }
        "<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom>".to_string()
    }

    fn line_xml(&self, border: &Border, opacity: f64) -> String {
        let dash = match border.dash.as_deref() {
            Some("dashed") => "<a:prstDash val=\"dash\"/>",
            Some("dotted") => "<a:prstDash val=\"sysDot\"/>",
            _ => "",
        };
        let cap = match border.cap.as_deref() {
            Some("round") => " cap=\"rnd\"",
            Some("square") => " cap=\"sq\"",
            Some("butt") => " cap=\"flat\"",
            _ => "",
        };
        let join = match border.join.as_deref() {
            Some("round") => "<a:round/>",
            Some("bevel") => "<a:bevel/>",
            Some("miter" | "miter-clip" | "arcs") => "<a:miter lim=\"800000\"/>",
            _ => "",
        };
        let end = |tag: &str, arrow: Option<&Arrow>| {
            let Some(arrow) = arrow else {
                return String::new();
            };
            let kind = match arrow.kind.as_str() {
                "oval" => "oval",
                "arrow" => "arrow",
                _ => "triangle",
            };
            let size = match arrow.size.as_str() {
                "sm" => "sm",
                "lg" => "lg",
                _ => "med",
            };
            format!("<a:{tag} type=\"{kind}\" w=\"{size}\" len=\"{size}\"/>")
        };
        format!(
            "<a:ln w=\"{}\"{cap}>{}{dash}{join}{}{}</a:ln>",
            self.emu(border.width).max(1),
            solid_xml(border.color, opacity),
            end("headEnd", border.head.as_ref()),
            end("tailEnd", border.tail.as_ref())
        )
    }

    fn shadow_xml(&self, shadow: Option<&Shadow>, opacity: f64) -> String {
        shadow.map_or(String::new(), |s| {
            let distance = self.emu(s.x.hypot(s.y));
            let direction = s.y.atan2(s.x).to_degrees().rem_euclid(360.0);
            format!(
                "<a:effectLst><a:outerShdw blurRad=\"{}\" dist=\"{distance}\" dir=\"{}\" algn=\"ctr\" rotWithShape=\"0\">{}</a:outerShdw></a:effectLst>",
                self.emu(s.blur),
                (direction * DEGREE).round() as i64,
                color_xml(s.color, opacity)
            )
        })
    }

    fn fill_xml(fill: Option<&Fill>, opacity: f64) -> String {
        match fill {
            Some(Fill {
                gradient: Some(g), ..
            }) => gradient_xml(g, opacity),
            Some(Fill { color: Some(c), .. }) => solid_xml(*c, opacity),
            _ => "<a:noFill/>".to_string(),
        }
    }

    /// A freeform, or a line when that is all its outline is. Nothing if it cannot be read.
    fn path_xml(&mut self, item: &PathItem) -> Option<String> {
        let segments = path_segments(&item.d)?;
        let line = match &item.border {
            Some(border) => self.line_xml(border, 1.0),
            None => "<a:ln><a:noFill/></a:ln>".to_string(),
        };
        let effect = self.shadow_xml(item.shadow.as_ref(), 1.0);
        if let [('M', from), ('L', to)] = segments.as_slice() {
            // Two points fill nothing.
            item.border.as_ref()?;
            let id = self.id();
            let mut flips = String::new();
            if from[0] > to[0] {
                flips.push_str(" flipH=\"1\"");
            }
            if from[1] > to[1] {
                flips.push_str(" flipV=\"1\"");
            }
            return Some(format!(
                "<p:cxnSp><p:nvCxnSpPr><p:cNvPr id=\"{id}\" name=\"Line {id}\"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm{flips}><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></a:xfrm><a:prstGeom prst=\"line\"><a:avLst/></a:prstGeom>{line}{effect}</p:spPr></p:cxnSp>",
                self.emu(item.x),
                self.emu(item.y),
                self.emu(item.w).max(0),
                self.emu(item.h).max(0)
            ));
        }
        let id = self.id();
        let (width, height) = (self.emu(item.w).max(0), self.emu(item.h).max(0));
        let mut outline = String::new();
        for (kind, numbers) in &segments {
            let points: String = numbers
                .chunks(2)
                .map(|p| format!("<a:pt x=\"{}\" y=\"{}\"/>", self.emu(p[0]), self.emu(p[1])))
                .collect();
            let _ = match kind {
                'M' => write!(outline, "<a:moveTo>{points}</a:moveTo>"),
                'L' => write!(outline, "<a:lnTo>{points}</a:lnTo>"),
                'C' => write!(outline, "<a:cubicBezTo>{points}</a:cubicBezTo>"),
                _ => write!(outline, "<a:close/>"),
            };
        }
        let unfilled = if item.fill.is_none() {
            " fill=\"none\""
        } else {
            ""
        };
        Some(format!(
            "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"Freeform {id}\"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>{}<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l=\"0\" t=\"0\" r=\"r\" b=\"b\"/><a:pathLst><a:path w=\"{width}\" h=\"{height}\"{unfilled}>{outline}</a:path></a:pathLst></a:custGeom>{}{line}{effect}</p:spPr></p:sp>",
            self.xfrm(item.x, item.y, item.w, item.h, 0.0, false),
            Self::fill_xml(item.fill.as_ref(), 1.0),
        ))
    }

    /// The shapes of one drawing, in a group that leaves them where they are on the slide.
    fn group_xml(&mut self, item: &GroupItem) -> Option<String> {
        let id = self.id();
        let shapes: String = item
            .items
            .iter()
            .filter_map(|child| self.item_xml(child))
            .collect();
        if shapes.is_empty() {
            return None;
        }
        // A group scales its shapes by its size: never by nothing.
        let (x, y) = (self.emu(item.x), self.emu(item.y));
        let (w, h) = (self.emu(item.w).max(1), self.emu(item.h).max(1));
        Some(format!(
            "<p:grpSp><p:nvGrpSpPr><p:cNvPr id=\"{id}\" name=\"Group {id}\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{w}\" cy=\"{h}\"/><a:chOff x=\"{x}\" y=\"{y}\"/><a:chExt cx=\"{w}\" cy=\"{h}\"/></a:xfrm></p:grpSpPr>{shapes}</p:grpSp>"
        ))
    }

    fn item_xml(&mut self, item: &Item) -> Option<String> {
        match item {
            Item::Box(item) => Some(self.box_xml(item)),
            Item::Text(item) => Some(self.text_xml(item)),
            Item::Image(item) => self.image_xml(item),
            Item::Shot(item) => self.shot_xml(item),
            Item::Path(item) => self.path_xml(item),
            Item::Group(item) => self.group_xml(item),
        }
    }

    fn box_xml(&mut self, item: &BoxItem) -> String {
        let id = self.id();
        let fill = Self::fill_xml(item.fill.as_ref(), item.opacity);
        let line = match &item.border {
            Some(border) => self.line_xml(border, item.opacity),
            None => "<a:ln><a:noFill/></a:ln>".to_string(),
        };
        let effect = self.shadow_xml(item.shadow.as_ref(), item.opacity);
        format!(
            "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"Shape {id}\"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>{}{}{fill}{line}{effect}</p:spPr></p:sp>",
            self.xfrm(item.x, item.y, item.w, item.h, item.rotation, false),
            self.geometry(item.w, item.h, item.radius, item.ellipse),
        )
    }

    fn link_xml(&mut self, link: &str) -> String {
        if let Some(slide) = link.strip_prefix('#') {
            let Some(number) = self.numbers.get(slide).copied() else {
                return String::new();
            };
            let id = self.rels.add("slide", &format!("slide{number}.xml"), false);
            return format!("<a:hlinkClick r:id=\"{id}\" action=\"ppaction://hlinksldjump\"/>");
        }
        let lower = link.to_ascii_lowercase();
        if !["http://", "https://", "mailto:"]
            .iter()
            .any(|s| lower.starts_with(s))
        {
            return String::new();
        }
        let id = self.rels.add("hyperlink", link, true);
        format!("<a:hlinkClick r:id=\"{id}\"/>")
    }

    fn run_props(&mut self, tag: &str, run: &Run) -> String {
        let mut attrs = String::from(" lang=\"en-US\"");
        if run.size > 0.0 {
            let shrink = if run.baseline != 0.0 { 1.5 } else { 1.0 };
            let size = (self.points(run.size) * shrink * 100.0)
                .round()
                .clamp(100.0, 400_000.0) as i64;
            let _ = write!(attrs, " sz=\"{size}\"");
        }
        attrs.push_str(if run.bold { " b=\"1\"" } else { " b=\"0\"" });
        if run.italic {
            attrs.push_str(" i=\"1\"");
        }
        if run.underline {
            attrs.push_str(" u=\"sng\"");
        }
        if run.strike {
            attrs.push_str(" strike=\"sngStrike\"");
        }
        if run.spacing != 0.0 {
            let spacing = (self.points(run.spacing) * 100.0)
                .round()
                .clamp(-400_000.0, 400_000.0);
            let _ = write!(attrs, " spc=\"{}\"", spacing as i64);
        }
        if run.baseline != 0.0 {
            let baseline = (run.baseline * 1000.0).round().clamp(-100_000.0, 100_000.0);
            let _ = write!(attrs, " baseline=\"{}\"", baseline as i64);
        }
        attrs.push_str(" dirty=\"0\"");
        let mut inner = String::new();
        if let Some(color) = run.color {
            inner.push_str(&solid_xml(color, 1.0));
        }
        if let Some(mark) = run.highlight {
            let _ = write!(inner, "<a:highlight>{}</a:highlight>", color_xml(mark, 1.0));
        }
        if !run.font.is_empty() {
            let _ = write!(
                inner,
                "<a:latin typeface=\"{0}\"/><a:cs typeface=\"{0}\"/>",
                esc(&run.font)
            );
        }
        if let Some(link) = &run.link {
            inner.push_str(&self.link_xml(link));
        }
        format!("<a:{tag}{attrs}>{inner}</a:{tag}>")
    }

    fn paragraph_xml(&mut self, paragraph: &Paragraph) -> String {
        let align = match paragraph.align.as_str() {
            "center" => "ctr",
            "right" => "r",
            "justify" => "just",
            _ => "l",
        };
        let mut attrs = format!(" algn=\"{align}\"");
        if let Some(margin) = paragraph.margin_left {
            let _ = write!(attrs, " marL=\"{}\"", self.emu(margin).max(0));
        }
        let _ = write!(
            attrs,
            " indent=\"{}\"",
            self.emu(paragraph.indent.unwrap_or(0.0))
        );
        let mut props = String::new();
        if let Some(line) = paragraph.line_height {
            let _ = write!(
                props,
                "<a:lnSpc><a:spcPts val=\"{}\"/></a:lnSpc>",
                (self.points(line) * 100.0).round().clamp(0.0, 158_400.0) as i64
            );
        }
        if let Some(before) = paragraph.space_before.filter(|s| *s > 0.0) {
            let _ = write!(
                props,
                "<a:spcBef><a:spcPts val=\"{}\"/></a:spcBef>",
                (self.points(before) * 100.0).round().clamp(0.0, 158_400.0) as i64
            );
        }
        match &paragraph.bullet {
            Some(Bullet {
                number: Some(kind),
                start,
                ..
            }) => {
                let scheme = match kind.as_str() {
                    "lower-alpha" | "lower-latin" => "alphaLcPeriod",
                    "upper-alpha" | "upper-latin" => "alphaUcPeriod",
                    "lower-roman" => "romanLcPeriod",
                    "upper-roman" => "romanUcPeriod",
                    _ => "arabicPeriod",
                };
                let start = start.map_or(String::new(), |s| format!(" startAt=\"{s}\""));
                let _ = write!(
                    props,
                    "<a:buFont typeface=\"+mj-lt\"/><a:buAutoNum type=\"{scheme}\"{start}/>"
                );
            }
            Some(Bullet { char: Some(c), .. }) => {
                let _ = write!(
                    props,
                    "<a:buFont typeface=\"Arial\"/><a:buChar char=\"{}\"/>",
                    esc(c)
                );
            }
            _ => props.push_str("<a:buNone/>"),
        }
        let mut out = format!("<a:p><a:pPr{attrs}>{props}</a:pPr>");
        for run in &paragraph.runs {
            if run.line_break {
                out.push_str("<a:br/>");
            } else {
                let _ = write!(
                    out,
                    "<a:r>{}<a:t>{}</a:t></a:r>",
                    self.run_props("rPr", run),
                    esc(&run.text)
                );
            }
        }
        out.push_str("</a:p>");
        out
    }

    fn text_xml(&mut self, item: &TextItem) -> String {
        let id = self.id();
        let paragraphs: String = item
            .paragraphs
            .iter()
            .map(|p| self.paragraph_xml(p))
            .collect();
        let wrap = if item.wrap { "square" } else { "none" };
        let anchor = match item.anchor.as_str() {
            "center" => "ctr",
            "bottom" => "b",
            _ => "t",
        };
        format!(
            "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"Text {id}\"/><p:cNvSpPr txBox=\"1\"/><p:nvPr/></p:nvSpPr><p:spPr>{}<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap=\"{wrap}\" lIns=\"0\" tIns=\"0\" rIns=\"0\" bIns=\"0\" rtlCol=\"0\" anchor=\"{anchor}\"><a:noAutofit/></a:bodyPr><a:lstStyle/>{paragraphs}</p:txBody></p:sp>",
            self.xfrm(item.x, item.y, item.w, item.h, item.rotation, false),
        )
    }

    /// The media part for an asset, with its relationship; `None` if it cannot be read.
    fn asset_rel(&mut self, src: &str) -> Option<String> {
        let ext = src.rsplit('.').next().unwrap_or("").to_lowercase();
        let ext = if ext == "jpg" {
            "jpeg".to_string()
        } else {
            ext
        };
        let key = format!("asset:{src}");
        let name = match self.media.by_source.get(&key) {
            Some(name) => name.clone(),
            None => {
                let bytes = (self.load)(src)?;
                self.media.add(key, &ext, bytes)
            }
        };
        Some(self.rels.add("image", &format!("../media/{name}"), false))
    }

    fn shot_rel(&mut self, shot: usize) -> Option<String> {
        let bytes = self.shots.get(&shot)?.clone();
        let name = self.media.add(format!("shot:{shot}"), "png", bytes);
        Some(self.rels.add("image", &format!("../media/{name}"), false))
    }

    #[allow(clippy::too_many_arguments)]
    fn picture_xml(
        &mut self,
        rel: &str,
        alt: &str,
        xfrm: String,
        geometry: String,
        crop: Option<&Crop>,
        opacity: f64,
    ) -> String {
        let id = self.id();
        let alpha = if opacity < 0.999 {
            format!(
                "<a:alphaModFix amt=\"{}\"/>",
                (opacity.clamp(0.0, 1.0) * WHOLE).round() as i64
            )
        } else {
            String::new()
        };
        let crop = crop.map_or("<a:srcRect/>".to_string(), |c| {
            let part = |v: f64| (v.clamp(0.0, 1.0) * WHOLE).round() as i64;
            format!(
                "<a:srcRect l=\"{}\" t=\"{}\" r=\"{}\" b=\"{}\"/>",
                part(c.l),
                part(c.t),
                part(c.r),
                part(c.b)
            )
        });
        format!(
            "<p:pic><p:nvPicPr><p:cNvPr id=\"{id}\" name=\"Picture {id}\" descr=\"{}\"/><p:cNvPicPr><a:picLocks noChangeAspect=\"1\"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed=\"{rel}\">{alpha}</a:blip>{crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>{xfrm}{geometry}</p:spPr></p:pic>",
            esc(alt),
        )
    }

    fn image_xml(&mut self, item: &ImageItem) -> Option<String> {
        let rel = self.asset_rel(&item.src)?;
        let xfrm = self.xfrm(item.x, item.y, item.w, item.h, item.rotation, item.flip_h);
        let mut geometry = self.geometry(item.w, item.h, item.radius, item.ellipse);
        if let Some(border) = &item.border {
            geometry.push_str(&self.line_xml(border, item.opacity));
        }
        Some(self.picture_xml(
            &rel,
            &item.alt,
            xfrm,
            geometry,
            item.crop.as_ref(),
            item.opacity,
        ))
    }

    fn shot_xml(&mut self, item: &ShotItem) -> Option<String> {
        let rel = self.shot_rel(item.shot)?;
        let xfrm = self.xfrm(item.x, item.y, item.w, item.h, 0.0, false);
        let geometry = self.geometry(item.w, item.h, 0.0, false);
        Some(self.picture_xml(&rel, "", xfrm, geometry, None, 1.0))
    }

    fn background_xml(&mut self, background: &Background) -> String {
        let picture = |rel: String| {
            format!(
                "<a:blipFill dpi=\"0\" rotWithShape=\"1\"><a:blip r:embed=\"{rel}\"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></a:blipFill>"
            )
        };
        let fill = if let Some(rel) = background.shot.and_then(|s| self.shot_rel(s)) {
            picture(rel)
        } else if let Some(rel) = background.src.as_deref().and_then(|s| self.asset_rel(s)) {
            picture(rel)
        } else if let Some(gradient) = &background.gradient {
            gradient_xml(gradient, 1.0)
        } else {
            solid_xml(background.color.unwrap_or([255.0, 255.0, 255.0, 1.0]), 1.0)
        };
        format!("<p:bg><p:bgPr>{fill}<a:effectLst/></p:bgPr></p:bg>")
    }
}

/// A shape tree's fixed opening.
const TREE_START: &str = "<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>";

fn ns() -> String {
    format!("xmlns:a=\"{NS_A}\" xmlns:r=\"{NS_R}\" xmlns:p=\"{NS_P}\"")
}

/// Paragraphs of plain text, one per line of notes.
fn plain_paragraphs(text: &str) -> String {
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            format!(
                "<a:p><a:r><a:rPr lang=\"en-US\" dirty=\"0\"/><a:t>{}</a:t></a:r></a:p>",
                esc(line)
            )
        })
        .collect()
}

fn notes_xml(text: &str) -> String {
    let body = plain_paragraphs(text);
    format!(
        "{XML_HEADER}<p:notes {}><p:cSld><p:spTree>{TREE_START}<p:sp><p:nvSpPr><p:cNvPr id=\"2\" name=\"Slide Image\"/><p:cNvSpPr><a:spLocks noGrp=\"1\" noRot=\"1\" noChangeAspect=\"1\"/></p:cNvSpPr><p:nvPr><p:ph type=\"sldImg\"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id=\"3\" name=\"Notes\"/><p:cNvSpPr><a:spLocks noGrp=\"1\"/></p:cNvSpPr><p:nvPr><p:ph type=\"body\" idx=\"1\"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>{body}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>",
        ns()
    )
}

/// Builds the presentation. `load` reads a deck-relative asset; `shots` holds captured pictures.
pub(in crate::pptx) fn package<F: Fn(&str) -> Option<Vec<u8>>>(
    scene: &Scene,
    meta: &Meta,
    shots: &HashMap<usize, Vec<u8>>,
    load: F,
) -> Result<Vec<u8>> {
    let emu = emu_per_px(meta.canvas);
    let numbers: HashMap<String, usize> = scene
        .slides
        .iter()
        .enumerate()
        .map(|(i, s)| (s.id.clone(), i + 1))
        .collect();
    let mut media = Media::default();
    let mut parts: Vec<(String, String)> = Vec::new();
    let mut notes_numbers = Vec::new();

    for (index, slide) in scene.slides.iter().enumerate() {
        let number = index + 1;
        let mut writer = Writer {
            emu,
            next_id: 1,
            rels: Rels::new(),
            media: &mut media,
            load: &load,
            shots,
            numbers: &numbers,
        };
        writer
            .rels
            .add("slideLayout", "../slideLayouts/slideLayout1.xml", false);
        if let Some(text) = meta.notes.get(&slide.id) {
            writer.rels.add(
                "notesSlide",
                &format!("../notesSlides/notesSlide{number}.xml"),
                false,
            );
            let mut rels = Rels::new();
            rels.add("notesMaster", "../notesMasters/notesMaster1.xml", false);
            rels.add("slide", &format!("../slides/slide{number}.xml"), false);
            parts.push((
                format!("ppt/notesSlides/notesSlide{number}.xml"),
                notes_xml(text),
            ));
            parts.push((
                format!("ppt/notesSlides/_rels/notesSlide{number}.xml.rels"),
                rels.xml(),
            ));
            notes_numbers.push(number);
        }
        let background = writer.background_xml(&slide.background);
        let mut shapes = String::new();
        for item in &slide.items {
            shapes.push_str(&writer.item_xml(item).unwrap_or_default());
        }
        parts.push((
            format!("ppt/slides/slide{number}.xml"),
            format!(
                "{XML_HEADER}<p:sld {}><p:cSld>{background}<p:spTree>{TREE_START}{shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>",
                ns()
            ),
        ));
        parts.push((
            format!("ppt/slides/_rels/slide{number}.xml.rels"),
            writer.rels.xml(),
        ));
    }

    let count = scene.slides.len();
    let has_notes = !notes_numbers.is_empty();
    let width = (f64::from(meta.canvas.0) * emu).round().max(MIN_SLIDE_EMU) as i64;
    let height = (f64::from(meta.canvas.1) * emu).round().max(MIN_SLIDE_EMU) as i64;

    let mut presentation_rels = Rels::new();
    presentation_rels.add("slideMaster", "slideMasters/slideMaster1.xml", false);
    let notes_master = has_notes
        .then(|| presentation_rels.add("notesMaster", "notesMasters/notesMaster1.xml", false));
    presentation_rels.add("theme", "theme/theme1.xml", false);
    let slide_rels: Vec<String> = (1..=count)
        .map(|n| presentation_rels.add("slide", &format!("slides/slide{n}.xml"), false))
        .collect();

    let slide_ids: String = slide_rels
        .iter()
        .enumerate()
        .map(|(i, rel)| format!("<p:sldId id=\"{}\" r:id=\"{rel}\"/>", 256 + i))
        .collect();
    let notes_list = notes_master.map_or(String::new(), |rel| {
        format!("<p:notesMasterIdLst><p:notesMasterId r:id=\"{rel}\"/></p:notesMasterIdLst>")
    });
    let sections = sections_xml(scene, meta);
    parts.push((
        "ppt/presentation.xml".to_string(),
        format!(
            "{XML_HEADER}<p:presentation {} saveSubsetFonts=\"1\"><p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst>{notes_list}<p:sldIdLst>{slide_ids}</p:sldIdLst><p:sldSz cx=\"{width}\" cy=\"{height}\"/><p:notesSz cx=\"6858000\" cy=\"9144000\"/>{sections}</p:presentation>",
            ns()
        ),
    ));
    parts.push((
        "ppt/_rels/presentation.xml.rels".to_string(),
        presentation_rels.xml(),
    ));
    parts.push(("ppt/theme/theme1.xml".to_string(), theme_xml()));
    parts.push((
        "ppt/slideMasters/slideMaster1.xml".to_string(),
        master_xml(),
    ));
    let mut master_rels = Rels::new();
    master_rels.add("slideLayout", "../slideLayouts/slideLayout1.xml", false);
    master_rels.add("theme", "../theme/theme1.xml", false);
    parts.push((
        "ppt/slideMasters/_rels/slideMaster1.xml.rels".to_string(),
        master_rels.xml(),
    ));
    parts.push((
        "ppt/slideLayouts/slideLayout1.xml".to_string(),
        layout_xml(),
    ));
    let mut layout_rels = Rels::new();
    layout_rels.add("slideMaster", "../slideMasters/slideMaster1.xml", false);
    parts.push((
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels".to_string(),
        layout_rels.xml(),
    ));
    if has_notes {
        parts.push(("ppt/theme/theme2.xml".to_string(), theme_xml()));
        parts.push((
            "ppt/notesMasters/notesMaster1.xml".to_string(),
            notes_master_xml(),
        ));
        let mut rels = Rels::new();
        rels.add("theme", "../theme/theme2.xml", false);
        parts.push((
            "ppt/notesMasters/_rels/notesMaster1.xml.rels".to_string(),
            rels.xml(),
        ));
    }
    parts.push(("docProps/core.xml".to_string(), core_xml(&meta.title)));
    parts.push(("docProps/app.xml".to_string(), app_xml(count)));
    parts.push((
        "_rels/.rels".to_string(),
        format!(
            "{XML_HEADER}<Relationships xmlns=\"{NS_RELS}\"><Relationship Id=\"rId1\" Type=\"{REL}/officeDocument\" Target=\"ppt/presentation.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/><Relationship Id=\"rId3\" Type=\"{REL}/extended-properties\" Target=\"docProps/app.xml\"/></Relationships>"
        ),
    ));
    let types = content_types(count, &notes_numbers, &media);

    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let deflate = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let failed = |e: &dyn std::fmt::Display| Error::msg(format!("cannot write the file: {e}"));
    // Office expects the content types first.
    archive
        .start_file("[Content_Types].xml", deflate)
        .map_err(|e| failed(&e))?;
    archive.write_all(types.as_bytes())?;
    for (name, xml) in &parts {
        archive.start_file(name, deflate).map_err(|e| failed(&e))?;
        archive.write_all(xml.as_bytes())?;
    }
    for (name, bytes) in &media.parts {
        archive
            .start_file(format!("ppt/media/{name}"), stored)
            .map_err(|e| failed(&e))?;
        archive.write_all(bytes)?;
    }
    let written = archive.finish().map_err(|e| failed(&e))?;
    Ok(written.into_inner())
}

/// `<p:extLst>` listing the sections, with slides before the first in one of their own:
/// PowerPoint wants every slide in a section.
fn sections_xml(scene: &Scene, meta: &Meta) -> String {
    let starts: HashMap<&str, &str> = meta
        .sections
        .iter()
        .map(|(name, slide)| (slide.as_str(), name.as_str()))
        .collect();
    if starts.is_empty() {
        return String::new();
    }
    let mut groups: Vec<(String, Vec<usize>)> = Vec::new();
    for (index, slide) in scene.slides.iter().enumerate() {
        match starts.get(slide.id.as_str()) {
            Some(name) => groups.push(((*name).to_string(), vec![index])),
            None => match groups.last_mut() {
                Some(group) => group.1.push(index),
                None => groups.push((super::super::DEFAULT_SECTION.to_string(), vec![index])),
            },
        }
    }
    let sections: String = groups
        .iter()
        .map(|(name, slides)| {
            let ids: String = slides
                .iter()
                .map(|i| format!("<p14:sldId id=\"{}\"/>", 256 + i))
                .collect();
            let guid = uuid::Uuid::new_v4().to_string().to_uppercase();
            format!(
                "<p14:section name=\"{}\" id=\"{{{guid}}}\"><p14:sldIdLst>{ids}</p14:sldIdLst></p14:section>",
                esc(name)
            )
        })
        .collect();
    format!(
        "<p:extLst><p:ext uri=\"{{521415D9-36F7-43E2-AB2F-B90AF26B5E84}}\"><p14:sectionLst xmlns:p14=\"http://schemas.microsoft.com/office/powerpoint/2010/main\">{sections}</p14:sectionLst></p:ext></p:extLst>"
    )
}

fn content_types(count: usize, notes: &[usize], media: &Media) -> String {
    const PML: &str = "application/vnd.openxmlformats-officedocument.presentationml";
    let mut out = format!(
        "{XML_HEADER}<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/>"
    );
    let mut extensions: Vec<&str> = media
        .parts
        .iter()
        .filter_map(|(name, _)| name.rsplit('.').next())
        .collect();
    extensions.sort_unstable();
    extensions.dedup();
    for ext in extensions {
        let _ = write!(
            out,
            "<Default Extension=\"{}\" ContentType=\"image/{}\"/>",
            esc(ext),
            esc(ext)
        );
    }
    let mut part = |name: String, kind: &str| {
        let _ = write!(
            out,
            "<Override PartName=\"{name}\" ContentType=\"{PML}.{kind}+xml\"/>"
        );
    };
    part("/ppt/presentation.xml".to_string(), "presentation.main");
    part(
        "/ppt/slideMasters/slideMaster1.xml".to_string(),
        "slideMaster",
    );
    part(
        "/ppt/slideLayouts/slideLayout1.xml".to_string(),
        "slideLayout",
    );
    for n in 1..=count {
        part(format!("/ppt/slides/slide{n}.xml"), "slide");
    }
    for n in notes {
        part(format!("/ppt/notesSlides/notesSlide{n}.xml"), "notesSlide");
    }
    if !notes.is_empty() {
        part(
            "/ppt/notesMasters/notesMaster1.xml".to_string(),
            "notesMaster",
        );
    }
    let theme = "application/vnd.openxmlformats-officedocument.theme+xml";
    let _ = write!(
        out,
        "<Override PartName=\"/ppt/theme/theme1.xml\" ContentType=\"{theme}\"/>"
    );
    if !notes.is_empty() {
        let _ = write!(
            out,
            "<Override PartName=\"/ppt/theme/theme2.xml\" ContentType=\"{theme}\"/>"
        );
    }
    out.push_str("<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/><Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/></Types>");
    out
}

fn core_xml(title: &str) -> String {
    format!(
        "{XML_HEADER}<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:title>{}</dc:title><dc:creator>SlopSlide</dc:creator></cp:coreProperties>",
        esc(title)
    )
}

fn app_xml(slides: usize) -> String {
    format!(
        "{XML_HEADER}<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\"><Application>SlopSlide</Application><Slides>{slides}</Slides></Properties>"
    )
}

fn master_xml() -> String {
    format!(
        "{XML_HEADER}<p:sldMaster {}><p:cSld><p:bg><p:bgRef idx=\"1001\"><a:schemeClr val=\"bg1\"/></p:bgRef></p:bg><p:spTree>{TREE_START}</p:spTree></p:cSld><p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/><p:sldLayoutIdLst><p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn=\"l\"><a:defRPr sz=\"4400\"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz=\"2800\"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz=\"1800\"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>",
        ns()
    )
}

fn layout_xml() -> String {
    format!(
        "{XML_HEADER}<p:sldLayout {} type=\"blank\" preserve=\"1\"><p:cSld name=\"Blank\"><p:spTree>{TREE_START}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>",
        ns()
    )
}

fn notes_master_xml() -> String {
    format!(
        "{XML_HEADER}<p:notesMaster {}><p:cSld><p:bg><p:bgRef idx=\"1001\"><a:schemeClr val=\"bg1\"/></p:bgRef></p:bg><p:spTree>{TREE_START}<p:sp><p:nvSpPr><p:cNvPr id=\"2\" name=\"Slide Image\"/><p:cNvSpPr><a:spLocks noGrp=\"1\" noRot=\"1\" noChangeAspect=\"1\"/></p:cNvSpPr><p:nvPr><p:ph type=\"sldImg\" idx=\"2\"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x=\"685800\" y=\"1143000\"/><a:ext cx=\"5486400\" cy=\"3086100\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:noFill/></p:spPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id=\"3\" name=\"Notes\"/><p:cNvSpPr><a:spLocks noGrp=\"1\"/></p:cNvSpPr><p:nvPr><p:ph type=\"body\" idx=\"1\"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x=\"685800\" y=\"4400550\"/><a:ext cx=\"5486400\" cy=\"3600450\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang=\"en-US\"/><a:t>Notes</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/></p:notesMaster>",
        ns()
    )
}

fn theme_xml() -> String {
    let color = |tag: &str, value: &str| format!("<a:{tag}><a:srgbClr val=\"{value}\"/></a:{tag}>");
    let colors: String = [
        ("dk1", "000000"),
        ("lt1", "FFFFFF"),
        ("dk2", "44546A"),
        ("lt2", "E7E6E6"),
        ("accent1", "4472C4"),
        ("accent2", "ED7D31"),
        ("accent3", "A5A5A5"),
        ("accent4", "FFC000"),
        ("accent5", "5B9BD5"),
        ("accent6", "70AD47"),
        ("hlink", "0563C1"),
        ("folHlink", "954F72"),
    ]
    .iter()
    .map(|(tag, value)| color(tag, value))
    .collect();
    let fill = "<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>";
    let line = "<a:ln w=\"6350\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln>";
    let effect = "<a:effectStyle><a:effectLst/></a:effectStyle>";
    format!(
        "{XML_HEADER}<a:theme xmlns:a=\"{NS_A}\" name=\"SlopSlide\"><a:themeElements><a:clrScheme name=\"SlopSlide\">{colors}</a:clrScheme><a:fontScheme name=\"SlopSlide\"><a:majorFont><a:latin typeface=\"Calibri Light\"/><a:ea typeface=\"\"/><a:cs typeface=\"\"/></a:majorFont><a:minorFont><a:latin typeface=\"Calibri\"/><a:ea typeface=\"\"/><a:cs typeface=\"\"/></a:minorFont></a:fontScheme><a:fmtScheme name=\"SlopSlide\"><a:fillStyleLst>{fill}{fill}{fill}</a:fillStyleLst><a:lnStyleLst>{line}{line}{line}</a:lnStyleLst><a:effectStyleLst>{effect}{effect}{effect}</a:effectStyleLst><a:bgFillStyleLst>{fill}{fill}{fill}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>"
    )
}
