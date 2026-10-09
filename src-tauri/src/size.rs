//! The deck's slide size. Every slide is a fixed canvas, 1920×1080 px unless the deck names
//! another size in `<meta name="slopslide-size" content="…">`: `1080x1350` (pixels),
//! `8.5x11in` or `21x29.7cm`. Inches and centimetres become CSS pixels (96 per inch); the
//! unit is kept so the editor shows the size the way the user gave it.

use std::fmt;

use serde::{Deserialize, Serialize};

/// Name of the `<meta>` holding the deck's slide size.
pub const SIZE_META: &str = "slopslide-size";

/// The smallest and largest canvas side, in CSS pixels.
pub const MIN_PX: u32 = 100;
pub const MAX_PX: u32 = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Unit {
    Px,
    In,
    Cm,
}

impl Unit {
    /// CSS pixels per unit.
    fn px(self) -> f64 {
        match self {
            Unit::Px => 1.0,
            Unit::In => 96.0,
            Unit::Cm => 96.0 / 2.54,
        }
    }

    fn suffix(self) -> &'static str {
        match self {
            Unit::Px => "",
            Unit::In => "in",
            Unit::Cm => "cm",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideSize {
    pub width: f64,
    pub height: f64,
    pub unit: Unit,
}

impl Default for SlideSize {
    fn default() -> Self {
        Self {
            width: 1920.0,
            height: 1080.0,
            unit: Unit::Px,
        }
    }
}

impl SlideSize {
    /// Parses `1080x1350`, `1080 × 1350 px`, `8.5x11in`, `21x29.7cm`; None when malformed or
    /// out of range (see [`SlideSize::check`]).
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim().to_ascii_lowercase();
        let (dims, unit) = [("px", Unit::Px), ("in", Unit::In), ("cm", Unit::Cm)]
            .into_iter()
            .find_map(|(suffix, unit)| text.strip_suffix(suffix).map(|d| (d, unit)))
            .unwrap_or((&text, Unit::Px));
        let (w, h) = dims.split_once(['x', '×'])?;
        let number = |s: &str| s.trim().parse::<f64>().ok().filter(|n| n.is_finite());
        let size = Self {
            width: number(w)?,
            height: number(h)?,
            unit,
        };
        size.check().ok()?;
        Some(size)
    }

    /// The canvas in whole CSS pixels.
    pub fn pixels(&self) -> (u32, u32) {
        let px = |n: f64| (n * self.unit.px()).round().clamp(0.0, u32::MAX as f64) as u32;
        (px(self.width), px(self.height))
    }

    /// Refuses sizes whose canvas is not between [`MIN_PX`] and [`MAX_PX`] on both sides.
    pub fn check(&self) -> Result<(), String> {
        let (w, h) = self.pixels();
        let ok = |n: u32| (MIN_PX..=MAX_PX).contains(&n);
        if self.width.is_finite() && self.height.is_finite() && ok(w) && ok(h) {
            Ok(())
        } else {
            Err(format!(
                "A slide must be {MIN_PX} to {MAX_PX} pixels on each side; {self} is {w}×{h} px."
            ))
        }
    }

    /// The stage's size-dependent player styles, appended to the runtime stylesheet: the
    /// canvas size (as `--slop-w` / `--slop-h`), the printed page, and how far viewers without
    /// JavaScript zoom the slide list down to fit narrower windows.
    pub fn runtime_css(&self) -> String {
        let (w, h) = self.pixels();
        let mut css = format!(
            "/* Stage size: {self} (the deck's slopslide-size meta). */\n\
             :root {{\n  --slop-w: {w}px;\n  --slop-h: {h}px;\n}}\n\
             @media print {{\n  @page {{\n    size: {w}px {h}px;\n    margin: 0;\n  }}\n}}\n"
        );
        for step in (2..20).rev() {
            let zoom = f64::from(step) / 20.0;
            let below = f64::from(w) * f64::from(step + 1) / 20.0 - 0.02;
            css.push_str(&format!(
                "@media screen and (max-width: {}px) {{ html:not([data-slop-player]) .deck {{ zoom: {}; }} }}\n",
                number(below),
                number(zoom)
            ));
        }
        css
    }
}

/// A slide size as the frontend gets it: as given, and as the canvas in CSS pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SizeInfo {
    #[serde(flatten)]
    pub size: SlideSize,
    pub pixel_width: u32,
    pub pixel_height: u32,
}

impl From<SlideSize> for SizeInfo {
    fn from(size: SlideSize) -> Self {
        let (pixel_width, pixel_height) = size.pixels();
        Self {
            size,
            pixel_width,
            pixel_height,
        }
    }
}

/// `n` with at most two decimals and no trailing zeros.
fn number(n: f64) -> String {
    let text = format!("{n:.2}");
    let text = text.trim_end_matches('0').trim_end_matches('.');
    if text == "-0" {
        "0".into()
    } else {
        text.into()
    }
}

impl fmt::Display for SlideSize {
    /// The meta's `content`: `1920x1080`, `8.5x11in`, `21x29.7cm`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}x{}{}",
            number(self.width),
            number(self.height),
            self.unit.suffix()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn size(width: f64, height: f64, unit: Unit) -> SlideSize {
        SlideSize {
            width,
            height,
            unit,
        }
    }

    #[test]
    fn parses_pixels_inches_and_centimetres() {
        assert_eq!(
            SlideSize::parse("1080x1350"),
            Some(size(1080.0, 1350.0, Unit::Px))
        );
        assert_eq!(
            SlideSize::parse(" 1080 × 1350 PX "),
            Some(size(1080.0, 1350.0, Unit::Px))
        );
        assert_eq!(
            SlideSize::parse("8.5x11in"),
            Some(size(8.5, 11.0, Unit::In))
        );
        assert_eq!(
            SlideSize::parse("21 x 29.7 cm"),
            Some(size(21.0, 29.7, Unit::Cm))
        );
    }

    #[test]
    fn rejects_malformed_and_out_of_range_sizes() {
        for bad in [
            "",
            "1920",
            "x1080",
            "1920x",
            "axb",
            "1920x1080mm",
            "-5x10",
            "NaNx10",
            "infx10",
            "50x50",
            "20000x1080",
            "1x1in",
        ] {
            assert_eq!(SlideSize::parse(bad), None, "{bad}");
        }
        assert!(size(1920.0, f64::NAN, Unit::Px).check().is_err());
        assert!(SlideSize::default().check().is_ok());
    }

    #[test]
    fn converts_to_css_pixels() {
        assert_eq!(SlideSize::default().pixels(), (1920, 1080));
        assert_eq!(size(8.5, 11.0, Unit::In).pixels(), (816, 1056));
        assert_eq!(size(21.0, 29.7, Unit::Cm).pixels(), (794, 1123));
    }

    #[test]
    fn formats_as_the_meta_content_and_round_trips() {
        for (s, text) in [
            (SlideSize::default(), "1920x1080"),
            (size(8.5, 11.0, Unit::In), "8.5x11in"),
            (size(21.0, 29.7, Unit::Cm), "21x29.7cm"),
            (size(1080.004, 1350.0, Unit::Px), "1080x1350"),
        ] {
            assert_eq!(s.to_string(), text);
            assert_eq!(SlideSize::parse(text).unwrap().to_string(), text);
        }
    }

    #[test]
    fn serializes_with_the_canvas_in_pixels() {
        let json = serde_json::to_value(SizeInfo::from(size(8.5, 11.0, Unit::In))).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "width": 8.5, "height": 11.0, "unit": "in", "pixelWidth": 816, "pixelHeight": 1056 })
        );
        let back: SlideSize = serde_json::from_value(json).unwrap();
        assert_eq!(back, size(8.5, 11.0, Unit::In));
    }

    #[test]
    fn stage_css_follows_the_canvas() {
        let css = SlideSize::default().runtime_css();
        assert!(css.contains("--slop-w: 1920px;") && css.contains("--slop-h: 1080px;"));
        assert!(css.contains("size: 1920px 1080px;"));
        // The zoom steps the stylesheet always had for 1920 px slides.
        assert!(css.contains(
            "(max-width: 1919.98px) { html:not([data-slop-player]) .deck { zoom: 0.95; } }"
        ));
        assert!(css.contains(
            "(max-width: 287.98px) { html:not([data-slop-player]) .deck { zoom: 0.1; } }"
        ));
        assert_eq!(css.matches("zoom:").count(), 18);

        let portrait = size(1080.0, 1350.0, Unit::Px).runtime_css();
        assert!(
            portrait.contains("--slop-w: 1080px;") && portrait.contains("size: 1080px 1350px;")
        );
        assert!(portrait.contains("(max-width: 1079.98px)"));
        assert!(!portrait.contains("1919.98"));
    }

    #[test]
    fn zoom_steps_fit_the_slides_into_narrow_windows() {
        for size in [
            SlideSize::default(),
            size(1080.0, 1350.0, Unit::Px),
            size(8.5, 11.0, Unit::In),
        ] {
            let (w, _) = size.pixels();
            let css = size.runtime_css();
            let steps: Vec<(f64, f64)> = css
                .lines()
                .filter_map(|line| {
                    let width = line.split("max-width: ").nth(1)?.split("px").next()?;
                    let zoom = line.split("zoom: ").nth(1)?.split(';').next()?;
                    Some((width.parse().ok()?, zoom.parse().ok()?))
                })
                .collect();
            assert_eq!(steps.len(), 18, "{size}");
            for (width, zoom) in steps {
                // The step applies to windows narrower than `width`; the zoomed slide still fits
                // the narrowest of them.
                let narrowest = width + 0.02 - f64::from(w) * 0.05;
                assert!(
                    f64::from(w) * zoom <= narrowest + 1e-6,
                    "{size}: {width} {zoom}"
                );
            }
        }
        // Phones (≈375–430 CSS px wide) get a step.
        assert!(SlideSize::default()
            .runtime_css()
            .contains("(max-width: 383.98px)"));
    }
}
