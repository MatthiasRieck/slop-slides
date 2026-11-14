import type { Element, Root } from "hast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import type { Piece } from "./teleprompter";

/** Parses like react-markdown with remark-gfm, so its text is the text shown. */
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkRehype, { allowDangerousHtml: true });

/** `visit`s the text in `parent`, in order; what it returns takes the text's place. */
function mapText(
  parent: Root | Element,
  visit: (text: string, node: Root["children"][number]) => Root["children"],
): void {
  parent.children = parent.children.flatMap((child) => {
    if (child.type === "element") mapText(child, visit);
    // Markup written in the text is shown as text; react-markdown gets to it after us.
    return child.type === "text" || child.type === "raw" ? visit(child.value, child) : [child];
  }) as typeof parent.children;
}

/** What `markdown` reads as: its text without the marks, blocks on lines of their own. */
export function markdownText(markdown: string): string {
  let out = "";
  mapText(parser.runSync(parser.parse(markdown)) as Root, (text, node) => {
    out += text;
    return [node];
  });
  return out;
}

/**
 * A rehype plugin marking `pieces`, stretches of the text [markdownText] gives, wherever the
 * formatting puts them: each becomes a span of `className(piece)`, cut up where blocks and
 * inline marks need it.
 */
export function rehypePieces(pieces: Piece[], className: (piece: Piece) => string) {
  return (tree: Root) => {
    let index = 0;
    let used = 0;
    const take = (length: number) => {
      const out: Piece[] = [];
      for (let left = length; left > 0 && index < pieces.length; ) {
        const piece = pieces[index]!;
        const text = piece.text.slice(used, used + left);
        out.push({ ...piece, text });
        left -= text.length;
        used += text.length;
        if (used === piece.text.length) {
          index++;
          used = 0;
        }
      }
      return out;
    };
    mapText(tree, (text, node) => {
      const stretches = take(text.length);
      // The space between blocks: no span may stand directly in a list or a table.
      if (text.trim() === "") return [node];
      return stretches.map((piece) => ({
        type: "element",
        tagName: "span",
        properties: {
          className: [className(piece)],
          dataSaid: piece.said || undefined,
          dataCurrent: piece.current || undefined,
        },
        children: [{ type: "text", value: piece.text }],
      }));
    });
  };
}

/**
 * Where a link in a chat message leads: a page for the browser, a file of the workspace, a slide
 * of the open deck (by the id its `#…` names; whether there is such a slide is for the chat to
 * check), or nowhere the app goes.
 */
export type LinkTarget =
  | { kind: "url"; url: string }
  | { kind: "file"; path: string }
  | { kind: "slide"; id: string }
  | null;

/**
 * Where the link `href` of a chat message leads. Web and mail addresses are for the system's
 * browser; a path is a file, relative to the `workspace` folder unless it is inside it already;
 * `#id` is the slide with that id, as the agent is told to write its links to slides.
 * Anything else (a script, a file outside the workspace) leads nowhere.
 */
export function linkTarget(href: string | undefined, workspace: string | null): LinkTarget {
  const link = href?.trim();
  if (!link) return null;
  if (link.startsWith("#")) {
    let id = link.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      // Not encoded after all: the id is as written.
    }
    return id ? { kind: "slide", id } : null;
  }
  if (/^(https?:|mailto:)/i.test(link)) return { kind: "url", url: link };
  if (!workspace) return null;
  const root = workspace.replaceAll("\\", "/").replace(/\/+$/, "");
  let path = link.replace(/^file:\/\//i, "").replace(/[?#].*$/, "");
  // Any other scheme is not a path; a Windows drive letter is.
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return null;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Not encoded after all: the path is as written.
  }
  path = path.replaceAll("\\", "/");
  const absolute = path.startsWith("/") || /^[a-z]:\//i.test(path);
  if (!absolute) path = `${root}/${path.replace(/^\.\//, "")}`;
  if (path.split("/").includes("..") || !path.startsWith(`${root}/`)) return null;
  return { kind: "file", path };
}

/** A fence of a code block, indented by three spaces at most: its indent, the marks, then what follows them. */
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
/** A line that starts an item of a list: its indent, the item's mark, and the space before its text. */
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)/;
/** A line that may start a block of HTML, which ends by rules of its own. */
const HTML_START = /^ {0,3}<[a-z/!?]/i;
/** A definition of a link or a footnote, which text anywhere else in the document refers to. */
const DEFINITION = /^ {0,3}\[[^\]\n]+\]:/m;

/** How far `line` is indented, in columns; a tab counts as four. */
function indentOf(line: string): number {
  let columns = 0;
  for (const char of line) {
    if (char === " ") columns += 1;
    else if (char === "\t") columns += 4;
    else break;
  }
  return columns;
}

/**
 * Where the text of a list item starts, in columns: what is indented this far belongs to the
 * item. Taken to be further in where it is not plain (a tab, or more spaces than an item takes),
 * as that is the side to err on: see `splitBlocks`.
 */
function itemColumn([, indent = "", mark = "", space = ""]: RegExpExecArray): number {
  const plain = space.length >= 1 && space.length <= 4 && !space.includes("\t");
  return indent.length + mark.length + (space === "" ? 1 : plain ? space.length : 4);
}

/**
 * Cuts Markdown into pieces that each read the same alone as in the whole: put together again
 * they are `text`, and rendered one after the other they show what `text` shows. A reply that is
 * still being written only changes its last piece, so the ones before need no parsing again.
 *
 * A piece ends before the blank lines that come before a line starting at the margin, which is
 * where a block of the document ends: a fenced code block with blank lines in it stays whole (one
 * not closed yet runs to the end), as do a list with the paragraphs and code of its items, and a
 * table. The blank lines go to the piece after them, where they mean nothing.
 *
 * It never cuts where it might be wrong, at the price of cutting less:
 * - A text with definitions of links or footnotes is one piece, as what refers to them may be
 *   anywhere.
 * - After a line of HTML, which ends by rules of its own, the rest is one piece. So it is after
 *   a fence of which it is not clear whether it belongs to a list item or stands by itself.
 * - A list or quote with a fence in it stays with the block after it: whether a blank line
 *   after code that its item ended (not a fence of its own) is still code depends on that block.
 * - A numbered item that does not start at 1 stays with indented code before it: the parser
 *   reads it as text there, blank lines between them or not.
 */
export function splitBlocks(text: string): string[] {
  if (!text) return [];
  if (DEFINITION.test(text)) return [text];
  const blocks: string[] = [];
  let start = 0;
  /** The closing fence of the code block being read, one that stands by itself. */
  let closing: RegExp | null = null;
  /** Where the text of the list item last started is, while a list may be going on; see `itemColumn`. */
  let item: number | null = null;
  /** A line since may have ended the list, or gone on with a paragraph of it. */
  let listUnsure = false;
  /** A fence was written in a list or a quote since a block last ended at the margin. */
  let fenceInside = false;
  /** Where the blank lines before the line being read start; null when it follows a line with text, or none. */
  let blankFrom: number | null = null;
  let hasContent = false;
  /** How far the line with text before the one being read is indented. */
  let indentBefore = 0;
  for (let at = 0; at < text.length; ) {
    const newline = text.indexOf("\n", at);
    const next = newline === -1 ? text.length : newline + 1;
    const line = text.slice(at, newline === -1 ? text.length : newline).replace(/\r$/, "");
    if (closing) {
      if (closing.test(line)) closing = null;
    } else if (line.trim() === "") {
      if (hasContent) blankFrom ??= at;
    } else {
      const indent = indentOf(line);
      const startsItem = LIST_ITEM.exec(line);
      // A block ended before the blank lines, unless this is the next item of the list.
      if (blankFrom !== null && indent === 0 && !(item !== null && startsItem)) {
        const afterCode = indentBefore >= 4 && !!startsItem && !/^(?:[-*+]|0*1[.)])/.test(line);
        if (!fenceInside && !afterCode) {
          blocks.push(text.slice(start, blankFrom));
          start = blankFrom;
        }
        item = null;
        fenceInside = false;
      }
      blankFrom = null;
      hasContent = true;
      indentBefore = indent;
      if (HTML_START.test(line)) break;
      if (startsItem) {
        item = itemColumn(startsItem);
        listUnsure = false;
      } else if (item !== null && indent < item) {
        listUnsure = true;
      }
      const [fence, , marks = "", info = ""] = FENCE.exec(line) ?? [];
      // Backticks after the fence make it a stretch of code in a line of text.
      const fenced = fence !== undefined && !(marks[0] === "`" && info.includes("`"));
      const inItem = item !== null && indent >= item && !listUnsure;
      if (fenced && !inItem) {
        if (item !== null && indent > 0) break;
        closing = new RegExp(`^ {0,3}${marks[0]}{${marks.length},}[ \\t]*$`);
      } else if (line.includes("```") || line.includes("~~~")) {
        fenceInside = true;
      }
    }
    at = next;
  }
  blocks.push(text.slice(start));
  return blocks;
}
