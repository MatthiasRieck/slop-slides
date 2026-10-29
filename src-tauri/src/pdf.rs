//! PDF export. The deck is printed by the same engine that shows it: a hidden window loads it
//! in its print state (`?static&print`, see protocol.rs) and the platform's webview writes it
//! to the file as PDF, with real, selectable text. The runtime's print stylesheet puts each
//! shown slide on its own page of the slides' size, with backgrounds kept.
//!
//! Each platform prints the window's webview (WKWebView on macOS, WebView2 on Windows,
//! WebKitGTK on Linux) with no dialog, onto pages of the slide size and no margins. WebView2
//! and WebKitGTK print everything as vector. macOS WebKit cannot print transparency (gradients
//! that fade out come out black, masks break), so there each slide's decor is first captured
//! as an image with its text hidden, and the page prints that image with the text on top,
//! still as text (see `assets/pdf.js`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::{mpsc, oneshot};

use crate::error::{Error, Result};
use crate::{deck, html, protocol};

/// PDF points per CSS pixel: 72 per inch over 96.
const POINTS_PER_PX: f64 = 0.75;
/// Where the page's helper answers; the navigation is caught, never made.
const SIGNAL_PATH: &str = "/.pdf-signal";
/// Longest wait for the deck to load, for a step of the helper, or for the PDF to be written.
const TIMEOUT: Duration = Duration::from_secs(60);
/// Decor images are this many pixels per slide pixel: 3840 wide for a 1920 slide, about
/// 290 dpi on a page 13.3 inches wide.
const DECOR_SCALE: f64 = 2.0;
/// The page's helper, run once it has loaded; it starts by reporting when it is ready.
const PDF_JS: &str = include_str!("../assets/pdf.js");

/// A page's size in points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageSize {
    pub width: f64,
    pub height: f64,
}

impl PageSize {
    /// The page for slides `width` × `height` CSS pixels.
    pub fn of_slides(width: u32, height: u32) -> PageSize {
        PageSize {
            width: f64::from(width) * POINTS_PER_PX,
            height: f64::from(height) * POINTS_PER_PX,
        }
    }
}

/// Prints the deck `file` (in the open workspace) to `dest` as a PDF.
pub async fn export(app: &AppHandle, file: &Path, dest: &Path) -> Result<()> {
    let (width, height) = html::slide_size(&deck::read_html(file)?).pixels();
    let dest = absolute_dest(dest)?;
    let dest_file = dest.clone();
    let url = protocol::file_url(file, "static&print")
        .parse()
        .map_err(|e| Error::msg(format!("cannot open the deck for printing: {e}")))?;

    let (window_width, window_height) = window_size((width, height), screen_area(app));
    let (signal_tx, signals) = mpsc::unbounded_channel::<Url>();
    let label = format!("pdf-export-{}", uuid::Uuid::new_v4().simple());
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::CustomProtocol(url))
        .title("PDF export")
        .inner_size(window_width, window_height)
        .visible(false)
        // No title bar: WebKit would inset the page under it, and captures would be off.
        .decorations(false)
        .focused(false)
        .skip_taskbar(true)
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = webview.eval(PDF_JS);
            }
        })
        .on_navigation(move |url| {
            if url.path() != SIGNAL_PATH {
                return true;
            }
            let _ = signal_tx.send(url.clone());
            false
        })
        .build()
        .map_err(|e| Error::msg(format!("cannot open the deck for printing: {e}")))?;

    let mut helper = Helper {
        window: &window,
        signals,
        task: "printing",
    };
    let printed = async {
        let ready = helper.answer("ready").await?;
        let slides: usize = ready
            .get("slides")
            .and_then(|n| n.parse().ok())
            .unwrap_or(0);
        if slides == 0 {
            return Err(Error::msg("the deck has no shown slides to export"));
        }
        let page = platform::paper(PageSize::of_slides(width, height));
        let slide_height = print_height(page, width);
        if (slide_height - f64::from(height)).abs() > 0.001 {
            helper
                .run(
                    &format!("window.__slopPdf.fit({width}, {slide_height})"),
                    "fit",
                )
                .await?;
        }
        if cfg!(target_os = "macos") {
            helper.flatten_decor(slides, width).await?;
        }
        let (tx, rx) = oneshot::channel::<Result<()>>();
        window
            .with_webview(move |platform| platform::print(platform, dest, page, tx))
            .map_err(|e| Error::msg(format!("cannot reach the webview: {e}")))?;
        tokio::time::timeout(TIMEOUT, rx)
            .await
            .map_err(|_| Error::msg("printing the PDF took too long"))?
            .map_err(|_| Error::msg("printing the PDF was cancelled"))??;
        if cfg!(target_os = "macos") {
            let mut pdf = std::fs::read(&dest_file)?;
            if crop_to_whole_points(&mut pdf) > 0 {
                std::fs::write(&dest_file, pdf)?;
            }
        }
        Ok(())
    }
    .await;
    let _ = window.destroy();
    printed
}

/// How tall each slide prints, in CSS pixels, on `paper` for slides `width` pixels wide.
/// WebKit scales the slides to the paper's width and breaks pages every whole CSS pixel of
/// the paper's height (A4 gives 794 px slides 1122 px of its 1122.9), so a slide taller than
/// that spills onto a page of its own.
fn print_height(paper: PageSize, width: u32) -> f64 {
    (paper.height * f64::from(width) / paper.width + 1e-6).floor()
}

/// Crops each page box of a macOS WebKit PDF to whole points at the top: WebKit draws a page
/// whole points tall, shifted down by the fraction (A4 is 841.89 pt; its pages start 0.89 pt
/// down), which would leave a hairline of bare paper above every slide. Boxes are rewritten
/// in place, padded with spaces, so no byte offsets move. Returns how many it cropped.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn crop_to_whole_points(pdf: &mut [u8]) -> usize {
    const KEY: &[u8] = b"/MediaBox";
    let mut cropped = 0;
    let mut at = 0;
    while let Some(found) = find(&pdf[at..], KEY) {
        at += found + KEY.len();
        let Some(top) = box_top(pdf, at) else {
            continue;
        };
        let text = std::str::from_utf8(&pdf[top.clone()]).unwrap_or("");
        let Ok(value) = text.parse::<f64>() else {
            continue;
        };
        if value.fract() == 0.0 {
            continue;
        }
        let whole = format!("{}", value.floor());
        if whole.len() > top.len() {
            continue;
        }
        let field = &mut pdf[top];
        field.fill(b' ');
        field[..whole.len()].copy_from_slice(whole.as_bytes());
        cropped += 1;
    }
    cropped
}

/// Where `haystack` first has `needle`.
fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// The bytes of the fourth number (the top) of the `[x0 y0 x1 y1]` box starting at `at`.
fn box_top(pdf: &[u8], mut at: usize) -> Option<std::ops::Range<usize>> {
    let skip_space = |at: &mut usize| {
        while pdf.get(*at).is_some_and(u8::is_ascii_whitespace) {
            *at += 1;
        }
    };
    skip_space(&mut at);
    if pdf.get(at) != Some(&b'[') {
        return None;
    }
    at += 1;
    let mut number = 0..0;
    for _ in 0..4 {
        skip_space(&mut at);
        let start = at;
        while pdf
            .get(at)
            .is_some_and(|c| c.is_ascii_digit() || *c == b'.' || *c == b'-')
        {
            at += 1;
        }
        if at == start {
            return None;
        }
        number = start..at;
    }
    skip_space(&mut at);
    (pdf.get(at) == Some(&b']')).then_some(number)
}

/// The room on screen for a window, in logical pixels: the main screen's work area.
pub(crate) fn screen_area(app: &AppHandle) -> Option<(f64, f64)> {
    let monitor = app.primary_monitor().ok()??;
    let area = monitor
        .work_area()
        .size
        .to_logical::<f64>(monitor.scale_factor());
    Some((area.width, area.height))
}

/// The hidden window's size: the slides', shrunk to fit well inside `screen` if given. macOS
/// keeps windows on screen, and a window cut down to fit would show part of the page.
pub(crate) fn window_size(slide: (u32, u32), screen: Option<(f64, f64)>) -> (f64, f64) {
    let (w, h) = (f64::from(slide.0), f64::from(slide.1));
    let scale = screen
        .filter(|(sw, sh)| *sw >= 1.0 && *sh >= 1.0)
        .map_or(1.0, |(sw, sh)| (0.8 * sw / w).min(0.8 * sh / h).min(1.0));
    ((w * scale).floor().max(1.0), (h * scale).floor().max(1.0))
}

/// The hidden window's page helper (`assets/pdf.js`, or `assets/video.js` for video.rs) and
/// its answers.
pub(crate) struct Helper<'a> {
    pub window: &'a WebviewWindow,
    pub signals: mpsc::UnboundedReceiver<Url>,
    /// What the window is for, as the errors name it ("printing").
    pub task: &'static str,
}

impl Helper<'_> {
    /// Runs `script` in the page, then waits for the answer named `step`.
    pub async fn run(&mut self, script: &str, step: &str) -> Result<HashMap<String, String>> {
        self.window
            .eval(script)
            .map_err(|e| Error::msg(format!("cannot reach the deck: {e}")))?;
        self.answer(step).await
    }

    /// The next answer, which must be the one named `step`, as its query parameters.
    pub async fn answer(&mut self, step: &str) -> Result<HashMap<String, String>> {
        let url = tokio::time::timeout(TIMEOUT, self.signals.recv())
            .await
            .map_err(|_| {
                Error::msg(format!(
                    "the deck took too long to get ready for {}",
                    self.task
                ))
            })?
            .ok_or_else(|| Error::msg(format!("the deck was closed during {}", self.task)))?;
        let answer = parse_answer(&url);
        if !answer.contains_key(step) {
            return Err(Error::msg(format!(
                "unexpected answer from the deck: {url}"
            )));
        }
        Ok(answer)
    }

    /// Captures each slide's decor (all but its text) and has the page print that image with
    /// only the text on top.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    async fn flatten_decor(&mut self, slides: usize, width: u32) -> Result<()> {
        use base64::Engine as _;
        self.run("window.__slopPdf.decor()", "decor").await?;
        let pixels_wide = decor_pixels(width);
        for index in 0..slides {
            let shown = self
                .run(&format!("window.__slopPdf.show({index})"), "shown")
                .await?;
            let (rect, viewport) = geometry(&shown)?;
            let rect = inside_whole_points(rect);
            #[cfg(target_os = "macos")]
            let png =
                crate::capture::render_region(self.window.as_ref(), rect, viewport, pixels_wide)
                    .await?;
            #[cfg(not(target_os = "macos"))]
            let png =
                crate::capture::snapshot(self.window.as_ref(), rect, viewport, pixels_wide).await?;
            let url = format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(png)
            );
            self.window
                .eval(format!(
                    "window.__slopPdf.paint({index}, {})",
                    js_string(&url)
                ))
                .map_err(|e| Error::msg(format!("cannot reach the deck: {e}")))?;
        }
        self.run("window.__slopPdf.text()", "text").await?;
        Ok(())
    }
}

/// How wide each slide's decor image is, in pixels: [`DECOR_SCALE`] times the canvas width,
/// rendered afresh at that size (not scaled up from the screen).
fn decor_pixels(canvas_width: u32) -> u32 {
    (f64::from(canvas_width) * DECOR_SCALE)
        .round()
        .clamp(1.0, f64::from(crate::size::MAX_PX)) as u32
}

/// The query parameters of a helper's answer (`/.pdf-signal?shown=0&rect=…`).
pub(crate) fn parse_answer(url: &Url) -> HashMap<String, String> {
    url.query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect()
}

/// Where a shown slide is: `rect=x,y,w,h` and `view=w,h`, in CSS pixels.
pub(crate) fn geometry(
    answer: &HashMap<String, String>,
) -> Result<(crate::capture::Rect, crate::capture::Size)> {
    let numbers = |key: &str, n: usize| -> Option<Vec<f64>> {
        let values: Vec<f64> = answer
            .get(key)?
            .split(',')
            .map(|v| v.trim().parse().ok())
            .collect::<Option<_>>()?;
        (values.len() == n).then_some(values)
    };
    match (numbers("rect", 4), numbers("view", 2)) {
        (Some(r), Some(v)) => Ok((
            crate::capture::Rect {
                x: r[0],
                y: r[1],
                width: r[2],
                height: r[3],
            },
            crate::capture::Size {
                width: v[0],
                height: v[1],
            },
        )),
        _ => Err(Error::msg("the deck did not say where its slide is")),
    }
}

/// `rect` shrunk to the whole points inside it. The slide sits at a fraction of a point (the
/// player centres and scales it), and a capture from its exact edge would blend in a hairline
/// of the black page around it; the image is stretched over the slide, so the lost edge (under
/// a pixel) does not show.
pub(crate) fn inside_whole_points(rect: crate::capture::Rect) -> crate::capture::Rect {
    let (left, top) = (rect.x.ceil(), rect.y.ceil());
    let (right, bottom) = (
        (rect.x + rect.width).floor(),
        (rect.y + rect.height).floor(),
    );
    crate::capture::Rect {
        x: left,
        y: top,
        width: (right - left).max(1.0),
        height: (bottom - top).max(1.0),
    }
}

/// `text` as a JavaScript string literal.
pub(crate) fn js_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into())
}

/// `dest` as an absolute path (the platforms want one), checking its folder exists.
pub(crate) fn absolute_dest(dest: &Path) -> Result<PathBuf> {
    let dest = std::path::absolute(dest)?;
    match dest.parent() {
        Some(dir) if dir.is_dir() => Ok(dest),
        _ => Err(Error::msg(format!("not a folder: {}", dest.display()))),
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::cell::{Cell, RefCell};
    use std::ffi::c_void;
    use std::path::PathBuf;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, NSObject};
    use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSPrintInfo, NSPrintJobSavingURL, NSPrintOperation, NSPrintSaveJob,
        NSPrintingPaginationMode,
    };
    use objc2_foundation::{NSSize, NSString, NSURL};
    use objc2_web_kit::WKWebView;
    use tauri::webview::PlatformWebview;
    use tokio::sync::oneshot::Sender;

    use super::PageSize;
    use crate::error::{Error, Result};

    pub struct Ivars {
        tx: Cell<Option<Sender<Result<()>>>>,
    }

    define_class!(
        /// Hears when a print operation has finished, and passes on how it went.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "SlopSlidePdfPrintDelegate"]
        #[ivars = Ivars]
        pub struct PrintDelegate;

        impl PrintDelegate {
            #[unsafe(method(printOperationDidRun:success:contextInfo:))]
            fn did_run(&self, _operation: *mut AnyObject, success: Bool, _context: *mut c_void) {
                if let Some(tx) = self.ivars().tx.take() {
                    let _ = tx.send(if success.as_bool() {
                        Ok(())
                    } else {
                        Err(Error::msg("printing the PDF failed"))
                    });
                }
            }
        }
    );

    impl PrintDelegate {
        fn new(mtm: MainThreadMarker, tx: Sender<Result<()>>) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(Ivars {
                tx: Cell::new(Some(tx)),
            });
            unsafe { msg_send![super(this), init] }
        }

        fn pending(&self) -> bool {
            let tx = self.ivars().tx.take();
            let pending = tx.is_some();
            self.ivars().tx.set(tx);
            pending
        }
    }

    thread_local! {
        /// Delegates of print operations, kept alive until they have reported back
        /// (AppKit does not retain them).
        static DELEGATES: RefCell<Vec<Retained<PrintDelegate>>> = const { RefCell::new(Vec::new()) };
    }

    /// The paper AppKit prints `page` on: a size close to a standard paper becomes that paper.
    pub fn paper(page: PageSize) -> PageSize {
        let info = NSPrintInfo::new();
        info.setPaperSize(NSSize::new(page.width, page.height));
        let paper = info.paperSize();
        PageSize {
            width: paper.width,
            height: paper.height,
        }
    }

    /// Prints the WKWebView to `dest`; runs on the main thread (`with_webview`).
    pub fn print(platform: PlatformWebview, dest: PathBuf, page: PageSize, tx: Sender<Result<()>>) {
        let Some(mtm) = MainThreadMarker::new() else {
            let _ = tx.send(Err(Error::msg("printing must start on the main thread")));
            return;
        };
        // SAFETY: on macOS the platform handle is the window's live WKWebView.
        let webview = unsafe { &*platform.inner().cast::<WKWebView>() };
        let Some(window) = webview.window() else {
            let _ = tx.send(Err(Error::msg("the deck is not in a window")));
            return;
        };

        let info = NSPrintInfo::new();
        info.setPaperSize(NSSize::new(page.width, page.height));
        info.setTopMargin(0.0);
        info.setBottomMargin(0.0);
        info.setLeftMargin(0.0);
        info.setRightMargin(0.0);
        info.setHorizontallyCentered(false);
        info.setVerticallyCentered(false);
        info.setHorizontalPagination(NSPrintingPaginationMode::Fit);
        info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
        // SAFETY: the job disposition and saving URL are AppKit's own keys and value types.
        unsafe {
            info.setJobDisposition(NSPrintSaveJob);
            let url = NSURL::fileURLWithPath(&NSString::from_str(&dest.to_string_lossy()));
            info.dictionary()
                .insert(NSPrintJobSavingURL, &*url as &AnyObject);
        }

        // SAFETY: a print operation for this live web view, run on the main thread.
        let operation: Retained<NSPrintOperation> =
            unsafe { webview.printOperationWithPrintInfo(&info) };
        operation.setShowsPrintPanel(false);
        operation.setShowsProgressPanel(false);
        // WebKit's printing view starts with no size, and would print blank pages.
        if let Some(view) = operation.view() {
            view.setFrame(webview.bounds());
        }
        let delegate = PrintDelegate::new(mtm, tx);
        DELEGATES.with(|all| {
            let mut all = all.borrow_mut();
            all.retain(|d| d.pending());
            all.push(delegate.clone());
        });
        // A modal run keeps the run loop going, which WebKit needs to lay out the pages; with
        // no panels, nothing is shown.
        unsafe {
            operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                &window,
                Some(&delegate),
                Some(sel!(printOperationDidRun:success:contextInfo:)),
                std::ptr::null_mut(),
            );
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::cell::Cell;
    use std::path::PathBuf;
    use std::rc::Rc;

    use tauri::webview::PlatformWebview;
    use tokio::sync::oneshot::Sender;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2_2, ICoreWebView2_7,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, HSTRING};

    use super::PageSize;
    use crate::error::{Error, Result};

    /// The paper `page` prints on: exactly that size.
    pub fn paper(page: PageSize) -> PageSize {
        page
    }

    /// Prints the WebView2 to `dest`; runs on the UI thread (`with_webview`).
    pub fn print(platform: PlatformWebview, dest: PathBuf, page: PageSize, tx: Sender<Result<()>>) {
        let tx = Rc::new(Cell::new(Some(tx)));
        let reply = move |result: Result<()>| {
            if let Some(tx) = tx.take() {
                let _ = tx.send(result);
            }
        };
        // SAFETY: COM calls on the live controller, from the thread that owns it.
        if let Err(e) = unsafe { begin(&platform, &dest, page, reply.clone()) } {
            reply(Err(failed(e)));
        }
    }

    unsafe fn begin(
        platform: &PlatformWebview,
        dest: &std::path::Path,
        page: PageSize,
        reply: impl Fn(Result<()>) + 'static,
    ) -> windows::core::Result<()> {
        let webview = platform.controller().CoreWebView2()?;
        let environment = webview
            .cast::<ICoreWebView2_2>()?
            .Environment()?
            .cast::<ICoreWebView2Environment6>()?;
        let settings = environment.CreatePrintSettings()?;
        // WebView2 measures pages in inches.
        settings.SetPageWidth(page.width / 72.0)?;
        settings.SetPageHeight(page.height / 72.0)?;
        settings.SetMarginTop(0.0)?;
        settings.SetMarginBottom(0.0)?;
        settings.SetMarginLeft(0.0)?;
        settings.SetMarginRight(0.0)?;
        settings.SetScaleFactor(1.0)?;
        settings.SetShouldPrintBackgrounds(true)?;
        settings.SetShouldPrintHeaderAndFooter(false)?;
        let handler = PrintToPdfCompletedHandler::create(Box::new(
            move |result: windows::core::Result<()>, success: bool| {
                reply(match result {
                    Ok(()) if success => Ok(()),
                    Ok(()) => Err(Error::msg("printing the PDF failed")),
                    Err(e) => Err(failed(e)),
                });
                Ok(())
            },
        ));
        webview.cast::<ICoreWebView2_7>()?.PrintToPdf(
            &HSTRING::from(dest.as_os_str()),
            &settings,
            &handler,
        )
    }

    fn failed(e: windows::core::Error) -> Error {
        Error::msg(format!("printing the PDF failed: {e}"))
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::cell::Cell;
    use std::path::PathBuf;
    use std::rc::Rc;

    use gtk::{PageOrientation, PageSetup, PaperSize, PrintSettings, Unit};
    use tauri::webview::PlatformWebview;
    use tokio::sync::oneshot::Sender;
    use webkit2gtk::{PrintOperation, PrintOperationExt};

    use super::PageSize;
    use crate::error::{Error, Result};

    /// GTK's built-in printer that writes files, by its English name; GTK shows (and looks
    /// it up by) the name translated into the user's language, from its `gtk30` catalog.
    const FILE_PRINTER: &str = "Print to File";

    /// The paper `page` prints on: exactly that size.
    pub fn paper(page: PageSize) -> PageSize {
        page
    }

    /// Prints the WebKitGTK view to `dest`; runs on the GTK thread (`with_webview`).
    pub fn print(platform: PlatformWebview, dest: PathBuf, page: PageSize, tx: Sender<Result<()>>) {
        let uri = match gtk::glib::filename_to_uri(&dest, None) {
            Ok(uri) => uri,
            Err(e) => {
                let _ = tx.send(Err(Error::msg(format!("cannot save to that file: {e}"))));
                return;
            }
        };
        let settings = PrintSettings::new();
        settings.set_printer(&gtk::glib::dgettext(Some("gtk30"), FILE_PRINTER));
        settings.set(gtk::PRINT_SETTINGS_OUTPUT_FILE_FORMAT, Some("pdf"));
        settings.set(gtk::PRINT_SETTINGS_OUTPUT_URI, Some(uri.as_str()));
        let paper =
            PaperSize::new_custom("slopslide", "Slide", page.width, page.height, Unit::Points);
        let setup = PageSetup::new();
        setup.set_orientation(PageOrientation::Portrait);
        setup.set_paper_size(&paper);
        for set in [
            PageSetup::set_top_margin,
            PageSetup::set_bottom_margin,
            PageSetup::set_left_margin,
            PageSetup::set_right_margin,
        ] {
            set(&setup, 0.0, Unit::Points);
        }
        settings.set_paper_size(&paper);

        let operation = PrintOperation::new(&platform.inner());
        operation.set_print_settings(&settings);
        operation.set_page_setup(&setup);
        let tx = Rc::new(Cell::new(Some(tx)));
        let failed = tx.clone();
        operation.connect_failed(move |_, error| {
            if let Some(tx) = failed.take() {
                let _ = tx.send(Err(Error::msg(format!("printing the PDF failed: {error}"))));
            }
        });
        // `finished` follows `failed` too; by then the error has been sent.
        operation.connect_finished(move |_| {
            if let Some(tx) = tx.take() {
                let _ = tx.send(Ok(()));
            }
        });
        operation.print();
    }
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
mod platform {
    use std::path::PathBuf;

    use tauri::webview::PlatformWebview;
    use tokio::sync::oneshot::Sender;

    use super::PageSize;
    use crate::error::{Error, Result};

    pub fn paper(page: PageSize) -> PageSize {
        page
    }

    pub fn print(
        _platform: PlatformWebview,
        _dest: PathBuf,
        _page: PageSize,
        tx: Sender<Result<()>>,
    ) {
        let _ = tx.send(Err(Error::msg(
            "PDF export is not supported on this platform",
        )));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_are_the_slide_size_in_points() {
        assert_eq!(
            PageSize::of_slides(1920, 1080),
            PageSize {
                width: 1440.0,
                height: 810.0
            }
        );
        assert_eq!(
            PageSize::of_slides(1080, 1350),
            PageSize {
                width: 810.0,
                height: 1012.5
            }
        );
    }

    #[test]
    fn the_window_fits_well_inside_the_screen() {
        assert_eq!(window_size((1920, 1080), None), (1920.0, 1080.0));
        assert_eq!(
            window_size((1920, 1080), Some((3008.0, 1667.0))),
            (1920.0, 1080.0)
        );
        // A 1440×875 work area: 80% of its height bounds a 16:9 slide.
        assert_eq!(
            window_size((1920, 1080), Some((1440.0, 875.0))),
            (1152.0, 648.0)
        );
        assert_eq!(
            window_size((1080, 1350), Some((1920.0, 1050.0))),
            (672.0, 840.0)
        );
        assert_eq!(
            window_size((1920, 1080), Some((0.0, 0.0))),
            (1920.0, 1080.0)
        );
    }

    #[test]
    fn slides_print_as_tall_as_whole_pixels_of_the_paper_allow() {
        // A 21×29.7 cm slide is 794×1123 px; macOS gives it A4, 595.28×841.89 pt, which
        // WebKit pages every 1122 px (measured: 1122 fits, 1122.1 spills).
        let a4 = PageSize {
            width: 595.2755670547485,
            height: 841.8897705078125,
        };
        assert_eq!(print_height(a4, 794), 1122.0);
        assert_eq!(print_height(PageSize::of_slides(1920, 1080), 1920), 1080.0);
        assert_eq!(print_height(PageSize::of_slides(1080, 1350), 1080), 1350.0);
        assert_eq!(print_height(PageSize::of_slides(794, 1123), 794), 1123.0);
    }

    #[test]
    fn crops_page_boxes_to_whole_points_in_place() {
        let mut pdf = b"<< /Type /Pages /MediaBox [0 0 595.2756 841.8898] /Count 2 >>\n\
            << /Type /Page /MediaBox\n[0 0 810 1012.5] >>\n\
            << /MediaBox [0 0 1440 810] >> /MediaBox (not a box)"
            .to_vec();
        let before = pdf.len();
        assert_eq!(crop_to_whole_points(&mut pdf), 2);
        assert_eq!(pdf.len(), before, "offsets stay put");
        let text = String::from_utf8(pdf).unwrap();
        assert!(
            text.contains("/MediaBox [0 0 595.2756 841     ] /Count"),
            "{text}"
        );
        assert!(text.contains("/MediaBox\n[0 0 810 1012  ] >>"), "{text}");
        assert!(text.contains("/MediaBox [0 0 1440 810] >>"));
    }

    #[test]
    fn leaves_malformed_boxes_alone() {
        let mut pdf = b"/MediaBox [0 0 1.5] /MediaBox [a b c d] /MediaBox [0 0 1 2.5".to_vec();
        let copy = pdf.clone();
        assert_eq!(crop_to_whole_points(&mut pdf), 0);
        assert_eq!(pdf, copy);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn appkit_snaps_a4_slides_to_a4_paper() {
        let paper = platform::paper(PageSize::of_slides(794, 1123));
        assert!(paper.height <= 842.25 && paper.height > 841.0, "{paper:?}");
        let odd = PageSize::of_slides(1920, 1080);
        assert_eq!(platform::paper(odd), odd, "no standard paper is close");
    }

    #[test]
    fn decor_images_are_twice_the_canvas_within_limits() {
        assert_eq!(decor_pixels(1920), 3840);
        assert_eq!(decor_pixels(1080), 2160);
        assert_eq!(decor_pixels(9000), crate::size::MAX_PX);
        assert_eq!(decor_pixels(0), 1);
    }

    #[test]
    fn the_helper_answers_on_the_signal_path() {
        assert!(PDF_JS.contains(&format!("location.origin + \"{SIGNAL_PATH}?\"")));
        assert!(PDF_JS.contains("window.__slopPdf.ready();"));
    }

    #[test]
    fn reads_answers_and_slide_geometry() {
        let url: Url = "slop://localhost/.pdf-signal?shown=2&rect=0,12.5,1920,1080&view=1920,1105"
            .parse()
            .unwrap();
        let answer = parse_answer(&url);
        assert_eq!(answer["shown"], "2");
        let (rect, view) = geometry(&answer).unwrap();
        assert_eq!(
            rect,
            crate::capture::Rect {
                x: 0.0,
                y: 12.5,
                width: 1920.0,
                height: 1080.0
            }
        );
        assert_eq!(
            view,
            crate::capture::Size {
                width: 1920.0,
                height: 1105.0
            }
        );
        let ready = parse_answer(
            &"http://slop.localhost/.pdf-signal?ready&slides=7"
                .parse()
                .unwrap(),
        );
        assert_eq!(ready["slides"], "7");
        assert!(ready.contains_key("ready"));
    }

    #[test]
    fn captures_only_whole_points_inside_the_slide() {
        let rect = |x, y, width, height| crate::capture::Rect {
            x,
            y,
            width,
            height,
        };
        // As the player showed an A4 slide: 0.09 px down, its bottom edge mid-pixel.
        assert_eq!(
            inside_whole_points(rect(0.0, 0.09375, 1877.0, 1055.8125)),
            rect(0.0, 1.0, 1877.0, 1054.0)
        );
        assert_eq!(
            inside_whole_points(rect(28.2777, 0.0, 1820.4443, 1024.0)),
            rect(29.0, 0.0, 1819.0, 1024.0)
        );
        assert_eq!(inside_whole_points(rect(10.0, 10.0, 0.5, 0.5)).width, 1.0);
    }

    #[test]
    fn rejects_answers_without_geometry() {
        let answer =
            |q: &str| parse_answer(&format!("slop://localhost/.pdf-signal?{q}").parse().unwrap());
        assert!(geometry(&answer("shown=0")).is_err());
        assert!(geometry(&answer("shown=0&rect=1,2,3&view=4,5")).is_err());
        assert!(geometry(&answer("shown=0&rect=1,2,x,4&view=4,5")).is_err());
    }

    #[test]
    fn quotes_javascript_strings() {
        assert_eq!(
            js_string("data:image/png;base64,AB+/="),
            "\"data:image/png;base64,AB+/=\""
        );
        assert_eq!(js_string("a\"b\\"), "\"a\\\"b\\\\\"");
    }

    #[test]
    fn destinations_must_be_in_an_existing_folder() {
        let dir = std::env::temp_dir().join(format!("slopslide-pdf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = absolute_dest(&dir.join("Talk.pdf")).unwrap();
        assert!(dest.is_absolute());
        assert_eq!(dest.file_name().unwrap(), "Talk.pdf");
        assert!(absolute_dest(&dir.join("missing").join("Talk.pdf")).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
