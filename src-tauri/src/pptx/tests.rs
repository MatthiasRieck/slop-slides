//! Import, export, and the one through the other, on small presentations built here part by
//! part the way PowerPoint lays them out.

use std::collections::HashMap;
use std::io::{Cursor, Read, Write};

use zip::write::SimpleFileOptions;

use super::export::{
    matte, package, Background, Border, BoxItem, Bullet, Crop, Fill, Gradient, ImageItem, Item,
    Meta, Paragraph, Run, Scene, SceneSlide, Shadow, ShotInfo, ShotItem, Stop, TextItem,
};
use super::import::{self, convert};
use super::xml;
use crate::capture::Image;
use crate::{deck, html, lint};

const NS: &str = r#"xmlns:a="urn:a" xmlns:r="urn:r" xmlns:p="urn:p""#;
const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

fn zip_of(parts: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in parts {
        archive
            .start_file(*name, SimpleFileOptions::default())
            .unwrap();
        archive.write_all(bytes).unwrap();
    }
    archive.finish().unwrap().into_inner()
}

fn rels(entries: &[(&str, &str, &str)]) -> Vec<u8> {
    let body: String = entries
        .iter()
        .map(|(id, kind, target)| {
            let external = if target.contains("://") || target.starts_with("javascript:") {
                r#" TargetMode="External""#
            } else {
                ""
            };
            format!(r#"<Relationship Id="{id}" Type="{REL}/{kind}" Target="{target}"{external}/>"#)
        })
        .collect();
    format!("<Relationships>{body}</Relationships>").into_bytes()
}

fn slide_xml(attrs: &str, shapes: &str) -> Vec<u8> {
    format!(r#"<p:sld {NS} {attrs}><p:cSld><p:spTree>{shapes}</p:spTree></p:cSld></p:sld>"#)
        .into_bytes()
}

const THEME: &str = r#"<a:theme xmlns:a="urn:a"><a:themeElements><a:clrScheme name="t">
<a:dk1><a:sysClr val="windowText" lastClr="111111"/></a:dk1><a:lt1><a:srgbClr val="FAFAFA"/></a:lt1>
<a:dk2><a:srgbClr val="222222"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2>
<a:accent1><a:srgbClr val="FF0000"/></a:accent1></a:clrScheme>
<a:fontScheme name="t"><a:majorFont><a:latin typeface="Georgia"/></a:majorFont>
<a:minorFont><a:latin typeface="Verdana"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>"#;

fn master() -> Vec<u8> {
    format!(
        r#"<p:sldMaster {NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg2"/></a:solidFill></p:bgPr></p:bg><p:spTree>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Logo bar"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="100000"/></a:xfrm><a:prstGeom prst="rect"/><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="300" cy="400"/></a:xfrm></p:spPr><p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:r><a:t>Click to edit</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1"/>
<p:txStyles><p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4400" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>
<p:bodyStyle><a:lvl1pPr marL="228600" indent="-228600"><a:buChar char="&#8226;"/><a:defRPr sz="2800"/></a:lvl1pPr><a:lvl2pPr marL="685800" indent="-228600"><a:buChar char="&#8211;"/><a:defRPr sz="2400"/></a:lvl2pPr></p:bodyStyle>
<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>"#
    )
    .into_bytes()
}

fn layout() -> Vec<u8> {
    format!(
        r#"<p:sldLayout {NS}><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="609600" y="304800"/><a:ext cx="10972800" cy="1143000"/></a:xfrm></p:spPr></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="609600" y="1600200"/><a:ext cx="10972800" cy="4525963"/></a:xfrm></p:spPr></p:sp>
</p:spTree></p:cSld></p:sldLayout>"#
    )
    .into_bytes()
}

const SHAPES: &str = r#"
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Q3 &amp; beyond</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>
<a:p><a:r><a:rPr b="1"/><a:t>First &lt;point&gt;</a:t></a:r></a:p>
<a:p><a:pPr lvl="1"/><a:r><a:t>Detail</a:t></a:r></a:p>
<a:p><a:pPr marL="0" indent="0"><a:buNone/></a:pPr><a:r><a:t>Plain</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="4" name="Empty"/><p:cNvSpPr/><p:nvPr><p:ph type="subTitle" idx="2"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="5" name="Box"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm rot="5400000"><a:off x="635000" y="635000"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 50000"/></a:avLst></a:prstGeom><a:solidFill><a:srgbClr val="00FF00"><a:alpha val="50000"/></a:srgbClr></a:solidFill><a:ln w="12700"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:prstDash val="dash"/></a:ln></p:spPr>
<p:txBody><a:bodyPr anchor="b"/><a:lstStyle/><a:p><a:pPr algn="r"/><a:r><a:rPr sz="2000"><a:hlinkClick r:id="rIdWeb"/></a:rPr><a:t>web</a:t></a:r><a:r><a:rPr><a:hlinkClick r:id="rIdBad"/></a:rPr><a:t>bad</a:t></a:r><a:r><a:rPr><a:hlinkClick r:id="rIdNext" action="ppaction://hlinksldjump"/></a:rPr><a:t>next</a:t></a:r><a:fld type="slidenum"><a:t>99</a:t></a:fld></a:p></p:txBody></p:sp>
<p:pic><p:nvPicPr><p:cNvPr id="6" name="Photo" descr="A &quot;nice&quot; photo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdPng"/><a:srcRect l="25000" r="25000"/><a:stretch/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="635000" cy="635000"/></a:xfrm></p:spPr></p:pic>
<p:pic><p:nvPicPr><p:cNvPr id="7" name="Same"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdPng"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="6350" cy="6350"/></a:xfrm></p:spPr></p:pic>
<p:pic><p:nvPicPr><p:cNvPr id="8" name="Old"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdEmf"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="6350" cy="6350"/></a:xfrm></p:spPr></p:pic>
<p:grpSp><p:nvGrpSpPr/><p:grpSpPr><a:xfrm><a:off x="6350000" y="0"/><a:ext cx="1270000" cy="1270000"/><a:chOff x="0" y="0"/><a:chExt cx="635000" cy="635000"/></a:xfrm></p:grpSpPr>
<p:sp><p:nvSpPr><p:cNvPr id="9" name="Star"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="63500" y="63500"/><a:ext cx="63500" cy="63500"/></a:xfrm><a:prstGeom prst="rightArrow"/><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="000000"/></a:gs><a:gs pos="100000"><a:srgbClr val="FFFFFF"/></a:gs></a:gsLst><a:lin ang="5400000"/></a:gradFill></p:spPr></p:sp>
</p:grpSp>
<p:graphicFrame><p:nvGraphicFramePr/><p:xfrm><a:off x="0" y="6350000"/><a:ext cx="1270000" cy="635000"/></p:xfrm><a:graphic><a:graphicData><a:tbl><a:tblGrid><a:gridCol w="635000"/><a:gridCol w="635000"/></a:tblGrid><a:tr h="317500"><a:tc gridSpan="2"><a:txBody><a:bodyPr/><a:p><a:r><a:t>Header</a:t></a:r></a:p></a:txBody><a:tcPr><a:solidFill><a:srgbClr val="ABCDEF"/></a:solidFill></a:tcPr></a:tc><a:tc hMerge="1"><a:txBody><a:bodyPr/><a:p/></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>
<p:graphicFrame><p:nvGraphicFramePr/><p:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></p:xfrm><a:graphic><a:graphicData><c:chart xmlns:c="urn:c" r:id="rIdChart"/></a:graphicData></a:graphic></p:graphicFrame>
"#;

const CHART: &str = r#"<c:chartSpace xmlns:c="urn:c"><c:chart><c:barChart><c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Sales</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>East</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>42</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:chart></c:chartSpace>"#;

fn notes() -> Vec<u8> {
    format!(
        r#"<p:notes {NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="I"/><p:cNvSpPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="N"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>Say R&amp;D &lt;slowly&gt;</a:t></a:r></a:p><a:p/><a:p><a:r><a:t>Then pause</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>"#
    )
    .into_bytes()
}

/// A presentation of two slides, the second hidden and starting a section.
fn sample() -> Vec<u8> {
    let presentation = format!(
        r#"<p:presentation {NS}><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/>
<p:defaultTextStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:defaultTextStyle>
<p:extLst><p:ext uri="x"><p14:sectionLst xmlns:p14="urn:p14"><p14:section name="Wrap &quot;up&quot;" id="x"><p14:sldIdLst><p14:sldId id="257"/></p14:sldIdLst></p14:section></p14:sectionLst></p:ext></p:extLst></p:presentation>"#
    );
    let slide_rels = rels(&[
        ("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"),
        ("rIdN", "notesSlide", "../notesSlides/notesSlide1.xml"),
        ("rIdPng", "image", "../media/image1.PNG"),
        ("rIdEmf", "image", "../media/image2.emf"),
        ("rIdWeb", "hyperlink", "https://example.com/?a=1&amp;b=2"),
        ("rIdBad", "hyperlink", "javascript:alert(1)"),
        ("rIdNext", "slide", "slide2.xml"),
        ("rIdChart", "chart", "../charts/chart1.xml"),
    ]);
    let second = format!(
        r#"<p:sld {NS} show="0" showMasterSp="0"><p:cSld><p:bg><p:bgPr><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="000000"/></a:gs><a:gs pos="100000"><a:srgbClr val="FFFFFF"/></a:gs></a:gsLst><a:lin ang="0"/></a:gradFill></p:bgPr></p:bg><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>Q3 &amp; beyond</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#
    );
    zip_of(&[
        (
            "_rels/.rels",
            rels(&[
                ("rId1", "officeDocument", "ppt/presentation.xml"),
                ("rId2", "metadata/core-properties", "docProps/core.xml"),
            ]),
        ),
        (
            "docProps/core.xml",
            br#"<cp:coreProperties xmlns:cp="urn:c" xmlns:dc="urn:d"><dc:title>Board update</dc:title></cp:coreProperties>"#.to_vec(),
        ),
        ("ppt/presentation.xml", presentation.into_bytes()),
        (
            "ppt/_rels/presentation.xml.rels",
            rels(&[
                ("rId1", "slideMaster", "slideMasters/slideMaster1.xml"),
                ("rId2", "slide", "slides/slide1.xml"),
                ("rId3", "slide", "slides/slide2.xml"),
            ]),
        ),
        ("ppt/slides/slide1.xml", slide_xml("", SHAPES)),
        ("ppt/slides/_rels/slide1.xml.rels", slide_rels),
        ("ppt/slides/slide2.xml", second.into_bytes()),
        (
            "ppt/slides/_rels/slide2.xml.rels",
            rels(&[("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml")]),
        ),
        ("ppt/slideLayouts/slideLayout1.xml", layout()),
        (
            "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
            rels(&[("rId1", "slideMaster", "../slideMasters/slideMaster1.xml")]),
        ),
        ("ppt/slideMasters/slideMaster1.xml", master()),
        (
            "ppt/slideMasters/_rels/slideMaster1.xml.rels",
            rels(&[("rId1", "theme", "../theme/theme1.xml")]),
        ),
        ("ppt/theme/theme1.xml", THEME.as_bytes().to_vec()),
        ("ppt/notesSlides/notesSlide1.xml", notes()),
        ("ppt/charts/chart1.xml", CHART.as_bytes().to_vec()),
        ("ppt/media/image1.PNG", b"png bytes".to_vec()),
        ("ppt/media/image2.emf", b"emf bytes".to_vec()),
    ])
}

/// The deck's markup with the runtime, as the app keeps it.
fn lint_issues(converted: &import::Converted) -> Vec<lint::Issue> {
    let source = html::ensure_runtime(&converted.html);
    let names: Vec<String> = converted
        .assets
        .iter()
        .map(|(name, _)| format!("assets/{name}"))
        .collect();
    lint::lint(&source, |path| names.iter().any(|n| n == path), &[])
}

#[test]
fn imported_decks_pass_the_linter() {
    let converted = convert(sample(), "fallback").unwrap();
    assert_eq!(lint_issues(&converted), []);
}

#[test]
fn takes_the_title_and_slide_ids_from_the_presentation() {
    let converted = convert(sample(), "fallback").unwrap();
    assert_eq!(converted.title, "Board update");
    assert!(converted.html.contains("<title>Board update</title>"));
    let ids: Vec<_> = html::find_slides(&converted.html)
        .into_iter()
        .map(|s| s.id.unwrap())
        .collect();
    assert_eq!(ids, ["q3-beyond", "q3-beyond-2"]);
    assert!(
        !converted.html.contains("slopslide-size"),
        "1920×1080 is the default"
    );
}

#[test]
fn placeholders_inherit_from_layout_master_and_theme() {
    let html = convert(sample(), "x").unwrap().html;
    // The position comes from the layout, the anchor from the master.
    assert!(html.contains("left: 96px; top: 48px; width: 1728px; height: 180px"));
    assert!(html.contains("justify-content: center"));
    // Size, weight, colour, and the theme's major font from the master's title style.
    assert!(html.contains(
        r#"font-size: 88px; font-weight: 700; color: #111111; font-family: &quot;Georgia&quot;, sans-serif"#
    ));
    assert!(html.contains("text-align: center"));
}

#[test]
fn bullets_become_lists_by_level_and_stop_where_a_paragraph_opts_out() {
    let html = convert(sample(), "x").unwrap().html;
    assert!(html.contains(r#"<ul style="list-style-type: &quot;• &quot;"#));
    assert!(html.contains(r#"<ul style="list-style-type: &quot;– &quot;"#));
    assert!(html.contains("margin-left: 108px"), "level 2 indent");
    assert!(html.contains("Plain</span></p>"));
    assert!(html.contains("First &lt;point&gt;"), "text is escaped");
}

#[test]
fn master_art_shows_but_its_prompts_and_empty_placeholders_do_not() {
    let html = convert(sample(), "x").unwrap().html;
    assert!(
        html.contains("background-color: #ff0000"),
        "the master's bar"
    );
    assert!(!html.contains("Click to edit"));
    let first = &html[..html.find("q3-beyond-2").unwrap()];
    assert_eq!(first.matches("#ff0000").count(), 1);
    let second = &html[html.find("q3-beyond-2").unwrap()..];
    assert!(!second.contains("#ff0000"), "showMasterSp=0 leaves it out");
}

#[test]
fn shapes_keep_their_fill_line_geometry_and_rotation() {
    let html = convert(sample(), "x").unwrap().html;
    assert!(html.contains("transform: rotate(90deg)"));
    assert!(html.contains("background-color: rgba(0, 255, 0, 0.5)"));
    assert!(html.contains("border: 2px dashed #111111"));
    assert!(html.contains("border-radius: 50px"), "half the short side");
    assert!(html.contains("justify-content: flex-end"));
    assert!(html.contains("text-align: right"));
}

#[test]
fn links_stay_safe_and_slide_jumps_find_their_slide() {
    let html = convert(sample(), "x").unwrap().html;
    assert!(html.contains(r#"href="https://example.com/?a=1&amp;b=2" target="_blank""#));
    assert!(html.contains(r##"href="#q3-beyond-2""##));
    assert!(!html.contains("javascript:"));
    assert!(
        html.contains(">bad</span>"),
        "the words stay without the link"
    );
}

#[test]
fn slide_number_fields_show_the_real_number() {
    let html = convert(sample(), "x").unwrap().html;
    assert!(html.contains(">1</span>"));
    assert!(!html.contains(">99<"));
}

#[test]
fn images_come_along_cropped_once_each_and_unsupported_ones_are_reported() {
    let converted = convert(sample(), "x").unwrap();
    let names: Vec<_> = converted.assets.iter().map(|a| a.0.as_str()).collect();
    assert_eq!(names, ["image1.png"], "lowercased and only once");
    assert_eq!(converted.assets[0].1, b"png bytes");
    assert!(converted.html.contains(r#"alt="A &quot;nice&quot; photo""#));
    assert!(converted.html.contains("ppt-crop"));
    assert!(converted
        .html
        .contains("width: 200%; height: 100%; left: -50%; top: 0%"));
    assert!(converted.skipped.iter().any(|s| s.contains("EMF")));
}

#[test]
fn groups_scale_their_children_and_presets_are_drawn() {
    let html = convert(sample(), "x").unwrap().html;
    assert!(html.contains("left: 1020px; top: 20px; width: 20px; height: 20px"));
    assert!(html.contains("<linearGradient"));
    assert!(html.contains("<path d=\"M0 "));
}

#[test]
fn tables_are_tables_and_charts_keep_their_numbers() {
    let converted = convert(sample(), "x").unwrap();
    assert!(converted.html.contains(r#"colspan="2""#));
    assert!(converted.html.contains("background-color: #abcdef"));
    assert_eq!(
        converted.html.matches("<td colspan").count(),
        1,
        "merged cells are skipped"
    );
    for text in ["Sales", "East", "42"] {
        assert!(
            converted.html.contains(&format!("<td>{text}</td>")),
            "{text}"
        );
    }
    assert!(converted.skipped.iter().any(|s| s.contains("charts")));
}

#[test]
fn theme_references_outrank_presentation_defaults_but_not_the_shape() {
    let shape = |run: &str| {
        format!(
            r#"<p:sp><p:nvSpPr><p:cNvPr id="2" name="x"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></a:xfrm></p:spPr><p:style><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style><p:txBody><a:bodyPr/><a:p><a:r>{run}<a:t>x</a:t></a:r></a:p></p:txBody></p:sp>"#
        )
    };
    let shapes = shape("")
        + &shape(r#"<a:rPr><a:solidFill><a:srgbClr val="123456"/></a:solidFill></a:rPr>"#);
    let presentation = format!(
        r#"<p:presentation {NS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:defaultTextStyle><a:lvl1pPr><a:defRPr><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:defaultTextStyle></p:presentation>"#
    );
    let html = convert(
        zip_of(&[
            ("ppt/presentation.xml", presentation.into_bytes()),
            (
                "ppt/_rels/presentation.xml.rels",
                rels(&[("rId1", "slide", "slides/slide1.xml")]),
            ),
            ("ppt/slides/slide1.xml", slide_xml("", &shapes)),
            (
                "ppt/slides/_rels/slide1.xml.rels",
                rels(&[("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml")]),
            ),
            ("ppt/slideLayouts/slideLayout1.xml", layout()),
            (
                "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
                rels(&[("rId1", "slideMaster", "../slideMasters/slideMaster1.xml")]),
            ),
            ("ppt/slideMasters/slideMaster1.xml", master()),
            (
                "ppt/slideMasters/_rels/slideMaster1.xml.rels",
                rels(&[("rId1", "theme", "../theme/theme1.xml")]),
            ),
            ("ppt/theme/theme1.xml", THEME.as_bytes().to_vec()),
        ]),
        "x",
    )
    .unwrap()
    .html;
    assert!(html.contains("color: #fafafa"), "the shape's reference");
    assert!(html.contains("color: #123456"), "the run's own colour");
    assert!(!html.contains("color: #111111"), "the deck-wide default");
}

#[test]
fn styled_tables_come_along_plain_with_their_grid_and_header() {
    let table = r#"<p:graphicFrame><p:nvGraphicFramePr/><p:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></p:xfrm><a:graphic><a:graphicData><a:tbl><a:tblPr firstRow="1"><a:tableStyleId>{X}</a:tableStyleId></a:tblPr><a:tblGrid><a:gridCol w="635000"/></a:tblGrid><a:tr h="1"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Head</a:t></a:r></a:p></a:txBody></a:tc></a:tr><a:tr h="1"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Cell</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>"#;
    let parts = zip_of(&[
        (
            "ppt/presentation.xml",
            format!(r#"<p:presentation {NS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>"#).into_bytes(),
        ),
        ("ppt/_rels/presentation.xml.rels", rels(&[("rId1", "slide", "slides/slide1.xml")])),
        ("ppt/slides/slide1.xml", slide_xml("", table)),
    ]);
    let converted = convert(parts, "x").unwrap();
    assert_eq!(converted.html.matches("border: 1px solid").count(), 2);
    assert!(converted.html.contains(r#"font-weight: 700">Head"#));
    assert!(!converted.html.contains(r#"font-weight: 700">Cell"#));
    assert!(converted.skipped.iter().any(|s| s.contains("table styles")));
}

#[test]
fn notes_sections_and_hidden_slides_come_along() {
    let html = convert(sample(), "x").unwrap().html;
    let slides = html::find_slides(&html);
    assert_eq!(
        html::notes(&html[slides[0].range.clone()]),
        "Say R&D <slowly>\n\nThen pause"
    );
    let sections = html::find_sections(&html);
    assert_eq!(sections.len(), 1);
    assert!(html.contains(r#"data-title="Wrap &quot;up&quot;""#));
    assert!(html.contains(r#"id="q3-beyond-2" data-hidden"#));
    assert!(html.contains("background-image: linear-gradient(90deg, #000000 0%, #ffffff 100%)"));
}

#[test]
fn other_slide_shapes_get_their_size_meta() {
    let source = sample();
    let mut archive = zip::ZipArchive::new(Cursor::new(source)).unwrap();
    let mut parts = Vec::new();
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).unwrap();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        let text = String::from_utf8_lossy(&bytes).replace(
            r#"cx="12192000" cy="6858000""#,
            r#"cx="9144000" cy="6858000""#,
        );
        let bytes = if file.name().unwrap().ends_with("presentation.xml") {
            text.into_bytes()
        } else {
            bytes
        };
        parts.push((file.name().unwrap().to_string(), bytes));
    }
    let refs: Vec<(&str, Vec<u8>)> = parts.iter().map(|(n, b)| (n.as_str(), b.clone())).collect();
    let converted = convert(zip_of(&refs), "x").unwrap();
    assert!(converted
        .html
        .contains(r#"<meta name="slopslide-size" content="1920x1440">"#));
    assert_eq!(lint_issues(&converted), []);
}

#[test]
fn refuses_what_is_not_a_presentation() {
    let not_zip = convert(b"\xD0\xCF\x11\xE0 an old .ppt".to_vec(), "x")
        .err()
        .unwrap();
    assert!(not_zip
        .to_string()
        .contains(".ppt files must be saved as .pptx"));
    let other_zip = convert(zip_of(&[("word/document.xml", b"<w/>".to_vec())]), "x")
        .err()
        .unwrap();
    assert!(other_zip.to_string().contains("no PowerPoint presentation"));
    let empty = convert(
        zip_of(&[(
            "ppt/presentation.xml",
            format!("<p:presentation {NS}/>").into_bytes(),
        )]),
        "x",
    )
    .err()
    .unwrap();
    assert!(empty.to_string().contains("no slides"));
}

#[test]
fn a_hostile_file_cannot_reach_outside_assets_or_break_out_of_styles() {
    let shapes = r#"<p:sp><p:nvSpPr><p:cNvPr id="2" name="x"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr><a:latin typeface="x&quot;;}&lt;/style&gt;&lt;script&gt;"/></a:rPr><a:t>&lt;script&gt;alert(1)&lt;/script&gt;</a:t></a:r></a:p></p:txBody></p:sp>
    <p:pic><p:nvPicPr><p:cNvPr id="3" name="y" descr="&quot; onerror=&quot;x"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></a:xfrm></p:spPr></p:pic>"#;
    let parts = zip_of(&[
        (
            "ppt/presentation.xml",
            format!(r#"<p:presentation {NS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>"#).into_bytes(),
        ),
        ("ppt/_rels/presentation.xml.rels", rels(&[("rId1", "slide", "slides/slide1.xml")])),
        ("ppt/slides/slide1.xml", slide_xml("", shapes)),
        ("ppt/slides/_rels/slide1.xml.rels", rels(&[("rId2", "image", "../../../../etc/pass wd.png")])),
        ("etc/pass wd.png", b"x".to_vec()),
    ]);
    let converted = convert(parts, "x").unwrap();
    assert!(!converted.html.contains("<script"));
    assert!(converted.html.contains("&lt;script&gt;alert(1)"));
    assert!(!converted.html.contains("onerror=\""));
    for (name, _) in &converted.assets {
        assert!(!name.contains('/') && !name.contains(".."), "{name}");
    }
}

#[test]
fn import_writes_the_deck_and_its_assets_and_leaves_the_file_alone() {
    let dir = std::env::temp_dir().join(format!("slopslide-pptx-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let source = dir.join("My talk.pptx");
    let bytes = sample();
    std::fs::write(&source, &bytes).unwrap();
    let imported = super::import(&source, &dir).unwrap();
    assert_eq!(imported.deck.title, "Board update");
    assert_eq!(imported.deck.slides.len(), 2);
    assert!(imported.deck.slides[1].hidden);
    assert_eq!(
        imported.deck.slides[0].notes,
        "Say R&D <slowly>\n\nThen pause"
    );
    let file = std::path::PathBuf::from(&imported.deck.path);
    assert_eq!(file.file_name().unwrap(), deck::DECK_FILE);
    assert_eq!(file.parent().unwrap().file_name().unwrap(), "board-update");
    assert!(file.parent().unwrap().join("assets/image1.png").is_file());
    assert_eq!(std::fs::read(&source).unwrap(), bytes);
    assert_eq!(deck::lint(&file, None).unwrap(), []);
    // A second import does not touch the first.
    let again = super::import(&source, &dir).unwrap();
    assert_ne!(again.deck.path, imported.deck.path);
    std::fs::remove_dir_all(&dir).unwrap();
}

// --- Export ------------------------------------------------------------------------------------

fn run(text: &str) -> Run {
    Run {
        text: text.to_string(),
        font: "Inter".to_string(),
        size: 60.0,
        color: Some([10.0, 20.0, 30.0, 0.5]),
        ..Run::default()
    }
}

fn scene() -> Scene {
    Scene {
        shots: vec![ShotInfo { opaque: false }, ShotInfo { opaque: true }],
        slides: vec![
            SceneSlide {
                id: "one".into(),
                background: Background {
                    color: Some([1.0, 2.0, 3.0, 1.0]),
                    ..Background::default()
                },
                items: vec![
                    Item::Box(BoxItem {
                        x: 96.0,
                        y: 48.0,
                        w: 192.0,
                        h: 108.0,
                        fill: Some(Fill {
                            color: Some([255.0, 0.0, 0.0, 0.25]),
                            gradient: None,
                        }),
                        border: Some(Border {
                            color: [0.0, 0.0, 255.0, 1.0],
                            width: 3.0,
                            dash: Some("dashed".into()),
                        }),
                        shadow: Some(Shadow {
                            color: [0.0, 0.0, 0.0, 0.3],
                            x: 0.0,
                            y: 10.0,
                            blur: 40.0,
                        }),
                        radius: 27.0,
                        opacity: 0.5,
                        ..BoxItem::default()
                    }),
                    Item::Box(BoxItem {
                        w: 100.0,
                        h: 100.0,
                        fill: Some(Fill {
                            color: None,
                            gradient: Some(Gradient {
                                angle: 180.0,
                                stops: vec![
                                    Stop {
                                        at: 0.0,
                                        color: [0.0, 0.0, 0.0, 1.0],
                                    },
                                    Stop {
                                        at: 1.0,
                                        color: [255.0, 255.0, 255.0, 1.0],
                                    },
                                ],
                            }),
                        }),
                        ellipse: true,
                        opacity: 1.0,
                        ..BoxItem::default()
                    }),
                    Item::Text(TextItem {
                        x: 100.0,
                        y: 200.0,
                        w: 800.0,
                        h: 80.0,
                        rotation: 90.0,
                        wrap: true,
                        paragraphs: vec![
                            Paragraph {
                                align: "center".into(),
                                line_height: Some(72.0),
                                runs: vec![
                                    Run {
                                        bold: true,
                                        link: Some("https://example.com/?a=1&b=2".into()),
                                        ..run("R&D <title>")
                                    },
                                    Run {
                                        line_break: true,
                                        ..Run::default()
                                    },
                                    Run {
                                        link: Some("#two".into()),
                                        ..run("next")
                                    },
                                    Run {
                                        link: Some("javascript:alert(1)".into()),
                                        ..run("bad")
                                    },
                                ],
                                ..Paragraph::default()
                            },
                            Paragraph {
                                bullet: Some(Bullet {
                                    char: Some("•".into()),
                                    ..Bullet::default()
                                }),
                                margin_left: Some(40.0),
                                indent: Some(-40.0),
                                space_before: Some(12.0),
                                runs: vec![run("point")],
                                ..Paragraph::default()
                            },
                            Paragraph {
                                bullet: Some(Bullet {
                                    number: Some("lower-roman".into()),
                                    start: Some(3),
                                    ..Bullet::default()
                                }),
                                runs: vec![run("numbered")],
                                ..Paragraph::default()
                            },
                        ],
                    }),
                    Item::Image(ImageItem {
                        src: "assets/photo.jpg".into(),
                        alt: "A \"photo\"".into(),
                        w: 50.0,
                        h: 50.0,
                        flip_h: true,
                        crop: Some(Crop {
                            l: 0.1,
                            r: 0.2,
                            t: 0.0,
                            b: 0.0,
                        }),
                        opacity: 0.5,
                        ellipse: true,
                        ..ImageItem::default()
                    }),
                    Item::Image(ImageItem {
                        src: "assets/photo.jpg".into(),
                        w: 5.0,
                        h: 5.0,
                        opacity: 1.0,
                        ..ImageItem::default()
                    }),
                    Item::Image(ImageItem {
                        src: "assets/missing.png".into(),
                        w: 5.0,
                        h: 5.0,
                        opacity: 1.0,
                        ..ImageItem::default()
                    }),
                    Item::Shot(ShotItem {
                        shot: 0,
                        w: 10.0,
                        h: 10.0,
                        ..ShotItem::default()
                    }),
                ],
            },
            SceneSlide {
                id: "two".into(),
                background: Background {
                    shot: Some(1),
                    ..Background::default()
                },
                items: vec![],
            },
        ],
    }
}

fn meta() -> Meta {
    Meta {
        title: "Q3 & beyond".into(),
        canvas: (1920, 1080),
        notes: HashMap::from([("one".to_string(), "Line one\n\nLine <two>".to_string())]),
        sections: vec![("Wrap up".to_string(), "two".to_string())],
    }
}

fn exported() -> Vec<u8> {
    let shots = HashMap::from([(0, b"shot".to_vec()), (1, b"background".to_vec())]);
    package(&scene(), &meta(), &shots, |src| {
        (src == "assets/photo.jpg").then(|| b"jpeg".to_vec())
    })
    .unwrap()
}

fn read_parts(bytes: Vec<u8>) -> HashMap<String, Vec<u8>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    (0..archive.len())
        .map(|i| {
            let mut file = archive.by_index(i).unwrap();
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).unwrap();
            (file.name().unwrap().to_string(), bytes)
        })
        .collect()
}

fn text_of(parts: &HashMap<String, Vec<u8>>, name: &str) -> String {
    String::from_utf8(parts[name].clone()).unwrap()
}

#[test]
fn every_part_is_well_formed_declared_and_linked() {
    let parts = read_parts(exported());
    let types = xml::parse(&parts["[Content_Types].xml"]).unwrap();
    let declared: Vec<&str> = types
        .all("Override")
        .filter_map(|o| o.attr("PartName"))
        .collect();
    let defaults: Vec<&str> = types
        .all("Default")
        .filter_map(|o| o.attr("Extension"))
        .collect();
    for (name, bytes) in &parts {
        if name == "[Content_Types].xml" {
            continue;
        }
        let ext = name.rsplit('.').next().unwrap();
        assert!(
            defaults.contains(&ext) || declared.contains(&format!("/{name}").as_str()),
            "{name} has no content type"
        );
        if ext == "xml" || ext == "rels" {
            assert!(xml::parse(bytes).is_some(), "{name} is not well-formed");
        }
        if ext == "xml" && name.starts_with("ppt/") {
            assert!(
                declared.contains(&format!("/{name}").as_str()),
                "{name} needs an override"
            );
        }
    }
    for name in &declared {
        assert!(
            parts.contains_key(name.trim_start_matches('/')),
            "{name} is declared, not there"
        );
    }
    for (name, bytes) in &parts {
        if !name.ends_with(".rels") {
            continue;
        }
        let dir = name.split("_rels/").next().unwrap();
        for rel in xml::parse(bytes).unwrap().all("Relationship") {
            if rel.attr("TargetMode") == Some("External") {
                continue;
            }
            let mut path: Vec<&str> = dir.split('/').filter(|p| !p.is_empty()).collect();
            for piece in rel.attr("Target").unwrap().split('/') {
                if piece == ".." {
                    path.pop();
                } else {
                    path.push(piece);
                }
            }
            let target = path.join("/");
            assert!(
                parts.contains_key(&target),
                "{name} points at missing {target}"
            );
        }
    }
}

#[test]
fn a_1920_canvas_fills_a_widescreen_slide_and_points_scale_with_it() {
    let parts = read_parts(exported());
    assert!(text_of(&parts, "ppt/presentation.xml")
        .contains(r#"<p:sldSz cx="12192000" cy="6858000"/>"#));
    let slide = text_of(&parts, "ppt/slides/slide1.xml");
    // 96,48 px at 6350 EMU per px; 60 px text is 30 pt.
    assert!(slide.contains(r#"<a:off x="609600" y="304800"/>"#));
    assert!(slide.contains(r#"sz="3000""#));
}

#[test]
fn smaller_canvases_keep_their_real_size() {
    let meta = Meta {
        canvas: (816, 1056),
        ..meta()
    };
    let parts = read_parts(package(&Scene::default(), &meta, &HashMap::new(), |_| None).unwrap());
    assert!(text_of(&parts, "ppt/presentation.xml")
        .contains(r#"<p:sldSz cx="7772400" cy="10058400"/>"#));
}

#[test]
fn css_effects_map_onto_powerpoints_own() {
    let slide = text_of(&read_parts(exported()), "ppt/slides/slide1.xml");
    // Fill alpha times the element's opacity.
    assert!(slide.contains(r#"<a:srgbClr val="FF0000"><a:alpha val="12500"/></a:srgbClr>"#));
    assert!(slide.contains(r#"<a:prstDash val="dash"/>"#));
    assert!(slide.contains(r#"<a:outerShdw blurRad="254000" dist="63500" dir="5400000""#));
    assert!(slide.contains(r#"<a:gd name="adj" fmla="val 25000"/>"#));
    assert!(slide.contains(r#"prst="ellipse""#));
    assert!(
        slide.contains(r#"<a:lin ang="5400000" scaled="0"/>"#),
        "CSS 180deg runs downwards"
    );
    assert!(slide.contains(r#"rot="5400000""#));
}

#[test]
fn text_stays_text_with_its_lists_links_and_escapes() {
    let parts = read_parts(exported());
    let slide = text_of(&parts, "ppt/slides/slide1.xml");
    assert!(slide.contains("<a:t>R&amp;D &lt;title&gt;</a:t>"));
    assert!(slide.contains(r#"typeface="Inter""#));
    assert!(slide.contains(r#"b="1""#));
    assert!(slide.contains("<a:br/>"));
    assert!(slide.contains(r#"<a:buChar char="•"/>"#));
    assert!(slide.contains(r#"<a:buAutoNum type="romanLcPeriod" startAt="3"/>"#));
    assert!(slide.contains(r#"action="ppaction://hlinksldjump""#));
    let rels = text_of(&parts, "ppt/slides/_rels/slide1.xml.rels");
    assert!(rels.contains("https://example.com/?a=1&amp;b=2"));
    assert!(rels.contains(r#"Target="slide2.xml""#));
    assert!(!rels.contains("javascript"));
}

#[test]
fn pictures_share_media_keep_alpha_and_skip_what_is_gone() {
    let parts = read_parts(exported());
    let slide = text_of(&parts, "ppt/slides/slide1.xml");
    assert_eq!(parts["ppt/media/image1.jpeg"], b"jpeg");
    assert_eq!(parts["ppt/media/image2.png"], b"shot");
    assert_eq!(parts["ppt/media/image3.png"], b"background");
    assert_eq!(
        slide.matches("<p:pic>").count(),
        3,
        "two photos and a shot; the missing file is left out"
    );
    assert!(slide.contains(r#"<a:alphaModFix amt="50000"/>"#));
    assert!(slide.contains(r#"<a:srcRect l="10000" t="0" r="20000" b="0"/>"#));
    assert!(slide.contains(r#"flipH="1""#));
    assert!(slide.contains(r#"descr="A &quot;photo&quot;""#));
    assert!(text_of(&parts, "ppt/slides/slide2.xml").contains("<a:blipFill"));
}

#[test]
fn elements_follow_powerpoints_schema_order() {
    let slide = text_of(&read_parts(exported()), "ppt/slides/slide1.xml");
    let order = |a: &str, b: &str| {
        let (a, b) = (slide.find(a).unwrap(), slide.find(b).unwrap());
        assert!(a < b);
    };
    order("<p:bg>", "<p:spTree>");
    order("<a:prstGeom", "<a:ln");
    order("</a:ln>", "<a:effectLst>");
    let first_ppr = slide.find("<a:pPr").unwrap();
    let props = &slide[first_ppr..];
    assert!(props.find("<a:lnSpc>").unwrap() < props.find("<a:buNone/>").unwrap());
    let rpr = &slide[slide.find("<a:rPr").unwrap()..];
    assert!(rpr.find("<a:solidFill>").unwrap() < rpr.find("<a:latin").unwrap());
    assert!(rpr.find("<a:latin").unwrap() < rpr.find("<a:hlinkClick").unwrap());
    let presentation = text_of(&read_parts(exported()), "ppt/presentation.xml");
    let at = |s: &str| presentation.find(s).unwrap();
    assert!(at("<p:sldMasterIdLst>") < at("<p:notesMasterIdLst>"));
    assert!(at("<p:notesMasterIdLst>") < at("<p:sldIdLst>"));
    assert!(at("<p:sldIdLst>") < at("<p:sldSz"));
    assert!(at("<p:notesSz") < at("<p:extLst>"));
}

#[test]
fn an_export_imports_back_with_its_words_notes_and_sections() {
    let converted = convert(exported(), "x").unwrap();
    assert_eq!(converted.title, "Q3 & beyond");
    assert!(converted.html.contains("R&amp;D &lt;title&gt;"));
    let slides = html::find_slides(&converted.html);
    assert_eq!(slides.len(), 2);
    assert_eq!(
        html::notes(&converted.html[slides[0].range.clone()]),
        "Line one\n\nLine <two>"
    );
    // PowerPoint's own "Default Section" for the slides before the first does not come back.
    assert_eq!(html::find_sections(&converted.html).len(), 1);
    assert!(converted.html.contains(r#"data-title="Wrap up""#));
    // The first box has a 3px outline, drawn inside its box by CSS and across its edge by PowerPoint.
    assert!(converted.html.contains("left: 94.5px; top: 46.5px"));
    assert!(converted.html.contains("font-size: 60px"));
    assert_eq!(lint_issues(&converted), []);
}

#[test]
fn matte_recovers_colour_and_transparency() {
    let picture = |rgba: Vec<u8>| Image {
        width: 3,
        height: 1,
        rgba,
    };
    // Solid red; half-transparent red; nothing.
    let white = picture(vec![255, 0, 0, 255, 255, 128, 128, 255, 255, 255, 255, 255]);
    let black = picture(vec![255, 0, 0, 255, 128, 0, 0, 255, 0, 0, 0, 255]);
    let out = matte(&white, &black).unwrap();
    assert_eq!(&out.rgba[..4], [255, 0, 0, 255]);
    assert_eq!(out.rgba[4], 255);
    assert!((i32::from(out.rgba[7]) - 128).abs() <= 2);
    assert_eq!(out.rgba[11], 0);
    let other = Image {
        width: 1,
        height: 1,
        rgba: vec![0, 0, 0, 255],
    };
    assert!(matte(&white, &other).is_err());
}

/// A deck of one slide holding `item`, exported and imported again, photo included.
fn through_export(item: Item) -> import::Converted {
    let scene = Scene {
        slides: vec![SceneSlide {
            id: "one".into(),
            items: vec![item],
            ..scene().slides[0].clone()
        }],
        shots: vec![],
    };
    let bytes = package(&scene, &meta(), &HashMap::new(), |src| {
        (src == "assets/photo.jpg").then(|| b"jpeg".to_vec())
    })
    .unwrap();
    convert(bytes, "x").unwrap()
}

fn text_item(paragraph: Paragraph) -> Item {
    Item::Text(TextItem {
        w: 800.0,
        h: 80.0,
        wrap: true,
        paragraphs: vec![paragraph],
        ..TextItem::default()
    })
}

fn raised() -> Item {
    text_item(Paragraph {
        runs: vec![
            run("E=mc"),
            Run {
                baseline: 30.0,
                ..run("2")
            },
        ],
        ..Paragraph::default()
    })
}

#[test]
fn raised_text_is_sized_for_powerpoint_to_shrink_and_comes_back_the_same() {
    let scene = Scene {
        slides: vec![SceneSlide {
            id: "one".into(),
            items: vec![raised()],
            ..scene().slides[0].clone()
        }],
        shots: vec![],
    };
    let parts = read_parts(package(&scene, &meta(), &HashMap::new(), |_| None).unwrap());
    let slide = text_of(&parts, "ppt/slides/slide1.xml");
    assert!(slide.contains(r#"sz="4500""#), "30pt becomes 45pt");
    assert!(slide.contains(r#"baseline="30000""#));

    let html = through_export(raised()).html;
    assert!(html.contains("font-size: 60px"), "the size it was");
    assert!(html.contains("vertical-align: 0.45em; line-height: 0"));
    assert!(!html.contains("font-size: 90px"));
}

#[test]
fn highlights_come_back_behind_their_words() {
    let html = through_export(text_item(Paragraph {
        runs: vec![Run {
            highlight: Some([255.0, 229.0, 138.0, 1.0]),
            ..run("marked")
        }],
        ..Paragraph::default()
    }))
    .html;
    assert!(html.contains("background-color: #ffe58a"));
}

#[test]
fn a_paragraph_is_sized_like_its_text_so_wrapped_lines_keep_their_height() {
    let html = through_export(text_item(Paragraph {
        line_height: Some(84.0),
        runs: vec![run("Long text")],
        ..Paragraph::default()
    }))
    .html;
    let block = html.split("<p ").nth(1).unwrap();
    let block = &block[..block.find('>').unwrap()];
    assert!(block.contains("line-height: 84px"), "{block}");
    assert!(block.contains("font-size: 60px"), "{block}");
    assert!(block.contains("font-family: &quot;Inter&quot;"), "{block}");
}

#[test]
fn numbers_carry_on_across_separate_text_boxes() {
    let number = |start| Bullet {
        number: Some("decimal".into()),
        start,
        ..Bullet::default()
    };
    let html = through_export(text_item(Paragraph {
        bullet: Some(number(Some(3))),
        runs: vec![run("Third")],
        ..Paragraph::default()
    }))
    .html;
    assert!(html.contains(r#"<ol start="3""#), "{html}");
}

#[test]
fn rounded_and_outlined_pictures_keep_their_look_and_size() {
    let picture = ImageItem {
        src: "assets/photo.jpg".into(),
        x: 100.0,
        y: 100.0,
        w: 400.0,
        h: 200.0,
        radius: 20.0,
        border: Some(Border {
            color: [255.0, 255.0, 255.0, 1.0],
            width: 6.0,
            dash: None,
        }),
        opacity: 1.0,
        ..ImageItem::default()
    };
    let scene = Scene {
        slides: vec![SceneSlide {
            id: "one".into(),
            items: vec![Item::Image(picture.clone())],
            ..scene().slides[0].clone()
        }],
        shots: vec![],
    };
    let parts =
        read_parts(package(&scene, &meta(), &HashMap::new(), |_| Some(b"jpeg".to_vec())).unwrap());
    let slide = text_of(&parts, "ppt/slides/slide1.xml");
    assert!(slide.contains(r#"prst="roundRect""#));
    assert!(slide.contains("<a:ln w="), "{slide}");

    let html = through_export(Item::Image(picture)).html;
    assert!(html.contains("border-radius: 20px"), "{html}");
    assert!(html.contains("border: 6px solid #ffffff"), "{html}");
    assert!(html.contains("box-sizing: border-box"), "{html}");
}

#[test]
fn an_outline_centred_on_a_shapes_edge_grows_the_css_box_it_is_drawn_inside() {
    let html = through_export(Item::Box(BoxItem {
        x: 100.0,
        y: 100.0,
        w: 400.0,
        h: 200.0,
        fill: Some(Fill {
            color: Some([255.0, 255.0, 255.0, 1.0]),
            gradient: None,
        }),
        border: Some(Border {
            color: [0.0, 0.0, 0.0, 1.0],
            width: 4.0,
            dash: None,
        }),
        opacity: 1.0,
        ..BoxItem::default()
    }))
    .html;
    assert!(
        html.contains("left: 98px; top: 98px; width: 404px; height: 204px"),
        "{html}"
    );
}

#[test]
fn cropped_pictures_may_be_taller_than_their_frame() {
    assert!(convert(exported(), "x")
        .unwrap()
        .html
        .contains(".ppt-crop img { position: absolute; max-width: none; max-height: none; }"));
}
