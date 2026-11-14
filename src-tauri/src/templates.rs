//! Slide templates: decks whose slides are example layouts (title, section, bullets, …) in
//! one style. A deck names the template its design comes from in a `<meta>` (see
//! [`html::TEMPLATE_META`]); the editor offers that template's slides as layouts for new
//! slides and changed ones, and its styles for restyling the deck.
//!
//! Built-in templates ship inside the app. The user's own live in
//! `~/.slopslides/templates/<id>/deck.html` (with an optional `assets/` folder), one folder
//! per template; a user template replaces a built-in one with the same id.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::SystemTime;

use serde::Serialize;

use crate::comments;
use crate::deck::{self, DECK_FILE};
use crate::error::{Error, Result};
use crate::html;
use crate::review;
use crate::size::SizeInfo;

const BUILTIN: &[(&str, &str)] = &[
    (
        "claymorphism",
        include_str!("../templates/claymorphism.html"),
    ),
    ("cybercore", include_str!("../templates/cybercore.html")),
    (
        "neo-brutalism",
        include_str!("../templates/neo-brutalism.html"),
    ),
    ("scrapbook", include_str!("../templates/scrapbook.html")),
    ("surrealism", include_str!("../templates/surrealism.html")),
    ("y2k", include_str!("../templates/y2k.html")),
    ("pixel-art", include_str!("../templates/pixel-art.html")),
    ("synthwave", include_str!("../templates/synthwave.html")),
    (
        "glassmorphism",
        include_str!("../templates/glassmorphism.html"),
    ),
    ("neumorphism", include_str!("../templates/neumorphism.html")),
    ("bento-grid", include_str!("../templates/bento-grid.html")),
    ("editorial", include_str!("../templates/editorial.html")),
    ("swiss", include_str!("../templates/swiss.html")),
    ("minimalism", include_str!("../templates/minimalism.html")),
    ("plain", include_str!("../templates/plain.html")),
    ("maximalism", include_str!("../templates/maximalism.html")),
    (
        "luxury-typography",
        include_str!("../templates/luxury-typography.html"),
    ),
    (
        "conceptual-sketch",
        include_str!("../templates/conceptual-sketch.html"),
    ),
    ("ethereal", include_str!("../templates/ethereal.html")),
    ("bohemian", include_str!("../templates/bohemian.html")),
    ("victorian", include_str!("../templates/victorian.html")),
    ("cyberpunk", include_str!("../templates/cyberpunk.html")),
    ("wabi-sabi", include_str!("../templates/wabi-sabi.html")),
    ("bold-signal", include_str!("../templates/bold-signal.html")),
    (
        "electric-studio",
        include_str!("../templates/electric-studio.html"),
    ),
    (
        "creative-voltage",
        include_str!("../templates/creative-voltage.html"),
    ),
    (
        "dark-botanical",
        include_str!("../templates/dark-botanical.html"),
    ),
    (
        "notebook-tabs",
        include_str!("../templates/notebook-tabs.html"),
    ),
    (
        "pastel-geometry",
        include_str!("../templates/pastel-geometry.html"),
    ),
    (
        "split-pastel",
        include_str!("../templates/split-pastel.html"),
    ),
    (
        "vintage-editorial",
        include_str!("../templates/vintage-editorial.html"),
    ),
    (
        "terminal-green",
        include_str!("../templates/terminal-green.html"),
    ),
];

/// Where staged copies of templates go inside a deck, for the agent to read.
pub const STAGED_DIR: &str = "templates";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TemplateSummary {
    pub id: String,
    pub title: String,
    /// Ships with the app (as opposed to the user's own, under `~/.slopslides/templates`).
    pub builtin: bool,
    /// Folder of a user template.
    pub path: Option<String>,
    /// Ids of the template's slides: one per layout, in order.
    pub slides: Vec<String>,
    /// The template's slide size, which a new deck made from it takes.
    pub size: SizeInfo,
}

/// `~/.slopslides/templates`, created on first use. It is asked for with every template preview,
/// so the folder is made once and its path kept.
pub fn user_root() -> Result<PathBuf> {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    if let Some(root) = ROOT.get() {
        return Ok(root.clone());
    }
    let root = crate::files::app_home()?.join("templates");
    fs::create_dir_all(&root)?;
    Ok(ROOT.get_or_init(|| root).clone())
}

/// Template ids are folder names that are safe in a URL path segment and an attribute.
pub fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && !id.starts_with('.')
        && !id.contains(['/', '\\', '"', '\'', '<', '>', '&', '?', '#', '%'])
}

fn builtin(id: &str) -> Option<&'static str> {
    BUILTIN
        .iter()
        .find(|(b, _)| *b == id)
        .map(|(_, html)| *html)
}

/// Folder of the user template `id`, if there is one.
pub fn user_dir(root: &Path, id: &str) -> Option<PathBuf> {
    if !is_valid_id(id) {
        return None;
    }
    let dir = root.join(id);
    dir.join(DECK_FILE).is_file().then_some(dir)
}

/// The template's deck.html as stored (user templates win over built-in ones).
pub fn source(root: &Path, id: &str) -> Result<String> {
    if let Some(dir) = user_dir(root, id) {
        return Ok(fs::read_to_string(dir.join(DECK_FILE))?);
    }
    builtin(id)
        .map(str::to_string)
        .ok_or_else(|| Error::msg(format!("template not found: {id}")))
}

fn summary(id: &str, source: &str, path: Option<&Path>) -> TemplateSummary {
    TemplateSummary {
        id: id.to_string(),
        title: html::title(source).unwrap_or_else(|| id.replace('-', " ")),
        builtin: path.is_none(),
        path: path.map(|p| p.to_string_lossy().into_owned()),
        slides: html::find_slides(source)
            .into_iter()
            .filter_map(|s| s.id)
            .collect(),
        size: html::slide_size(source).into(),
    }
}

/// What the built-in templates are. They are compiled in, so each is read (its slides found,
/// its title and size) once, not every time the templates are listed.
fn builtin_summaries() -> &'static [TemplateSummary] {
    static SUMMARIES: LazyLock<Vec<TemplateSummary>> = LazyLock::new(|| {
        BUILTIN
            .iter()
            .map(|(id, source)| summary(id, source, None))
            .collect()
    });
    &SUMMARIES
}

/// The user's templates (by title), then the built-in ones they do not replace.
pub fn list(root: &Path) -> Vec<TemplateSummary> {
    let mut own: Vec<TemplateSummary> = fs::read_dir(root)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let id = entry.ok()?.file_name().to_str()?.to_string();
            let dir = user_dir(root, &id)?;
            let source = fs::read_to_string(dir.join(DECK_FILE)).ok()?;
            Some(summary(&id, &source, Some(&dir)))
        })
        .filter(|t| !t.slides.is_empty())
        .collect();
    own.sort_by_key(|t| t.title.to_lowercase());
    let builtins: Vec<TemplateSummary> = builtin_summaries()
        .iter()
        .filter(|builtin| !own.iter().any(|t| t.id == builtin.id))
        .cloned()
        .collect();
    own.extend(builtins);
    own
}

/// Copies the template into the deck's session for the agent to read; returns its absolute
/// path.
pub fn stage(session: &Path, root: &Path, id: &str) -> Result<String> {
    if !is_valid_id(id) {
        return Err(Error::msg(format!("invalid template id: {id}")));
    }
    let source = html::without_runtime(&source(root, id)?);
    let dir = session.join(STAGED_DIR);
    fs::create_dir_all(&dir)?;
    let name = format!("{id}.html");
    if fs::read_to_string(dir.join(&name)).ok().as_deref() != Some(source.as_str()) {
        fs::write(dir.join(&name), source)?;
    }
    Ok(dir.join(name).to_string_lossy().into_owned())
}

/// A new deck.html in the template's style: its styles (and fonts) without its slides,
/// titled `title`, naming the template.
pub fn deck_shell(source: &str, id: &str, title: &str) -> String {
    let shell = html::strip_slides(source);
    let shell = html::set_title(&without_marks(&shell), title);
    html::ensure_runtime(&html::set_template(&shell, Some(id)))
}

/// The built-in template the example deck is made from.
const EXAMPLE_TEMPLATE: &str = "editorial";
/// What the example deck is called.
pub const EXAMPLE_TITLE: &str = "Example deck";

/// Creates an example deck in `root` for a first look at the app, as `example-deck/deck.html`
/// (or `example-deck-2`, … when that is taken): every layout of a built-in template, with its
/// placeholder text, so there are slides to edit, restyle and present. Returns its deck file.
pub fn create_example(root: &Path) -> Result<PathBuf> {
    let source = builtin(EXAMPLE_TEMPLATE).expect("a built-in template");
    let source = html::set_template(
        &html::set_title(source, EXAMPLE_TITLE),
        Some(EXAMPLE_TEMPLATE),
    );
    let dir = crate::files::unique_dir(root, &html::slugify(EXAMPLE_TITLE));
    fs::create_dir_all(&dir)?;
    let file = dir.join(DECK_FILE);
    deck::write_html(&file, &html::ensure_runtime(&source))?;
    Ok(file)
}

/// Saves the deck file `deck_file` as the user template `name`: a copy of it with
/// placeholder text in place of its content, and its assets. Returns the new template.
pub fn create_from_deck(deck_file: &Path, root: &Path, name: &str) -> Result<TemplateSummary> {
    let name = name.trim();
    let name = if name.is_empty() { "My template" } else { name };
    let stem = html::slugify(name);
    let stem = if stem.is_empty() { "template" } else { &stem };
    let id = std::iter::once(stem.to_string())
        .chain((2..).map(|n| format!("{stem}-{n}")))
        .find(|id| !root.join(id).exists() && builtin(id).is_none())
        .expect("unbounded");
    let source = fs::read_to_string(deck_file)?;
    if html::find_slides(&source).is_empty() {
        return Err(Error::msg(
            "The deck has no slides to make a template from.",
        ));
    }
    let cleaned = html::with_placeholder_text(&source);
    let cleaned = html::set_template(&html::set_title(&without_marks(&cleaned), name), None);
    let dir = root.join(&id);
    fs::create_dir_all(&dir)?;
    fs::write(dir.join(DECK_FILE), &cleaned)?;
    let assets = deck::folder(deck_file).join("assets");
    if assets.is_dir() {
        copy_dir(&assets, &dir.join("assets"))?;
    }
    Ok(summary(&id, &cleaned, Some(&dir)))
}

/// `html` without the user's review marks and comments, which a template does not take along.
fn without_marks(html: &str) -> String {
    comments::write(
        &review::write(html, &Default::default()),
        &Default::default(),
    )
}

fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// A template file for the editor's previews.
#[derive(Debug, PartialEq)]
pub enum Preview {
    /// The template's deck.html with the player runtime, and the file it is made from when
    /// the template is the user's.
    Deck {
        html: Arc<[u8]>,
        file: Option<PathBuf>,
    },
    /// One of a user template's assets.
    Asset(PathBuf),
}

/// A template's deck.html with the player runtime, as served.
type Page = Arc<[u8]>;
/// When a file was written and how long it is: what tells one version of it from the next.
type Stamp = (Option<SystemTime>, u64);

/// A built-in template with the player runtime, made on first use: every layout's preview asks
/// for the whole template again.
fn builtin_preview(id: &str) -> Option<Page> {
    static MADE: LazyLock<Mutex<HashMap<&'static str, Page>>> = LazyLock::new(Mutex::default);
    let (id, source) = BUILTIN.iter().find(|(b, _)| *b == id)?;
    let mut made = MADE.lock().unwrap_or_else(|e| e.into_inner());
    let html = made
        .entry(id)
        .or_insert_with(|| html::ensure_runtime(source).into_bytes().into());
    Some(html.clone())
}

/// The user template at `file` with the player runtime, made again only when the file was
/// written since (told by its time and length).
fn user_preview(file: &Path) -> Option<Page> {
    static MADE: LazyLock<Mutex<HashMap<PathBuf, (Stamp, Page)>>> = LazyLock::new(Mutex::default);
    let meta = fs::metadata(file).ok()?;
    let stamp = (meta.modified().ok(), meta.len());
    let known = MADE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(file)
        .cloned();
    if let Some((_, html)) = known.filter(|(made_of, _)| *made_of == stamp) {
        return Some(html);
    }
    let source = fs::read_to_string(file).ok()?;
    let html: Page = html::ensure_runtime(&source).into_bytes().into();
    MADE.lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(file.to_path_buf(), (stamp, html.clone()));
    Some(html)
}

/// A template file for the editor's previews: deck.html with the player runtime, or one of a
/// user template's assets (which may not exist).
pub fn preview(root: &Path, id: &str, rel: &str) -> Option<Preview> {
    let own = user_dir(root, id);
    if rel != DECK_FILE {
        return Some(Preview::Asset(deck::resolve_in_deck(&own?, rel).ok()?));
    }
    match own.map(|dir| dir.join(DECK_FILE)) {
        Some(file) => Some(Preview::Deck {
            html: user_preview(&file)?,
            file: Some(file),
        }),
        None => Some(Preview::Deck {
            html: builtin_preview(id)?,
            file: None,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lint;
    use crate::test_support::TempDir;

    /// A throwaway folder (the user's templates, or a deck).
    struct TempFolder(TempDir);

    impl TempFolder {
        fn new() -> Self {
            TempFolder(TempDir::new("tpl"))
        }
        fn add(&self, id: &str, html: &str) -> PathBuf {
            let dir = self.0.join(id);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join(DECK_FILE), html).unwrap();
            dir
        }
    }

    const MINE: &str = "<!DOCTYPE html><html><head><title>Mine</title><style>.slide{}</style></head><body><main class=\"deck\">\n<section class=\"slide\" id=\"cover\"><h1>Cover</h1></section>\n<section class=\"slide\" id=\"list\"><p>List</p></section>\n</main></body></html>";

    const LAYOUTS: &[&str] = &[
        "title", "section", "bullets", "split", "stats", "quote", "closing",
    ];

    #[test]
    fn every_builtin_template_has_the_shared_layouts_and_passes_lint() {
        assert_eq!(BUILTIN.len(), 32);
        for (id, source) in BUILTIN {
            assert!(is_valid_id(id) && html::slugify(id) == *id, "{id}");
            let ids: Vec<_> = html::find_slides(source)
                .into_iter()
                .filter_map(|s| s.id)
                .collect();
            assert_eq!(ids, LAYOUTS, "{id}");
            assert!(html::title(source).is_some(), "{id} has a title");
            assert!(
                !source.contains("slopslide:runtime"),
                "{id}: the runtime is added when served"
            );
            let served = html::ensure_runtime(source);
            assert_eq!(lint::lint(&served, |_| false, &[]), vec![], "{id}");
            let shell = deck_shell(source, id, "Talk");
            assert_eq!(
                lint::lint(&shell, |_| false, &[]),
                vec![],
                "{id} as a new deck"
            );
        }
    }

    #[test]
    fn every_builtin_template_has_its_own_entrance() {
        for (id, source) in BUILTIN {
            let keyframes = format!("@keyframes {id}-reveal {{");
            let start = source
                .find(&keyframes)
                .unwrap_or_else(|| panic!("{id}: {keyframes}"));
            let frames = &source[start..start + source[start..].find("\n    }").unwrap()];
            let last = frames.lines().last().unwrap().trim();
            assert!(
                last.starts_with("to { opacity: 1;"),
                "{id}: the last frame shows the element ({last})"
            );
            assert!(
                !last.contains("translate") && !last.contains("scale") && !last.contains("rotate"),
                "{id}: elements land on their own styles ({last})"
            );
            assert!(
                source.contains(&format!(".slide.active .reveal {{ animation: {id}-reveal ")),
                "{id} plays its entrance"
            );
            assert!(
                source[source.find(&format!("animation: {id}-reveal")).unwrap()..]
                    .split(';')
                    .next()
                    .unwrap()
                    .ends_with(" both"),
                "{id}: elements stay hidden until their turn"
            );
        }
    }

    #[test]
    fn plain_template_is_black_on_white_without_decoration() {
        let source = builtin("plain").unwrap();
        assert_eq!(html::title(source).as_deref(), Some("Plain"));
        for rule in [
            "--bg: #ffffff;",
            "--ink: #000000;",
            "--muted: #000000;",
            "--accent: #000000;",
            ".slide .deco { display: none; }",
        ] {
            assert!(source.contains(rule), "plain: {rule}");
        }
        let style = &source[source.find("/* Plain").unwrap()..];
        for gimmick in ["gradient", "shadow", "border-radius", "translate", "rotate"] {
            assert!(!style.contains(gimmick), "plain has no {gimmick}");
        }
        let size = html::slide_size(source);
        assert_eq!((size.width, size.height), (1920.0, 1080.0));
    }

    #[test]
    fn lists_user_templates_first_and_lets_them_replace_builtins() {
        let root = TempFolder::new();
        root.add("mine", MINE);
        root.add("swiss", &MINE.replace("Mine", "My Swiss"));
        root.add("empty", "<html><head><title>Empty</title></head></html>");
        fs::create_dir_all(root.0.join("no-deck")).unwrap();
        root.add(".hidden", MINE);

        let all = list(&root.0);
        let ids: Vec<_> = all.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(&ids[..2], ["mine", "swiss"], "by title: Mine, My Swiss");
        assert_eq!(all.len(), 2 + BUILTIN.len() - 1);
        assert_eq!(ids.iter().filter(|id| **id == "swiss").count(), 1);
        assert!(!ids.contains(&"empty") && !ids.contains(&"no-deck") && !ids.contains(&".hidden"));

        let mine = &all[0];
        assert_eq!(mine.title, "Mine");
        assert!(!mine.builtin);
        assert_eq!(mine.slides, ["cover", "list"]);
        assert_eq!(
            mine.path.as_deref(),
            Some(root.0.join("mine").to_str().unwrap())
        );
        assert_eq!(all[1].title, "My Swiss");

        let synthwave = all.iter().find(|t| t.id == "synthwave").unwrap();
        assert!(synthwave.builtin && synthwave.path.is_none());
        assert_eq!(synthwave.title, "Synthwave");
        assert_eq!(list(&root.0.join("missing")).len(), BUILTIN.len());
    }

    #[test]
    fn reads_sources_and_serves_files() {
        let root = TempFolder::new();
        let dir = root.add("mine", MINE);
        fs::create_dir_all(dir.join("assets")).unwrap();
        fs::write(dir.join("assets/logo.svg"), "<svg/>").unwrap();

        assert_eq!(source(&root.0, "mine").unwrap(), MINE);
        assert!(source(&root.0, "swiss")
            .unwrap()
            .contains("<title>Swiss Design</title>"));
        assert!(source(&root.0, "nope").is_err());
        assert!(source(&root.0, "../mine").is_err());

        let Some(Preview::Deck { html, file: None }) = preview(&root.0, "swiss", "deck.html")
        else {
            panic!("a built-in template has no file");
        };
        assert!(String::from_utf8_lossy(&html).contains(html::JS_START));
        assert_eq!(
            preview(&root.0, "mine", "assets/logo.svg"),
            Some(Preview::Asset(dir.join("assets/logo.svg")))
        );
        assert_eq!(preview(&root.0, "mine", "../mine/deck.html"), None);
        assert_eq!(preview(&root.0, "swiss", "assets/logo.svg"), None);
        assert_eq!(preview(&root.0, "nope", "deck.html"), None);
    }

    #[test]
    fn a_template_gets_its_runtime_once_for_all_its_previews() {
        let root = TempFolder::new();
        let dir = root.add("mine", MINE);
        let deck = |id: &str| match preview(&root.0, id, "deck.html") {
            Some(Preview::Deck { html, file }) => (html, file),
            other => panic!("no deck: {other:?}"),
        };

        let (first, none) = deck("swiss");
        assert!(none.is_none());
        assert!(
            Arc::ptr_eq(&first, &deck("swiss").0),
            "a built-in template is made once"
        );

        let (mine, file) = deck("mine");
        assert_eq!(file, Some(dir.join(DECK_FILE)));
        assert!(String::from_utf8_lossy(&mine).contains(html::JS_START));
        assert!(
            Arc::ptr_eq(&mine, &deck("mine").0),
            "the user's own is kept while its file is as it was"
        );
        fs::write(dir.join(DECK_FILE), MINE.replace("Mine", "Mine, changed")).unwrap();
        let (changed, _) = deck("mine");
        assert!(
            !Arc::ptr_eq(&mine, &changed),
            "and made again once it changed"
        );
        assert!(String::from_utf8_lossy(&changed).contains("Mine, changed"));
    }

    #[test]
    fn builtin_templates_are_read_once_for_every_listing() {
        let (first, again) = (builtin_summaries(), builtin_summaries());
        assert!(std::ptr::eq(first, again));
        assert_eq!(first.len(), BUILTIN.len());
        let root = TempFolder::new();
        let listed = list(&root.0);
        assert_eq!(listed.as_slice(), first, "a listing copies what is kept");
    }

    #[test]
    fn validates_ids() {
        for ok in ["swiss", "my template", "Été"] {
            assert!(is_valid_id(ok), "{ok}");
        }
        for bad in [
            "", ".x", "a/b", "a\\b", "a\"b", "a<b", "a&b", "a?b", "a#b", "a%b",
        ] {
            assert!(!is_valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn stages_a_copy_without_the_runtime_for_the_agent() {
        let root = TempFolder::new();
        root.add("mine", &html::ensure_runtime(MINE));
        let session = TempFolder::new();
        let path = stage(&session.0, &root.0, "mine").unwrap();
        assert_eq!(Path::new(&path), session.0.join("templates/mine.html"));
        let staged = fs::read_to_string(&path).unwrap();
        assert!(!staged.contains("slopslide:runtime"));
        assert_eq!(html::find_slides(&staged).len(), 2);
        assert_eq!(
            stage(&session.0, &root.0, "mine").unwrap(),
            path,
            "idempotent"
        );
        assert!(stage(&session.0, &root.0, "bento-grid").is_ok());
        assert!(stage(&session.0, &root.0, "../x").is_err());
        assert!(stage(&session.0, &root.0, "nope").is_err());
    }

    #[test]
    fn the_example_deck_is_a_deck_with_slides_that_never_replaces_one() {
        let root = TempDir::new("templates-example");
        let first = create_example(&root).unwrap();
        assert_eq!(first, root.join("example-deck").join(DECK_FILE));
        let source = fs::read_to_string(&first).unwrap();
        assert_eq!(html::title(&source).as_deref(), Some(EXAMPLE_TITLE));
        assert!(html::find_slides(&source).len() > 3);
        assert_eq!(
            html::app_meta_content(&source, html::TEMPLATE_META).as_deref(),
            Some(EXAMPLE_TEMPLATE)
        );
        assert_eq!(
            crate::workspace::classify(&source),
            crate::workspace::FileKind::Deck
        );
        let second = create_example(&root).unwrap();
        assert_eq!(second, root.join("example-deck-2").join(DECK_FILE));
    }

    #[test]
    fn a_deck_shell_has_the_styles_but_no_slides() {
        let source = BUILTIN[0].1;
        let shell = deck_shell(source, BUILTIN[0].0, "Q3 & beyond");
        assert!(html::find_slides(&shell).is_empty());
        assert_eq!(html::title(&shell).as_deref(), Some("Q3 & beyond"));
        assert_eq!(html::template(&shell).as_deref(), Some(BUILTIN[0].0));
        let style = &source[source.find("<style>").unwrap()..source.find("</style>").unwrap()];
        assert!(shell.contains(style));
        assert!(shell.contains(html::CSS_START) && shell.contains(html::JS_START));
    }

    #[test]
    fn saves_a_deck_as_a_template_with_placeholder_content() {
        let root = TempFolder::new();
        let deck = TempFolder::new();
        let marks = [(
            "cover".to_string(),
            vec![review::Stroke {
                tool: review::InkTool::Pen,
                color: "#ef4444".into(),
                points: vec![[0.5, 0.5]],
            }],
        )]
        .into();
        let source = html::set_template(
            &review::write(&html::ensure_runtime(MINE), &marks),
            Some("swiss"),
        );
        fs::write(deck.0.join(DECK_FILE), &source).unwrap();
        fs::create_dir_all(deck.0.join("assets/icons")).unwrap();
        fs::write(deck.0.join("assets/icons/a.svg"), "<svg/>").unwrap();
        fs::write(deck.0.join("notes.txt"), "draft").unwrap();

        let created =
            create_from_deck(&deck.0.join(DECK_FILE), &root.0, "  Quarterly Review ").unwrap();
        assert_eq!(created.id, "quarterly-review");
        assert_eq!(created.title, "Quarterly Review");
        assert!(!created.builtin);
        assert_eq!(created.slides, ["cover", "list"]);
        let dir = root.0.join("quarterly-review");
        let html = fs::read_to_string(dir.join(DECK_FILE)).unwrap();
        let slides = html::find_slides(&html);
        let text = &html[slides[0].range.start..slides[1].range.end];
        assert!(!text.contains("Cover") && !text.contains("List"), "{text}");
        assert!(!html.contains(review::START), "review marks are dropped");
        assert!(!html.contains(comments::START), "comments are dropped");
        assert_eq!(html::template(&html), None);
        assert!(html.contains(html::JS_START), "the runtime stays");
        assert_eq!(
            fs::read_to_string(dir.join("assets/icons/a.svg")).unwrap(),
            "<svg/>"
        );
        assert!(
            !dir.join("notes.txt").exists(),
            "only deck.html and assets/ are copied"
        );
        assert_eq!(
            fs::read_to_string(deck.0.join(DECK_FILE)).unwrap(),
            source,
            "the deck is untouched"
        );

        let again = create_from_deck(&deck.0.join(DECK_FILE), &root.0, "Quarterly review").unwrap();
        assert_eq!(again.id, "quarterly-review-2");
        assert_eq!(
            create_from_deck(&deck.0.join(DECK_FILE), &root.0, "Swiss")
                .unwrap()
                .id,
            "swiss-2",
            "never shadows a built-in"
        );
        assert_eq!(
            create_from_deck(&deck.0.join(DECK_FILE), &root.0, " ")
                .unwrap()
                .id,
            "my-template"
        );
        assert_eq!(list(&root.0).iter().filter(|t| !t.builtin).count(), 4);

        fs::write(
            deck.0.join(DECK_FILE),
            "<html><body><main class=\"deck\"></main></body></html>",
        )
        .unwrap();
        assert!(create_from_deck(&deck.0.join(DECK_FILE), &root.0, "Empty").is_err());
    }
}
