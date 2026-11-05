//! `slopslide --export-smoke <deck.html> <out dir> [text…]`: exports the deck to PDF and
//! PowerPoint with the real webview of the platform, imports the PowerPoint file back, and
//! checks each result. CI runs it on every platform (see .github/workflows/ci.yml), as the
//! exports drive platform code no unit test reaches: hidden windows, printing, captures.
//!
//! Exits 0 when every export worked, 1 otherwise, naming what failed on stderr. Each `text`
//! must come through in the PowerPoint file.

use std::io::{Cursor, Read};
use std::path::PathBuf;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Manager, RunEvent};

use crate::error::{Error, Result};
use crate::workspace::OpenWorkspace;
use crate::{deck, pdf, pptx, protocol};

pub const FLAG: &str = "--export-smoke";
/// The label the workspace is opened under; no window has it, the exports only need the
/// folder served.
const WORKSPACE_LABEL: &str = "export-smoke";

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
    let shown = deck::load(&file)?
        .slides
        .iter()
        .filter(|s| !s.hidden)
        .count();

    let pdf_file = out.join("deck.pdf");
    pdf::export(app, &file, &pdf_file)
        .await
        .map_err(|e| Error::msg(format!("PDF export: {e}")))?;
    check_pdf(&std::fs::read(&pdf_file)?).map_err(|e| Error::msg(format!("PDF export: {e}")))?;
    println!("PDF export ok: {}", pdf_file.display());

    let pptx_file = out.join("deck.pptx");
    pptx::export(app, &file, &pptx_file)
        .await
        .map_err(|e| Error::msg(format!("PowerPoint export: {e}")))?;
    check_pptx(&std::fs::read(&pptx_file)?, shown, &args.texts)
        .map_err(|e| Error::msg(format!("PowerPoint export: {e}")))?;
    println!("PowerPoint export ok: {}", pptx_file.display());

    let import_root = out.join("imported");
    std::fs::create_dir_all(&import_root)?;
    let imported = pptx::import(&pptx_file, &import_root)
        .map_err(|e| Error::msg(format!("PowerPoint import: {e}")))?;
    if imported.deck.slides.len() != shown {
        return Err(Error::msg(format!(
            "PowerPoint import: {} slides back from {shown}",
            imported.deck.slides.len()
        )));
    }
    println!("PowerPoint import ok: {}", imported.deck.path);
    Ok(())
}

/// Whether `bytes` look like a whole PDF.
pub fn check_pdf(bytes: &[u8]) -> Result<()> {
    if !bytes.starts_with(b"%PDF-") {
        return Err(Error::msg("the file is not a PDF"));
    }
    let tail = &bytes[bytes.len().saturating_sub(1024)..];
    if !tail.windows(5).any(|w| w == b"%%EOF") {
        return Err(Error::msg("the PDF is cut short"));
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

    use std::path::Path;

    use super::*;

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

    #[test]
    fn a_pdf_needs_its_header_and_end() {
        assert!(check_pdf(b"%PDF-1.7\n1 0 obj\n%%EOF\n").is_ok());
        assert!(check_pdf(b"<html></html>").is_err());
        assert!(check_pdf(b"%PDF-1.7\n1 0 obj\n").is_err());
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

    #[test]
    fn the_fixture_deck_has_shown_and_hidden_slides() {
        let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/export-smoke/deck.html");
        let loaded = deck::load(&file).unwrap();
        let shown: Vec<&str> = loaded
            .slides
            .iter()
            .filter(|s| !s.hidden)
            .map(|s| s.id.as_str())
            .collect();
        assert_eq!(shown, ["title", "shapes"]);
        assert_eq!(loaded.slides.len(), 3);
    }
}
