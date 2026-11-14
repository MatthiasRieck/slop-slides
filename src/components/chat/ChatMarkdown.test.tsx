import { render } from "@testing-library/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";

import { splitBlocks } from "../../lib/markdown";
import { ChatMarkdown } from "./ChatMarkdown";

const FENCE = "```";

/** What `node` shows: its elements, without the line breaks react-markdown puts between blocks. */
const shown = (node: HTMLElement) => [...node.children].map((child) => child.outerHTML);

/** Links by where they lead alone: the chat writes its own, with a title and nothing else of what they carry. */
const plainLinks = (html: string[]) => html.map((block) => block.replace(/<a [^>]*?(href="[^"]*")[^>]*>/g, "<a $1>"));

/** What the chat shows for `text`, read piece by piece. */
const inPieces = (text: string) => plainLinks(shown(render(<ChatMarkdown>{text}</ChatMarkdown>).container));

/** What `text` shows read as one document. */
const asOne = (text: string) =>
  plainLinks(shown(render(<Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>).container));

/** Replies of the kinds an agent writes, with what could go wrong when they are read in pieces. */
const REPLIES: Record<string, string> = {
  "paragraphs and headings": "# Title\n\nSome **bold** text\nover two lines.\n\n## Next\n\nMore.\n",
  "a tight and a loose list": "- one\n- two\n\nText.\n\n1. first\n\n2. second\n\n   with a paragraph\n\n3. third\n",
  "a list that goes on after code of an item": `- one\n\n  ${FENCE}js\n  a();\n\n  b();\n  ${FENCE}\n\n- two\n\nAfter.`,
  "a numbered list parted by a paragraph": "1. a\n2. b\n\nBetween.\n\n3. c\n4. d\n",
  "code with blank lines and what looks like Markdown": `Run:\n\n${FENCE}md\n# not a title\n\n- not a list\n\n[x]: not-a-link\n${FENCE}\n\nDone.`,
  "a fence longer than the one inside it": `${FENCE}${FENCE}md\n${FENCE}js\n\ncode\n${FENCE}\n\n${FENCE}${FENCE}\n\nAfter.`,
  "a fence not closed yet": `Text.\n\n${FENCE}html\n<section>\n\n</section>\n\nstill code`,
  "a table": "Before.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter.\n\n| c |\n|---|\n| 3 |\n",
  "quotes parted by a blank line": "> one\n> two\n\n> three\n\nText.",
  "indented code in chunks": "Code:\n\n    first\n\n    second\n\nAfter.",
  "links defined elsewhere":
    "See [the docs][docs] and [more][m].\n\nText.\n\n[docs]: https://example.com/docs\n\n[m]: https://example.com/more\n",
  footnotes: "A claim.[^1]\n\nAnother.[^two]\n\n[^1]: Its source.\n\n[^two]: Another source.\n",
  "HTML with blank lines in it": "One.\n\n<pre>\n\nkept as written\n</pre>\n\nTwo.\n\n<div>\n\n**bold**\n\n</div>\n",
  "a rule, and a heading underlined": "Above\n\n---\n\nTitle\n=====\n\nBelow\n-----\n\nText.",
  "a fence right under a list": `- item\n${FENCE}\ncode\n\ncode\n${FENCE}\n\n- another\n`,
  "a list item that goes on at the margin": `- item\ngoes on\n  ${FENCE}\n  code\n\n  code\n  ${FENCE}\n\nAfter.`,
  "task lists and nested lists": "- [x] done\n- [ ] open\n\n  - nested\n\n    deeper text\n\n- last\n\nEnd.",
};

describe("ChatMarkdown", () => {
  it.each(Object.entries(REPLIES))("shows %s as the whole text reads", (_name, text) => {
    expect(inPieces(text)).toEqual(asOne(text));
  });

  it.each(Object.entries(REPLIES))("shows %s the same at every point of its coming in", (_name, text) => {
    // Cut where a reply is cut as it streams: anywhere. Every tenth letter keeps the test quick.
    for (let length = 1; length < text.length; length += 10) {
      const soFar = text.slice(0, length);
      expect(inPieces(soFar), JSON.stringify(soFar)).toEqual(asOne(soFar));
    }
  });

  it("reads a reply of several blocks in several pieces", () => {
    // What makes the above worth checking: the pieces are not the whole text.
    expect(splitBlocks(REPLIES["a table"]!).length).toBeGreaterThan(2);
  });

  it("keeps links from taking the window anywhere, in every piece", () => {
    const { container } = render(<ChatMarkdown>{"[one](https://a.example)\n\n[two](https://b.example)"}</ChatMarkdown>);
    const links = [...container.querySelectorAll("a")];
    expect(links.map((link) => link.title)).toEqual(["https://a.example", "https://b.example"]);
  });
});
