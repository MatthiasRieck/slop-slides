//! What a shape is placed and painted in: the slide's colour mapping, a group's coordinates,
//! a shape's box, and fills and lines ready for CSS or SVG.

use super::*;

/// How the master maps logical colours to the theme.
pub(super) struct Palette<'a> {
    pub(super) theme: &'a Theme,
    pub(super) map: &'a HashMap<String, String>,
}

impl Palette<'_> {
    pub(super) fn scheme(&self, name: &str) -> Option<Color> {
        let key = self.map.get(name).map_or(name, String::as_str);
        self.theme.colors.get(key).copied()
    }

    /// The colour held by `node`'s first colour child, with its modifiers.
    pub(super) fn color(&self, node: &Node) -> Option<Color> {
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
pub(super) struct Frame {
    pub(super) sx: f64,
    pub(super) sy: f64,
    pub(super) tx: f64,
    pub(super) ty: f64,
    /// Accumulated group rotation, in degrees.
    pub(super) rotation: f64,
}

impl Frame {
    pub(super) const IDENTITY: Frame = Frame {
        sx: 1.0,
        sy: 1.0,
        tx: 0.0,
        ty: 0.0,
        rotation: 0.0,
    };

    pub(super) fn nested(self, xfrm: &Node) -> Frame {
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
pub(super) struct Box2 {
    pub(super) x: f64,
    pub(super) y: f64,
    pub(super) w: f64,
    pub(super) h: f64,
    pub(super) rotation: f64,
    pub(super) flip_h: bool,
    pub(super) flip_v: bool,
}

pub(super) fn read_box(xfrm: &Node, frame: Frame) -> Option<Box2> {
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
pub(super) enum Fill {
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
    pub(super) fn css(&self) -> Option<String> {
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
pub(super) struct Line {
    pub(super) color: Color,
    /// In EMU.
    pub(super) width: f64,
    pub(super) dash: Option<&'static str>,
    pub(super) head_arrow: bool,
    pub(super) tail_arrow: bool,
}
