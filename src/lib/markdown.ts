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

/** Stretches of a sentence, those written between backticks marked as code. */
export function codeSpans(text: string): { text: string; code: boolean }[] {
  return text
    .split("`")
    .map((part, index) => ({ text: part, code: index % 2 === 1 }))
    .filter((part) => part.text !== "");
}

/** Where a link in a chat message leads: a page for the browser, a file of the workspace, or nowhere the app goes. */
export type LinkTarget = { kind: "url"; url: string } | { kind: "file"; path: string } | null;

/**
 * Where the link `href` of a chat message leads. Web and mail addresses are for the system's
 * browser; a path is a file, relative to the `workspace` folder unless it is inside it already.
 * Anything else (a place on the page, a script, a file outside the workspace) leads nowhere.
 */
export function linkTarget(href: string | undefined, workspace: string | null): LinkTarget {
  const link = href?.trim();
  if (!link || link.startsWith("#")) return null;
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
