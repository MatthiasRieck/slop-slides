//! Text as HTML text and back.

/// Plain text as HTML text.
pub(crate) fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Plain text as the value of a double-quoted attribute.
pub(super) fn escape_attr(text: &str) -> String {
    escape(text).replace('"', "&quot;")
}

/// HTML text as plain text, for the entities [`escape_attr`] writes and `&#39;`.
pub(super) fn decode_entities(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}
