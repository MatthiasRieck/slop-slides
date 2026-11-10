//! Shapes, lines and pictures.

use super::*;

impl Converter {
    pub(super) fn line_of(
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

    pub(super) fn box_css(&self, b: Box2) -> String {
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
    pub(super) fn svg_shape(
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
    pub(super) fn custom_path(&self, geometry: &Node, b: Box2) -> Option<String> {
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
    pub(super) fn shape_html(
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
                        let radius = bx.w.abs().min(bx.h.abs()) * adjust / WHOLE;
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
    pub(super) fn arrow_heads(&self, b: Box2, line: &Line) -> String {
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

    pub(super) fn picture_html(
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
            extra.push_str(&format!("; opacity: {}", round(amount / WHOLE, 3)));
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
                .map_or(0.0, |v| v / WHOLE)
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
}
