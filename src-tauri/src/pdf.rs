//! PDF export: one page per slide, each the slide's screenshot (see capture.rs) filling a
//! page of the slide's own size. The editor captures the slides one at a time; their pages
//! wait here, by destination file, until the last one arrives and the file is written.
//!
//! The PDF is written by hand. Each image goes in as the compressed pixel data of an RGB
//! PNG, which PDF reads directly as a Flate stream with PNG predictors, so no other
//! encoder is needed.

use std::collections::HashMap;
use std::io::Write as _;
use std::path::Path;
use std::sync::Mutex;

use crate::capture::Image;
use crate::error::{Error, Result};

/// PDF points per CSS pixel: 72 per inch over 96.
const POINTS_PER_PX: f64 = 0.75;

/// One slide's page.
#[derive(Debug, Clone, PartialEq)]
pub struct Page {
    /// Page size in points.
    pub width: f64,
    pub height: f64,
    /// The image's size in pixels.
    pub pixels_wide: u32,
    pub pixels_high: u32,
    /// zlib stream of PNG-filtered RGB rows (a PNG's IDAT data).
    pub data: Vec<u8>,
}

impl Page {
    /// A page `canvas_width` × `canvas_height` CSS pixels (the slides' size) showing `image`.
    pub fn new(image: &Image, canvas_width: f64, canvas_height: f64) -> Result<Page> {
        if !(canvas_width >= 1.0 && canvas_height >= 1.0) || image.width == 0 || image.height == 0 {
            return Err(Error::msg("nothing to export: the slide has no size"));
        }
        Ok(Page {
            width: canvas_width * POINTS_PER_PX,
            height: canvas_height * POINTS_PER_PX,
            pixels_wide: image.width,
            pixels_high: image.height,
            data: idat(&opaque_rgb(image), image.width, image.height)?,
        })
    }
}

/// Pages captured so far, by destination file.
#[derive(Default)]
pub struct PdfExports(Mutex<HashMap<String, Vec<Page>>>);

impl PdfExports {
    pub fn add(&self, dest: &str, page: Page) {
        self.lock().entry(dest.to_string()).or_default().push(page);
    }

    /// Drops the pages for `dest`, returning them.
    pub fn take(&self, dest: &str) -> Vec<Page> {
        self.lock().remove(dest).unwrap_or_default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Vec<Page>>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Writes `pages` to `dest` as a PDF titled `title`.
pub fn save(dest: &Path, title: &str, pages: &[Page]) -> Result<()> {
    if pages.is_empty() {
        return Err(Error::msg("nothing to export: no slides were captured"));
    }
    std::fs::write(dest, write(title, pages))?;
    Ok(())
}

/// `image` composited over white, as RGB bytes.
fn opaque_rgb(image: &Image) -> Vec<u8> {
    image
        .rgba
        .chunks_exact(4)
        .flat_map(|px| {
            let a = u32::from(px[3]);
            let over_white = |c: u8| ((u32::from(c) * a + 255 * (255 - a) + 127) / 255) as u8;
            [over_white(px[0]), over_white(px[1]), over_white(px[2])]
        })
        .collect()
}

/// The IDAT data of `rgb` encoded as a PNG.
fn idat(rgb: &[u8], width: u32, height: u32) -> Result<Vec<u8>> {
    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::High);
        let fail = |e: png::EncodingError| Error::msg(format!("cannot encode the slide: {e}"));
        let mut writer = encoder.write_header().map_err(fail)?;
        writer.write_image_data(rgb).map_err(fail)?;
        writer.finish().map_err(fail)?;
    }
    // Chunks after the 8-byte signature: length, type, data, CRC.
    let mut data = Vec::new();
    let mut at = 8;
    while at + 8 <= png.len() {
        let len = u32::from_be_bytes([png[at], png[at + 1], png[at + 2], png[at + 3]]) as usize;
        let start = at + 8;
        let end = start + len;
        if end > png.len() {
            break;
        }
        if &png[at + 4..start] == b"IDAT" {
            data.extend_from_slice(&png[start..end]);
        }
        at = end + 4;
    }
    Ok(data)
}

/// The PDF file for `pages`.
pub fn write(title: &str, pages: &[Page]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut offsets = Vec::new();
    // Objects: 1 catalog, 2 page tree, 3 info, then page, contents and image for each page.
    let page_id = |i: usize| 4 + 3 * i;
    let mut object = |out: &mut Vec<u8>, body: &[u8]| {
        offsets.push(out.len());
        let _ = writeln!(out, "{} 0 obj", offsets.len());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    };

    out.extend_from_slice(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
    object(&mut out, b"<< /Type /Catalog /Pages 2 0 R >>");
    let kids: Vec<String> = (0..pages.len())
        .map(|i| format!("{} 0 R", page_id(i)))
        .collect();
    object(
        &mut out,
        format!(
            "<< /Type /Pages /Kids [{}] /Count {} >>",
            kids.join(" "),
            pages.len()
        )
        .as_bytes(),
    );
    object(
        &mut out,
        format!(
            "<< /Title {} /Creator (SlopSlide) /Producer (SlopSlide) >>",
            text_string(title)
        )
        .as_bytes(),
    );
    for (i, page) in pages.iter().enumerate() {
        let (w, h) = (number(page.width), number(page.height));
        object(
            &mut out,
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {w} {h}] \
                 /Resources << /XObject << /Slide {} 0 R >> >> /Contents {} 0 R >>",
                page_id(i) + 2,
                page_id(i) + 1,
            )
            .as_bytes(),
        );
        let draw = format!("q {w} 0 0 {h} 0 0 cm /Slide Do Q");
        object(&mut out, &stream("", draw.as_bytes()));
        let image = format!(
            "/Type /XObject /Subtype /Image /Width {0} /Height {1} /ColorSpace /DeviceRGB \
             /BitsPerComponent 8 /Filter /FlateDecode \
             /DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns {0} >> ",
            page.pixels_wide, page.pixels_high
        );
        object(&mut out, &stream(&image, &page.data));
    }

    let xref = out.len();
    let _ = writeln!(out, "xref\n0 {}\n0000000000 65535 f ", offsets.len() + 1);
    for offset in &offsets {
        let _ = writeln!(out, "{offset:010} 00000 n ");
    }
    let _ = writeln!(
        out,
        "trailer\n<< /Size {} /Root 1 0 R /Info 3 0 R >>\nstartxref\n{xref}\n%%EOF",
        offsets.len() + 1
    );
    out
}

/// A stream object's body: `dict` entries, the length, then the data.
fn stream(dict: &str, data: &[u8]) -> Vec<u8> {
    let mut out = format!("<< {dict}/Length {} >>\nstream\n", data.len()).into_bytes();
    out.extend_from_slice(data);
    out.extend_from_slice(b"\nendstream");
    out
}

/// `n` with at most two decimals, as PDF numbers are written.
fn number(n: f64) -> String {
    let s = format!("{n:.2}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// `text` as a PDF text string: UTF-16BE with a byte order mark, in hex.
fn text_string(text: &str) -> String {
    let hex: String = text.encode_utf16().map(|u| format!("{u:04X}")).collect();
    format!("<FEFF{hex}>")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: u32, height: u32, px: [u8; 4]) -> Image {
        Image {
            width,
            height,
            rgba: px.repeat((width * height) as usize),
        }
    }

    /// Inflates the page data back into PNG-filtered rows, via the png crate's own decoder.
    fn decode(page: &Page) -> Vec<u8> {
        let mut png = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png, page.pixels_wide, page.pixels_high);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            let writer = encoder.write_header().unwrap();
            drop(writer);
        }
        // Swap in our IDAT data: signature + IHDR (8 + 25 bytes), then IDAT and IEND.
        let mut rebuilt = png[..33].to_vec();
        rebuilt.extend((page.data.len() as u32).to_be_bytes());
        let mut chunk = b"IDAT".to_vec();
        chunk.extend(&page.data);
        rebuilt.extend(&chunk);
        rebuilt.extend(crc32(&chunk).to_be_bytes());
        rebuilt.extend([0, 0, 0, 0]);
        rebuilt.extend(b"IEND");
        rebuilt.extend(crc32(b"IEND").to_be_bytes());
        let mut reader = png::Decoder::new(std::io::Cursor::new(rebuilt))
            .read_info()
            .unwrap();
        let mut buf = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buf).unwrap();
        buf.truncate(info.buffer_size());
        buf
    }

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = !0u32;
        for &b in bytes {
            crc ^= u32::from(b);
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xEDB8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    #[test]
    fn a_page_is_the_canvas_size_in_points() {
        let page = Page::new(&solid(64, 36, [1, 2, 3, 255]), 1920.0, 1080.0).unwrap();
        assert_eq!((page.width, page.height), (1440.0, 810.0));
        assert_eq!((page.pixels_wide, page.pixels_high), (64, 36));
    }

    #[test]
    fn page_data_holds_the_slide_pixels() {
        let page = Page::new(&solid(5, 3, [10, 20, 30, 255]), 50.0, 30.0).unwrap();
        assert_eq!(decode(&page), [10, 20, 30].repeat(15));
    }

    #[test]
    fn transparency_is_flattened_onto_white() {
        let page = Page::new(&solid(2, 2, [0, 0, 0, 0]), 2.0, 2.0).unwrap();
        assert_eq!(decode(&page), [255; 12]);
        let half = Page::new(&solid(1, 1, [0, 100, 255, 128]), 1.0, 1.0).unwrap();
        assert_eq!(decode(&half), [127, 177, 255]);
    }

    #[test]
    fn rejects_empty_slides() {
        assert!(Page::new(&solid(0, 0, [0; 4]), 1920.0, 1080.0).is_err());
        assert!(Page::new(&solid(2, 2, [0; 4]), 0.0, 1080.0).is_err());
        assert!(Page::new(&solid(2, 2, [0; 4]), f64::NAN, 1080.0).is_err());
    }

    #[test]
    fn writes_a_well_formed_pdf() {
        let pages = vec![
            Page::new(&solid(4, 3, [255, 0, 0, 255]), 1920.0, 1080.0).unwrap(),
            Page::new(&solid(3, 4, [0, 0, 255, 255]), 1080.0, 1350.5).unwrap(),
        ];
        let pdf = write("Q3 Plan — ünïcode", &pages);
        let text = String::from_utf8_lossy(&pdf);
        assert!(pdf.starts_with(b"%PDF-1.4\n"));
        assert!(text.ends_with("%%EOF\n"));
        assert!(text.contains("/Type /Pages /Kids [4 0 R 7 0 R] /Count 2"));
        assert!(text.contains("/MediaBox [0 0 1440 810]"));
        assert!(text.contains("/MediaBox [0 0 810 1012.88]"));
        assert!(text.contains("q 1440 0 0 810 0 0 cm /Slide Do Q"));
        assert!(text.contains("/Width 4 /Height 3"));
        assert!(text.contains("/Columns 3 >>"));
        assert!(text.contains("/Title <FEFF0051003300200050006C0061006E00202014"));

        // Every xref entry points at its object, and startxref at the table.
        let end = pdf.windows(7).rposition(|w| w == b"endobj\n").unwrap() + 7;
        let tail = String::from_utf8(pdf[end..].to_vec()).unwrap();
        let xref_at: usize = tail
            .rsplit("startxref\n")
            .next()
            .unwrap()
            .lines()
            .next()
            .unwrap()
            .parse()
            .unwrap();
        let table = String::from_utf8(pdf[xref_at..].to_vec()).unwrap();
        assert!(table.starts_with("xref\n0 10\n"));
        let entries: Vec<usize> = table
            .lines()
            .skip(3)
            .take(9)
            .map(|l| l[..10].parse().unwrap())
            .collect();
        for (i, offset) in entries.iter().enumerate() {
            assert!(
                pdf[*offset..].starts_with(format!("{} 0 obj\n", i + 1).as_bytes()),
                "object {}",
                i + 1
            );
        }
        // Stream lengths match their data.
        let length = pages[0].data.len();
        assert!(text.contains(&format!("/Length {length} >>")));
    }

    #[test]
    fn text_strings_are_utf16_hex() {
        assert_eq!(text_string(""), "<FEFF>");
        assert_eq!(text_string("A("), "<FEFF00410028>");
        assert_eq!(text_string("😀"), "<FEFFD83DDE00>");
    }

    #[test]
    fn numbers_drop_trailing_zeros() {
        assert_eq!(number(1440.0), "1440");
        assert_eq!(number(1012.875), "1012.88");
        assert_eq!(number(0.5), "0.5");
    }

    #[test]
    fn exports_collect_pages_per_destination() {
        let exports = PdfExports::default();
        let page = Page::new(&solid(1, 1, [0; 4]), 1.0, 1.0).unwrap();
        exports.add("/a.pdf", page.clone());
        exports.add("/b.pdf", page.clone());
        exports.add("/a.pdf", page.clone());
        assert_eq!(exports.take("/a.pdf").len(), 2);
        assert!(exports.take("/a.pdf").is_empty());
        assert_eq!(exports.take("/b.pdf").len(), 1);
    }

    #[test]
    fn saves_the_file_and_refuses_an_empty_one() {
        let dir = std::env::temp_dir().join(format!("slopslide-pdf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("Talk.pdf");
        assert!(save(&dest, "Talk", &[]).is_err());
        assert!(!dest.exists());
        let page = Page::new(&solid(2, 2, [9, 9, 9, 255]), 2.0, 2.0).unwrap();
        save(&dest, "Talk", &[page]).unwrap();
        assert!(std::fs::read(&dest).unwrap().starts_with(b"%PDF-"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
