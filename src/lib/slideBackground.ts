/**
 * A slide's own background in its markup, as the slide editor sets it on the slide being edited
 * (see `setBackground` in src-tauri/assets/editor/70-look.js): for giving every slide the same.
 */

/** The opening tag of an element at the start of `markup`: its name, its attributes, and how it closes. */
const OPENING_TAG = /^(\s*<[a-zA-Z][\w-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))?)*)(\s*\/?>)/;
const STYLE_ATTRIBUTE = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/** The declarations of an inline style, split at the semicolons that are not inside brackets or quotes (a data URL has its own). */
function declarations(style: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let from = 0;
  for (let i = 0; i < style.length; i++) {
    const char = style[i]!;
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === ";" && depth === 0) {
      parts.push(style.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(style.slice(from));
  return parts.map((part) => part.trim()).filter(Boolean);
}

const property = (declaration: string) => declaration.split(":")[0]!.trim().toLowerCase();

/**
 * `markup` (a slide's, starting with its opening tag) with `color` as the slide's own
 * background, over any gradient or image the deck gives it; null takes the slide's own
 * background off, so the deck's shows again. Anything else in its style stays. Markup that does
 * not start with a tag comes back as it is.
 */
export function withSlideBackground(markup: string, color: string | null): string {
  const tag = OPENING_TAG.exec(markup);
  if (!tag) return markup;
  const [whole, name, attributes, close] = tag as unknown as [string, string, string, string];
  const style = STYLE_ATTRIBUTE.exec(attributes);
  const kept = declarations(style?.[1] ?? style?.[2] ?? "").filter(
    (declaration) => !["background-color", "background-image"].includes(property(declaration)),
  );
  const own = color ? [`background-color: ${color}`, "background-image: none"] : [];
  const next = [...kept, ...own].join("; ");
  const attribute = next ? ` style="${next.replace(/"/g, "'")}"` : "";
  const rest = style ? attributes.replace(STYLE_ATTRIBUTE, attribute) : attributes + attribute;
  return name + rest + close + markup.slice(whole.length);
}
