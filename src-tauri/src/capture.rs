//! Screenshots of part of the app's own window, used to show the agent a slide the user
//! sketched on. The native webview renders the slide iframe and the ink layer on top of it
//! together, which the page itself cannot do: the slide is a sandboxed cross-origin frame.

use serde::Deserialize;
use tauri::Webview;

use crate::error::{Error, Result};

/// Width in pixels of the saved image; about what the model looks at anyway.
pub const SNAPSHOT_WIDTH: f64 = 1600.0;

/// A region of the webview in CSS pixels, as `getBoundingClientRect()` reports it.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    fn check(self) -> Result<Self> {
        let values = [self.x, self.y, self.width, self.height];
        if values.iter().all(|v| v.is_finite()) && self.width >= 1.0 && self.height >= 1.0 {
            Ok(self)
        } else {
            Err(Error::msg("nothing to capture: the slide is not on screen"))
        }
    }
}

/// PNG of `rect` as currently shown in `webview`.
pub async fn snapshot(webview: &Webview, rect: Rect) -> Result<Vec<u8>> {
    let rect = rect.check()?;
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>>>();
    webview
        .with_webview(move |platform| {
            #[cfg(target_os = "macos")]
            // SAFETY: on macOS the platform handle is the window's WKWebView, and
            // `with_webview` runs this on the main thread.
            unsafe {
                macos::snapshot(platform.inner(), rect, tx)
            };
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (platform, rect);
                let _ = tx.send(Err(Error::msg(
                    "slide screenshots are not supported on this platform yet",
                )));
            }
        })
        .map_err(|e| Error::msg(format!("cannot reach the webview: {e}")))?;
    rx.await
        .map_err(|_| Error::msg("the screenshot was cancelled"))?
}

#[cfg(target_os = "macos")]
mod macos {
    use std::cell::Cell;
    use std::ffi::c_void;

    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::{NSDictionary, NSError, NSNumber};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
    use tokio::sync::oneshot::Sender;

    use super::{Rect, SNAPSHOT_WIDTH};
    use crate::error::{Error, Result};

    /// Starts a snapshot of `rect`; the PNG (or error) arrives on `tx`.
    ///
    /// # Safety
    /// `webview` must point to a live `WKWebView`, and this must run on the main thread.
    pub unsafe fn snapshot(webview: *mut c_void, rect: Rect, tx: Sender<Result<Vec<u8>>>) {
        let Some(mtm) = MainThreadMarker::new() else {
            let _ = tx.send(Err(Error::msg("screenshots must start on the main thread")));
            return;
        };
        let webview = &*webview.cast::<WKWebView>();
        let config = WKSnapshotConfiguration::new(mtm);
        config.setRect(CGRect::new(
            CGPoint::new(rect.x, rect.y),
            CGSize::new(rect.width, rect.height),
        ));
        config.setSnapshotWidth(Some(&NSNumber::new_f64(SNAPSHOT_WIDTH)));
        // The handler is called once, but block2 needs a `Fn`.
        let tx = Cell::new(Some(tx));
        let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            let result = match image.as_ref() {
                Some(image) => png(image),
                None => Err(Error::msg(match error.as_ref() {
                    Some(error) => format!("screenshot failed: {}", error.localizedDescription()),
                    None => "screenshot failed".into(),
                })),
            };
            if let Some(tx) = tx.take() {
                let _ = tx.send(result);
            }
        });
        webview.takeSnapshotWithConfiguration_completionHandler(Some(&config), &handler);
    }

    fn png(image: &NSImage) -> Result<Vec<u8>> {
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

    #[test]
    fn accepts_a_visible_region() {
        assert!(rect(10.0, 20.5, 640.0, 360.0).check().is_ok());
        assert!(
            rect(-5.0, 0.0, 1.0, 1.0).check().is_ok(),
            "partly off-screen is fine"
        );
    }

    #[test]
    fn rejects_empty_or_invalid_regions() {
        assert!(rect(0.0, 0.0, 0.0, 360.0).check().is_err());
        assert!(rect(0.0, 0.0, 640.0, 0.5).check().is_err());
        assert!(rect(f64::NAN, 0.0, 640.0, 360.0).check().is_err());
        assert!(rect(0.0, 0.0, f64::INFINITY, 360.0).check().is_err());
    }

    #[test]
    fn deserializes_a_dom_rect() {
        let parsed: Rect =
            serde_json::from_str(r#"{"x":1.5,"y":2,"width":300,"height":168.75}"#).unwrap();
        assert_eq!(
            (parsed.x, parsed.y, parsed.width, parsed.height),
            (1.5, 2.0, 300.0, 168.75)
        );
    }
}
