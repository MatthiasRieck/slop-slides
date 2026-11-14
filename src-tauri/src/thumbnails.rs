//! Slide thumbnails as pictures. A list of slides (the slide list, the grid of all slides, the
//! start screen's decks, the layout pickers, the Changes list, the presenter's view) shows each
//! slide as a picture instead of a document of its own: dozens of documents laid out, styled and
//! scripted on the window's own thread cost far more than as many images.
//!
//! `slop://localhost/.thumb/<preview>` is the picture of the preview at `slop://localhost/<preview>`
//! (a slide `?embed&slide=…&static`, a template's or a committed one). It is made once, in a
//! hidden window of its own (as render.rs renders slides for the agent: `assets/render.js` shows
//! the slide with every animation finished, once its fonts and images are in, then the window
//! is captured), and kept on disk under `~/.slopslides/thumbnails`, named by what it shows: the
//! page the preview is served, where it is (its assets are relative to it), the preview's
//! options, and the deck's `assets/` folder as it is now. A slide that changes is a new picture;
//! one that comes back is found again. Pictures not looked at for longest go first once the
//! folder grows past [`CACHE_BYTES`].
//!
//! One hidden window makes them, in the order they are asked for (the frontend asks for the
//! slides in view first), and closes when there is nothing to make for a while. The pictures of
//! one deck waiting together are made in one go: the window loads one page holding each of
//! their slides whole (`?embed&slide=a&slide=b…`, see `html::slides_of`), in which each shows as
//! in a preview of its own, and captures one after the other. A picture the frontend no longer
//! shows before its turn comes (see [`forget`]) is not made.
//!
//! When pictures cannot be made (no capture on the platform, a page that never gets ready) the
//! answer is an error, and the frontend shows the live preview instead; after a few failures in
//! a row it stops trying for the rest of the run.

use std::borrow::Cow;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use sha2::{Digest, Sha256};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Url, WebviewWindow};
use tokio::sync::{mpsc, oneshot};

use crate::error::{Error, Result};
use crate::export_window::{self, Helper, Page};
use crate::{html, protocol, render};

/// First path segment of a thumbnail, followed by the preview's own path.
pub const PREFIX: &str = ".thumb";
/// How wide a picture is, in pixels: sharp in the slide list on a high-density screen, and in
/// the grid of all slides at its largest.
pub const WIDTH: u32 = 960;
/// Changes when pictures are made differently, so that older ones are made again.
const FORMAT: &str = "thumbnail-1";
/// How large the folder of pictures may grow.
pub const CACHE_BYTES: u64 = 256 * 1024 * 1024;
/// How much is written between two looks at the folder's size.
const PRUNE_EVERY: u64 = 16 * 1024 * 1024;
/// The most files of a deck's `assets/` folder looked at for its state.
const MAX_ASSETS: usize = 4000;
/// The most pictures made from one page: each of their slides is laid out and loads its
/// images there.
pub const MAX_BATCH: usize = 12;
/// Longest a page may take to get ready, or a picture to be made in it; one that never gets
/// there gives up its place.
const JOB_TIMEOUT: Duration = Duration::from_secs(20);
/// How long the hidden window stays open with nothing to make.
const IDLE: Duration = Duration::from_secs(20);
/// Failures in a row after which no picture is made for the rest of the run.
const MAX_FAILURES: u32 = 3;
/// What the hidden window is for, as its errors name it.
const TASK: &str = "thumbnails";
/// Why a picture nobody shows any more was not made.
const NOT_WANTED: &str = "the thumbnail is no longer shown";

/// A picture, or why there is none.
type Made = std::result::Result<Arc<[u8]>, String>;

/// What the maker is told.
enum Task {
    /// A picture was asked for.
    Wake,
    /// Close the hidden window now: the app has no window left that shows slides.
    Close,
}

/// One picture to make: the preview's address, its slides' size, and its name in the cache.
#[derive(Debug, Clone)]
struct Job {
    key: String,
    url: Url,
    canvas: (u32, u32),
}

impl Job {
    /// The page the preview is a slide of, and how it is shown: its address without the slide
    /// it names and the version. The pictures of a page made in one go share it.
    fn page(&self) -> String {
        let rest: Vec<_> = query_parts(&self.url)
            .filter(|p| !is_param(p, "slide") && !is_param(p, "v"))
            .collect();
        format!("{}?{}", self.url.path(), rest.join("&"))
    }

    /// The `slide` parameter of the preview, as it is written in its address.
    fn slide_param(&self) -> Option<&str> {
        query_parts(&self.url).find(|p| is_param(p, "slide"))
    }

    /// The slide the preview names, decoded as its page reads it; empty for none (the first).
    fn slide(&self) -> String {
        self.url
            .query_pairs()
            .find(|(name, _)| name == "slide")
            .map(|(_, value)| value.into_owned())
            .unwrap_or_default()
    }
}

/// The parameters of `url`'s query, as written.
fn query_parts(url: &Url) -> impl Iterator<Item = &str> {
    url.query()
        .unwrap_or("")
        .split('&')
        .filter(|p| !p.is_empty())
}

/// Whether the query parameter `part` is `name` (`name` or `name=…`).
fn is_param(part: &str, name: &str) -> bool {
    part.strip_prefix(name)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('='))
}

/// The address of one page in which each of `jobs`' slides shows whole, as in its own preview:
/// the first one's, naming every slide.
fn batch_url(jobs: &[Job]) -> Url {
    let mut url = jobs[0].url.clone();
    let mut parts: Vec<&str> = query_parts(&jobs[0].url)
        .filter(|p| !is_param(p, "slide"))
        .collect();
    parts.extend(jobs.iter().filter_map(Job::slide_param));
    url.set_query(Some(&parts.join("&")));
    url
}

/// Everyone waiting for one picture.
#[derive(Default)]
struct Waiting {
    answers: Vec<oneshot::Sender<Made>>,
    /// The addresses asked for it that are still shown (see [`Thumbnails::forget`]).
    shown: Vec<String>,
}

/// The pictures being made, and who waits for them. Managed by the app (see lib.rs).
#[derive(Default)]
pub struct Thumbnails {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// How the maker is told; none until the first picture is asked for.
    maker: Option<mpsc::UnboundedSender<Task>>,
    /// The pictures to make, in the order asked for.
    queue: VecDeque<Job>,
    /// Everyone waiting for a picture, by its name: asked twice, it is made once.
    waiting: HashMap<String, Waiting>,
    /// Failures since the last picture made.
    failures: u32,
}

impl State {
    /// Asks for `job`'s picture on behalf of a request for `address`; true when it is new.
    fn ask(&mut self, job: Job, address: String, answer: oneshot::Sender<Made>) -> bool {
        let waiting = self.waiting.entry(job.key.clone()).or_default();
        waiting.answers.push(answer);
        waiting.shown.push(address);
        let new = waiting.answers.len() == 1;
        if new {
            self.queue.push_back(job);
        }
        new
    }

    /// Whether anyone still shows the picture `key`.
    fn wanted(&self, key: &str) -> bool {
        self.waiting.get(key).is_some_and(|w| !w.shown.is_empty())
    }

    /// The pictures to make next, from one page: the first one asked for, and the others of its
    /// page waiting, in the order asked for. Those no longer shown are let go on the way, as
    /// `dropped`.
    fn next_batch(&mut self, dropped: &mut Vec<Job>) -> Vec<Job> {
        let mut batch: Vec<Job> = Vec::new();
        let mut rest = VecDeque::with_capacity(self.queue.len());
        while let Some(job) = self.queue.pop_front() {
            if !self.wanted(&job.key) {
                dropped.push(job);
                continue;
            }
            let fits = match batch.first() {
                None => true,
                Some(first) => {
                    batch.len() < MAX_BATCH
                        && first.canvas == job.canvas
                        && first.page() == job.page()
                        && job.slide_param().is_some()
                }
            };
            if fits {
                batch.push(job);
            } else {
                rest.push_back(job);
            }
        }
        self.queue = rest;
        batch
    }

    /// Takes everyone waiting for the picture `key`, counting a failure or a success.
    fn finish(&mut self, key: &str, made: &Made, counts: bool) -> Vec<oneshot::Sender<Made>> {
        if counts {
            self.failures = match made {
                Ok(_) => 0,
                Err(_) => self.failures + 1,
            };
        }
        self.waiting
            .remove(key)
            .map(|w| w.answers)
            .unwrap_or_default()
    }
}

impl Thumbnails {
    /// Whether pictures are still made in this run.
    fn working(&self) -> bool {
        self.state.lock().unwrap().failures < MAX_FAILURES
    }

    /// Waits for the picture of `job`, asked for at `address`, asking the maker for it unless
    /// someone already has.
    async fn wait(&self, app: &AppHandle, job: Job, address: String) -> Made {
        let (tx, rx) = oneshot::channel();
        {
            let mut state = self.state.lock().unwrap();
            if state.ask(job, address, tx) {
                let maker = state.maker.get_or_insert_with(|| {
                    let (tx, rx) = mpsc::unbounded_channel();
                    tauri::async_runtime::spawn(make_all(app.clone(), rx));
                    tx
                });
                // The maker only stops with the app.
                let _ = maker.send(Task::Wake);
            }
        }
        rx.await
            .unwrap_or_else(|_| Err("the thumbnail was not made".into()))
    }

    /// The picture at `address` is no longer shown where it was asked for: unless it is shown
    /// elsewhere too, it is not made when its turn comes.
    pub fn forget(&self, address: &str) {
        let mut state = self.state.lock().unwrap();
        for waiting in state.waiting.values_mut() {
            if let Some(at) = waiting.shown.iter().position(|a| a == address) {
                waiting.shown.swap_remove(at);
                return;
            }
        }
    }

    /// Closes the hidden window, if one is open, rather than when it has been idle a while: the
    /// last of the app's windows has closed, and a window left open would keep the app running.
    pub fn close_window(&self) {
        if let Some(maker) = &self.state.lock().unwrap().maker {
            let _ = maker.send(Task::Close);
        }
    }

    /// The pictures to make next (see [`State::next_batch`]); those no longer shown are
    /// answered that they were not made.
    fn next_batch(&self) -> Vec<Job> {
        let mut dropped = Vec::new();
        let batch = self.state.lock().unwrap().next_batch(&mut dropped);
        for job in dropped {
            self.finish(&job.key, &Err(NOT_WANTED.into()), false);
        }
        batch
    }

    /// Whether anyone still shows the picture `key`.
    fn wanted(&self, key: &str) -> bool {
        self.state.lock().unwrap().wanted(key)
    }

    /// Hands the picture `key` (or why there is none) to everyone waiting for it; `counts` when
    /// it was tried, so that a failure counts towards giving up.
    fn finish(&self, key: &str, made: &Made, counts: bool) {
        let answers = self.state.lock().unwrap().finish(key, made, counts);
        for tx in answers {
            let _ = tx.send(made.clone());
        }
    }
}

/// The address a thumbnail is asked for at, as [`forget`] names it: its path and query.
fn address(url: &Url) -> String {
    match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_string(),
    }
}

/// The picture at `url` (a thumbnail's address) is no longer shown where it was asked for; see
/// [`Thumbnails::forget`].
pub fn forget(app: &AppHandle, url: &str) {
    if let Ok(url) = url.parse::<Url>() {
        app.state::<Thumbnails>().forget(&address(&url));
    }
}

/// The preview a thumbnail's path is the picture of: `/.thumb/.file/…` is `/.file/…`.
pub fn preview_path(raw_path: &str) -> Option<&str> {
    raw_path
        .strip_prefix('/')?
        .strip_prefix(PREFIX)
        .filter(|rest| rest.starts_with('/'))
}

/// The preview's query without `v`, which only tells the webview a preview is new: what the
/// picture shows is in the page itself.
fn options(query: Option<&str>) -> String {
    query
        .unwrap_or("")
        .split('&')
        .filter(|p| !p.is_empty() && *p != "v" && !p.starts_with("v="))
        .collect::<Vec<_>>()
        .join("&")
}

/// The state of a deck's `assets/` folder: how many files it has and when the last of them
/// changed. A slide's images and fonts are there; a picture made before one changed is stale.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Assets {
    files: usize,
    newest: u128,
}

/// The state of the `assets/` folder beside `page_file`, the file a preview is served from;
/// none for one served from the app or a commit, which do not change in place.
pub fn assets_of(page_file: Option<&Path>) -> Assets {
    let Some(folder) = page_file.and_then(Path::parent) else {
        return Assets::default();
    };
    let mut assets = Assets::default();
    let mut dirs = vec![folder.join("assets")];
    while let Some(dir) = dirs.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if assets.files >= MAX_ASSETS {
                return assets;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                dirs.push(entry.path());
                continue;
            }
            assets.files += 1;
            let changed = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos());
            assets.newest = assets.newest.max(changed);
        }
    }
    assets
}

/// The picture's name in the cache: what it shows, and how it is made.
pub fn key(path: &str, query: Option<&str>, page: &[u8], assets: Assets) -> String {
    let mut hash = Sha256::new();
    for part in [
        FORMAT.as_bytes(),
        &WIDTH.to_le_bytes(),
        path.as_bytes(),
        options(query).as_bytes(),
        &assets.files.to_le_bytes(),
        &assets.newest.to_le_bytes(),
    ] {
        hash.update((part.len() as u64).to_le_bytes());
        hash.update(part);
    }
    hash.update(page);
    hash.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// The folder of pictures, each named by its [`key`].
pub struct Cache {
    dir: PathBuf,
}

impl Cache {
    /// `~/.slopslides/thumbnails`.
    pub fn open() -> Result<Cache> {
        Ok(Cache::at(crate::files::app_home()?.join("thumbnails")))
    }

    pub fn at(dir: PathBuf) -> Cache {
        Cache { dir }
    }

    fn file(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.png"))
    }

    /// The picture `key`, if it was made; marked as looked at, so it is kept longest.
    pub fn get(&self, key: &str) -> Option<Vec<u8>> {
        let file = self.file(key);
        let bytes = std::fs::read(&file).ok()?;
        if let Ok(opened) = std::fs::File::options().write(true).open(&file) {
            let _ = opened.set_modified(SystemTime::now());
        }
        Some(bytes)
    }

    pub fn put(&self, key: &str, png: &[u8]) -> Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        crate::files::atomic_write(&self.file(key), png)
    }

    /// Removes the pictures looked at longest ago until the folder holds at most `bytes`.
    pub fn prune(&self, bytes: u64) {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return;
        };
        let mut files: Vec<(SystemTime, u64, PathBuf)> = entries
            .flatten()
            .filter_map(|entry| {
                let meta = entry.metadata().ok().filter(|m| m.is_file())?;
                Some((meta.modified().ok()?, meta.len(), entry.path()))
            })
            .collect();
        let mut total: u64 = files.iter().map(|(_, len, _)| len).sum();
        files.sort();
        for (_, len, path) in files {
            if total <= bytes {
                break;
            }
            if std::fs::remove_file(path).is_ok() {
                total -= len;
            }
        }
    }
}

/// Answers a request for `/.thumb/<preview>`: the picture, from the cache or made now; 503 when
/// pictures are not made in this run, so that the frontend shows the live preview.
pub async fn respond(app: AppHandle, request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    match picture(&app, &request).await {
        Ok((key, png)) => {
            let tag = format!("\"{key}\"");
            let asked = request
                .headers()
                .get(header::IF_NONE_MATCH)
                .and_then(|v| v.to_str().ok());
            let answer = Response::builder()
                .header(header::CONTENT_TYPE, "image/png")
                .header(header::CACHE_CONTROL, "no-cache")
                .header(header::ETAG, &tag)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
            if asked == Some(tag.as_str()) {
                return answer
                    .status(StatusCode::NOT_MODIFIED)
                    .body(Cow::Borrowed(&b""[..]))
                    .unwrap();
            }
            answer.status(StatusCode::OK).body(Cow::Owned(png)).unwrap()
        }
        Err(status) => Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "text/plain")
            .body(Cow::Borrowed(&b""[..]))
            .unwrap(),
    }
}

/// The picture a request asks for, with its name.
async fn picture(
    app: &AppHandle,
    request: &Request<Vec<u8>>,
) -> std::result::Result<(String, Vec<u8>), StatusCode> {
    let uri = request.uri();
    let path = preview_path(uri.path())
        .ok_or(StatusCode::NOT_FOUND)?
        .to_string();
    let query = uri.query().map(str::to_string);
    let asked: Url = uri
        .to_string()
        .parse()
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let url: Url = uri
        .to_string()
        .replacen(&format!("/{PREFIX}/"), "/", 1)
        .parse()
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    // Reading the page and the folders is file work: off the async threads.
    let found = {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let (page, file) = protocol::preview_page(&app, &path, query.as_deref())?;
            let key = key(&path, query.as_deref(), &page, assets_of(file.as_deref()));
            let canvas = html::slide_size(&String::from_utf8_lossy(&page)).pixels();
            let cache = Cache::open().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            let cached = cache.get(&key);
            Ok::<_, StatusCode>((key, canvas, cached))
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)??
    };
    let (key, canvas, cached) = found;
    if let Some(png) = cached {
        return Ok((key, png));
    }
    let thumbnails = app.state::<Thumbnails>();
    if !thumbnails.working() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    let job = Job {
        key: key.clone(),
        url,
        canvas,
    };
    match thumbnails.wait(app, job, address(&asked)).await {
        Ok(png) => Ok((key, png.to_vec())),
        Err(_) => Err(StatusCode::SERVICE_UNAVAILABLE),
    }
}

/// The hidden window pictures are made in, and the size of slides it was opened for.
struct Maker {
    window: WebviewWindow,
    signals: mpsc::UnboundedReceiver<Url>,
    canvas: (u32, u32),
}

impl Drop for Maker {
    fn drop(&mut self) {
        let _ = self.window.destroy();
    }
}

impl Maker {
    /// The window of `maker` showing the page at `url`, opening one for slides of `canvas`.
    fn load<'m>(
        app: &AppHandle,
        maker: &'m mut Option<Maker>,
        url: Url,
        canvas: (u32, u32),
    ) -> Result<&'m mut Maker> {
        match maker {
            Some(open) if open.canvas == canvas => {
                // Answers left over from the last page are not this one's.
                while open.signals.try_recv().is_ok() {}
                open.window
                    .navigate(url)
                    .map_err(|e| Error::msg(format!("cannot show the slide: {e}")))?;
            }
            _ => {
                *maker = None;
                let (window, signals) = export_window::open_url(app, url, canvas, page())?;
                *maker = Some(Maker {
                    window,
                    signals,
                    canvas,
                });
            }
        }
        Ok(maker.as_mut().expect("opened above"))
    }
}

/// Makes the pictures asked for, a page at a time, as long as the app runs.
async fn make_all(app: AppHandle, mut tasks: mpsc::UnboundedReceiver<Task>) {
    let cache = Cache::open().ok();
    if let Some(cache) = &cache {
        cache.prune(CACHE_BYTES);
    }
    let mut maker: Option<Maker> = None;
    let mut written = 0;
    loop {
        let batch = app.state::<Thumbnails>().next_batch();
        if batch.is_empty() {
            match tokio::time::timeout(IDLE, tasks.recv()).await {
                Ok(Some(Task::Wake)) => {}
                Ok(None) => return,
                Ok(Some(Task::Close)) | Err(_) => maker = None,
            }
            continue;
        }
        let mut store = |key: &str, png: &[u8]| {
            let Some(cache) = &cache else { return };
            if cache.put(key, png).is_ok() {
                written += png.len() as u64;
            }
            if written > PRUNE_EVERY {
                cache.prune(CACHE_BYTES);
                written = 0;
            }
        };
        if make_batch(&app, &mut maker, &batch, &mut store)
            .await
            .is_err()
        {
            // A window that failed may be stuck on a page: start again with a new one.
            maker = None;
        }
    }
}

/// Makes the pictures of `batch` (of one page) in the window of `maker`, storing each as it is
/// made and handing it to whoever waits for it. On an error, those not made yet are answered
/// with it (counting as one failure), and the error is returned.
async fn make_batch(
    app: &AppHandle,
    maker: &mut Option<Maker>,
    batch: &[Job],
    store: &mut impl FnMut(&str, &[u8]),
) -> Result<()> {
    let thumbnails = app.state::<Thumbnails>();
    // How many of the batch are answered.
    let mut done = 0;
    let result = async {
        let open = Maker::load(app, maker, batch_url(batch), batch[0].canvas)?;
        let window = open.window.clone();
        let mut helper = Helper {
            window: &window,
            signals: std::mem::replace(&mut open.signals, mpsc::unbounded_channel().1),
            task: TASK,
        };
        let made = async {
            within(ready(&mut helper)).await?;
            for job in batch {
                if thumbnails.wanted(&job.key) {
                    let png = within(capture(&mut helper, &job.slide())).await?;
                    store(&job.key, &png);
                    thumbnails.finish(&job.key, &Ok(Arc::from(png)), true);
                } else {
                    thumbnails.finish(&job.key, &Err(NOT_WANTED.into()), false);
                }
                done += 1;
            }
            Ok::<_, Error>(())
        }
        .await;
        open.signals = helper.signals;
        made
    }
    .await;
    if let Err(e) = &result {
        for (n, job) in batch[done..].iter().enumerate() {
            thumbnails.finish(&job.key, &Err(e.to_string()), n == 0);
        }
    }
    result
}

/// `step`, or an error once it has taken [`JOB_TIMEOUT`].
async fn within<T>(step: impl std::future::Future<Output = Result<T>>) -> Result<T> {
    tokio::time::timeout(JOB_TIMEOUT, step)
        .await
        .unwrap_or_else(|_| Err(Error::msg("the slide took too long to get ready")))
}

/// What the hidden window is: render.rs's, its helper showing each slide on the page in turn.
fn page() -> Page {
    Page {
        label: "thumbnails",
        title: "Thumbnails",
        query: "",
        script: render::RENDER_JS,
        signal: render::SIGNAL_PATH,
        purpose: TASK,
        out_of_sight: true,
    }
}

/// Waits for the page to have loaded, with a slide.
async fn ready(helper: &mut Helper<'_>) -> Result<()> {
    let ready = helper.answer("ready").await?;
    if ready.get("slides").map_or(true, |n| n == "0") {
        return Err(Error::msg("the preview has no slide"));
    }
    Ok(())
}

/// The script that shows the slide a preview names as `slide`, once it is ready (see
/// `assets/render.js`).
fn preview_script(slide: &str) -> String {
    format!(
        "window.__slopRender.preview({})",
        export_window::js_string(slide)
    )
}

/// Shows the slide a preview names as `slide`, every animation finished, and captures it.
async fn capture(helper: &mut Helper<'_>, slide: &str) -> Result<Vec<u8>> {
    let shown = helper.run(&preview_script(slide), "shown").await?;
    if shown.contains_key("missing") {
        return Err(Error::msg("the preview has no slide"));
    }
    export_window::check_view(&shown)?;
    let (rect, viewport) = export_window::geometry(&shown)?;
    let rect = export_window::inside_whole_points(rect);
    export_window::capture(helper.window, rect, viewport, WIDTH).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn a_thumbnail_is_the_picture_of_the_preview_after_its_prefix() {
        assert_eq!(
            preview_path("/.thumb/.file/Users/me/talk/deck.html"),
            Some("/.file/Users/me/talk/deck.html")
        );
        assert_eq!(
            preview_path("/.thumb/.template/t/deck.html"),
            Some("/.template/t/deck.html")
        );
        assert_eq!(preview_path("/.file/a/deck.html"), None);
        assert_eq!(preview_path("/.thumbs/a"), None);
        assert_eq!(preview_path("/.thumb"), None);
    }

    #[test]
    fn the_version_parameter_is_not_part_of_the_name() {
        let page = b"<html>a</html>";
        let a = key(
            "/.file/d.html",
            Some("embed&slide=a&v=1.2.0&static"),
            page,
            Assets::default(),
        );
        let b = key(
            "/.file/d.html",
            Some("embed&slide=a&v=9.9.3&static"),
            page,
            Assets::default(),
        );
        assert_eq!(a, b, "a new version with the same page is the same picture");
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn the_page_where_it_is_its_options_and_assets_make_the_name() {
        let base = key(
            "/.file/d.html",
            Some("embed&slide=a&static"),
            b"x",
            Assets::default(),
        );
        let changed = [
            key(
                "/.file/d.html",
                Some("embed&slide=a&static"),
                b"y",
                Assets::default(),
            ),
            key(
                "/.file/e/d.html",
                Some("embed&slide=a&static"),
                b"x",
                Assets::default(),
            ),
            key(
                "/.file/d.html",
                Some("embed&slide=a&static&print"),
                b"x",
                Assets::default(),
            ),
            key(
                "/.file/d.html",
                Some("embed&slide=a&static"),
                b"x",
                Assets {
                    files: 1,
                    newest: 5,
                },
            ),
        ];
        for other in changed {
            assert_ne!(base, other);
        }
    }

    #[test]
    fn an_asset_that_changes_changes_the_state_of_the_folder() {
        let dir = TempDir::new("thumb-assets");
        let deck = dir.write("talk/deck.html", "<html></html>");
        assert_eq!(
            assets_of(Some(&deck)),
            Assets::default(),
            "no assets folder"
        );
        assert_eq!(assets_of(None), Assets::default());
        let image = dir.write("talk/assets/img/a.png", "1");
        let first = assets_of(Some(&deck));
        assert_eq!(first.files, 1, "files in folders inside count");
        let later = SystemTime::now() + Duration::from_secs(5);
        std::fs::File::options()
            .write(true)
            .open(&image)
            .unwrap()
            .set_modified(later)
            .unwrap();
        assert_ne!(assets_of(Some(&deck)), first, "a newer file");
        dir.write("talk/assets/b.png", "2");
        assert_eq!(assets_of(Some(&deck)).files, 2);
        dir.write("talk/other.png", "3");
        assert_eq!(assets_of(Some(&deck)).files, 2, "only the assets folder");
    }

    #[test]
    fn the_cache_keeps_pictures_by_name_and_lets_the_oldest_go() {
        let dir = TempDir::new("thumb-cache");
        let cache = Cache::at(dir.join("thumbnails"));
        assert_eq!(cache.get("a"), None);
        for (name, age) in [("old", 30), ("mid", 20), ("new", 10)] {
            cache.put(name, &[0; 100]).unwrap();
            let when = SystemTime::now() - Duration::from_secs(age);
            std::fs::File::options()
                .write(true)
                .open(cache.file(name))
                .unwrap()
                .set_modified(when)
                .unwrap();
        }
        // Looking at the oldest keeps it.
        assert_eq!(cache.get("old"), Some(vec![0; 100]));
        cache.prune(250);
        assert_eq!(cache.get("mid"), None, "looked at longest ago");
        assert!(cache.get("old").is_some());
        assert!(cache.get("new").is_some());
        cache.prune(1000);
        assert!(cache.get("new").is_some(), "within the size, nothing goes");
    }

    fn job(key: &str, url: &str) -> Job {
        Job {
            key: key.into(),
            url: url.parse().unwrap(),
            canvas: (1920, 1080),
        }
    }

    /// The preview of slide `slide` of the deck `deck`, as the slide list asks for it.
    fn slide(deck: &str, slide: &str) -> Job {
        job(
            &format!("{deck}/{slide}"),
            &format!(
                "slop://localhost/.file/{deck}/deck.html?embed&slide={slide}&v=1.{slide}&static"
            ),
        )
    }

    /// Asks for `job` as shown at an address of its own (its key), and returns the answer.
    fn ask(state: &mut State, job: Job) -> oneshot::Receiver<Made> {
        let (tx, rx) = oneshot::channel();
        let address = job.key.clone();
        state.ask(job, address, tx);
        rx
    }

    fn keys(jobs: &[Job]) -> Vec<&str> {
        jobs.iter().map(|job| job.key.as_str()).collect()
    }

    #[test]
    fn a_picture_asked_for_twice_is_made_once_and_handed_to_both() {
        let thumbnails = Thumbnails::default();
        let (mut ra, mut rb) = {
            let mut state = thumbnails.state.lock().unwrap();
            let (a, ra) = oneshot::channel();
            let (b, rb) = oneshot::channel();
            assert!(state.ask(slide("t", "a"), "list".into(), a));
            assert!(!state.ask(slide("t", "a"), "grid".into(), b), "made once");
            assert_eq!(state.queue.len(), 1);
            (ra, rb)
        };
        thumbnails.finish("t/a", &Ok(Arc::from(&b"png"[..])), true);
        assert_eq!(&*ra.try_recv().unwrap().unwrap(), b"png");
        assert_eq!(&*rb.try_recv().unwrap().unwrap(), b"png");
        assert!(thumbnails.state.lock().unwrap().waiting.is_empty());
    }

    #[test]
    fn pictures_stop_being_made_after_failures_in_a_row() {
        let thumbnails = Thumbnails::default();
        for _ in 0..MAX_FAILURES - 1 {
            thumbnails.finish("k", &Err("no".into()), true);
        }
        assert!(thumbnails.working());
        thumbnails.finish("k", &Ok(Arc::from(&b"png"[..])), true);
        for _ in 0..MAX_FAILURES - 1 {
            thumbnails.finish("k", &Err("no".into()), true);
        }
        assert!(thumbnails.working(), "a success starts the count again");
        thumbnails.finish("k", &Err(NOT_WANTED.into()), false);
        assert!(
            thumbnails.working(),
            "one not made as nobody shows it is no failure"
        );
        thumbnails.finish("k", &Err("no".into()), true);
        assert!(!thumbnails.working());
    }

    #[test]
    fn the_pictures_of_one_deck_waiting_together_are_made_from_one_page() {
        let mut state = State::default();
        let _answers: Vec<_> = [
            slide("talk", "a"),
            slide("talk", "b"),
            slide("other", "x"),
            slide("talk", "c"),
            job(
                "tpl",
                "slop://localhost/.template/t/deck.html?embed&slide=a&static",
            ),
            slide("other", "y"),
        ]
        .into_iter()
        .map(|job| ask(&mut state, job))
        .collect();
        let mut dropped = Vec::new();
        let first = state.next_batch(&mut dropped);
        assert_eq!(
            keys(&first),
            ["talk/a", "talk/b", "talk/c"],
            "in the order asked"
        );
        assert_eq!(
            batch_url(&first).as_str(),
            "slop://localhost/.file/talk/deck.html?embed&v=1.a&static&slide=a&slide=b&slide=c",
            "one page for all three"
        );
        assert_eq!(
            keys(&state.next_batch(&mut dropped)),
            ["other/x", "other/y"]
        );
        assert_eq!(keys(&state.next_batch(&mut dropped)), ["tpl"]);
        assert!(state.next_batch(&mut dropped).is_empty());
        assert!(dropped.is_empty());
    }

    #[test]
    fn a_page_makes_at_most_a_batch_of_pictures_of_one_size() {
        let mut state = State::default();
        let mut answers = Vec::new();
        for n in 0..MAX_BATCH + 2 {
            answers.push(ask(&mut state, slide("talk", &format!("s{n}"))));
        }
        let mut wide = slide("talk", "wide");
        wide.canvas = (1080, 1350);
        answers.push(ask(&mut state, wide));
        let mut dropped = Vec::new();
        assert_eq!(state.next_batch(&mut dropped).len(), MAX_BATCH);
        assert_eq!(
            keys(&state.next_batch(&mut dropped)),
            ["talk/s12", "talk/s13"]
        );
        assert_eq!(keys(&state.next_batch(&mut dropped)), ["talk/wide"]);
    }

    #[test]
    fn a_picture_no_longer_shown_is_not_made() {
        let thumbnails = Thumbnails::default();
        let (mut gone, mut kept) = {
            let mut state = thumbnails.state.lock().unwrap();
            let gone = ask(&mut state, slide("talk", "a"));
            let (tx, kept) = oneshot::channel();
            state.ask(slide("talk", "b"), "list".into(), tx);
            let (tx, _also) = oneshot::channel();
            state.ask(slide("talk", "b"), "grid".into(), tx);
            (gone, kept)
        };
        thumbnails.forget("talk/a");
        thumbnails.forget("grid");
        thumbnails.forget("never asked");
        assert!(!thumbnails.wanted("talk/a"));
        assert!(thumbnails.wanted("talk/b"), "still shown in the list");
        assert_eq!(keys(&thumbnails.next_batch()), ["talk/b"]);
        assert_eq!(gone.try_recv().unwrap().unwrap_err(), NOT_WANTED);
        assert!(kept.try_recv().is_err(), "still waiting for its picture");
        assert!(thumbnails.working());
    }

    #[test]
    fn a_job_knows_its_page_and_its_slide() {
        let a = job(
            "a",
            "slop://localhost/.file/t/deck.html?embed&slide=c%20d&v=7&static",
        );
        let b = job(
            "b",
            "slop://localhost/.file/t/deck.html?embed&slide=%232&v=8&static",
        );
        assert_eq!(
            a.page(),
            b.page(),
            "the version and the slide are not the page"
        );
        assert_eq!(a.page(), "/.file/t/deck.html?embed&static");
        assert_eq!((a.slide(), b.slide()), ("c d".into(), "#2".into()));
        assert_eq!(a.slide_param(), Some("slide=c%20d"));
        let none = job("n", "slop://localhost/.file/t/deck.html?embed&static");
        assert_eq!(none.slide(), "");
        assert_eq!(batch_url(&[none]).query(), Some("embed&static"));
        assert_eq!(
            address(
                &"slop://localhost/.thumb/.file/t/deck.html?embed&slide=a"
                    .parse()
                    .unwrap()
            ),
            "/.thumb/.file/t/deck.html?embed&slide=a"
        );
    }

    #[test]
    fn a_slide_is_shown_once_it_is_ready_by_the_page_helper() {
        assert_eq!(
            preview_script("a\"b"),
            "window.__slopRender.preview(\"a\\\"b\")"
        );
    }
}
