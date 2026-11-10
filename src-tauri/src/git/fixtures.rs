//! Decks the tests of version control share.

pub(super) fn deck(slides: &[&str]) -> String {
    deck_styled("red", slides)
}

pub(super) fn deck_styled(color: &str, slides: &[&str]) -> String {
    let slides: Vec<String> = slides
        .iter()
        .map(|slide| match slide.split_once('=') {
            Some((id, text)) => {
                format!("<section class=\"slide\" id=\"{id}\"><h1>{text}</h1></section>")
            }
            None => format!("<section class=\"slide\"><h1>{slide}</h1></section>"),
        })
        .collect();
    format!(
        "<!DOCTYPE html><html><head><title>Talk</title><style>h1 {{ color: {color} }}</style></head>\n<body><main class=\"deck\">\n{}\n</main></body></html>\n",
        slides.join("\n")
    )
}
