//! The `.pptx` file as a package of parts: reading them within limits, and their
//! relationships.

use super::*;

/// The file's parts, read on demand.
pub(super) struct Package {
    pub(super) archive: zip::ZipArchive<Cursor<Vec<u8>>>,
    pub(super) read_so_far: u64,
}

/// A part's relationships: id to target (a part path, or a URL when external).
#[derive(Default, Clone)]
pub(super) struct Rels(HashMap<String, Rel>);

#[derive(Clone)]
pub(super) struct Rel {
    pub(super) kind: String,
    pub(super) target: String,
    pub(super) external: bool,
}

impl Rels {
    pub(super) fn get(&self, id: &str) -> Option<&Rel> {
        self.0.get(id)
    }

    /// The first target whose type ends in `/<kind>`.
    pub(super) fn of_kind(&self, kind: &str) -> Option<&str> {
        let suffix = format!("/{kind}");
        let mut matches: Vec<&Rel> = self
            .0
            .values()
            .filter(|r| r.kind.ends_with(&suffix))
            .collect();
        matches.sort_by(|a, b| a.target.cmp(&b.target));
        matches.first().map(|r| r.target.as_str())
    }
}

/// `target` of a relationship from the part `from`, as a path in the package.
pub(super) fn resolve_target(from: &str, target: &str) -> String {
    if let Some(absolute) = target.strip_prefix('/') {
        return absolute.to_string();
    }
    let mut parts: Vec<&str> = from.split('/').collect();
    parts.pop();
    for piece in target.split('/') {
        match piece {
            "." | "" => {}
            ".." => {
                parts.pop();
            }
            piece => parts.push(piece),
        }
    }
    parts.join("/")
}

impl Package {
    pub(super) fn open(bytes: Vec<u8>) -> Result<Package> {
        let archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| {
            Error::msg(
                "This is not a PowerPoint .pptx file. Older .ppt files must be saved as .pptx first.",
            )
        })?;
        Ok(Package {
            archive,
            read_so_far: 0,
        })
    }

    pub(super) fn read(&mut self, path: &str) -> Option<Vec<u8>> {
        let entry = self.archive.by_name(path).ok()?;
        let room = MAX_PART.min(MAX_TOTAL.saturating_sub(self.read_so_far));
        let mut bytes = Vec::new();
        entry.take(room + 1).read_to_end(&mut bytes).ok()?;
        if bytes.len() as u64 > room {
            return None;
        }
        self.read_so_far += bytes.len() as u64;
        Some(bytes)
    }

    pub(super) fn xml(&mut self, path: &str) -> Option<Node> {
        xml::parse(&self.read(path)?)
    }

    pub(super) fn rels(&mut self, part: &str) -> Rels {
        let (dir, name) = part.rsplit_once('/').unwrap_or(("", part));
        let path = format!("{dir}/_rels/{name}.rels");
        let Some(root) = self.xml(path.trim_start_matches('/')) else {
            return Rels::default();
        };
        Rels(
            root.all("Relationship")
                .filter_map(|r| {
                    let external = r.attr("TargetMode") == Some("External");
                    let target = r.attr("Target")?;
                    let rel = Rel {
                        kind: r.attr("Type").unwrap_or_default().to_string(),
                        target: if external {
                            target.to_string()
                        } else {
                            resolve_target(part, target)
                        },
                        external,
                    };
                    Some((r.attr("Id")?.to_string(), rel))
                })
                .collect(),
        )
    }

    pub(super) fn part(&mut self, path: &str) -> Option<Part> {
        let root = self.xml(path)?;
        Some(Part {
            path: path.to_string(),
            rels: self.rels(path),
            root,
        })
    }
}

/// An XML part with its relationships.
#[derive(Clone)]
pub(super) struct Part {
    pub(super) path: String,
    pub(super) root: Node,
    pub(super) rels: Rels,
}
