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
