//! Tables and charts.

use super::*;

impl Converter {
    /// A table's cell border, from `a:lnL` and friends.
    pub(super) fn cell_border(
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

    pub(super) fn table_html(
        &mut self,
        chain: &Chain,
        part: &Part,
        table: &Node,
        bx: Box2,
        out: &mut String,
    ) {
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
    pub(super) fn chart_html(&mut self, part: &Part, id: &str, bx: Box2, out: &mut String) {
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
}
