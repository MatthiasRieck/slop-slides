//! PowerPoint's preset shapes as SVG paths.

use super::*;

/// The value of the adjust handle `name` in `props`, as a fraction, or `default`.
pub(super) fn adjust(props: &Node, name: &str, default: f64) -> f64 {
    props
        .at(&["prstGeom", "avLst"])
        .into_iter()
        .flat_map(|list| list.all("gd"))
        .find(|g| g.attr("name") == Some(name))
        .and_then(|g| g.attr("fmla"))
        .and_then(|f| f.strip_prefix("val "))
        .and_then(|v| v.parse::<f64>().ok())
        .map_or(default, |v| v / WHOLE)
}

pub(super) fn polygon(points: &[(f64, f64)]) -> String {
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
pub(super) fn preset_path(kind: &str, w: f64, h: f64, props: &Node) -> Option<String> {
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
