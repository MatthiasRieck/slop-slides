//! Colours as DrawingML gives them, and the theme they refer to.

use super::*;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct Color {
    pub(super) r: u8,
    pub(super) g: u8,
    pub(super) b: u8,
    /// 0 to 1.
    pub(super) a: f64,
}

impl Color {
    pub(super) fn hex(text: &str) -> Option<Color> {
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

    pub(super) fn css(self) -> String {
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

    pub(super) fn to_hsl(self) -> (f64, f64, f64) {
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

    pub(super) fn from_hsl(h: f64, s: f64, l: f64, a: f64) -> Color {
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
    pub(super) fn modified(mut self, node: &Node) -> Color {
        for m in &node.children {
            let value = m.num("val").unwrap_or(0.0) / WHOLE;
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
pub(super) fn preset_color(name: &str) -> Color {
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
pub(super) struct Theme {
    pub(super) colors: HashMap<String, Color>,
    pub(super) major_font: String,
    pub(super) minor_font: String,
}

impl Theme {
    pub(super) fn parse(root: Option<&Node>) -> Theme {
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

    pub(super) fn font(&self, typeface: &str) -> String {
        match typeface {
            "+mj-lt" | "+mj-ea" | "+mj-cs" => self.major_font.clone(),
            "+mn-lt" | "+mn-ea" | "+mn-cs" => self.minor_font.clone(),
            other => other.to_string(),
        }
    }
}
