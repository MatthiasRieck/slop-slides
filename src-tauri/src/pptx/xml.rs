//! A small read-only XML tree over quick-xml, enough to walk Office parts. Elements are named
//! without their namespace prefix (`p:sp` is `sp`); attributes keep theirs (`r:id`). Custom
//! entities are never expanded, so a hostile file cannot grow through them.

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;

/// Deeper elements are refused: no real part comes close, and the tree is walked recursively.
const MAX_DEPTH: usize = 256;

#[derive(Debug, Default, Clone)]
pub struct Node {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<Node>,
    pub text: String,
}

fn element(start: &BytesStart) -> Node {
    let name = String::from_utf8_lossy(start.local_name().as_ref()).into_owned();
    let attrs = start
        .attributes()
        .flatten()
        .map(|a| {
            let key = String::from_utf8_lossy(a.key.as_ref()).into_owned();
            let value = a
                .normalized_value(quick_xml::XmlVersion::default())
                .map(|v| v.into_owned())
                .unwrap_or_else(|_| String::from_utf8_lossy(&a.value).into_owned());
            (key, value)
        })
        .collect();
    Node {
        name,
        attrs,
        ..Node::default()
    }
}

/// Parses `bytes`; `None` when they are not well-formed XML with a root element.
pub fn parse(bytes: &[u8]) -> Option<Node> {
    let mut reader = Reader::from_reader(bytes);
    let mut stack: Vec<Node> = Vec::new();
    let mut buf = Vec::new();
    loop {
        let event = reader.read_event_into(&mut buf).ok()?;
        match event {
            Event::Start(ref start) => {
                if stack.len() >= MAX_DEPTH {
                    return None;
                }
                stack.push(element(start));
            }
            Event::Empty(ref start) => {
                let node = element(start);
                match stack.last_mut() {
                    Some(parent) => parent.children.push(node),
                    None => return Some(node),
                }
            }
            Event::End(_) => {
                let node = stack.pop()?;
                match stack.last_mut() {
                    Some(parent) => parent.children.push(node),
                    None => return Some(node),
                }
            }
            Event::Text(ref text) => {
                if let Some(top) = stack.last_mut() {
                    top.text.push_str(&text.decode().ok()?);
                }
            }
            Event::CData(ref text) => {
                if let Some(top) = stack.last_mut() {
                    top.text.push_str(&String::from_utf8_lossy(text.as_ref()));
                }
            }
            Event::GeneralRef(ref entity) => {
                if let Some(top) = stack.last_mut() {
                    let name = entity.decode().ok()?;
                    let text = match name.as_ref() {
                        "amp" => "&".to_string(),
                        "lt" => "<".to_string(),
                        "gt" => ">".to_string(),
                        "quot" => "\"".to_string(),
                        "apos" => "'".to_string(),
                        _ => entity
                            .resolve_char_ref()
                            .ok()
                            .flatten()
                            .map(String::from)
                            .unwrap_or_default(),
                    };
                    top.text.push_str(&text);
                }
            }
            Event::Eof => return None,
            _ => {}
        }
        buf.clear();
    }
}

impl Node {
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    pub fn num(&self, name: &str) -> Option<f64> {
        self.attr(name)?
            .parse()
            .ok()
            .filter(|v: &f64| v.is_finite())
    }

    /// An `xsd:boolean` attribute.
    pub fn flag(&self, name: &str) -> Option<bool> {
        self.attr(name).map(|v| v == "1" || v == "true")
    }

    pub fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|c| c.name == name)
    }

    pub fn all<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Node> {
        self.children.iter().filter(move |c| c.name == name)
    }

    /// The element at the end of `path`, following first matches.
    pub fn at(&self, path: &[&str]) -> Option<&Node> {
        path.iter().try_fold(self, |node, name| node.child(name))
    }

    /// The first element named `name` at or under this one.
    pub fn find(&self, name: &str) -> Option<&Node> {
        if self.name == name {
            return Some(self);
        }
        self.children.iter().find_map(|c| c.find(name))
    }

    /// Every element named `name` at or under this one, in document order.
    pub fn find_all<'a>(&'a self, name: &str, out: &mut Vec<&'a Node>) {
        if self.name == name {
            out.push(self);
        }
        for child in &self.children {
            child.find_all(name, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_prefixes_from_elements_and_keeps_them_on_attributes() {
        let root = parse(
            br#"<p:sld xmlns:p="urn:p" xmlns:r="urn:r"><p:sp id="4" r:id="rId2"><a:t>x &amp; y &#169;</a:t></p:sp></p:sld>"#,
        )
        .unwrap();
        assert_eq!(root.name, "sld");
        let sp = root.child("sp").unwrap();
        assert_eq!(sp.attr("id"), Some("4"));
        assert_eq!(sp.attr("r:id"), Some("rId2"));
        assert_eq!(sp.child("t").unwrap().text, "x & y ©");
    }

    #[test]
    fn rejects_broken_and_endlessly_nested_xml() {
        assert!(parse(b"<a><b></a>").is_none());
        assert!(parse(b"<a>").is_none());
        assert!(parse(b"").is_none());
        let deep = "<a>".repeat(MAX_DEPTH + 1) + &"</a>".repeat(MAX_DEPTH + 1);
        assert!(parse(deep.as_bytes()).is_none());
    }

    #[test]
    fn finds_elements_anywhere_under_a_node() {
        let root = parse(b"<a><b><c n='1'/></b><c n='2'/></a>").unwrap();
        assert_eq!(root.find("c").unwrap().attr("n"), Some("1"));
        let mut found = Vec::new();
        root.find_all("c", &mut found);
        assert_eq!(found.len(), 2);
        assert_eq!(root.at(&["b", "c"]).unwrap().num("n"), Some(1.0));
    }
}
