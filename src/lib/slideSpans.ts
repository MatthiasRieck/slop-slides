/**
 * Finds the top-level `<section class="slide">` elements of deck.html and their character
 * ranges. Mirrors `find_slides` in src-tauri/src/html.rs (comments, `<script>`, `<style>`
 * and quoted attributes are skipped) so ids line up with the backend's, including the
 * positional `#n` ids of slides that have no id yet.
 */
export interface SlideSpan {
  id: string;
  from: number;
  to: number;
}

const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);

interface Tag {
  name: string;
  closing: boolean;
  attrs: Map<string, string>;
  end: number;
}

export function findSlideSpans(html: string): SlideSpan[] {
  const lower = html.toLowerCase();
  const slides: SlideSpan[] = [];
  let open: { from: number; id: string | null; depth: number } | null = null;
  let i = 0;
  while (i < html.length) {
    i = html.indexOf("<", i);
    if (i < 0) break;
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const tag = parseTag(html, i);
    if (!tag) {
      i += 1;
      continue;
    }
    if (!tag.closing && RAW_TEXT.has(tag.name)) {
      const close = lower.indexOf(`</${tag.name}`, tag.end);
      i = close < 0 ? html.length : close;
      continue;
    }
    if (tag.name === "section") {
      if (open && !tag.closing) open.depth += 1;
      else if (open && open.depth > 0) open.depth -= 1;
      else if (open) {
        const index = slides.length;
        slides.push({ id: open.id ?? `#${index + 1}`, from: open.from, to: tag.end });
        open = null;
      } else if (!tag.closing && (tag.attrs.get("class") ?? "").split(/\s+/).includes("slide")) {
        open = { from: i, id: tag.attrs.get("id") || null, depth: 0 };
      }
    }
    i = tag.end;
  }
  return slides;
}

function parseTag(html: string, start: number): Tag | null {
  let i = start + 1;
  const closing = html[i] === "/";
  if (closing) i += 1;
  const name = /^[a-zA-Z0-9]*/.exec(html.slice(i, i + 64))![0];
  if (!name) return null;
  i += name.length;
  const attrs = new Map<string, string>();
  const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);
  for (;;) {
    while (isSpace(html[i]) || html[i] === "/") i += 1;
    if (i >= html.length) return null;
    if (html[i] === ">") break;
    const attrStart = i;
    while (i < html.length && !/[=>/\s]/.test(html[i]!)) i += 1;
    const attr = html.slice(attrStart, i).toLowerCase();
    while (isSpace(html[i])) i += 1;
    let value = "";
    if (html[i] === "=") {
      i += 1;
      while (isSpace(html[i])) i += 1;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const end = html.indexOf(quote, i + 1);
        if (end < 0) return null;
        value = html.slice(i + 1, end);
        i = end + 1;
      } else {
        const valueStart = i;
        while (i < html.length && !isSpace(html[i]) && html[i] !== ">") i += 1;
        value = html.slice(valueStart, i);
      }
    }
    if (!attrs.has(attr)) attrs.set(attr, value);
  }
  return { name: name.toLowerCase(), closing, attrs, end: i + 1 };
}
