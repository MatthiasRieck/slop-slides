//! Screenshots of part of the app's own window, used to show the agent a slide the user
//! sketched on. The native webview renders the slide iframe and the ink layer on top of it
//! together, which the page itself cannot do: the slide is a sandboxed cross-origin frame.
//!
//! Each platform grabs the whole visible webview (WKWebView on macOS, WebView2 on Windows,
//! WebKitGTK on Linux). The shared code below then maps the requested CSS-pixel region onto
//! that image, whatever its scale factor, and crops, downsizes and encodes it.

use std::io::Cursor;

use serde::Deserialize;
use tauri::Webview;

use crate::error::{Error, Result};

/// Widest sketch screenshot, in pixels; about what the model looks at anyway.
pub const SKETCH_WIDTH: u32 = 1600;
/// Widest exported slide image when the canvas width is not given: the default 1920×1080 stage.
pub const SLIDE_WIDTH: u32 = 1920;

/// A region of the webview in CSS pixels, as `getBoundingClientRect()` reports it.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The webview's size in CSS pixels (`innerWidth`, `innerHeight`).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

/// An 8-bit RGBA bitmap, rows top to bottom.
#[derive(Debug, Clone, PartialEq)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

impl Image {
    fn pixel(&self, x: u32, y: u32) -> &[u8] {
        let i = (y as usize * self.width as usize + x as usize) * 4;
        &self.rgba[i..i + 4]
    }
}

/// PNG of `rect` as currently shown in `webview`, at most `max_width` pixels wide.
pub async fn snapshot(
    webview: &Webview,
    rect: Rect,
    viewport: Size,
    max_width: u32,
) -> Result<Vec<u8>> {
    let image = snapshot_image(webview, rect, viewport, max_width).await?;
    tauri::async_runtime::spawn_blocking(move || encode_png(&image))
        .await
        .map_err(|e| Error::msg(format!("screenshot failed: {e}")))?
}

/// The pixels of `rect` as currently shown in `webview`, at most `max_width` pixels wide.
pub async fn snapshot_image(
    webview: &Webview,
    rect: Rect,
    viewport: Size,
    max_width: u32,
) -> Result<Image> {
    check(rect, viewport)?;
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Image>>();
    webview
        .with_webview(move |platform| platform::start(platform, tx))
        .map_err(|e| Error::msg(format!("cannot reach the webview: {e}")))?;
    let full = rx
        .await
        .map_err(|_| Error::msg("the screenshot was cancelled"))??;
    tauri::async_runtime::spawn_blocking(move || {
        let region = crop(&full, rect, viewport)?;
        Ok(downscale(&region, max_width))
    })
    .await
    .map_err(|e| Error::msg(format!("screenshot failed: {e}")))?
}

/// PNG of `rect` of `webview`, rendered afresh `pixels_wide` pixels wide: sharper than the
/// screen shows it, as WebKit draws the region again at that size rather than scaling pixels.
/// The PNG keeps the snapshot's colour profile.
#[cfg(target_os = "macos")]
pub async fn render_region(
    webview: &Webview,
    rect: Rect,
    viewport: Size,
    pixels_wide: u32,
) -> Result<Vec<u8>> {
    render(webview, rect, viewport, pixels_wide, platform::png).await
}

/// The pixels of `rect` of `webview`, rendered afresh `pixels_wide` pixels wide (see
/// [`render_region`]), read straight from the snapshot without encoding an image file.
#[cfg(target_os = "macos")]
pub async fn render_region_image(
    webview: &Webview,
    rect: Rect,
    viewport: Size,
    pixels_wide: u32,
) -> Result<Image> {
    render(webview, rect, viewport, pixels_wide, platform::pixels).await
}

#[cfg(target_os = "macos")]
async fn render<T: Send + 'static>(
    webview: &Webview,
    rect: Rect,
    viewport: Size,
    pixels_wide: u32,
    convert: fn(&objc2_app_kit::NSImage) -> Result<T>,
) -> Result<T> {
    check(rect, viewport)?;
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<T>>();
    webview
        .with_webview(move |platform| {
            platform::start_region(platform, rect, pixels_wide, tx, convert)
        })
        .map_err(|e| Error::msg(format!("cannot reach the webview: {e}")))?;
    rx.await
        .map_err(|_| Error::msg("the screenshot was cancelled"))?
}

fn check(rect: Rect, viewport: Size) -> Result<()> {
    let finite = [
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        viewport.width,
        viewport.height,
    ]
    .iter()
    .all(|v| v.is_finite());
    let sized = rect.width >= 1.0 && rect.height >= 1.0;
    if finite && sized && viewport.width >= 1.0 && viewport.height >= 1.0 {
        Ok(())
    } else {
        Err(Error::msg("nothing to capture: the slide is not on screen"))
    }
}

/// The part of `full` (a capture of the whole viewport) that shows `rect`. The capture's
/// pixel density is inferred from its size, so this works on any display scale.
pub fn crop(full: &Image, rect: Rect, viewport: Size) -> Result<Image> {
    let sx = f64::from(full.width) / viewport.width;
    let sy = f64::from(full.height) / viewport.height;
    let clamp = |v: f64, max: u32| v.round().clamp(0.0, f64::from(max)) as u32;
    let (left, right) = (
        clamp(rect.x * sx, full.width),
        clamp((rect.x + rect.width) * sx, full.width),
    );
    let (top, bottom) = (
        clamp(rect.y * sy, full.height),
        clamp((rect.y + rect.height) * sy, full.height),
    );
    if right <= left || bottom <= top {
        return Err(Error::msg("nothing to capture: the slide is not on screen"));
    }
    let (width, height) = (right - left, bottom - top);
    let mut rgba = Vec::with_capacity(width as usize * height as usize * 4);
    for y in top..bottom {
        let start = (y as usize * full.width as usize + left as usize) * 4;
        rgba.extend_from_slice(&full.rgba[start..start + width as usize * 4]);
    }
    Ok(Image {
        width,
        height,
        rgba,
    })
}

/// `image` shrunk to at most `max_width` wide, averaging the pixels each output pixel
/// covers. Smaller images are returned as they are.
pub fn downscale(image: &Image, max_width: u32) -> Image {
    if image.width <= max_width || max_width == 0 {
        return image.clone();
    }
    let width = max_width;
    let height = ((u64::from(image.height) * u64::from(width) + u64::from(image.width) / 2)
        / u64::from(image.width))
    .max(1) as u32;
    // Source pixels [span(i), span(i + 1)) feed output pixel i.
    let span = |i: u32, out: u32, src: u32| (u64::from(i) * u64::from(src) / u64::from(out)) as u32;
    let mut rgba = Vec::with_capacity(width as usize * height as usize * 4);
    for oy in 0..height {
        let (y0, y1) = (
            span(oy, height, image.height),
            span(oy + 1, height, image.height),
        );
        let y1 = y1.max(y0 + 1);
        for ox in 0..width {
            let (x0, x1) = (
                span(ox, width, image.width),
                span(ox + 1, width, image.width),
            );
            let x1 = x1.max(x0 + 1);
            let mut sum = [0u64; 4];
            for y in y0..y1 {
                for x in x0..x1 {
                    for (s, &c) in sum.iter_mut().zip(image.pixel(x, y)) {
                        *s += u64::from(c);
                    }
                }
            }
            let count = u64::from((x1 - x0) * (y1 - y0));
            rgba.extend(sum.iter().map(|s| ((s + count / 2) / count) as u8));
        }
    }
    Image {
        width,
        height,
        rgba,
    }
}

pub fn encode_png(image: &Image) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, image.width, image.height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let fail = |e: png::EncodingError| Error::msg(format!("cannot encode the screenshot: {e}"));
    let mut writer = encoder.write_header().map_err(fail)?;
    writer.write_image_data(&image.rgba).map_err(fail)?;
    writer.finish().map_err(fail)?;
    Ok(out)
}

/// Decodes a PNG of any color type into RGBA.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn decode_png(bytes: &[u8]) -> Result<Image> {
    let fail = |e: png::DecodingError| Error::msg(format!("cannot read the screenshot: {e}"));
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().map_err(fail)?;
    let size = reader
        .output_buffer_size()
        .ok_or_else(|| Error::msg("the screenshot is too large"))?;
    let mut buf = vec![0; size];
    let info = reader.next_frame(&mut buf).map_err(fail)?;
    let pixels = (info.width * info.height) as usize;
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf[..pixels * 4].to_vec(),
        png::ColorType::Rgb => buf[..pixels * 3]
            .chunks_exact(3)
            .flat_map(|p| [p[0], p[1], p[2], 255])
            .collect(),
        png::ColorType::GrayscaleAlpha => buf[..pixels * 2]
            .chunks_exact(2)
            .flat_map(|p| [p[0], p[0], p[0], p[1]])
            .collect(),
        png::ColorType::Grayscale => buf[..pixels].iter().flat_map(|&g| [g, g, g, 255]).collect(),
        png::ColorType::Indexed => return Err(Error::msg("unexpected palette screenshot")),
    };
    Ok(Image {
        width: info.width,
        height: info.height,
        rgba,
    })
}

/// Turns premultiplied RGBA pixels, in place, into the plain RGBA an [`Image`] holds.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn unpremultiply(rgba: &mut [u8]) {
    for px in rgba.chunks_exact_mut(4) {
        let a = u32::from(px[3]);
        if a == 255 {
            continue;
        }
        for c in &mut px[..3] {
            *c = ((u32::from(*c) * 255 + a / 2).checked_div(a)).map_or(0, |v| v.min(255) as u8);
        }
    }
}

/// Converts cairo's ARGB32 (premultiplied alpha, native-endian 32-bit pixels) to RGBA.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn from_cairo_argb32(data: &[u8], width: u32, height: u32, stride: usize) -> Image {
    let mut rgba = Vec::with_capacity(width as usize * height as usize * 4);
    for row in data.chunks(stride).take(height as usize) {
        for px in row[..width as usize * 4].chunks_exact(4) {
            let argb = u32::from_ne_bytes([px[0], px[1], px[2], px[3]]);
            let a = (argb >> 24) as u8;
            let channel = |shift: u32| {
                let c = (argb >> shift) & 0xff;
                if a == 0 {
                    0
                } else {
                    ((c * 255 + u32::from(a) / 2) / u32::from(a)).min(255) as u8
                }
            };
            rgba.extend([channel(16), channel(8), channel(0), a]);
        }
    }
    Image {
        width,
        height,
        rgba,
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::cell::Cell;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_core_graphics::{
        CGBitmapContextCreate, CGBlendMode, CGColorSpace, CGColorSpaceModel, CGContext, CGImage,
        CGImageAlphaInfo, CGImageByteOrderInfo, CGInterpolationQuality,
    };
    use objc2_foundation::{NSDictionary, NSError, NSNumber, NSPoint, NSRect, NSSize};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
    use tauri::webview::PlatformWebview;
    use tokio::sync::oneshot::Sender;

    use super::{unpremultiply, Image, Rect};
    use crate::error::{Error, Result};

    /// Snapshots the visible WKWebView; runs on the main thread (`with_webview`).
    pub fn start(platform: PlatformWebview, tx: Sender<Result<Image>>) {
        let Some(mtm) = MainThreadMarker::new() else {
            let _ = tx.send(Err(Error::msg("screenshots must start on the main thread")));
            return;
        };
        // SAFETY: on macOS the platform handle is the window's live WKWebView.
        let webview = unsafe { &*platform.inner().cast::<WKWebView>() };
        // The default configuration captures the view's bounds at its backing resolution.
        let config = unsafe { WKSnapshotConfiguration::new(mtm) };
        take(webview, &config, tx, pixels);
    }

    /// Renders `rect` of the WKWebView `pixels_wide` pixels wide and sends `convert` of it;
    /// runs on the main thread (`with_webview`).
    pub fn start_region<T: 'static>(
        platform: PlatformWebview,
        rect: Rect,
        pixels_wide: u32,
        tx: Sender<Result<T>>,
        convert: fn(&NSImage) -> Result<T>,
    ) {
        let Some(mtm) = MainThreadMarker::new() else {
            let _ = tx.send(Err(Error::msg("screenshots must start on the main thread")));
            return;
        };
        // SAFETY: on macOS the platform handle is the window's live WKWebView.
        let webview = unsafe { &*platform.inner().cast::<WKWebView>() };
        // The snapshot width is in points; each is `scale` pixels.
        let scale = webview.window().map_or(1.0, |w| w.backingScaleFactor());
        let config = unsafe { WKSnapshotConfiguration::new(mtm) };
        let region = NSRect::new(
            NSPoint::new(rect.x, rect.y),
            NSSize::new(rect.width, rect.height),
        );
        let width: Retained<NSNumber> = NSNumber::new_f64(f64::from(pixels_wide) / scale);
        // SAFETY: plain configuration values for a snapshot of this view.
        unsafe {
            config.setRect(region);
            config.setSnapshotWidth(Some(&width));
        }
        take(webview, &config, tx, convert);
    }

    /// Takes the snapshot `config` describes and sends `convert` of it to `tx`.
    fn take<T: 'static>(
        webview: &WKWebView,
        config: &WKSnapshotConfiguration,
        tx: Sender<Result<T>>,
        convert: impl Fn(&NSImage) -> Result<T> + 'static,
    ) {
        // The handler is called once, but block2 needs a `Fn`.
        let tx = Cell::new(Some(tx));
        let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            // SAFETY: WebKit passes either a valid image or a valid error (or null).
            let result = match unsafe { image.as_ref() } {
                Some(image) => convert(image),
                None => Err(Error::msg(match unsafe { error.as_ref() } {
                    Some(error) => format!("screenshot failed: {}", error.localizedDescription()),
                    None => "screenshot failed".into(),
                })),
            };
            if let Some(tx) = tx.take() {
                let _ = tx.send(result);
            }
        });
        unsafe { webview.takeSnapshotWithConfiguration_completionHandler(Some(config), &handler) };
    }

    /// `image` as a PNG, its colour profile kept.
    pub fn png(image: &NSImage) -> Result<Vec<u8>> {
        let encode = || {
            let tiff = image.TIFFRepresentation()?;
            let bitmap = NSBitmapImageRep::imageRepWithData(&tiff)?;
            // SAFETY: an empty properties dictionary is always valid.
            unsafe {
                bitmap.representationUsingType_properties(
                    NSBitmapImageFileType::PNG,
                    &NSDictionary::new(),
                )
            }
        };
        encode()
            .map(|data| data.to_vec())
            .ok_or_else(|| Error::msg("cannot encode the screenshot as PNG"))
    }

    /// The pixels of `image` at its full resolution (as its PNG holds them), drawn once into an
    /// RGBA buffer: no PNG is encoded or decoded. The values stay in the snapshot's own colour
    /// space, as in its PNG.
    pub fn pixels(image: &NSImage) -> Result<Image> {
        let fail = || Error::msg("cannot read the screenshot's pixels");
        // The snapshot rep's own size (and a CGImage for it) follows the screen's scale: on a
        // 1x screen a 2x snapshot reads as its points. Its uncompressed TIFF keeps every pixel.
        let tiff = image.TIFFRepresentation().ok_or_else(fail)?;
        let bitmap = NSBitmapImageRep::imageRepWithData(&tiff).ok_or_else(fail)?;
        let cg = bitmap.CGImage().ok_or_else(fail)?;
        let (width, height) = (CGImage::width(Some(&cg)), CGImage::height(Some(&cg)));
        if width == 0 || height == 0 {
            return Err(fail());
        }
        let space = CGImage::color_space(Some(&cg))
            .filter(|space| CGColorSpace::model(Some(space)) == CGColorSpaceModel::RGB)
            .or_else(CGColorSpace::new_device_rgb)
            .ok_or_else(fail)?;
        let mut rgba = vec![0u8; width * height * 4];
        // Bytes R, G, B, A in memory, alpha premultiplied (all CoreGraphics draws into).
        let info = CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0;
        {
            // SAFETY: `rgba` holds `height` rows of `width * 4` bytes and outlives the context.
            let context = unsafe {
                CGBitmapContextCreate(
                    rgba.as_mut_ptr().cast(),
                    width,
                    height,
                    8,
                    width * 4,
                    Some(&space),
                    info,
                )
            }
            .ok_or_else(fail)?;
            CGContext::set_blend_mode(Some(&context), CGBlendMode::Copy);
            CGContext::set_interpolation_quality(Some(&context), CGInterpolationQuality::High);
            let bounds = CGRect::new(
                CGPoint::new(0.0, 0.0),
                CGSize::new(width as f64, height as f64),
            );
            // Bitmap contexts keep the top row first, as images are drawn upright.
            CGContext::draw_image(Some(&context), bounds, Some(&cg));
        }
        unpremultiply(&mut rgba);
        Ok(Image {
            width: width as u32,
            height: height as u32,
            rgba,
        })
    }

    #[cfg(test)]
    mod tests {
        use objc2::AllocAnyThread;
        use objc2_core_graphics::CGBitmapContextCreateImage;

        use super::*;
        use crate::capture::decode_png;

        /// An NSImage of `px` (RGBA, rows top first), `scale` pixels per point, as WebKit's
        /// snapshots of a Retina window are.
        fn ns_image(width: usize, height: usize, px: &[u8], scale: f64) -> Retained<NSImage> {
            let mut data = px.to_vec();
            for p in data.chunks_exact_mut(4) {
                let a = u32::from(p[3]);
                for c in &mut p[..3] {
                    *c = ((u32::from(*c) * a + 127) / 255) as u8;
                }
            }
            let space = CGColorSpace::new_device_rgb().unwrap();
            let info = CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0;
            let context = unsafe {
                CGBitmapContextCreate(
                    data.as_mut_ptr().cast(),
                    width,
                    height,
                    8,
                    width * 4,
                    Some(&space),
                    info,
                )
            }
            .unwrap();
            let cg = CGBitmapContextCreateImage(Some(&context)).unwrap();
            let size = NSSize::new(width as f64 / scale, height as f64 / scale);
            NSImage::initWithCGImage_size(NSImage::alloc(), &cg, size)
        }

        fn gradient(width: usize, height: usize) -> Vec<u8> {
            (0..height)
                .flat_map(|y| {
                    (0..width).flat_map(move |x| [(x * 7) as u8, (y * 5) as u8, (x + y) as u8, 255])
                })
                .collect()
        }

        #[test]
        fn reads_pixels_upright_at_full_retina_resolution() {
            let px = gradient(40, 24);
            let image = pixels(&ns_image(40, 24, &px, 2.0)).unwrap();
            assert_eq!((image.width, image.height), (40, 24), "pixels, not points");
            assert_eq!(image.rgba, px, "same rows, top first, RGBA order");
        }

        #[test]
        fn reads_every_pixel_whatever_the_screen_scale() {
            // The snapshot rep reports its size at the screen's scale, not the image's.
            for scale in [1.0, 3.0] {
                let px = gradient(36, 18);
                let image = pixels(&ns_image(36, 18, &px, scale)).unwrap();
                assert_eq!((image.width, image.height), (36, 18), "at {scale}x");
                assert_eq!(image.rgba, px, "at {scale}x");
            }
        }

        #[test]
        fn matches_the_png_path() {
            let mut px = gradient(33, 17);
            // A transparent and a half-transparent pixel too.
            px[..4].copy_from_slice(&[0, 0, 0, 0]);
            px[4..8].copy_from_slice(&[200, 100, 50, 128]);
            let image = ns_image(33, 17, &px, 2.0);
            let direct = pixels(&image).unwrap();
            let via_png = decode_png(&png(&image).unwrap()).unwrap();
            assert_eq!(
                (direct.width, direct.height),
                (via_png.width, via_png.height)
            );
            assert_eq!(direct.rgba, via_png.rgba);
        }

        /// Run explicitly to compare reading a 1080p snapshot's pixels directly with the
        /// TIFF → PNG → decode path video export used before.
        #[test]
        #[ignore = "1080p capture conversion benchmark; run with --ignored --nocapture"]
        fn benchmark_capture_conversion_1080p() {
            use std::time::Instant;
            let image = ns_image(1920, 1080, &gradient(1920, 1080), 2.0);
            let runs = 20;
            let start = Instant::now();
            for _ in 0..runs {
                std::hint::black_box(decode_png(&png(&image).unwrap()).unwrap());
            }
            let via_png = start.elapsed() / runs;
            let start = Instant::now();
            for _ in 0..runs {
                std::hint::black_box(pixels(&image).unwrap());
            }
            let direct = start.elapsed() / runs;
            eprintln!("1080p frame: TIFF/PNG round trip {via_png:?}, direct pixels {direct:?}");
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::cell::Cell;
    use std::rc::Rc;

    use tauri::webview::PlatformWebview;
    use tokio::sync::oneshot::Sender;
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
    use windows::Win32::System::Com::{IStream, STREAM_SEEK_SET};

    use super::{decode_png, Image};
    use crate::error::{Error, Result};

    /// Captures the WebView2 as a PNG; runs on the UI thread (`with_webview`).
    pub fn start(platform: PlatformWebview, tx: Sender<Result<Image>>) {
        let tx = Rc::new(Cell::new(Some(tx)));
        let reply = move |result: Result<Image>| {
            if let Some(tx) = tx.take() {
                let _ = tx.send(result);
            }
        };
        // SAFETY: COM calls on the live controller, from the thread that owns it.
        if let Err(e) = unsafe { begin(&platform, reply.clone()) } {
            reply(Err(failed(e)));
        }
    }

    unsafe fn begin(
        platform: &PlatformWebview,
        reply: impl Fn(Result<Image>) + 'static,
    ) -> windows::core::Result<()> {
        let webview = platform.controller().CoreWebView2()?;
        let stream = CreateStreamOnHGlobal(HGLOBAL::default(), true)?;
        let handler = CapturePreviewCompletedHandler::create(Box::new({
            let stream = stream.clone();
            move |result: windows::core::Result<()>| {
                reply(
                    result
                        .map_err(failed)
                        .and_then(|()| read_all(&stream))
                        .and_then(|bytes| decode_png(&bytes)),
                );
                Ok(())
            }
        }));
        webview.CapturePreview(
            COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
            &stream,
            &handler,
        )
    }

    fn read_all(stream: &IStream) -> Result<Vec<u8>> {
        // SAFETY: reads into a buffer we own, with its true length.
        unsafe {
            stream.Seek(0, STREAM_SEEK_SET, None).map_err(failed)?;
            let mut out = Vec::new();
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let mut read = 0u32;
                stream
                    .Read(buf.as_mut_ptr().cast(), buf.len() as u32, Some(&mut read))
                    .ok()
                    .map_err(failed)?;
                if read == 0 {
                    return Ok(out);
                }
                out.extend_from_slice(&buf[..read as usize]);
            }
        }
    }

    fn failed(e: windows::core::Error) -> Error {
        Error::msg(format!("screenshot failed: {e}"))
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use cairo::{Context, Format, ImageSurface, Surface};
    use tauri::webview::PlatformWebview;
    use tokio::sync::oneshot::Sender;
    use webkit2gtk::{gio, SnapshotOptions, SnapshotRegion, WebViewExt};

    use super::{from_cairo_argb32, Image};
    use crate::error::{Error, Result};

    /// Snapshots the visible WebKitGTK view; runs on the GTK thread (`with_webview`).
    pub fn start(platform: PlatformWebview, tx: Sender<Result<Image>>) {
        platform.inner().snapshot(
            SnapshotRegion::Visible,
            SnapshotOptions::NONE,
            None::<&gio::Cancellable>,
            move |result| {
                let image = result
                    .map_err(|e| Error::msg(format!("screenshot failed: {e}")))
                    .and_then(|surface| to_image(&surface));
                let _ = tx.send(image);
            },
        );
    }

    /// Copies the snapshot into a surface we own, at its full device resolution.
    fn to_image(surface: &Surface) -> Result<Image> {
        let fail = |e: cairo::Error| Error::msg(format!("cannot read the screenshot: {e}"));
        let source = ImageSurface::try_from(surface.clone())
            .map_err(|_| Error::msg("unexpected screenshot surface"))?;
        let (width, height) = (source.width(), source.height());
        let mut copy = ImageSurface::create(Format::ARgb32, width, height).map_err(fail)?;
        let (sx, sy) = surface.device_scale();
        copy.set_device_scale(sx, sy);
        {
            let cr = Context::new(&copy).map_err(fail)?;
            cr.set_source_surface(surface, 0.0, 0.0).map_err(fail)?;
            cr.paint().map_err(fail)?;
        }
        copy.flush();
        let stride = copy.stride() as usize;
        let data = copy
            .data()
            .map_err(|e| Error::msg(format!("cannot read the screenshot: {e}")))?;
        Ok(from_cairo_argb32(
            &data,
            width as u32,
            height as u32,
            stride,
        ))
    }
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
mod platform {
    use tauri::webview::PlatformWebview;
    use tokio::sync::oneshot::Sender;

    use super::Image;
    use crate::error::{Error, Result};

    pub fn start(_platform: PlatformWebview, tx: Sender<Result<Image>>) {
        let _ = tx.send(Err(Error::msg(
            "slide screenshots are not supported on this platform",
        )));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    const VIEWPORT: Size = Size {
        width: 100.0,
        height: 50.0,
    };

    /// An image whose pixel at (x, y) is [x, y, x + y, 255], so crops are easy to check.
    fn gradient(width: u32, height: u32) -> Image {
        let rgba = (0..height)
            .flat_map(|y| (0..width).flat_map(move |x| [x as u8, y as u8, (x + y) as u8, 255]))
            .collect();
        Image {
            width,
            height,
            rgba,
        }
    }

    fn solid(width: u32, height: u32, px: [u8; 4]) -> Image {
        Image {
            width,
            height,
            rgba: px.repeat((width * height) as usize),
        }
    }

    #[test]
    fn accepts_a_visible_region() {
        assert!(check(rect(10.0, 20.5, 64.0, 36.0), VIEWPORT).is_ok());
        assert!(
            check(rect(-5.0, 0.0, 1.0, 1.0), VIEWPORT).is_ok(),
            "partly off-screen is fine"
        );
    }

    #[test]
    fn rejects_empty_or_invalid_regions() {
        assert!(check(rect(0.0, 0.0, 0.0, 36.0), VIEWPORT).is_err());
        assert!(check(rect(0.0, 0.0, 64.0, 0.5), VIEWPORT).is_err());
        assert!(check(rect(f64::NAN, 0.0, 64.0, 36.0), VIEWPORT).is_err());
        assert!(check(rect(0.0, 0.0, f64::INFINITY, 36.0), VIEWPORT).is_err());
        let no_viewport = Size {
            width: 0.0,
            height: 50.0,
        };
        assert!(check(rect(0.0, 0.0, 64.0, 36.0), no_viewport).is_err());
    }

    #[test]
    fn deserializes_dom_geometry() {
        let parsed: Rect =
            serde_json::from_str(r#"{"x":1.5,"y":2,"width":300,"height":168.75}"#).unwrap();
        assert_eq!(parsed, rect(1.5, 2.0, 300.0, 168.75));
        let size: Size = serde_json::from_str(r#"{"width":1480,"height":920}"#).unwrap();
        assert_eq!(
            size,
            Size {
                width: 1480.0,
                height: 920.0
            }
        );
    }

    #[test]
    fn crops_at_one_pixel_per_css_pixel() {
        let full = gradient(100, 50);
        let out = crop(&full, rect(10.0, 5.0, 20.0, 8.0), VIEWPORT).unwrap();
        assert_eq!((out.width, out.height), (20, 8));
        assert_eq!(out.pixel(0, 0), [10, 5, 15, 255]);
        assert_eq!(out.pixel(19, 7), [29, 12, 41, 255]);
    }

    #[test]
    fn crops_high_density_captures_by_their_scale() {
        // A 2x display: the capture has twice the viewport's pixels each way.
        let full = gradient(200, 100);
        let out = crop(&full, rect(10.0, 5.0, 20.0, 8.0), VIEWPORT).unwrap();
        assert_eq!((out.width, out.height), (40, 16));
        assert_eq!(out.pixel(0, 0), [20, 10, 30, 255]);
        assert_eq!(out.pixel(39, 15), [59, 25, 84, 255]);
    }

    #[test]
    fn crops_fractional_scales_and_rects() {
        // 1.5x (Windows at 150%), with a rect on half pixels.
        let full = gradient(150, 75);
        let out = crop(&full, rect(10.5, 4.5, 20.0, 10.0), VIEWPORT).unwrap();
        assert_eq!((out.width, out.height), (30, 15));
        assert_eq!(
            out.pixel(0, 0),
            [16, 7, 23, 255],
            "rounded to the nearest pixel"
        );
    }

    #[test]
    fn crops_to_the_part_on_screen() {
        let full = gradient(100, 50);
        let out = crop(&full, rect(-10.0, 40.0, 30.0, 30.0), VIEWPORT).unwrap();
        assert_eq!((out.width, out.height), (20, 10));
        assert_eq!(out.pixel(0, 0), [0, 40, 40, 255]);
    }

    #[test]
    fn refuses_regions_entirely_off_screen() {
        let full = gradient(100, 50);
        assert!(crop(&full, rect(120.0, 0.0, 30.0, 30.0), VIEWPORT).is_err());
        assert!(crop(&full, rect(0.0, -40.0, 30.0, 30.0), VIEWPORT).is_err());
    }

    #[test]
    fn downscale_keeps_small_images() {
        let image = gradient(40, 20);
        assert_eq!(downscale(&image, 40), image);
        assert_eq!(downscale(&image, SLIDE_WIDTH), image);
    }

    #[test]
    fn downscale_keeps_the_aspect_ratio_and_averages() {
        let out = downscale(&solid(3200, 1800, [10, 20, 30, 255]), SKETCH_WIDTH);
        assert_eq!((out.width, out.height), (1600, 900));
        assert!(out.rgba.chunks(4).all(|p| p == [10, 20, 30, 255]));

        // Two columns, black and white, halve into grey.
        let mut stripes = solid(2, 1, [0, 0, 0, 255]);
        stripes.rgba[4..8].copy_from_slice(&[255, 255, 255, 255]);
        let grey = downscale(&stripes, 1);
        assert_eq!((grey.width, grey.height), (1, 1));
        assert_eq!(grey.rgba, [128, 128, 128, 255]);
    }

    #[test]
    fn downscale_handles_uneven_ratios() {
        let out = downscale(&gradient(250, 7), 100);
        assert_eq!((out.width, out.height), (100, 3));
        assert_eq!(out.rgba.len(), 100 * 3 * 4);
    }

    #[test]
    fn png_round_trips() {
        let image = gradient(17, 9);
        let bytes = encode_png(&image).unwrap();
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(decode_png(&bytes).unwrap(), image);
    }

    #[test]
    fn decodes_pngs_without_alpha_to_rgba() {
        let mut rgb = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut rgb, 2, 1);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&[1, 2, 3, 4, 5, 6]).unwrap();
        }
        let image = decode_png(&rgb).unwrap();
        assert_eq!(image.rgba, [1, 2, 3, 255, 4, 5, 6, 255]);
    }

    #[test]
    fn rejects_bytes_that_are_not_a_png() {
        assert!(decode_png(b"not a png").is_err());
    }

    #[test]
    fn unpremultiplies_pixels_in_place() {
        let mut rgba = [10, 20, 30, 255, 64, 32, 0, 128, 0, 0, 0, 0, 1, 1, 1, 1];
        unpremultiply(&mut rgba);
        assert_eq!(
            rgba,
            [10, 20, 30, 255, 128, 64, 0, 128, 0, 0, 0, 0, 255, 255, 255, 1]
        );
    }

    #[test]
    fn converts_cairo_pixels_and_skips_row_padding() {
        let px =
            |a: u32, r: u32, g: u32, b: u32| ((a << 24) | (r << 16) | (g << 8) | b).to_ne_bytes();
        // Two pixels per row, plus four bytes of stride padding.
        let mut data = Vec::new();
        data.extend(px(255, 10, 20, 30));
        data.extend(px(128, 64, 32, 0)); // premultiplied: half-transparent (128, 64, 0)
        data.extend([9, 9, 9, 9]);
        data.extend(px(0, 0, 0, 0));
        data.extend(px(255, 255, 255, 255));
        data.extend([9, 9, 9, 9]);
        let image = from_cairo_argb32(&data, 2, 2, 12);
        assert_eq!((image.width, image.height), (2, 2));
        assert_eq!(
            image.rgba,
            [10, 20, 30, 255, 128, 64, 0, 128, 0, 0, 0, 0, 255, 255, 255, 255]
        );
    }

    #[test]
    fn a_full_capture_becomes_a_slide_png() {
        // What `snapshot` does once the platform hands back a 2x capture.
        let full = gradient(200, 100);
        let region = crop(&full, rect(0.0, 0.0, 50.0, 25.0), VIEWPORT).unwrap();
        let png = encode_png(&downscale(&region, 60)).unwrap();
        let out = decode_png(&png).unwrap();
        assert_eq!((out.width, out.height), (60, 30));
    }
}
