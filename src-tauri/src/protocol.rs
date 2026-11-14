//! `slop://` URI scheme. Serves files of the open workspace (decks, the pages the viewer
//! shows, their assets) by their absolute path, as `slop://localhost/.file/<absolute path>`
//! (`http://slop.localhost/...` on Windows), so a deck's relative `assets/…` references
//! resolve exactly as they do when the file is opened in a browser. Files outside the
//! workspaces the windows have open are refused. Templates (see [`templates`]) are served as
//! `slop://localhost/.template/<template-id>/<path>`, for the layout and style previews, and
//! files in a deck's session (sketches the chat shows) by their absolute path, as
//! `slop://localhost/.session/<absolute path>`. A workspace file as of the last commit comes by
//! its absolute path too, as `slop://localhost/.head/<absolute path>`, so a slide's assets are
//! the committed ones as well (see [`git`]); one the commit does not have, like an ignored file,
//! comes from the workspace.
//!
//! With `?pan` in the query, a deck is served with the pasteboard (`assets/pasteboard.js`)
//! added, so the stage can pan and zoom around the slide. With `?edit`, it also gets the slide
//! editor (`assets/editor/`), which builds on the pasteboard, so the stage can edit text and
//! move elements in place. With `?show`, the presenter's whole-deck player gets the pasteboard
//! too, to zoom and pan the slide being shown. None of them ever becomes part of the deck file
//! or an export: the page gets tags that load them from `slop://localhost/.app/<version>/`
//! (see [`scripts`]). With `?print`, a deck is served with its player runtime brought up to
//! date, as an export has it, for printing to PDF (see pdf.rs). With `?embed&slide=<id>`, the
//! previews' query, a deck is served cut down to that slide (see [`html::single_slide`]).
//!
//! Responses say how they may be kept (see [`cache`]): the webview asks again by entity tag and
//! gets a 304 while the file is as it was, and audio and video get the byte ranges they ask for.

use std::borrow::Cow;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, LazyLock};

use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use tauri::http::{header, HeaderMap, Request, Response, StatusCode};
use tauri::{AppHandle, Manager};

use crate::git;
use crate::html;
use crate::sessions::Sessions;
use crate::templates;
use crate::workspace::OpenWorkspace;

mod cache;
mod head;
mod scripts;

use cache::{cache_policy, Origin, Ranged};

/// First path segment of workspace files, followed by their absolute path.
const FILE_PREFIX: &str = ".file";
/// First path segment of template files: `/.template/<template-id>/deck.html`.
const TEMPLATE_PREFIX: &str = ".template";
/// First path segment of session files, followed by their absolute path.
const SESSION_PREFIX: &str = ".session";
/// First path segment of files as of the last commit, followed by their absolute path.
const HEAD_PREFIX: &str = ".head";

/// What `encodeURIComponent` leaves alone, as the frontend builds the same URLs.
const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// The files of commits already read (see [`head::HeadFiles`]).
static HEAD_FILES: LazyLock<head::HeadFiles> = LazyLock::new(head::HeadFiles::default);

type Answer = Response<Cow<'static, [u8]>>;

/// What a request resolves to, before any of it is read.
#[derive(Debug)]
struct Found {
    mime: &'static str,
    body: Body,
    origin: Origin,
    /// The entity tag of this version of it; None when there is nothing to tell versions by.
    tag: Option<String>,
}

#[derive(Debug)]
enum Body {
    /// A file on disk, read only once the answer needs its bytes.
    File(PathBuf),
    /// Bytes kept by the app (a file of a commit, a template with its runtime).
    Shared(Arc<[u8]>),
    /// Compiled into the app.
    Static(&'static [u8]),
}

impl Found {
    /// A file on disk, tagged by when it was written and how long it is.
    fn file(path: PathBuf, mime: &'static str) -> Result<Self, StatusCode> {
        let meta = std::fs::metadata(&path).map_err(|_| StatusCode::NOT_FOUND)?;
        if meta.is_dir() {
            return Err(StatusCode::NOT_FOUND);
        }
        Ok(Found {
            mime,
            tag: cache::file_tag(scripts::version(), &meta),
            body: Body::File(path),
            origin: Origin::Live,
        })
    }

    fn len(&self) -> Result<u64, StatusCode> {
        match &self.body {
            Body::File(path) => std::fs::metadata(path)
                .map(|meta| meta.len())
                .map_err(|_| StatusCode::NOT_FOUND),
            Body::Shared(bytes) => Ok(bytes.len() as u64),
            Body::Static(bytes) => Ok(bytes.len() as u64),
        }
    }

    /// All of it.
    fn read(self) -> Result<Vec<u8>, StatusCode> {
        match self.body {
            Body::File(path) => std::fs::read(path).map_err(|_| StatusCode::NOT_FOUND),
            Body::Shared(bytes) => Ok(bytes.to_vec()),
            Body::Static(bytes) => Ok(bytes.to_vec()),
        }
    }

    /// The bytes in `range` of it, which lies inside it.
    fn read_range(&self, range: std::ops::Range<u64>) -> Result<Vec<u8>, StatusCode> {
        let (start, len) = (range.start as usize, (range.end - range.start) as usize);
        match &self.body {
            Body::File(path) => {
                let mut part = vec![0; len];
                let mut file = std::fs::File::open(path).map_err(|_| StatusCode::NOT_FOUND)?;
                file.seek(SeekFrom::Start(range.start))
                    .and_then(|_| file.read_exact(&mut part))
                    .map_err(|_| StatusCode::RANGE_NOT_SATISFIABLE)?;
                Ok(part)
            }
            Body::Shared(bytes) => Ok(bytes[start..start + len].to_vec()),
            Body::Static(bytes) => Ok(bytes[start..start + len].to_vec()),
        }
    }
}

/// Answers a request for a `slop://` address. It reads files and may start `git`, so it is
/// called off the main thread (see `lib.rs`); nothing in it touches a window.
pub fn handle(app: &AppHandle, request: Request<Vec<u8>>) -> Answer {
    let uri = request.uri();
    match find(app, uri.path()) {
        Ok(found) => respond(found, uri.query(), request.headers()),
        Err(status) => refuse(status),
    }
}

fn refuse(status: StatusCode) -> Answer {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain")
        .body(Cow::Borrowed(&b""[..]))
        .unwrap()
}

fn find(app: &AppHandle, raw_path: &str) -> Result<Found, StatusCode> {
    let (prefix, rel) = split_path(raw_path)?;
    if prefix == FILE_PREFIX {
        return find_in_workspace(&app.state::<OpenWorkspace>(), &rel);
    }
    if prefix == TEMPLATE_PREFIX {
        let (template, rel) = rel.split_once('/').ok_or(StatusCode::NOT_FOUND)?;
        let root = templates::user_root().map_err(|_| StatusCode::NOT_FOUND)?;
        return find_in_template(&root, template, rel);
    }
    if prefix == SESSION_PREFIX {
        let home = crate::files::app_home().map_err(|_| StatusCode::NOT_FOUND)?;
        return find_in_session(&Sessions::new(&home), &rel);
    }
    if prefix == HEAD_PREFIX {
        return find_at_head(&app.state::<OpenWorkspace>(), &rel);
    }
    if prefix == scripts::PREFIX {
        return find_script(&rel);
    }
    Err(StatusCode::NOT_FOUND)
}

/// The answer to a request that found `found`: nothing but "still good" when the webview's copy
/// is, the part of a file a player asked for, or all of it, a deck page made ready for its frame
/// (see [`page_for`]).
fn respond(found: Found, query: Option<&str>, asked: &HeaderMap) -> Answer {
    let policy = cache_policy(found.origin, query, found.tag.is_some());
    let asked_for =
        |name: header::HeaderName| asked.get(name).and_then(|value| value.to_str().ok());
    let mut answer = Response::builder()
        .header(header::CONTENT_TYPE, found.mime)
        .header(header::CACHE_CONTROL, policy.header())
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    if let Some(tag) = found.tag.as_deref() {
        answer = answer.header(header::ETAG, tag);
        if cache::matches(asked_for(header::IF_NONE_MATCH), tag) {
            return answer
                .status(StatusCode::NOT_MODIFIED)
                .body(Cow::Borrowed(&b""[..]))
                .unwrap();
        }
    }
    // A part asked for of another version than this one gets the whole of this one.
    let same_version =
        asked_for(header::IF_RANGE).map_or(true, |tag| Some(tag) == found.tag.as_deref());
    let range = asked_for(header::RANGE).filter(|_| same_version);
    match content(found, query, range) {
        Ok(content) => {
            if content.in_parts {
                answer = answer.header(header::ACCEPT_RANGES, "bytes");
            }
            if let Some(range) = content.range {
                answer = answer.header(header::CONTENT_RANGE, range);
            }
            answer
                .status(content.status)
                .body(Cow::Owned(content.bytes))
                .unwrap()
        }
        Err(status) => refuse(status),
    }
}

/// The body of an answer, and what it says about itself.
struct Content {
    status: StatusCode,
    bytes: Vec<u8>,
    /// Whether the resource can be asked for in parts.
    in_parts: bool,
    /// The `Content-Range` of a part, or of a refusal to give one.
    range: Option<String>,
}

/// What of `found` a request gets. A page is made ready for its frame (see [`page_for`]) and
/// always comes whole; only what is served as it is can be served in parts, which audio and
/// video ask for.
fn content(found: Found, query: Option<&str>, range: Option<&str>) -> Result<Content, StatusCode> {
    if found.mime.starts_with("text/html") {
        return Ok(Content {
            status: StatusCode::OK,
            bytes: page_for(query, found.read()?),
            in_parts: false,
            range: None,
        });
    }
    let len = found.len()?;
    let (status, bytes, range) = match cache::parse_range(range, len) {
        Ranged::Whole => (StatusCode::OK, found.read()?, None),
        Ranged::Part(part) => (
            StatusCode::PARTIAL_CONTENT,
            found.read_range(part.clone())?,
            Some(format!("bytes {}-{}/{len}", part.start, part.end - 1)),
        ),
        Ranged::Unsatisfiable => (
            StatusCode::RANGE_NOT_SATISFIABLE,
            Vec::new(),
            Some(format!("bytes */{len}")),
        ),
    };
    Ok(Content {
        status,
        bytes,
        in_parts: true,
        range,
    })
}

/// A page as its frame asked for it: cut down to the one slide a preview shows (`embed` with
/// `slide`), with its player runtime current for `print`, and with the tags of the app's scripts
/// for the stage and the show. Without any of those it is the file as it is.
fn page_for(query: Option<&str>, bytes: Vec<u8>) -> Vec<u8> {
    let slide = param(query, "slide").filter(|_| has_param(query, "embed"));
    let print = has_param(query, "print");
    let added = scripts::for_query(query);
    if slide.is_none() && !print && added.is_empty() {
        return bytes;
    }
    let source = String::from_utf8_lossy(&bytes);
    // The slide editor asks the page whether an id is taken anywhere in the deck.
    let others = match has_param(query, "edit") {
        true => html::Others::Ids,
        false => html::Others::Empty,
    };
    let mut page = match &slide {
        Some(slide) => html::single_slide(&source, slide, others),
        None => Cow::Borrowed(source.as_ref()),
    };
    if print {
        page = Cow::Owned(html::ensure_runtime(&page));
    }
    if !added.is_empty() {
        page = Cow::Owned(with_scripts(&page, &scripts::tags(&added, origin())));
    }
    page.into_owned().into_bytes()
}

/// Scheme and host of every address the app serves. WebView2 (Windows) exposes custom schemes
/// as `http://<scheme>.localhost`.
fn origin() -> &'static str {
    match cfg!(windows) {
        true => "http://slop.localhost",
        false => "slop://localhost",
    }
}

/// URL of a workspace file, by its absolute path, as the frontend's `fileUrl` makes it.
pub fn file_url(file: &Path, query: &str) -> String {
    let path = file.to_string_lossy().replace('\\', "/");
    // canonicalize() adds Windows verbatim prefixes. Sending them as URL segments would
    // turn a drive path into a relative path when the handler reconstructs it.
    let path = if let Some(unc) = path.strip_prefix("//?/UNC/") {
        format!("//{unc}")
    } else if let Some(drive) = path
        .strip_prefix("//?/")
        .filter(|p| p.as_bytes().get(1) == Some(&b':'))
    {
        drive.to_string()
    } else {
        path
    };
    // Unlike a Unix root slash, a network path's two leading slashes are significant.
    let path = if path.starts_with("//") {
        path.as_str()
    } else {
        path.trim_start_matches('/')
    };
    let encoded: Vec<String> = std::iter::once(FILE_PREFIX)
        .chain(path.split('/'))
        .map(|segment| utf8_percent_encode(segment, URI_COMPONENT).to_string())
        .collect();
    format!("{}/{}?{query}", origin(), encoded.join("/"))
}

/// `/<prefix>/<path>`, percent-decoded.
fn split_path(raw_path: &str) -> Result<(String, String), StatusCode> {
    let path = percent_decode_str(raw_path)
        .decode_utf8()
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let (prefix, rel) = path
        .trim_start_matches('/')
        .split_once('/')
        .ok_or(StatusCode::NOT_FOUND)?;
    Ok((prefix.to_string(), rel.to_string()))
}

/// Whether the query string has the parameter `name` (`name` or `name=<value>`).
fn has_param(query: Option<&str>, name: &str) -> bool {
    query.is_some_and(|q| {
        q.split('&')
            .any(|p| p == name || p.strip_prefix(name).is_some_and(|v| v.starts_with('=')))
    })
}

/// The value of the query string's first parameter `name`, decoded as the page's own
/// `URLSearchParams` decodes it (percent escapes, and `+` for a space); empty for one without
/// a value.
fn param(query: Option<&str>, name: &str) -> Option<String> {
    let value = query?
        .split('&')
        .find_map(|p| match p.strip_prefix(name)? {
            "" => Some(""),
            rest => rest.strip_prefix('='),
        })?;
    let spaced = value.replace('+', " ");
    Some(percent_decode_str(&spaced).decode_utf8_lossy().into_owned())
}

/// `html` with `tags` after everything else in `<body>`, so the scripts they load run after the
/// player. The end of the body is found in place: the page is copied once, into the answer.
fn with_scripts(html: &str, tags: &str) -> String {
    const BODY_END: &[u8] = b"</body";
    let at = html
        .as_bytes()
        .windows(BODY_END.len())
        .rposition(|window| window.eq_ignore_ascii_case(BODY_END))
        .unwrap_or(html.len());
    let mut out = String::with_capacity(html.len() + tags.len());
    out.push_str(&html[..at]);
    out.push_str(tags);
    out.push_str(&html[at..]);
    out
}

/// An absolute path sent without its leading `/` (`C:/…` on Windows).
fn absolute(path: &str) -> PathBuf {
    match cfg!(windows) {
        true => PathBuf::from(path),
        false => Path::new("/").join(path),
    }
}

/// A file of the open workspace, by its absolute path without the leading `/`.
fn find_in_workspace(workspace: &OpenWorkspace, path: &str) -> Result<Found, StatusCode> {
    let file = absolute(path);
    if !workspace.contains(&file) {
        return Err(StatusCode::FORBIDDEN);
    }
    Found::file(file, crate::assets::mime_for(path))
}

/// A session file, by its absolute path without the leading `/` (`C:/…` on Windows).
fn find_in_session(sessions: &Sessions, path: &str) -> Result<Found, StatusCode> {
    let file = absolute(path);
    if !sessions.contains(&file) {
        return Err(StatusCode::FORBIDDEN);
    }
    Found::file(file, crate::assets::mime_for(path))
}

/// A file of template `id` for the editor's previews: its deck.html with the player runtime, or
/// one of a user template's assets.
fn find_in_template(root: &Path, id: &str, rel: &str) -> Result<Found, StatusCode> {
    let mime = crate::assets::mime_for(rel);
    match templates::preview(root, id, rel).ok_or(StatusCode::NOT_FOUND)? {
        templates::Preview::Asset(file) => Found::file(file, mime),
        templates::Preview::Deck { html, file } => {
            let build = scripts::version();
            // A built-in template changes with the app only; the user's own with its file.
            let tag = match file {
                Some(file) => std::fs::metadata(file)
                    .ok()
                    .and_then(|meta| cache::file_tag(build, &meta)),
                None => Some(cache::version_tag(build, "builtin")),
            };
            Ok(Found {
                mime,
                body: Body::Shared(html),
                origin: Origin::Live,
                tag,
            })
        }
    }
}

/// One of the app's own scripts, at `<version>/<name>`.
fn find_script(rel: &str) -> Result<Found, StatusCode> {
    let source = scripts::read(rel).ok_or(StatusCode::NOT_FOUND)?;
    Ok(Found {
        mime: crate::assets::mime_for(rel),
        body: Body::Static(source.as_bytes()),
        origin: Origin::App,
        tag: Some(cache::version_tag(scripts::version(), "app")),
    })
}

/// Whether `file` stays where it says, without a `..`.
fn is_plain_path(file: &Path) -> bool {
    !file.components().any(|c| c == Component::ParentDir)
}

/// A file of the open workspace as of the last commit, by its absolute path without the leading
/// `/`. It may be gone from the disk, so its closest remaining folder must be inside instead.
/// What the commit holds is read once (see [`head::HeadFiles`]).
fn find_at_head(workspace: &OpenWorkspace, path: &str) -> Result<Found, StatusCode> {
    let file = absolute(path);
    let folder = git::existing_folder(&file).filter(|dir| workspace.contains(dir));
    let Some(folder) = folder.filter(|_| is_plain_path(&file)) else {
        return Err(StatusCode::FORBIDDEN);
    };
    let committed = git::head_oid(folder).and_then(|commit| {
        let bytes = HEAD_FILES.get(&commit, &file, || git::read_at_head(&file))?;
        Some((commit, bytes))
    });
    match committed {
        Some((commit, bytes)) => Ok(Found {
            mime: crate::assets::mime_for(path),
            body: Body::Shared(bytes),
            origin: Origin::Commit,
            tag: Some(cache::version_tag(scripts::version(), &commit)),
        }),
        None => find_in_workspace(workspace, path),
    }
}

#[cfg(test)]
mod tests;
