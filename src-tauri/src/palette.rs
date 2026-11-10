//! A deck's color palette: the custom properties its `:root` rules give a color
//! (`--accent: #e30613`). Every other color in the deck refers to them (`var(--accent)`,
//! `color-mix(in srgb, var(--accent) 30%, transparent)`), so changing the palette recolors the
//! whole deck. This module reads the palette, finds colors written out anywhere else (the
//! `palette-color` lint), and rewrites palette values.

use std::ops::Range;

use cssparser::{Delimiter, ParseError, Parser, ParserInput, Token};

use crate::html::{self, find_ci, parse_tag, CSS_END, CSS_START};

/// One color of the palette.
#[derive(Debug, Clone, PartialEq)]
pub struct PaletteColor {
    /// Without the leading `--`.
    pub name: String,
    /// As written in the deck (`#e30613`, `rgb(0 0 0 / 0.3)`, `white`).
    pub value: String,
    /// Byte range of the value in the deck.
    pub range: Range<usize>,
}

/// A color written out where the palette should have been referred to.
#[derive(Debug, Clone, PartialEq)]
pub struct Literal {
    /// Byte range in the deck.
    pub range: Range<usize>,
    /// Where it was found.
    pub place: Place,
    /// The property (or attribute) it is the value of, lowercased.
    pub property: String,
    /// For a presentation attribute that is just this color: where the tag can take it as a
    /// style instead.
    pub attribute: Option<AttributeSite>,
}

/// A presentation attribute (`fill="#fff"`) and where its tag's styles go.
#[derive(Debug, Clone, PartialEq)]
pub struct AttributeSite {
    /// The whole attribute, with the whitespace before it.
    pub whole: Range<usize>,
    /// The value of the tag's `style` attribute, if it has one.
    pub style: Option<Range<usize>>,
    /// Just after the tag's name, where a `style` attribute can go.
    pub name_end: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Place {
    /// A `<style>` element.
    Style,
    /// A `style="…"` attribute.
    Inline,
    /// An SVG presentation attribute (`fill="#fff"`), named.
    Attribute(&'static str),
}

/// SVG presentation attributes that take a color.
const COLOR_ATTRIBUTES: &[&str] = &[
    "fill",
    "stroke",
    "stop-color",
    "flood-color",
    "lighting-color",
    "color",
];

/// Functions whose result is a color made of written-out channels.
const COLOR_FUNCTIONS: &[&str] = &[
    "rgb",
    "rgba",
    "hsl",
    "hsla",
    "hwb",
    "lab",
    "lch",
    "oklab",
    "oklch",
    "color",
    "device-cmyk",
];

/// Functions whose arguments are not colors to check: what they point at is not drawn from
/// the palette (an image, a variable's fallback, an editor-drawn shape's SVG).
const OPAQUE_FUNCTIONS: &[&str] = &[
    "url",
    "src",
    "var",
    "env",
    "attr",
    "image-set",
    "-webkit-image-set",
];

/// CSS named colors (`transparent` and `currentColor` are not: they carry no hue).
const NAMED_COLORS: &[&str] = &[
    "aliceblue",
    "antiquewhite",
    "aqua",
    "aquamarine",
    "azure",
    "beige",
    "bisque",
    "black",
    "blanchedalmond",
    "blue",
    "blueviolet",
    "brown",
    "burlywood",
    "cadetblue",
    "chartreuse",
    "chocolate",
    "coral",
    "cornflowerblue",
    "cornsilk",
    "crimson",
    "cyan",
    "darkblue",
    "darkcyan",
    "darkgoldenrod",
    "darkgray",
    "darkgreen",
    "darkgrey",
    "darkkhaki",
    "darkmagenta",
    "darkolivegreen",
    "darkorange",
    "darkorchid",
    "darkred",
    "darksalmon",
    "darkseagreen",
    "darkslateblue",
    "darkslategray",
    "darkslategrey",
    "darkturquoise",
    "darkviolet",
    "deeppink",
    "deepskyblue",
    "dimgray",
    "dimgrey",
    "dodgerblue",
    "firebrick",
    "floralwhite",
    "forestgreen",
    "fuchsia",
    "gainsboro",
    "ghostwhite",
    "gold",
    "goldenrod",
    "gray",
    "green",
    "greenyellow",
    "grey",
    "honeydew",
    "hotpink",
    "indianred",
    "indigo",
    "ivory",
    "khaki",
    "lavender",
    "lavenderblush",
    "lawngreen",
    "lemonchiffon",
    "lightblue",
    "lightcoral",
    "lightcyan",
    "lightgoldenrodyellow",
    "lightgray",
    "lightgreen",
    "lightgrey",
    "lightpink",
    "lightsalmon",
    "lightseagreen",
    "lightskyblue",
    "lightslategray",
    "lightslategrey",
    "lightsteelblue",
    "lightyellow",
    "lime",
    "limegreen",
    "linen",
    "magenta",
    "maroon",
    "mediumaquamarine",
    "mediumblue",
    "mediumorchid",
    "mediumpurple",
    "mediumseagreen",
    "mediumslateblue",
    "mediumspringgreen",
    "mediumturquoise",
    "mediumvioletred",
    "midnightblue",
    "mintcream",
    "mistyrose",
    "moccasin",
    "navajowhite",
    "navy",
    "oldlace",
    "olive",
    "olivedrab",
    "orange",
    "orangered",
    "orchid",
    "palegoldenrod",
    "palegreen",
    "paleturquoise",
    "palevioletred",
    "papayawhip",
    "peachpuff",
    "peru",
    "pink",
    "plum",
    "powderblue",
    "purple",
    "rebeccapurple",
    "red",
    "rosybrown",
    "royalblue",
    "saddlebrown",
    "salmon",
    "sandybrown",
    "seagreen",
    "seashell",
    "sienna",
    "silver",
    "skyblue",
    "slateblue",
    "slategray",
    "slategrey",
    "snow",
    "springgreen",
    "steelblue",
    "tan",
    "teal",
    "thistle",
    "tomato",
    "turquoise",
    "violet",
    "wheat",
    "white",
    "whitesmoke",
    "yellow",
    "yellowgreen",
];

/// The palette name the editor gives a color the user picked by hand. It says nothing about
/// the color's use, so the `palette-name` lint asks for a real name.
pub fn is_placeholder_name(name: &str) -> bool {
    name.strip_prefix("custom-")
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// The deck's palette, in the order it is written. A name set twice keeps its last value, as
/// in CSS.
pub fn palette(html: &str) -> Vec<PaletteColor> {
    let mut colors: Vec<PaletteColor> = Vec::new();
    for range in style_blocks(html) {
        let found = scan_css(&html[range.clone()], false);
        for (name, value) in found.defs {
            let range = range.start + value.start..range.start + value.end;
            let color = PaletteColor {
                name,
                value: html[range.clone()].to_string(),
                range,
            };
            match colors.iter_mut().find(|c| c.name == color.name) {
                Some(existing) => *existing = color,
                None => colors.push(color),
            }
        }
    }
    colors
}

/// Every color the deck writes out instead of taking it from the palette, in document order.
pub fn literals(html: &str) -> Vec<Literal> {
    let mut out = Vec::new();
    for range in style_blocks(html) {
        let found = scan_css(&html[range.clone()], false);
        out.extend(found.literals.into_iter().map(|(r, property)| Literal {
            range: range.start + r.start..range.start + r.end,
            place: Place::Style,
            property,
            attribute: None,
        }));
    }
    for (_, tag) in html::tags(html) {
        if tag.closing {
            continue;
        }
        let style = tag
            .attrs
            .iter()
            .find(|(name, ..)| name == "style")
            .map(|(_, _, range, _)| range.clone());
        for (name, value, range, whole) in &tag.attrs {
            if name == "style" {
                let found = scan_css(value, true);
                out.extend(found.literals.into_iter().map(|(r, property)| Literal {
                    range: range.start + r.start..range.start + r.end,
                    place: Place::Inline,
                    property,
                    attribute: None,
                }));
            } else if let Some(attr) = COLOR_ATTRIBUTES.iter().find(|a| **a == name) {
                let found = scan_value(value);
                let only = found.len() == 1 && found[0] == (0..value.trim_end().len());
                let lead = html[..whole.start].trim_end().len();
                out.extend(found.into_iter().map(|r| Literal {
                    range: range.start + r.start..range.start + r.end,
                    place: Place::Attribute(attr),
                    property: name.clone(),
                    attribute: only.then(|| AttributeSite {
                        whole: lead..whole.end,
                        style: style.clone(),
                        name_end: tag.name_end,
                    }),
                }));
            }
        }
    }
    out.sort_by_key(|l| l.range.start);
    out
}

/// A color as one canonical string, to compare a written-out color with the palette's:
/// hex lowercased and expanded to six (or eight) digits, anything else lowercased without
/// spaces.
pub fn normalize(color: &str) -> String {
    let color = color.trim().to_ascii_lowercase();
    if let Some(hex) = color.strip_prefix('#') {
        if is_hex(hex) && matches!(hex.len(), 3 | 4) {
            return format!("#{}", hex.chars().flat_map(|c| [c, c]).collect::<String>());
        }
        if hex.len() == 8 && hex.ends_with("ff") {
            return format!("#{}", &hex[..6]);
        }
        return color;
    }
    color.split_whitespace().collect()
}

/// Sets palette colors (`name` without `--`) to new values, adding the ones the palette does
/// not have to the deck's first `:root` rule (made at the top of its first `<style>` if there
/// is none). Shapes the editor drew with a palette color (whose SVG names it with
/// `data-palette`) are redrawn in the new color. Values must be CSS colors.
pub fn set_colors(html: &str, colors: &[(String, String)]) -> Result<String, String> {
    for (name, value) in colors {
        if !is_name(name) {
            return Err(format!("`{name}` is not a palette color name"));
        }
        if !is_color(value) {
            return Err(format!("`{value}` is not a CSS color"));
        }
    }
    let current = palette(html);
    let mut edits: Vec<(Range<usize>, String)> = Vec::new();
    let mut added = String::new();
    for (name, value) in colors {
        match current.iter().find(|c| &c.name == name) {
            Some(c) => edits.push((c.range.clone(), value.clone())),
            None => added.push_str(&format!("\n      --{name}: {value};")),
        }
    }
    if !added.is_empty() {
        match root_rule_open(html) {
            Some(at) => edits.push((at..at, added)),
            None => {
                let block = style_blocks(html)
                    .into_iter()
                    .next()
                    .ok_or("the deck has no <style> element")?;
                // After any @import, which must come first.
                let at = imports_end(html, block);
                edits.push((at..at, format!("\n    :root {{{added}\n    }}\n")));
            }
        }
    }
    edits.sort_by_key(|(r, _)| std::cmp::Reverse(r.start));
    let mut out = html.to_string();
    for (range, text) in edits {
        out.replace_range(range, &text);
    }
    Ok(recolor_figures(&out, colors))
}

/// Moves every color the deck writes out into its palette: each becomes `var(--name)` of the
/// palette color it equals, or of a new one named for what it colors (`--text`, `--surface-2`).
/// A see-through color becomes a `color-mix` of an opaque palette color with `transparent`,
/// and a presentation attribute (`fill="#fff"`) a style, since attributes do not take
/// `var()`. Returns the deck unchanged when it has no such color.
pub fn adopt(html: &str) -> String {
    let found = literals(html);
    if found.is_empty() {
        return html.to_string();
    }
    let mut colors = palette(html);
    // Every custom property the deck sets, colors or not, so a new name clashes with none.
    let mut taken: Vec<String> = custom_properties(html);
    let mut added: Vec<(String, String)> = Vec::new();
    // The palette name for an opaque color, adding one when it is new.
    let mut name_for = |value: &str, property: &str, added: &mut Vec<(String, String)>| {
        let key = normalize(value);
        if let Some(c) = colors.iter().find(|c| normalize(&c.value) == key) {
            return c.name.clone();
        }
        let base = role(property);
        let name = (1..)
            .map(|n| {
                if n == 1 {
                    base.to_string()
                } else {
                    format!("{base}-{n}")
                }
            })
            .find(|n| !taken.contains(n))
            .unwrap_or_default();
        taken.push(name.clone());
        added.push((name.clone(), value.to_string()));
        colors.push(PaletteColor {
            name: name.clone(),
            value: value.to_string(),
            range: 0..0,
        });
        name
    };
    let mut edits: Vec<(Range<usize>, String)> = Vec::new();
    // Styles each tag takes over from its attributes: (name end, style value, declarations).
    let mut moved: Vec<(usize, Option<Range<usize>>, Vec<String>)> = Vec::new();
    for literal in found {
        let text = &html[literal.range.clone()];
        let reference = match rgba_of(text) {
            Some((_, alpha)) if alpha <= 0.0 => "transparent".to_string(),
            Some((rgb, alpha)) if alpha < 1.0 => {
                let hex = format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2]);
                let name = name_for(&hex, &literal.property, &mut added);
                let percent = (alpha * 1000.0).round() / 10.0;
                format!("color-mix(in srgb, var(--{name}) {percent}%, transparent)")
            }
            _ => format!("var(--{})", name_for(text, &literal.property, &mut added)),
        };
        match literal.attribute {
            Some(site) => {
                edits.push((site.whole, String::new()));
                let declaration = format!("{}: {reference}", literal.property);
                match moved.iter_mut().find(|(at, ..)| *at == site.name_end) {
                    Some((_, _, list)) => list.push(declaration),
                    None => moved.push((site.name_end, site.style, vec![declaration])),
                }
            }
            None => edits.push((literal.range, reference)),
        }
    }
    for (name_end, style, declarations) in moved {
        let list = declarations.join("; ");
        match style {
            Some(range) => {
                let value = html[range.clone()].trim_end();
                let at = range.start + value.len();
                let text = if value.trim().is_empty() {
                    list
                } else if value.ends_with(';') {
                    format!(" {list}")
                } else {
                    format!("; {list}")
                };
                edits.push((at..at, text));
            }
            None => edits.push((name_end..name_end, format!(" style=\"{list}\""))),
        }
    }
    if !added.is_empty() {
        let lines: String = added
            .iter()
            .map(|(name, value)| format!("\n      --{name}: {value};"))
            .collect();
        match root_rule_open(html) {
            Some(at) => edits.push((at..at, lines)),
            None => match style_blocks(html).into_iter().next() {
                Some(block) => {
                    let at = imports_end(html, block);
                    edits.push((at..at, format!("\n    :root {{{lines}\n    }}\n")));
                }
                None => {
                    let at = find_ci(html, 0, "</head").unwrap_or(0);
                    edits.push((
                        at..at,
                        format!("<style>\n    :root {{{lines}\n    }}\n  </style>\n"),
                    ));
                }
            },
        }
    }
    // Insertions at one spot keep their order: later edits go first only by start.
    edits.sort_by(|a, b| b.0.start.cmp(&a.0.start).then(b.0.end.cmp(&a.0.end)));
    let mut out = html.to_string();
    for (range, text) in edits {
        out.replace_range(range, &text);
    }
    out
}

/// The names (without `--`) of every custom property the deck mentions.
fn custom_properties(html: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for (at, _) in html.match_indices("--") {
        let name: String = html[at + 2..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        if !name.is_empty() && !names.contains(&name) {
            names.push(name);
        }
    }
    names
}

/// What a color new to the palette is named for: the kind of property it first colors.
fn role(property: &str) -> &'static str {
    let property = property.trim_start_matches("-webkit-");
    match property {
        "color" | "text-fill-color" | "caret-color" => "text",
        "box-shadow" | "filter" | "drop-shadow" => "shadow",
        "text-shadow" => "glow",
        "fill" => "fill",
        "stroke" | "text-stroke" | "text-stroke-color" => "stroke",
        "stop-color" => "stop",
        p if p.starts_with("background") => "surface",
        p if p.starts_with("border")
            || p.starts_with("outline")
            || p.starts_with("column-rule") =>
        {
            "line"
        }
        p if p.starts_with("text-decoration") => "line",
        _ => "color",
    }
}

/// The channels and alpha of a hex or numeric `rgb()` / `rgba()` color.
fn rgba_of(text: &str) -> Option<([u8; 3], f64)> {
    let text = text.trim().to_ascii_lowercase();
    if let Some(hex) = text.strip_prefix('#') {
        let full = normalize(&text);
        let digits = full.strip_prefix('#')?;
        if !is_hex(hex) {
            return None;
        }
        let byte = |i: usize| u8::from_str_radix(&digits[i..i + 2], 16).ok();
        let alpha = if digits.len() == 8 {
            f64::from(byte(6)?) / 255.0
        } else {
            1.0
        };
        return Some(([byte(0)?, byte(2)?, byte(4)?], alpha));
    }
    let inner = text
        .strip_prefix("rgba(")
        .or_else(|| text.strip_prefix("rgb("))?
        .strip_suffix(')')?;
    let parts: Vec<&str> = inner
        .split(|c: char| c == ',' || c == '/' || c.is_whitespace())
        .filter(|p| !p.is_empty())
        .collect();
    if !(3..=4).contains(&parts.len()) {
        return None;
    }
    let channel = |p: &str| -> Option<u8> {
        let v: f64 = p.parse().ok()?;
        (0.0..=255.0).contains(&v).then(|| v.round() as u8)
    };
    let alpha = match parts.get(3) {
        Some(a) if a.ends_with('%') => a.trim_end_matches('%').parse::<f64>().ok()? / 100.0,
        Some(a) => a.parse::<f64>().ok()?,
        None => 1.0,
    };
    Some((
        [channel(parts[0])?, channel(parts[1])?, channel(parts[2])?],
        alpha.clamp(0.0, 1.0),
    ))
}

/// Redraws the colors of editor-drawn shapes that name a palette color: their SVG (in a
/// `data:` URL, where `var()` does not reach) holds `fill='%23rrggbb' data-palette='name'`.
fn recolor_figures(html: &str, colors: &[(String, String)]) -> String {
    let mut out = html.to_string();
    for (name, value) in colors {
        let Some(hex) = hex_of(value) else {
            continue;
        };
        for attr in ["fill", "stroke"] {
            let marker = format!("' data-palette-{attr}='{name}'");
            let mut from = 0;
            while let Some(found) = out[from..].find(&marker) {
                let end = from + found;
                let prefix = format!("{attr}='");
                let Some(start) = out[..end].rfind(&prefix).map(|s| s + prefix.len()) else {
                    from = end + marker.len();
                    continue;
                };
                let encoded = hex.replace('#', "%23");
                out.replace_range(start..end, &encoded);
                from = start + encoded.len() + marker.len();
            }
        }
    }
    out
}

/// `#rrggbb` for a hex color, the only kind the editor's shapes draw.
fn hex_of(value: &str) -> Option<String> {
    let n = normalize(value);
    (n.starts_with('#') && n.len() == 7).then_some(n)
}

fn is_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Whether `value` is one CSS color and nothing else.
pub fn is_color(value: &str) -> bool {
    if value.contains([';', '{', '}', '<', '>', '"', '\'']) {
        return false;
    }
    let mut input = ParserInput::new(value);
    let mut p = Parser::new(&mut input);
    single_color(&mut p).is_some()
}

/// Just inside the first `:root { … }` of the deck's styles (after its `{`).
fn root_rule_open(html: &str) -> Option<usize> {
    for range in style_blocks(html) {
        if let Some(at) = scan_css(&html[range.clone()], false).root_open {
            return Some(range.start + at);
        }
    }
    None
}

/// Where the leading `@import` / `@charset` statements of a style block end.
fn imports_end(html: &str, block: Range<usize>) -> usize {
    let css = &html[block.clone()];
    let mut input = ParserInput::new(css);
    let mut p = Parser::new(&mut input);
    let mut end = 0;
    loop {
        let state = p.state();
        match p.next() {
            Ok(Token::AtKeyword(name))
                if name.eq_ignore_ascii_case("import") || name.eq_ignore_ascii_case("charset") =>
            {
                let _: Result<(), ParseError<()>> =
                    p.parse_until_after(Delimiter::Semicolon, |p| {
                        while p.next().is_ok() {}
                        Ok(())
                    });
                end = p.position().byte_index();
            }
            _ => {
                p.reset(&state);
                break;
            }
        }
    }
    block.start + end
}

/// Contents of the deck's own `<style>` elements, outside comments, scripts and the app's
/// runtime block.
pub(crate) fn style_blocks(html: &str) -> Vec<Range<usize>> {
    let runtime = html
        .find(CSS_START)
        .and_then(|s| html[s..].find(CSS_END).map(|e| s..s + e + CSS_END.len()));
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(found) = html.get(i..).and_then(|rest| rest.find('<')) {
        i += found;
        if html[i..].starts_with("<!--") {
            i = html[i..].find("-->").map_or(html.len(), |e| i + e + 3);
            continue;
        }
        let Some(tag) = parse_tag(html, i) else {
            i += 1;
            continue;
        };
        if !tag.closing && matches!(tag.name.as_str(), "script" | "style" | "textarea" | "title") {
            let close = find_ci(html, tag.end, &format!("</{}", tag.name)).unwrap_or(html.len());
            let inside_runtime = runtime.as_ref().is_some_and(|r| r.contains(&i));
            if tag.name == "style" && !inside_runtime {
                out.push(tag.end..close);
            }
            i = close;
            continue;
        }
        i = tag.end;
    }
    out
}

#[derive(Default)]
struct Found {
    /// Written-out colors, as byte ranges in the scanned text, with their property.
    literals: Vec<(Range<usize>, String)>,
    /// The property being scanned.
    property: String,
    /// Palette colors: name (without `--`) and the byte range of the value.
    defs: Vec<(String, Range<usize>)>,
    /// Just after the `{` of the first `:root` rule.
    root_open: Option<usize>,
}

impl Found {
    fn push(&mut self, range: Range<usize>) {
        self.literals.push((range, self.property.clone()));
    }
}

/// Scans a style sheet, or with `inline` the declarations of a `style` attribute.
fn scan_css(css: &str, inline: bool) -> Found {
    let mut input = ParserInput::new(css);
    let mut p = Parser::new(&mut input);
    let mut found = Found::default();
    if inline {
        declarations(&mut p, false, &mut found);
    } else {
        rules(&mut p, false, &mut found);
    }
    found
}

/// Written-out colors in one value, such as an SVG attribute's.
fn scan_value(value: &str) -> Vec<Range<usize>> {
    let mut input = ParserInput::new(value);
    let mut p = Parser::new(&mut input);
    let mut found = Found::default();
    scan(&mut p, true, &mut found);
    found.literals.into_iter().map(|(r, _)| r).collect()
}

/// A list of rules and declarations (a style sheet, or a rule's block with CSS nesting).
/// `root` says whether the block is a `:root` (or `html`) rule's.
fn rules(p: &mut Parser, root: bool, found: &mut Found) {
    loop {
        if p.is_exhausted() {
            break;
        }
        let state = p.state();
        let begin = p.position();
        let mut block = false;
        loop {
            match p.next() {
                Err(_) | Ok(Token::Semicolon) => break,
                Ok(Token::CurlyBracketBlock) => {
                    block = true;
                    break;
                }
                Ok(_) => {}
            }
        }
        if block {
            let prelude = without_comments(p.slice_from(begin).trim_end_matches('{'));
            let is_root = prelude.split(',').all(|s| {
                let s = s.trim();
                s.eq_ignore_ascii_case(":root") || s.eq_ignore_ascii_case("html")
            });
            if is_root && found.root_open.is_none() {
                found.root_open = Some(p.position().byte_index());
            }
            let _: Result<(), ParseError<()>> = p.parse_nested_block(|p| {
                rules(p, is_root, found);
                Ok(())
            });
        } else {
            p.reset(&state);
            let _: Result<(), ParseError<()>> = p.parse_until_after(Delimiter::Semicolon, |p| {
                declaration(p, root, found);
                while p.next().is_ok() {}
                Ok(())
            });
        }
    }
}

/// CSS text with its `/* … */` comments taken out.
fn without_comments(css: &str) -> String {
    let mut out = String::new();
    let mut rest = css;
    while let Some(start) = rest.find("/*") {
        out.push_str(&rest[..start]);
        rest = rest[start + 2..]
            .find("*/")
            .map_or("", |e| &rest[start + 2 + e + 2..]);
    }
    out.push_str(rest);
    out
}

/// The declarations of a `style` attribute.
fn declarations(p: &mut Parser, root: bool, found: &mut Found) {
    while !p.is_exhausted() {
        let _: Result<(), ParseError<()>> = p.parse_until_after(Delimiter::Semicolon, |p| {
            declaration(p, root, found);
            while p.next().is_ok() {}
            Ok(())
        });
    }
}

fn declaration(p: &mut Parser, root: bool, found: &mut Found) {
    let Ok(Token::Ident(name)) = p.next().cloned() else {
        return;
    };
    if p.expect_colon().is_err() {
        return;
    }
    let name = name.to_ascii_lowercase();
    // Masks use colors only for their alpha.
    if name.starts_with("mask") || name.starts_with("-webkit-mask") {
        return;
    }
    let custom = name.starts_with("--");
    found.property = name.clone();
    if custom && root {
        let state = p.state();
        if let Some(range) = single_color(p) {
            found.defs.push((name[2..].to_string(), range));
            return;
        }
        p.reset(&state);
    }
    scan(p, custom || takes_color(&name), found);
}

/// Whether a property's value may hold a named color (`red`), so its idents are checked.
fn takes_color(property: &str) -> bool {
    let property = property.trim_start_matches("-webkit-");
    property.contains("color")
        || matches!(
            property,
            "background"
                | "background-image"
                | "box-shadow"
                | "text-shadow"
                | "fill"
                | "stroke"
                | "filter"
                | "backdrop-filter"
                | "outline"
                | "text-decoration"
                | "column-rule"
                | "text-stroke"
                | "text-emphasis"
        )
        || (property.starts_with("border")
            && !["radius", "width", "style", "collapse", "spacing"]
                .iter()
                .any(|w| property.contains(w)))
}

/// The byte range of the value when the rest of `p` is one color (and maybe `!important`).
fn single_color(p: &mut Parser) -> Option<Range<usize>> {
    skip_space(p);
    let start = p.position().byte_index();
    let token = p.next().ok()?.clone();
    let is_color = match &token {
        Token::Hash(v) | Token::IDHash(v) => is_hex(v),
        Token::Ident(v) => is_named(v),
        Token::Function(f) if is_color_function(f) => {
            let relative: Result<bool, ParseError<()>> = p.parse_nested_block(|p| {
                let relative = p.try_parse(|p| p.expect_ident_matching("from")).is_ok();
                while p.next().is_ok() {}
                Ok(relative)
            });
            !relative.unwrap_or(true)
        }
        _ => false,
    };
    let end = p.position().byte_index();
    let _ = p.try_parse(|p| -> Result<(), cssparser::BasicParseError> {
        p.expect_delim('!')?;
        p.expect_ident_matching("important")
    });
    (is_color && p.is_exhausted()).then_some(start..end)
}

/// Moves past whitespace and comments.
fn skip_space(p: &mut Parser) {
    loop {
        let state = p.state();
        match p.next_including_whitespace_and_comments() {
            Ok(Token::WhiteSpace(_) | Token::Comment(_)) => {}
            _ => {
                p.reset(&state);
                break;
            }
        }
    }
}

fn is_color_function(name: &str) -> bool {
    COLOR_FUNCTIONS.iter().any(|f| name.eq_ignore_ascii_case(f))
}

/// Finds written-out colors in the rest of `p`. `named` checks idents for named colors.
fn scan(p: &mut Parser, named: bool, found: &mut Found) {
    loop {
        // Past whitespace first, so a literal's range starts at its first byte.
        skip_space(p);
        let at = p.position().byte_index();
        let Ok(token) = p.next().cloned() else {
            break;
        };
        match token {
            Token::Hash(v) | Token::IDHash(v) if is_hex(&v) => {
                found.push(at..p.position().byte_index())
            }
            Token::Ident(v) if named && is_named(&v) => found.push(at..p.position().byte_index()),
            Token::Function(f) => {
                let f = f.to_ascii_lowercase();
                if OPAQUE_FUNCTIONS.contains(&f.as_str()) {
                    continue;
                }
                if is_color_function(&f) {
                    // Relative colors (`rgb(from var(--ink) r g b / 0.5)`) derive from the
                    // palette; check only their origin.
                    let relative: Result<bool, ParseError<()>> = p.parse_nested_block(|p| {
                        if p.try_parse(|p| p.expect_ident_matching("from")).is_ok() {
                            scan(p, true, found);
                            Ok(true)
                        } else {
                            while p.next().is_ok() {}
                            Ok(false)
                        }
                    });
                    if !relative.unwrap_or(false) {
                        found.push(at..p.position().byte_index());
                    }
                    continue;
                }
                let named = named || matches!(f.as_str(), "color-mix" | "light-dark");
                let _: Result<(), ParseError<()>> = p.parse_nested_block(|p| {
                    scan(p, named, found);
                    Ok(())
                });
            }
            Token::ParenthesisBlock | Token::SquareBracketBlock | Token::CurlyBracketBlock => {
                let _: Result<(), ParseError<()>> = p.parse_nested_block(|p| {
                    scan(p, named, found);
                    Ok(())
                });
            }
            _ => {}
        }
    }
}

fn is_hex(v: &str) -> bool {
    matches!(v.len(), 3 | 4 | 6 | 8) && v.bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_named(v: &str) -> bool {
    NAMED_COLORS
        .binary_search(&v.to_ascii_lowercase().as_str())
        .is_ok()
}

/// The deck with every palette reference written out again (`var(--accent)` as its color, a
/// see-through mix as `rgba(…)`), for tests that check colors in generated decks.
#[cfg(test)]
pub(crate) fn resolve(html: &str) -> String {
    let mut out = html.to_string();
    for color in palette(html) {
        let value = &color.value;
        if let Some((rgb, _)) = rgba_of(value) {
            let [r, g, b] = rgb;
            let prefix = format!("color-mix(in srgb, var(--{}) ", color.name);
            while let Some(at) = out.find(&prefix) {
                let rest = &out[at + prefix.len()..];
                let Some(percent_end) = rest.find("%, transparent)") else {
                    break;
                };
                let alpha: f64 = rest[..percent_end].parse::<f64>().unwrap_or(100.0) / 100.0;
                let alpha = (alpha * 1000.0).round() / 1000.0;
                let end = at + prefix.len() + percent_end + "%, transparent)".len();
                out.replace_range(at..end, &format!("rgba({r}, {g}, {b}, {alpha})"));
            }
        }
        out = out.replace(&format!("var(--{})", color.name), value);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deck(style: &str, body: &str) -> String {
        format!("<!DOCTYPE html><html><head><style>{style}</style></head><body><main class=\"deck\">{body}</main></body></html>")
    }

    fn found(html: &str) -> Vec<&str> {
        literals(html)
            .iter()
            .map(|l| &html[l.range.clone()])
            .collect()
    }

    #[test]
    fn reads_the_root_palette() {
        let html = deck(
            ":root { --bg: #f4f4f0; --ink: white !important; --soft: rgb(0 0 0 / 0.3); --font: \"Inter\"; --line: 4px solid #000; --mix: color-mix(in srgb, var(--ink) 20%, transparent); }",
            "",
        );
        let colors = palette(&html);
        let named: Vec<_> = colors
            .iter()
            .map(|c| (c.name.as_str(), c.value.as_str()))
            .collect();
        assert_eq!(
            named,
            [
                ("bg", "#f4f4f0"),
                ("ink", "white"),
                ("soft", "rgb(0 0 0 / 0.3)")
            ]
        );
        assert_eq!(&html[colors[0].range.clone()], "#f4f4f0");
        // A shorthand holding a color is no palette color, and its color is written out.
        assert_eq!(found(&html), ["#000"]);
    }

    #[test]
    fn a_comment_before_the_root_rule_is_no_part_of_its_selector() {
        let html = deck("/* Theme */\n:root /* palette */ { --bg: #000; }", "");
        assert_eq!(palette(&html).len(), 1);
        assert!(found(&html).is_empty());
    }

    #[test]
    fn root_in_media_queries_and_html_selector_count_later_values_win() {
        let html = deck(
            "html { --a: #111; } @media (prefers-color-scheme: dark) { :root { --a: #222; --b: red; } }",
            "",
        );
        let colors = palette(&html);
        assert_eq!(colors.len(), 2);
        assert_eq!(colors[0].value, "#222");
        assert!(found(&html).is_empty());
    }

    #[test]
    fn finds_colors_written_out_in_styles() {
        let html = deck(
            ":root { --accent: #e30613; } .slide { color: #111; background: linear-gradient(red, var(--accent)); box-shadow: 0 0 4px rgba(0, 0, 0, 0.4); border: 2px solid Black; } .a { --local: #abc; }",
            "",
        );
        assert_eq!(
            found(&html),
            ["#111", "red", "rgba(0, 0, 0, 0.4)", "Black", "#abc"]
        );
    }

    #[test]
    fn allows_palette_references_and_colorless_keywords() {
        let html = deck(
            ":root { --accent: #e30613; } .slide { color: var(--accent); background: color-mix(in srgb, var(--accent) 30%, transparent); border-color: currentColor; outline: none; fill: rgb(from var(--accent) r g b / 0.5); color: var(--x, #fff); }",
            "",
        );
        assert!(found(&html).is_empty(), "{:?}", found(&html));
    }

    #[test]
    fn checks_the_origin_of_relative_colors_and_mix_arguments() {
        let html = deck(
            ".a { color: rgb(from #fff r g b / 0.5); background: color-mix(in oklch, white, var(--x)); }",
            "",
        );
        assert_eq!(found(&html), ["#fff", "white"]);
    }

    #[test]
    fn ignores_selectors_urls_masks_and_names_outside_color_properties() {
        let html = deck(
            "#fff { color: var(--a); } a#title:hover { color: var(--a); } .b { background: url(\"data:image/svg+xml,%3Cpath fill='%23fff'/%3E\") , url(#grad); mask-image: linear-gradient(#000, transparent); font-family: Red, serif; animation: tan 1s; }",
            "",
        );
        assert!(found(&html).is_empty(), "{:?}", found(&html));
    }

    #[test]
    fn checks_nested_rules_and_keyframes() {
        let html = deck(
            ".card { color: var(--a); &:hover { color: #f00; } } @keyframes glow { from { color: blue; } }",
            "",
        );
        assert_eq!(found(&html), ["#f00", "blue"]);
    }

    #[test]
    fn finds_inline_and_svg_attribute_colors() {
        let html = deck(
            "",
            "<section class=\"slide\" id=\"a\"><p style=\"color: #ff0000; font-size: 20px\">x</p><svg><path fill=\"red\" stroke=\"currentColor\"/><stop stop-color=\"#000\"/><path fill=\"url(#g)\" style=\"fill: var(--accent)\"/></svg></section>",
        );
        let all = literals(&html);
        let places: Vec<_> = all
            .iter()
            .map(|l| (&html[l.range.clone()], l.place))
            .collect();
        assert_eq!(
            places,
            [
                ("#ff0000", Place::Inline),
                ("red", Place::Attribute("fill")),
                ("#000", Place::Attribute("stop-color")),
            ]
        );
    }

    #[test]
    fn skips_the_runtime_comments_and_scripts() {
        let html = format!(
            "<html><head>{CSS_START}<style>.x {{ background: #000; }}</style>{CSS_END}<style>.y {{ color: var(--a); }}</style></head><body><!-- <p style=\"color: red\"></p> --><script>let c = \"<p style='color: red'>\";</script></body></html>"
        );
        assert!(found(&html).is_empty(), "{:?}", found(&html));
    }

    #[test]
    fn normalizes_colors_for_comparison() {
        assert_eq!(normalize("#ABC"), "#aabbcc");
        assert_eq!(normalize("#aabbccff"), "#aabbcc");
        assert_eq!(normalize("RGB(0, 0, 0)"), "rgb(0,0,0)");
        assert_eq!(normalize("#e30613"), "#e30613");
    }

    #[test]
    fn placeholder_names() {
        assert!(is_placeholder_name("custom-1"));
        assert!(is_placeholder_name("custom-12"));
        assert!(!is_placeholder_name("custom-"));
        assert!(!is_placeholder_name("custom-blue"));
        assert!(!is_placeholder_name("accent"));
    }

    #[test]
    fn tells_colors_apart() {
        assert!(is_color("#fff"));
        assert!(is_color("oklch(0.7 0.1 200)"));
        assert!(is_color(" tomato "));
        assert!(!is_color("var(--a)"));
        assert!(!is_color("#fff; color: red"));
        assert!(!is_color("4px solid #000"));
        assert!(!is_color("rgb(from var(--a) r g b)"));
    }

    #[test]
    fn sets_existing_and_new_colors() {
        let html = deck(
            "@import url(\"x.css\");\n:root { --bg: #fff; --ink: #000; }",
            "",
        );
        let out = set_colors(
            &html,
            &[
                ("ink".into(), "#222222".into()),
                ("accent".into(), "#e30613".into()),
            ],
        )
        .unwrap();
        let colors = palette(&out);
        let named: Vec<_> = colors
            .iter()
            .map(|c| (c.name.as_str(), c.value.as_str()))
            .collect();
        assert_eq!(
            named,
            [("accent", "#e30613"), ("bg", "#fff"), ("ink", "#222222")]
        );
    }

    #[test]
    fn adds_a_root_rule_after_imports_when_there_is_none() {
        let html = deck("@import url(\"x.css\");\n.slide { color: red; }", "");
        let out = set_colors(&html, &[("ink".into(), "#111".into())]).unwrap();
        let import = out.find("@import").unwrap();
        let root = out.find(":root").unwrap();
        assert!(import < root && root < out.find(".slide").unwrap());
        assert_eq!(palette(&out)[0].value, "#111");
    }

    #[test]
    fn refuses_bad_names_and_values() {
        let html = deck(":root { --a: #fff; }", "");
        assert!(set_colors(&html, &[("a; color".into(), "#fff".into())]).is_err());
        assert!(set_colors(&html, &[("a".into(), "#fff; } body { x".into())]).is_err());
        assert!(set_colors(
            &deck("", "").replace("<style></style>", ""),
            &[("a".into(), "#fff".into())]
        )
        .is_err());
    }

    #[test]
    fn adopt_moves_every_written_out_color_into_the_palette() {
        let html = deck(
            ":root { --accent: #ff2a6d; --line: 4px solid #000; }\n.a { color: #FF2A6D; box-shadow: 0 0 4px rgba(255, 42, 109, 0.4); background: rgb(13 2 33 / 70%); border-color: rgba(0,0,0,0); }\n.b { color: hsl(10 50% 50%); }",
            "<p style=\"color: white\">x</p><svg><path fill=\"#ffffff\" stroke=\"#123456\" d=\"M0\"/><path style=\"opacity: 0.5\" fill=\"#ffffff\"/></svg>",
        );
        let out = adopt(&html);
        assert!(literals(&out).is_empty(), "{:?}", found(&out));
        let colors = palette(&out);
        let named: Vec<_> = colors
            .iter()
            .map(|c| (c.name.as_str(), c.value.as_str()))
            .collect();
        assert_eq!(
            named,
            [
                ("color", "#000"),
                ("surface", "#0d0221"),
                ("text", "hsl(10 50% 50%)"),
                ("text-2", "white"),
                ("fill", "#ffffff"),
                ("stroke", "#123456"),
                ("accent", "#ff2a6d"),
            ]
        );
        assert!(out.contains("--line: 4px solid var(--color);"));
        assert!(out.contains(".a { color: var(--accent); box-shadow: 0 0 4px color-mix(in srgb, var(--accent) 40%, transparent); background: color-mix(in srgb, var(--surface) 70%, transparent); border-color: transparent; }"));
        assert!(out.contains("<p style=\"color: var(--text-2)\">"));
        assert!(out.contains("<path style=\"fill: var(--fill); stroke: var(--stroke)\" d=\"M0\"/>"));
        assert!(out.contains("<path style=\"opacity: 0.5; fill: var(--fill)\"/>"));
        assert_eq!(adopt(&out), out);
    }

    #[test]
    fn adopt_makes_a_palette_where_there_is_none() {
        let html =
            "<html><head><title>x</title></head><body><p style=\"color: red\">x</p></body></html>";
        let out = adopt(html);
        assert!(
            out.contains("<style>\n    :root {\n      --text: red;\n    }\n  </style>\n</head>")
        );
        assert!(out.contains("style=\"color: var(--text)\""));
    }

    #[test]
    fn reads_hex_and_rgb_channels() {
        assert_eq!(rgba_of("#fff"), Some(([255, 255, 255], 1.0)));
        assert_eq!(
            rgba_of("#00000080").map(|(c, a)| (c, (a * 100.0).round())),
            Some(([0, 0, 0], 50.0))
        );
        assert_eq!(rgba_of("rgba(1, 2, 3, 0.5)"), Some(([1, 2, 3], 0.5)));
        assert_eq!(rgba_of("rgb(1 2 3 / 25%)"), Some(([1, 2, 3], 0.25)));
        assert_eq!(rgba_of("rgb(10% 2 3)"), None);
        assert_eq!(rgba_of("tomato"), None);
    }

    #[test]
    fn recolors_figures_drawn_with_a_palette_color() {
        let html = deck(
            ":root { --accent: #ff0000; }",
            "<div data-shape=\"star\" style=\"background-image: url(&quot;data:image/svg+xml,<path d='M0' fill='%23ff0000' data-palette-fill='accent'/><path stroke='%23000000' data-palette-stroke='ink'/>&quot;)\"></div>",
        );
        let out = set_colors(&html, &[("accent".into(), "#00FF00".into())]).unwrap();
        assert!(out.contains("fill='%2300ff00' data-palette-fill='accent'"));
        assert!(out.contains("stroke='%23000000' data-palette-stroke='ink'"));
    }
}
