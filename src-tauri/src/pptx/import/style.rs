//! Text properties a paragraph and its runs inherit through the placeholder, layout, master
//! and theme.

use super::*;

/// Character properties, resolved over the inheritance chain.
#[derive(Default, Clone)]
pub(super) struct RunStyle {
    /// In points.
    pub(super) size: Option<f64>,
    pub(super) bold: Option<bool>,
    pub(super) italic: Option<bool>,
    pub(super) underline: Option<bool>,
    pub(super) strike: Option<bool>,
    pub(super) caps: Option<bool>,
    /// Letter spacing in points.
    pub(super) spacing: Option<f64>,
    /// Percent of the size raised (or lowered).
    pub(super) baseline: Option<f64>,
    pub(super) color: Option<Color>,
    /// The colour behind the text.
    pub(super) highlight: Option<Color>,
    pub(super) font: Option<String>,
}

#[derive(Clone, PartialEq)]
pub(super) enum Bullet {
    None,
    Char(String),
    Number { css_type: &'static str, start: u32 },
}

/// Paragraph properties, resolved over the inheritance chain.
#[derive(Default, Clone)]
pub(super) struct ParaStyle {
    pub(super) align: Option<String>,
    /// In EMU.
    pub(super) margin_left: Option<f64>,
    pub(super) indent: Option<f64>,
    pub(super) bullet: Option<Bullet>,
    /// A multiple of the normal line height, or exact points.
    pub(super) line_multiple: Option<f64>,
    pub(super) line_points: Option<f64>,
    pub(super) before_percent: Option<f64>,
    pub(super) before_points: Option<f64>,
    pub(super) after_percent: Option<f64>,
    pub(super) after_points: Option<f64>,
    pub(super) run: RunStyle,
}

/// Unicode for bullets drawn from symbol fonts, which the webview does not have.
pub(super) fn bullet_char(text: &str, font: Option<&str>) -> String {
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

pub(super) fn number_type(kind: &str) -> &'static str {
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

pub(super) fn apply_run(style: &mut RunStyle, node: &Node, ctx: &Palette) {
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

pub(super) fn apply_para(style: &mut ParaStyle, node: &Node, ctx: &Palette) {
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
pub(super) enum TextClass {
    Title,
    Body,
    Other,
}
