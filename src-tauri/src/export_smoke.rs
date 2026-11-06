//! `slopslide --export-smoke <deck.html> <out dir> [text…]`: runs every export the app offers
//! with the real webview of the platform and checks each result: PDF, PowerPoint (and its
//! import back), MP4 video (animated and still), slide images, the agent's slide renders, and
//! the standalone HTML deck, which is then opened again. CI runs it on every platform (see
//! .github/workflows/ci.yml), as the exports drive platform code no unit test reaches: hidden
//! windows, printing, captures.
//!
//! Exits 0 when every export worked, 1 otherwise, naming what failed on stderr. Each `text`
//! must come through in the PowerPoint file.

use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Manager, RunEvent};

use crate::capture::{self, Image};
use crate::error::{Error, Result};
use crate::workspace::OpenWorkspace;
use crate::{deck, html, pdf, pptx, protocol, render, video};

pub const FLAG: &str = "--export-smoke";
/// The label the workspace is opened under; no window has it, the exports only need the
/// folder served.
const WORKSPACE_LABEL: &str = "export-smoke";
/// The label the output folder is opened under, to open the exported HTML deck again.
const OUT_LABEL: &str = "export-smoke-out";
/// Each slide's time in the videos: the shortest the export allows keeps the run short.
const VIDEO_SECONDS: f64 = video::MIN_SECONDS;
const VIDEO_FPS: u32 = 24;

/// What to export and where, from the arguments after [`FLAG`].
#[derive(Debug, PartialEq)]
pub struct Args {
    pub deck: PathBuf,
    pub out: PathBuf,
    pub texts: Vec<String>,
}

impl Args {
    pub fn parse(args: &[String]) -> Result<Args> {
        match args {
            [deck, out, texts @ ..] => Ok(Args {
                deck: PathBuf::from(deck),
                out: PathBuf::from(out),
                texts: texts.to_vec(),
            }),
            _ => Err(Error::msg(format!(
                "usage: slopslide {FLAG} <deck.html> <out dir> [text…]"
            ))),
        }
    }
}

/// Runs the exports in an app with no windows of its own, and returns the exit code.
pub fn run(context: tauri::Context<tauri::Wry>, args: &[String]) -> i32 {
    let args = match Args::parse(args) {
        Ok(args) => args,
        Err(e) => {
            eprintln!("{e}");
            return 2;
        }
    };
    let mut context = context;
    context.config_mut().app.windows.clear();
    let code = Arc::new(AtomicI32::new(1));
    let result_code = code.clone();
    let app = tauri::Builder::default()
        .manage(OpenWorkspace::default())
        .register_uri_scheme_protocol("slop", |ctx, request| {
            protocol::handle(ctx.app_handle(), request)
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let exit = match export_all(&handle, &args).await {
                    Ok(()) => {
                        println!("export smoke test passed");
                        0
                    }
                    Err(e) => {
                        eprintln!("export smoke test failed: {e}");
                        1
                    }
                };
                result_code.store(exit, Ordering::SeqCst);
                handle.exit(exit);
            });
            Ok(())
        })
        .build(context);
    let app = match app {
        Ok(app) => app,
        Err(e) => {
            eprintln!("cannot start the app: {e}");
            return 1;
        }
    };
    app.run(|_, event| {
        // Closing an export's hidden window must not end the app; only `exit` does.
        if let RunEvent::ExitRequested {
            code: None, api, ..
        } = event
        {
            api.prevent_exit();
        }
    });
    code.load(Ordering::SeqCst)
}

async fn export_all(app: &AppHandle, args: &Args) -> Result<()> {
    let file = std::path::absolute(&args.deck)?.canonicalize()?;
    let folder = deck::folder(&file).to_path_buf();
    app.state::<OpenWorkspace>()
        .set(WORKSPACE_LABEL, Some(folder));
    std::fs::create_dir_all(&args.out)?;
    let out = args.out.canonicalize()?;
    let loaded = deck::load(&file)?;
    let shown: Vec<String> = loaded
        .slides
        .iter()
        .filter(|s| !s.hidden)
        .map(|s| s.id.clone())
        .collect();
    let canvas = html::slide_size(&deck::read_html(&file)?).pixels();

    step("PDF export", async {
        let pdf_file = out.join("deck.pdf");
        pdf::export(app, &file, &pdf_file).await?;
        check_pdf(
            &std::fs::read(&pdf_file)?,
            shown.len(),
            pdf::PageSize::of_slides(canvas.0, canvas.1),
        )?;
        Ok(pdf_file)
    })
    .await?;

    let pptx_file = step("PowerPoint export", async {
        let pptx_file = out.join("deck.pptx");
        pptx::export(app, &file, &pptx_file).await?;
        check_pptx(&std::fs::read(&pptx_file)?, shown.len(), &args.texts)?;
        Ok(pptx_file)
    })
    .await?;

    step("PowerPoint import", async {
        let import_root = out.join("imported");
        std::fs::create_dir_all(&import_root)?;
        let imported = pptx::import(&pptx_file, &import_root)?;
        if imported.deck.slides.len() != shown.len() {
            return Err(Error::msg(format!(
                "{} slides back from {}",
                imported.deck.slides.len(),
                shown.len()
            )));
        }
        Ok(PathBuf::from(imported.deck.path))
    })
    .await?;

    for animate in [true, false] {
        let (name, path) = match animate {
            true => ("Video export (animated)", out.join("deck.mp4")),
            false => ("Video export (still)", out.join("deck-still.mp4")),
        };
        step(name, async {
            let options = video::Options {
                seconds_per_slide: VIDEO_SECONDS,
                fps: VIDEO_FPS,
                animate,
                narration: false,
                pause_before: 0.0,
                pause_after: 0.0,
            };
            video::export(app, &file, &path, options, |_| {}).await?;
            check_mp4(
                &std::fs::read(&path)?,
                &VideoExpect {
                    size: video::video_size(canvas.0, canvas.1),
                    fps: VIDEO_FPS,
                    slides: shown.len(),
                    frames_per_slide: options.frames_per_slide(),
                },
            )?;
            Ok(path)
        })
        .await?;
    }

    step("Slide image export", async {
        let dir = deck::create_export_dir(&out, &loaded.title)?;
        let images = slide_images(app, &file, &shown, &dir, canvas).await?;
        for image in &images {
            check_png(&std::fs::read(image)?, canvas)
                .map_err(|e| Error::msg(format!("{}: {e}", image.display())))?;
        }
        Ok(dir)
    })
    .await?;

    step("Slide render", async {
        let dir = out.join("rendered");
        std::fs::create_dir_all(&dir)?;
        for rendered in render::render(app, &file, &shown).await? {
            use base64::Engine as _;
            let png = rendered
                .png
                .ok_or_else(|| Error::msg(format!("slide {} was not found", rendered.id)))?;
            let png = base64::engine::general_purpose::STANDARD
                .decode(png)
                .map_err(|e| Error::msg(format!("slide {}: {e}", rendered.id)))?;
            check_png(&png, canvas)
                .map_err(|e| Error::msg(format!("slide {}: {e}", rendered.id)))?;
            std::fs::write(dir.join(format!("{}.png", rendered.id)), png)?;
            if !rendered.overflow.is_empty() {
                println!(
                    "  {} overflows: {}",
                    rendered.id,
                    rendered.overflow.join("; ")
                );
            }
        }
        Ok(dir)
    })
    .await?;

    step("HTML export", async {
        let html_file = out.join("deck-export.html");
        deck::export(&file, &html_file)?;
        check_html_export(&std::fs::read_to_string(&html_file)?, &shown)?;
        // Opened again away from the deck's folder, it must show its slides on its own.
        app.state::<OpenWorkspace>()
            .set(OUT_LABEL, Some(out.clone()));
        let dir = out.join("html-export-slides");
        std::fs::create_dir_all(&dir)?;
        let html_file = html_file.canonicalize()?;
        for image in slide_images(app, &html_file, &shown, &dir, canvas).await? {
            check_png(&std::fs::read(&image)?, canvas)
                .map_err(|e| Error::msg(format!("{}: {e}", image.display())))?;
        }
        Ok(html_file)
    })
    .await?;
    Ok(())
}

/// Runs the export `name`, printing where it wrote; its errors are named after it.
async fn step<T: AsRef<Path>>(
    name: &str,
    export: impl std::future::Future<Output = Result<T>>,
) -> Result<T> {
    let started = std::time::Instant::now();
    let written = export
        .await
        .map_err(|e| Error::msg(format!("{name}: {e}")))?;
    println!(
        "{name} ok in {:.1}s: {}",
        started.elapsed().as_secs_f64(),
        written.as_ref().display()
    );
    Ok(written)
}

/// Exports the `shown` slides of the deck `file` as images into `dir`, as the app's slide
/// image export does: each slide shown whole, then captured at most the canvas width wide.
async fn slide_images(
    app: &AppHandle,
    file: &Path,
    shown: &[String],
    dir: &Path,
    canvas: (u32, u32),
) -> Result<Vec<PathBuf>> {
    let (window, signals) = render::open(app, file)?;
    let mut helper = pdf::Helper {
        window: &window,
        signals,
        task: render::TASK,
    };
    let saved = async {
        helper.answer("ready").await?;
        let mut saved = Vec::new();
        for (index, id) in shown.iter().enumerate() {
            let answer = render::show(&mut helper, id)
                .await?
                .ok_or_else(|| Error::msg(format!("slide {id} was not found")))?;
            let (rect, viewport) = pdf::geometry(&answer)?;
            // The fitted slide sits at a fraction of a pixel; keep its edge out of the image.
            let rect = pdf::inside_whole_points(rect);
            let path = capture::save_slide_image(
                window.as_ref(),
                dir,
                index,
                shown.len(),
                rect,
                viewport,
                Some(canvas.0),
            )
            .await?;
            saved.push(path);
        }
        Ok(saved)
    }
    .await;
    let _ = window.destroy();
    saved
}

/// Whether `bytes` are a whole PDF of `pages` pages of `page` size, with text in it.
pub fn check_pdf(bytes: &[u8], pages: usize, page: pdf::PageSize) -> Result<()> {
    if !bytes.starts_with(b"%PDF-") {
        return Err(Error::msg("the file is not a PDF"));
    }
    let tail = &bytes[bytes.len().saturating_sub(1024)..];
    if !tail.windows(5).any(|w| w == b"%%EOF") {
        return Err(Error::msg("the PDF is cut short"));
    }
    let found = pdf_pages(bytes);
    if found != pages {
        return Err(Error::msg(format!(
            "{found} pages in the PDF, {pages} shown in the deck"
        )));
    }
    let boxes = media_boxes(bytes);
    if boxes.is_empty() {
        return Err(Error::msg("the PDF gives no page size"));
    }
    let near = |a: f64, b: f64| (a - b).abs() <= 1.0;
    if let Some((w, h)) = boxes
        .iter()
        .find(|(w, h)| !near(*w, page.width) || !near(*h, page.height))
    {
        return Err(Error::msg(format!(
            "a {w}×{h} pt page, not {}×{} pt",
            page.width, page.height
        )));
    }
    if !contains(bytes, b"/Font") {
        return Err(Error::msg("the PDF has no text: no fonts"));
    }
    Ok(())
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// How many page objects (`/Type /Page`, not `/Pages`) the PDF has. Every platform's printer
/// writes them uncompressed, outside object streams.
fn pdf_pages(bytes: &[u8]) -> usize {
    let mut count = 0;
    let mut at = 0;
    while let Some(found) = find(&bytes[at..], b"/Type") {
        at += found + 5;
        let mut name = at;
        while bytes.get(name).is_some_and(u8::is_ascii_whitespace) {
            name += 1;
        }
        let page = bytes[name..].starts_with(b"/Page")
            && !bytes
                .get(name + 5)
                .is_some_and(|c| c.is_ascii_alphanumeric());
        count += usize::from(page);
    }
    count
}

/// The width and height of every `/MediaBox [x0 y0 x1 y1]`, in points.
fn media_boxes(bytes: &[u8]) -> Vec<(f64, f64)> {
    let mut boxes = Vec::new();
    let mut at = 0;
    while let Some(found) = find(&bytes[at..], b"/MediaBox") {
        at += found + 9;
        let rest = &bytes[at..bytes.len().min(at + 128)];
        let text = String::from_utf8_lossy(rest);
        let Some(inner) = text
            .trim_start()
            .strip_prefix('[')
            .and_then(|t| t.split(']').next())
        else {
            continue;
        };
        let n: Vec<f64> = inner
            .split_whitespace()
            .filter_map(|v| v.parse().ok())
            .collect();
        if let [x0, y0, x1, y1] = n[..] {
            boxes.push((x1 - x0, y1 - y0));
        }
    }
    boxes
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// What a video of the deck must be.
#[derive(Debug, Clone, Copy)]
pub struct VideoExpect {
    /// Its frames' size, in pixels.
    pub size: (u32, u32),
    pub fps: u32,
    /// How many shown slides it shows, each for `frames_per_slide` frames, from a keyframe.
    pub slides: usize,
    pub frames_per_slide: u32,
}

/// A one-colour frame compresses to well under a byte per thousand pixels (about 700 bytes
/// for 1920×1080); a slide with any text on it to many times that.
const BYTES_PER_KILOPIXEL: u64 = 1;

/// Whether `bytes` are an AV1 MP4 as `expect` says, with something on every slide: no slide
/// whose frames together are so small they can only be one colour. (A slide's first frame
/// may well be one colour: its entrance starts from nothing.)
pub fn check_mp4(bytes: &[u8], expect: &VideoExpect) -> Result<()> {
    let track = read_video_track(bytes)?;
    if (track.width, track.height) != expect.size {
        return Err(Error::msg(format!(
            "a {}×{} video, not {}×{}",
            track.width, track.height, expect.size.0, expect.size.1
        )));
    }
    let timescale = u64::from(track.timescale.max(1));
    let fps = u64::from(expect.fps.max(1));
    let frames = u64::from(expect.frames_per_slide) * expect.slides as u64;
    let length: u64 = track.durations.iter().map(|d| u64::from(*d)).sum();
    if length * fps != frames * timescale || track.duration != length {
        return Err(Error::msg(format!(
            "{:.3}s of video, not {:.3}s",
            length as f64 / timescale as f64,
            frames as f64 / fps as f64
        )));
    }
    if track.sizes.len() != track.durations.len() || track.sizes.is_empty() {
        return Err(Error::msg(format!(
            "{} frames but {} frame times",
            track.sizes.len(),
            track.durations.len()
        )));
    }
    // Each slide's bytes, by when its frames start.
    let slide_length = u64::from(expect.frames_per_slide.max(1)) * timescale;
    let mut bytes_per_slide = vec![0u64; expect.slides];
    let mut starts_key = vec![false; expect.slides];
    let mut at = 0u64;
    for (n, (size, duration)) in track.sizes.iter().zip(&track.durations).enumerate() {
        let slide = ((at * fps / slide_length) as usize).min(expect.slides.saturating_sub(1));
        if (at * fps).is_multiple_of(slide_length) && track.keys.contains(&(n as u32 + 1)) {
            starts_key[slide] = true;
        }
        bytes_per_slide[slide] += u64::from(*size);
        at += u64::from(*duration);
    }
    if let Some(slide) = starts_key.iter().position(|key| !key) {
        return Err(Error::msg(format!(
            "slide {} does not start on a keyframe",
            slide + 1
        )));
    }
    let least = u64::from(expect.size.0) * u64::from(expect.size.1) * BYTES_PER_KILOPIXEL / 1000;
    if let Some(slide) = bytes_per_slide.iter().position(|b| *b < least) {
        return Err(Error::msg(format!(
            "slide {} is all one colour ({} bytes)",
            slide + 1,
            bytes_per_slide[slide]
        )));
    }
    Ok(())
}

/// A video track's index, from an MP4 as mp4.rs writes it.
#[derive(Debug, PartialEq)]
struct VideoTrack {
    width: u32,
    height: u32,
    timescale: u32,
    /// The track's length, from `mdhd`, in its time units.
    duration: u64,
    durations: Vec<u32>,
    /// The keyframes, numbered from 1.
    keys: Vec<u32>,
    sizes: Vec<u32>,
}

fn read_video_track(file: &[u8]) -> Result<VideoTrack> {
    let top = mp4_boxes(file)?;
    let kinds: Vec<&[u8; 4]> = top.iter().map(|(k, _)| k).collect();
    if kinds.first() != Some(&b"ftyp") {
        return Err(Error::msg("the file is not an MP4"));
    }
    let moov = child(&top, b"moov")?;
    let trak = child(&mp4_boxes(moov)?, b"trak")?;
    let trak = mp4_boxes(trak)?;
    let mdia = mp4_boxes(child(&trak, b"mdia")?)?;
    let hdlr = child(&mdia, b"hdlr")?;
    if hdlr.get(8..12) != Some(b"vide") {
        return Err(Error::msg("the first track is not video"));
    }
    let mdhd = child(&mdia, b"mdhd")?;
    let (timescale, duration) = match mdhd.first() {
        Some(1) => (u32_at(mdhd, 20)?, u64_at(mdhd, 24)?),
        _ => (u32_at(mdhd, 12)?, u64::from(u32_at(mdhd, 16)?)),
    };
    let minf = mp4_boxes(child(&mdia, b"minf")?)?;
    let stbl = mp4_boxes(child(&minf, b"stbl")?)?;
    let stsd = child(&stbl, b"stsd")?;
    let entries = mp4_boxes(stsd.get(8..).unwrap_or_default())?;
    let entry = child(&entries, b"av01").map_err(|_| Error::msg("the video is not AV1"))?;
    let width = u32::from(u16_at(entry, 24)?);
    let height = u32::from(u16_at(entry, 26)?);
    let mut durations = Vec::new();
    for run in table(child(&stbl, b"stts")?, 0, 8)? {
        let (count, duration) = (u32_at(run, 0)?, u32_at(run, 4)?);
        durations.extend((0..count).map(|_| duration));
    }
    let keys = table(child(&stbl, b"stss")?, 0, 4)?
        .iter()
        .map(|e| u32_at(e, 0))
        .collect::<Result<_>>()?;
    let sizes = table(child(&stbl, b"stsz")?, 4, 4)?
        .iter()
        .map(|e| u32_at(e, 0))
        .collect::<Result<_>>()?;
    Ok(VideoTrack {
        width,
        height,
        timescale,
        duration,
        durations,
        keys,
        sizes,
    })
}

fn broken() -> Error {
    Error::msg("the MP4 is broken")
}

/// The boxes in `data`: (type, body).
fn mp4_boxes(data: &[u8]) -> Result<Vec<([u8; 4], &[u8])>> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < data.len() {
        let size32 = u32_at(data, at)? as usize;
        let kind: [u8; 4] = data
            .get(at + 4..at + 8)
            .and_then(|k| k.try_into().ok())
            .ok_or_else(broken)?;
        let (head, size) = match size32 {
            1 => (16, u64_at(data, at + 8)? as usize),
            0 => (8, data.len() - at),
            n => (8, n),
        };
        let body = data.get(at + head..at + size).ok_or_else(broken)?;
        out.push((kind, body));
        at += size;
    }
    Ok(out)
}

fn child<'a>(boxes: &[([u8; 4], &'a [u8])], kind: &[u8; 4]) -> Result<&'a [u8]> {
    boxes
        .iter()
        .find(|(k, _)| k == kind)
        .map(|(_, body)| *body)
        .ok_or_else(|| {
            Error::msg(format!(
                "the MP4 has no {} box",
                String::from_utf8_lossy(kind)
            ))
        })
}

/// A full box's table: its entry count after `skip` bytes, then entries `width` bytes each.
fn table(body: &[u8], skip: usize, width: usize) -> Result<Vec<&[u8]>> {
    let n = u32_at(body, 4 + skip)? as usize;
    (0..n)
        .map(|i| {
            body.get(8 + skip + i * width..8 + skip + (i + 1) * width)
                .ok_or_else(broken)
        })
        .collect()
}

fn u16_at(data: &[u8], at: usize) -> Result<u16> {
    let bytes = data.get(at..at + 2).ok_or_else(broken)?;
    Ok(u16::from_be_bytes([bytes[0], bytes[1]]))
}

fn u32_at(data: &[u8], at: usize) -> Result<u32> {
    let bytes = data.get(at..at + 4).ok_or_else(broken)?;
    Ok(u32::from_be_bytes(bytes.try_into().expect("4 bytes")))
}

fn u64_at(data: &[u8], at: usize) -> Result<u64> {
    let bytes = data.get(at..at + 8).ok_or_else(broken)?;
    Ok(u64::from_be_bytes(bytes.try_into().expect("8 bytes")))
}

/// Whether `bytes` are a PNG of a slide `canvas` (w, h) pixels: its shape, at most its width,
/// and not blank.
pub fn check_png(bytes: &[u8], canvas: (u32, u32)) -> Result<()> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(Error::msg("the file is not a PNG"));
    }
    let image = capture::decode_png(bytes)?;
    let (w, h) = (f64::from(image.width), f64::from(image.height));
    let tall = w * f64::from(canvas.1) / f64::from(canvas.0.max(1));
    if image.width > canvas.0 || (h - tall).abs() > 1.5 {
        return Err(Error::msg(format!(
            "a {}×{} image of a {}×{} slide",
            image.width, image.height, canvas.0, canvas.1
        )));
    }
    if is_blank(&image) {
        return Err(Error::msg("the image is blank"));
    }
    Ok(())
}

/// Whether nearly every pixel (all but one in a thousand) is the image's most common colour,
/// or the image is fully transparent: nothing was drawn.
pub fn is_blank(image: &Image) -> bool {
    let pixels: Vec<[u8; 4]> = image
        .rgba
        .as_chunks::<4>()
        .0
        .iter()
        .map(|p| [p[0], p[1], p[2], p[3]])
        .collect();
    if pixels.iter().all(|p| p[3] == 0) {
        return true;
    }
    let mut counts = std::collections::HashMap::<[u8; 4], usize>::new();
    for p in &pixels {
        *counts.entry(*p).or_default() += 1;
    }
    let Some((&common, _)) = counts.iter().max_by_key(|(_, n)| **n) else {
        return true;
    };
    let differs = |p: &&[u8; 4]| p.iter().zip(common).any(|(a, b)| a.abs_diff(b) > 16);
    pixels.iter().filter(differs).count() * 1000 < pixels.len()
}

/// Whether `source` is a deck that stands on its own, showing the `shown` slides: the
/// runtime is in it and every asset is inlined.
pub fn check_html_export(source: &str, shown: &[String]) -> Result<()> {
    let slides: Vec<String> = html::find_slides(source)
        .iter()
        .filter(|s| s.hidden.is_none())
        .map(|s| s.id.clone().unwrap_or_default())
        .collect();
    if slides != shown {
        return Err(Error::msg(format!(
            "shows slides {slides:?}, not {shown:?}"
        )));
    }
    if !source.contains(html::CSS_START) || !source.contains(html::JS_START) {
        return Err(Error::msg("the runtime is missing"));
    }
    let left: Vec<&str> = html::asset_refs(source).iter().map(|(_, p)| *p).collect();
    if !left.is_empty() {
        return Err(Error::msg(format!(
            "assets not inlined: {}",
            left.join(", ")
        )));
    }
    Ok(())
}

/// Whether `bytes` are a presentation of `slides` slides holding every one of `texts`.
pub fn check_pptx(bytes: &[u8], slides: usize, texts: &[String]) -> Result<()> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| Error::msg(format!("the file is not a PowerPoint package: {e}")))?;
    let slide_files: Vec<String> = (0..zip.len())
        .filter_map(|i| zip.name_for_index(i)?.ok())
        .map(|name| name.into_owned())
        .filter(|name| is_slide_part(name))
        .collect();
    if slide_files.len() != slides {
        return Err(Error::msg(format!(
            "{} slides in the file, {slides} shown in the deck",
            slide_files.len()
        )));
    }
    let mut xml = String::new();
    for name in &slide_files {
        zip.by_name(name)
            .map_err(|e| Error::msg(format!("cannot read {name}: {e}")))?
            .read_to_string(&mut xml)?;
    }
    for name in ["[Content_Types].xml", "ppt/presentation.xml"] {
        if zip.by_name(name).is_err() {
            return Err(Error::msg(format!("{name} is missing")));
        }
    }
    let missing: Vec<&str> = texts
        .iter()
        .filter(|t| !xml.contains(t.as_str()))
        .map(String::as_str)
        .collect();
    if !missing.is_empty() {
        return Err(Error::msg(format!("text missing: {}", missing.join(", "))));
    }
    Ok(())
}

/// `ppt/slides/slide<n>.xml`.
fn is_slide_part(name: &str) -> bool {
    name.strip_prefix("ppt/slides/slide")
        .and_then(|rest| rest.strip_suffix(".xml"))
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use zip::write::SimpleFileOptions;

    use super::*;
    use crate::lint;

    fn package(parts: &[(&str, &str)]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, body) in parts {
            zip.start_file(*name, SimpleFileOptions::default()).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_the_deck_the_folder_and_the_texts() {
        let args = Args::parse(&strings(&["a/deck.html", "out", "Hello", "World"])).unwrap();
        assert_eq!(
            args,
            Args {
                deck: PathBuf::from("a/deck.html"),
                out: PathBuf::from("out"),
                texts: strings(&["Hello", "World"]),
            }
        );
        assert!(Args::parse(&strings(&["a/deck.html"])).is_err());
    }

    const PAGE: pdf::PageSize = pdf::PageSize {
        width: 1440.0,
        height: 810.0,
    };

    fn pdf_of(pages: &[&str]) -> Vec<u8> {
        let mut out = b"%PDF-1.7\n1 0 obj << /Type /Pages /Count 2 >> endobj\n".to_vec();
        for page in pages {
            out.extend_from_slice(page.as_bytes());
            out.push(b'\n');
        }
        out.extend_from_slice(b"5 0 obj << /Type /Font >> endobj\n%%EOF\n");
        out
    }

    #[test]
    fn a_pdf_needs_its_header_and_end() {
        let page = "<< /Type /Page /MediaBox [0 0 1440 810] >>";
        assert!(check_pdf(&pdf_of(&[page, page]), 2, PAGE).is_ok());
        assert!(check_pdf(b"<html></html>", 0, PAGE).is_err());
        assert!(check_pdf(b"%PDF-1.7\n1 0 obj\n", 0, PAGE).is_err());
    }

    #[test]
    fn a_pdf_needs_a_page_per_shown_slide() {
        // Spaced as WebView2 and Cairo write it, and packed as other writers do.
        let spaced = "<< /Type /Page /MediaBox [0 0 1440 810] >>";
        let packed = "<</Type/Page/MediaBox[0 0 1440.0 810.0]>>";
        assert!(check_pdf(&pdf_of(&[spaced, packed]), 2, PAGE).is_ok());
        let err = check_pdf(&pdf_of(&[spaced]), 2, PAGE)
            .unwrap_err()
            .to_string();
        assert!(err.contains("1 pages"), "{err}");
        assert_eq!(pdf_pages(b"/Type /Pages /Type /PageLabel /Type /Page>>"), 1);
    }

    #[test]
    fn a_pdf_needs_pages_of_the_slide_size() {
        let a4 = "<< /Type /Page /MediaBox [0 0 595.28 841.89] >>";
        let err = check_pdf(&pdf_of(&[a4]), 1, PAGE).unwrap_err().to_string();
        assert!(err.contains("595.28"), "{err}");
        let inherited = "<< /Type /Page >>";
        assert!(
            check_pdf(&pdf_of(&[inherited]), 1, PAGE).is_err(),
            "no size at all"
        );
        assert_eq!(
            media_boxes(b"/MediaBox [ 0 0 1440 810.4 ] /MediaBox [x]"),
            [(1440.0, 810.4)]
        );
    }

    #[test]
    fn a_pdf_needs_text() {
        let page = "<< /Type /Page /MediaBox [0 0 1440 810] >>";
        let file = pdf_of(&[page]);
        let without = String::from_utf8(file)
            .unwrap()
            .replace("/Font", "/XObject");
        let err = check_pdf(without.as_bytes(), 1, PAGE)
            .unwrap_err()
            .to_string();
        assert!(err.contains("no text"), "{err}");
    }

    /// An image of `width` × `height` in the fixture's paper colour, with `ink` of its pixels,
    /// scattered, dark, as text would be.
    fn slide_image(width: u32, height: u32, ink: usize) -> Image {
        let pixels = (width * height) as usize;
        let mut rgba = [244u8, 241, 234, 255].repeat(pixels);
        let mut at = 0usize;
        for _ in 0..ink {
            // Steps coprime to any frame size here, so no pixel is inked twice.
            at = (at + 7919) % pixels;
            rgba[at * 4..at * 4 + 4].copy_from_slice(&[28, 27, 25, 255]);
        }
        Image {
            width,
            height,
            rgba,
        }
    }

    /// A video of one keyframe per image, each shown for `frames` frames at 24 fps.
    fn video_of(images: &[Image], frames: u32) -> Vec<u8> {
        let (w, h) = (images[0].width, images[0].height);
        let mut out = Cursor::new(Vec::new());
        let mut writer = video::VideoWriter::new(&mut out, (w, h), 24).unwrap();
        for image in images {
            writer.keyframe();
            writer.push(image).unwrap();
            for _ in 1..frames {
                writer.repeat().unwrap();
            }
        }
        writer.finish(None).unwrap();
        out.into_inner()
    }

    fn expect(size: (u32, u32), frames_per_slide: u32, slides: usize) -> VideoExpect {
        VideoExpect {
            size,
            fps: 24,
            slides,
            frames_per_slide,
        }
    }

    #[test]
    fn a_video_is_its_size_and_length_with_a_keyframe_per_slide() {
        let images = [slide_image(320, 180, 4000), slide_image(320, 180, 9000)];
        let file = video_of(&images, 12);
        assert!(check_mp4(&file, &expect((320, 180), 12, 2)).is_ok());

        let size = check_mp4(&file, &expect((640, 360), 12, 2))
            .unwrap_err()
            .to_string();
        assert!(size.contains("320×180"), "{size}");
        let length = check_mp4(&file, &expect((320, 180), 18, 2))
            .unwrap_err()
            .to_string();
        assert!(length.contains("1.000s of video, not 1.500s"), "{length}");
        let keys = check_mp4(&file, &expect((320, 180), 8, 3))
            .unwrap_err()
            .to_string();
        assert!(
            keys.contains("slide 2 does not start on a keyframe"),
            "{keys}"
        );
    }

    #[test]
    fn a_slide_of_one_colour_fails() {
        // The 0×0 window of a hidden Linux webview gives frames with nothing on them.
        let blank = slide_image(1920, 1080, 0);
        let file = video_of(&[slide_image(1920, 1080, 200_000), blank], 2);
        let err = check_mp4(&file, &expect((1920, 1080), 2, 2))
            .unwrap_err()
            .to_string();
        assert!(err.contains("slide 2 is all one colour"), "{err}");
    }

    #[test]
    fn a_slide_may_start_from_one_colour_as_its_entrance_plays() {
        let (w, h) = (1920, 1080);
        let mut out = Cursor::new(Vec::new());
        let mut writer = video::VideoWriter::new(&mut out, (w, h), 24).unwrap();
        for _ in 0..2 {
            writer.keyframe();
            writer.push(&slide_image(w, h, 0)).unwrap();
            writer.push(&slide_image(w, h, 200_000)).unwrap();
        }
        writer.finish(None).unwrap();
        assert!(check_mp4(&out.into_inner(), &expect((w, h), 2, 2)).is_ok());
    }

    #[test]
    fn a_broken_or_foreign_file_is_not_a_video() {
        assert!(check_mp4(b"not an mp4 at all", &expect((2, 2), 1, 1)).is_err());
        let file = video_of(&[slide_image(64, 36, 100)], 1);
        let cut = &file[..file.len() - 40];
        assert!(check_mp4(cut, &expect((64, 36), 1, 1)).is_err());
    }

    #[test]
    fn a_slide_image_is_a_png_of_the_slide_shape_with_something_on_it() {
        let png = |image: &Image| capture::encode_png(image).unwrap();
        assert!(check_png(&png(&slide_image(1920, 1080, 50_000)), (1920, 1080)).is_ok());
        // Captured smaller than the canvas (a window fitted to the screen) is fine.
        assert!(check_png(&png(&slide_image(1536, 864, 40_000)), (1920, 1080)).is_ok());

        let shape = check_png(&png(&slide_image(1920, 1200, 50_000)), (1920, 1080))
            .unwrap_err()
            .to_string();
        assert!(shape.contains("1920×1200"), "{shape}");
        assert!(check_png(&png(&slide_image(3840, 2160, 50_000)), (1920, 1080)).is_err());
        let blank = check_png(&png(&slide_image(1920, 1080, 0)), (1920, 1080))
            .unwrap_err()
            .to_string();
        assert!(blank.contains("blank"), "{blank}");
        assert!(check_png(b"GIF89a", (1920, 1080)).is_err());
    }

    #[test]
    fn blank_means_one_colour_or_see_through() {
        assert!(is_blank(&slide_image(100, 100, 5)));
        assert!(!is_blank(&slide_image(100, 100, 50)));
        let mut dark = slide_image(100, 100, 50);
        for px in dark.rgba.as_chunks_mut::<4>().0.iter_mut().take(10) {
            px.copy_from_slice(&[0, 0, 0, 255]);
        }
        assert!(!is_blank(&dark), "whatever colour the first pixels are");
        let clear = Image {
            width: 2,
            height: 1,
            rgba: vec![0, 0, 0, 0, 255, 255, 255, 0],
        };
        assert!(is_blank(&clear));
    }

    #[test]
    fn the_html_export_of_the_fixture_stands_on_its_own() {
        let file = fixture();
        let out = tempfile_dir().join("deck.html");
        deck::export(&file, &out).unwrap();
        let shown = strings(&["title", "shapes"]);
        check_html_export(&std::fs::read_to_string(&out).unwrap(), &shown).unwrap();
        let _ = std::fs::remove_dir_all(out.parent().unwrap());
    }

    #[test]
    fn an_html_export_needs_its_slides_runtime_and_assets() {
        let shown = strings(&["a"]);
        let deck = |body: &str| {
            format!(
                "<html><head>{} {}</head><body><main class=\"deck\">{body}</main></body></html>",
                html::CSS_START,
                html::JS_START
            )
        };
        let one = r#"<section class="slide" id="a"></section><section class="slide" id="b" data-hidden></section>"#;
        assert!(check_html_export(&deck(one), &shown).is_ok());
        let err = check_html_export(&deck(r#"<section class="slide" id="b"></section>"#), &shown)
            .unwrap_err()
            .to_string();
        assert!(err.contains("\"b\""), "{err}");
        let bare = one.to_string();
        assert!(check_html_export(&bare, &shown)
            .unwrap_err()
            .to_string()
            .contains("runtime"));
        let linked = deck(r#"<section class="slide" id="a"><img src="assets/x.png"></section>"#);
        let err = check_html_export(&linked, &shown).unwrap_err().to_string();
        assert!(err.contains("assets/x.png"), "{err}");
    }

    #[test]
    fn a_presentation_needs_its_slides_and_texts() {
        let file = package(&[
            ("[Content_Types].xml", "<Types/>"),
            ("ppt/presentation.xml", "<p:presentation/>"),
            ("ppt/slides/slide1.xml", "<a:t>Export smoke test</a:t>"),
            ("ppt/slides/slide2.xml", "<a:t>Shapes</a:t>"),
            ("ppt/slides/_rels/slide1.xml.rels", "<Relationships/>"),
        ]);
        assert!(check_pptx(&file, 2, &strings(&["Export smoke test", "Shapes"])).is_ok());
        let wrong_count = check_pptx(&file, 3, &[]).unwrap_err().to_string();
        assert!(wrong_count.contains("2 slides"), "{wrong_count}");
        let missing = check_pptx(&file, 2, &strings(&["Nowhere"]))
            .unwrap_err()
            .to_string();
        assert!(missing.contains("Nowhere"), "{missing}");
        assert!(check_pptx(b"not a zip", 0, &[]).is_err());
    }

    #[test]
    fn a_presentation_needs_its_main_parts() {
        let file = package(&[("ppt/slides/slide1.xml", "<a:t>x</a:t>")]);
        assert!(check_pptx(&file, 1, &[]).is_err());
    }

    #[test]
    fn only_slide_parts_count_as_slides() {
        assert!(is_slide_part("ppt/slides/slide12.xml"));
        assert!(!is_slide_part("ppt/slides/_rels/slide1.xml.rels"));
        assert!(!is_slide_part("ppt/slides/slide.xml"));
        assert!(!is_slide_part("ppt/slideLayouts/slideLayout1.xml"));
    }

    fn fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/export-smoke/deck.html")
    }

    fn tempfile_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("export-smoke-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_fixture_deck_has_shown_and_hidden_slides() {
        let loaded = deck::load(&fixture()).unwrap();
        let shown: Vec<&str> = loaded
            .slides
            .iter()
            .filter(|s| !s.hidden)
            .map(|s| s.id.as_str())
            .collect();
        assert_eq!(shown, ["title", "shapes"]);
        assert_eq!(loaded.slides.len(), 3);
    }

    #[test]
    fn the_fixture_deck_lints_clean_and_has_a_picture_to_inline() {
        let file = fixture();
        let errors: Vec<_> = deck::lint(&file, None)
            .unwrap()
            .into_iter()
            .filter(|issue| issue.severity == lint::Severity::Error)
            .collect();
        assert_eq!(errors, []);
        let source = deck::read_html(&file).unwrap();
        let assets: Vec<&str> = html::asset_refs(&source).iter().map(|(_, p)| *p).collect();
        assert_eq!(assets, ["assets/checks.png"]);
        assert!(file.with_file_name("assets/checks.png").is_file());
    }
}
