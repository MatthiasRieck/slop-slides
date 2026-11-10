//! Text frames: paragraph and run styles, and the HTML of a shape's text.

use super::*;

impl Converter {
    /// Resolves the text style stack for a paragraph at `level` of `shape`.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn para_style(
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

    pub(super) fn run_css(&self, style: &RunStyle, scale: f64) -> String {
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
    pub(super) fn runs_html(
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
    pub(super) fn link(&self, chain: &Chain, props: &Node) -> Option<String> {
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
    pub(super) fn text_html(
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
            .map_or(1.0, |s| s / WHOLE);
        let line_reduction = fit
            .and_then(|f| f.num("lnSpcReduction"))
            .map_or(0.0, |s| s / WHOLE);
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
}
