//! What the linter looks for in CSS: selectors that name slide ids, animation delays, 3D tilts,
//! and entrance keyframes. Plain text in, positions out; [`super::styles`] reports them.

use std::collections::HashSet;

/// Tokenize rather than search text: comments, strings, URL fragments and declaration
/// colors must not count as selectors. Pending references become selectors only when
/// followed by a rule block; recurse into grouping rules and CSS nesting as well.
pub(super) fn css_id_references<'i>(
    parser: &mut cssparser::Parser<'i, '_>,
    found: &mut Vec<(usize, String)>,
) -> Vec<(usize, String)> {
    use cssparser::Token;
    let mut pending = Vec::new();
    let mut at_rule = false;
    loop {
        let at = parser.position().byte_index();
        let Ok(token) = parser.next_including_whitespace_and_comments().cloned() else {
            break;
        };
        match token {
            Token::AtKeyword(name) => at_rule = !name.eq_ignore_ascii_case("scope"),
            Token::IDHash(id) => pending.push((at, id.to_string())),
            Token::Semicolon => {
                pending.clear();
                at_rule = false;
            }
            Token::CurlyBracketBlock => {
                if at_rule {
                    pending.clear();
                }
                at_rule = false;
                found.append(&mut pending);
                let _: Result<_, cssparser::ParseError<'i, ()>> = parser.parse_nested_block(|p| {
                    css_id_references(p, found);
                    Ok(())
                });
            }
            Token::Function(_) | Token::ParenthesisBlock => {
                let _: Result<_, cssparser::ParseError<'i, ()>> = parser.parse_nested_block(|p| {
                    pending.extend(css_id_references(p, found));
                    Ok(())
                });
            }
            Token::SquareBracketBlock => {
                let _: Result<_, cssparser::ParseError<'i, ()>> = parser.parse_nested_block(|p| {
                    // [id="title"] is just as dependent on identity as #title.
                    if p.expect_ident_matching("id").is_ok() && p.expect_delim('=').is_ok() {
                        if let Ok(Token::Ident(id) | Token::QuotedString(id)) = p.next() {
                            pending.push((at, id.to_string()));
                        }
                    }
                    // Consume flags / other attribute selectors without treating their
                    // values as CSS id selectors.
                    while p.next().is_ok() {}
                    Ok(())
                });
            }
            _ => {}
        }
    }
    pending
}

/// The steepest a 3D tilt (rotateX/rotateY) draws about right in exports, PDFs and renders.
pub(super) const STEEPEST_TILT: f64 = 45.0;

/// The shortest animation delay taken to time something to its slide, in seconds.
const TIMED_DELAY: f64 = 1.0;

/// The rules of `css` (outside `@keyframes`) that delay an animation to time it without being
/// under `.active`: where each starts, and its selector. `easings` are custom properties that
/// hold an easing, not a time.
pub(super) fn untimed_delays<'a>(css: &'a str, easings: &HashSet<&str>) -> Vec<(usize, &'a str)> {
    let mut found = Vec::new();
    let bytes = css.as_bytes();
    // Where the text since the last rule (a selector or an at-rule's prelude) starts.
    let mut head = 0;
    // A rule's declarations are skipped whole, so the scan only ever is between rules here.
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i = css[i + 2..]
                    .find("*/")
                    .map_or(bytes.len(), |e| i + 2 + e + 2);
                head = i;
                continue;
            }
            // A statement at-rule (`@import url(…);`) ends before the next rule.
            b';' => head = i + 1,
            b'{' => {
                let prelude = css[head..i].trim();
                if prelude.starts_with("@keyframes") || prelude.starts_with("@-webkit-keyframes") {
                    // Skip the whole block: its "rules" are keyframes.
                    let mut depth = 0;
                    while i < bytes.len() {
                        match bytes[i] {
                            b'{' => depth += 1,
                            b'}' => {
                                depth -= 1;
                                if depth == 0 {
                                    break;
                                }
                            }
                            _ => {}
                        }
                        i += 1;
                    }
                    head = i + 1;
                } else if prelude.starts_with('@') {
                    head = i + 1;
                } else {
                    let body_end = css[i..].find('}').map_or(css.len(), |e| i + e);
                    let body = &css[i + 1..body_end];
                    let selector = &css[head..i];
                    let ungated = selector.split(',').any(|part| !part.contains(".active"));
                    if ungated && delays_to_time(body, easings) {
                        let lead = selector.len() - selector.trim_start().len();
                        found.push((head + lead, selector));
                    }
                    i = body_end;
                    head = i + 1;
                }
            }
            b'}' => head = i + 1,
            _ => {}
        }
        i += 1;
    }
    found
}

/// Whether `declarations` delay an animation by [`TIMED_DELAY`] or more, or by a `var()` or
/// `calc()` (as times set per element are): in `animation-delay`, or as the second time of the
/// `animation` shorthand, where a `var()` of one of the `easings` is the easing, not a time.
fn delays_to_time(declarations: &str, easings: &HashSet<&str>) -> bool {
    let easing = |word: &str| {
        word.strip_prefix("var(")
            .and_then(|rest| rest.split([',', ')']).next())
            .is_some_and(|name| easings.contains(name.trim()))
    };
    let timed = |value: &str| {
        let value = value.trim();
        value.starts_with("var(")
            || value.starts_with("calc(")
            || seconds(value).is_some_and(|s| s >= TIMED_DELAY)
    };
    declarations.split(';').any(|declaration| {
        let Some((name, value)) = declaration.split_once(':') else {
            return false;
        };
        let value = value.trim().trim_end_matches("!important").trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "animation-delay" => value.split(',').any(timed),
            "animation" => value.split(',').any(|one| {
                // The first time is the duration, the second the delay.
                let times: Vec<&str> = css_words(one)
                    .into_iter()
                    .filter(|w| {
                        seconds(w).is_some()
                            || (w.starts_with("var(") && !easing(w))
                            || w.starts_with("calc(")
                    })
                    .collect();
                times.get(1).is_some_and(|delay| timed(delay))
            }),
            _ => false,
        }
    })
}

/// Custom properties `html` sets to an easing (`--spring: cubic-bezier(…)`), in its styles or
/// inline: in the `animation` shorthand such a `var()` sits where a delay may, but is none.
pub(super) fn easing_vars(html: &str) -> HashSet<&str> {
    let mut found = HashSet::new();
    for (at, _) in html.match_indices("--") {
        let rest = &html[at..];
        let name_end = rest[2..]
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
            .map_or(rest.len(), |e| e + 2);
        let Some(value) = rest[name_end..].trim_start().strip_prefix(':') else {
            continue;
        };
        let value = value.trim_start().to_ascii_lowercase();
        let easing = [
            "cubic-bezier(",
            "steps(",
            "linear(",
            "ease",
            "step-start",
            "step-end",
        ]
        .iter()
        .any(|start| value.starts_with(start));
        if easing && name_end > 2 {
            found.insert(&rest[..name_end]);
        }
    }
    found
}

/// The words of a CSS value, a function call with its arguments being one.
fn css_words(value: &str) -> Vec<&str> {
    let mut words = Vec::new();
    let (mut depth, mut start) = (0, None);
    for (i, c) in value.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            c if c.is_whitespace() && depth == 0 => {
                if let Some(s) = start.take() {
                    words.push(&value[s..i]);
                }
                continue;
            }
            _ => {}
        }
        start.get_or_insert(i);
    }
    if let Some(s) = start {
        words.push(&value[s..]);
    }
    words
}

/// A CSS time in seconds: `s` or `ms`; None for anything else.
fn seconds(time: &str) -> Option<f64> {
    let time = time.trim().to_ascii_lowercase();
    if let Some(ms) = time.strip_suffix("ms") {
        return ms.parse::<f64>().ok().map(|ms| ms / 1000.0);
    }
    time.strip_suffix('s')?.parse().ok()
}

/// Where `css` tilts something in 3D by more than [`STEEPEST_TILT`], and by how much, in degrees.
pub(super) fn steep_tilts(css: &str) -> Vec<(usize, f64)> {
    let lower = css.to_ascii_lowercase();
    let mut found = Vec::new();
    for function in ["rotatex(", "rotatey(", "rotate3d("] {
        for (at, _) in lower.match_indices(function) {
            let args = &lower[at + function.len()..];
            let Some(close) = args.find(')') else {
                continue;
            };
            // rotate3d(x, y, z, angle) tilts in 3D unless it turns about z alone.
            let args = &args[..close];
            let angle = if function == "rotate3d(" {
                let parts: Vec<&str> = args.split(',').map(str::trim).collect();
                let flat =
                    parts.len() == 4 && parts[..2].iter().all(|p| p.parse::<f64>() == Ok(0.0));
                if parts.len() != 4 || flat {
                    continue;
                }
                parts[3]
            } else {
                args.trim()
            };
            if let Some(degrees) = degrees(angle).filter(|d| {
                d.abs() % 180.0 > STEEPEST_TILT && d.abs() % 180.0 < 180.0 - STEEPEST_TILT
            }) {
                found.push((at, degrees.abs()));
            }
        }
    }
    found.sort_by_key(|(at, _)| *at);
    found
}

/// A CSS angle in degrees: `deg`, `rad`, `grad` or `turn`; None for anything else (a `var()`).
fn degrees(angle: &str) -> Option<f64> {
    let angle = angle.trim();
    let split = angle.find(|c: char| c.is_ascii_alphabetic())?;
    let value: f64 = angle[..split].trim().parse().ok()?;
    Some(match &angle[split..] {
        "deg" => value,
        "rad" => value.to_degrees(),
        "grad" => value * 0.9,
        "turn" => value * 360.0,
        _ => return None,
    })
}

/// `@keyframes` blocks in `css` that set `transform`: where each starts, and its name.
pub(super) fn transform_keyframes(css: &str) -> Vec<(usize, &str)> {
    let mut found = Vec::new();
    for (at, _) in css.match_indices("@keyframes") {
        let rest = &css[at + "@keyframes".len()..];
        let Some(brace) = rest.find('{') else {
            continue;
        };
        let name = rest[..brace].trim();
        let mut depth = 0;
        let body_end = rest[brace..]
            .char_indices()
            .find_map(|(i, c)| {
                match c {
                    '{' => depth += 1,
                    '}' => depth -= 1,
                    _ => {}
                }
                (depth == 0).then_some(brace + i)
            })
            .unwrap_or(rest.len());
        if !name.is_empty() && sets_property(&rest[brace..body_end], "transform") {
            found.push((at, name));
        }
    }
    found
}

/// Whether `css` declares `property` itself (not, say, `text-transform` or `transform-origin`).
fn sets_property(css: &str, property: &str) -> bool {
    css.match_indices(property).any(|(i, _)| {
        let before = css[..i].chars().next_back();
        let after = css[i + property.len()..].trim_start();
        !before.is_some_and(|c| c.is_ascii_alphanumeric() || c == '-') && after.starts_with(':')
    })
}

/// Whether a rule whose selector mentions `.reveal` uses the keyframes `name`.
pub(super) fn animates_reveal(css: &str, name: &str) -> bool {
    css.match_indices(name).any(|(i, _)| {
        let word =
            |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if word(css[..i].chars().next_back()) || word(css[i + name.len()..].chars().next()) {
            return false;
        }
        let Some(open) = css[..i].rfind('{') else {
            return false;
        };
        let selector_start = css[..open].rfind('}').map_or(0, |b| b + 1);
        let selector = &css[selector_start..open];
        !selector.contains("@keyframes")
            && selector.contains(".reveal")
            && css[open..i].find('}').is_none()
    })
}
