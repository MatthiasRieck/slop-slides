// @vitest-environment node
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { describe, expect, it } from "vitest";

import { codeSpans, linkTarget, markdownText, rehypePieces, splitBlocks } from "./markdown";
import { follow, pieces, startTrack, toScript } from "./teleprompter";

describe("markdownText", () => {
  it("leaves plain text as it is", () => {
    expect(markdownText("Plain text.\n\nNext part.")).toBe("Plain text.\nNext part.");
  });

  it("drops the marks and keeps blocks apart", () => {
    expect(markdownText("# Title\n\nSay **this**, [here](https://a.b).\n\n- One\n- Two")).toBe(
      "Title\nSay this, here.\n\nOne\nTwo\n",
    );
  });

  it("keeps markup written in the text, which is shown as text", () => {
    expect(markdownText("Say <hi> & wave")).toBe("Say <hi> & wave");
  });
});

describe("rehypePieces", () => {
  const paragraph = (children: unknown[]) => ({ type: "element", tagName: "p", properties: {}, children });
  const text = (value: string) => ({ type: "text", value });

  it("cuts pieces where inline marks and blocks fall", () => {
    const tree = {
      type: "root",
      children: [
        paragraph([text("one "), { ...paragraph([text("two")]), tagName: "strong" }]),
        text("\n"),
        paragraph([text("three")]),
      ],
    };
    const script = toScript("one two\nthree");
    const track = follow(script, startTrack(script), "one two three");
    rehypePieces(pieces(script, track), () => "x")(tree as never);
    interface Node {
      children: Node[];
      tagName?: string;
      value?: string;
      properties: { dataSaid?: boolean };
    }
    const spans: { said?: boolean; text?: string }[] = [];
    const walk = (node: Node) => {
      if (node.tagName === "span") spans.push({ said: node.properties.dataSaid, text: node.children[0]?.value });
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree as never);
    expect(spans.map((s) => s.text).join("")).toBe("one twothree");
    expect(spans.every((s) => s.said === true)).toBe(true);
    // The space between the blocks stays bare text.
    expect(tree.children[1]).toEqual(text("\n"));
  });
});

describe("codeSpans", () => {
  it("marks what is written between backticks as code", () => {
    expect(codeSpans("Install it with `npm i -g x` and run `x` once.")).toEqual([
      { text: "Install it with ", code: false },
      { text: "npm i -g x", code: true },
      { text: " and run ", code: false },
      { text: "x", code: true },
      { text: " once.", code: false },
    ]);
  });

  it("leaves a sentence without any as it is, and nothing of nothing", () => {
    expect(codeSpans("Install it from the website.")).toEqual([{ text: "Install it from the website.", code: false }]);
    expect(codeSpans("`x`")).toEqual([{ text: "x", code: true }]);
    expect(codeSpans("")).toEqual([]);
  });
});

describe("linkTarget", () => {
  const WORKSPACE = "/decks/talk";

  it.each(["https://example.com/a?b=1#c", "http://localhost:3000", "HTTPS://EXAMPLE.COM", "mailto:me@example.com"])(
    "sends %s to the system",
    (url) => {
      expect(linkTarget(url, WORKSPACE)).toEqual({ kind: "url", url });
      expect(linkTarget(url, null)).toEqual({ kind: "url", url });
    },
  );

  it.each([
    ["notes.md", "/decks/talk/notes.md"],
    ["./q3/deck.html", "/decks/talk/q3/deck.html"],
    ["q3/deck.html#intro", "/decks/talk/q3/deck.html"],
    ["assets/my%20photo.png?v=2", "/decks/talk/assets/my photo.png"],
    ["/decks/talk/q3/deck.html", "/decks/talk/q3/deck.html"],
    ["file:///decks/talk/notes.md", "/decks/talk/notes.md"],
    ["100%.md", "/decks/talk/100%.md"],
  ])("opens %s as a file of the workspace", (href, path) => {
    expect(linkTarget(href, WORKSPACE)).toEqual({ kind: "file", path });
  });

  it("knows a Windows workspace and its paths", () => {
    expect(linkTarget("q3\\deck.html", "C:\\decks\\talk")).toEqual({
      kind: "file",
      path: "C:/decks/talk/q3/deck.html",
    });
    expect(linkTarget("C:\\decks\\talk\\notes.md", "C:\\decks\\talk\\")).toEqual({
      kind: "file",
      path: "C:/decks/talk/notes.md",
    });
  });

  it.each([
    undefined,
    "",
    "  ",
    "#top",
    "javascript:alert(1)",
    "data:text/html,x",
    "ftp://example.com/x",
    "/etc/passwd",
    "../secrets.txt",
    "q3/../../secrets.txt",
    "/decks/talk-other/notes.md",
    "/decks/talk",
  ])("goes nowhere for %s", (href) => {
    expect(linkTarget(href, WORKSPACE)).toBeNull();
  });

  it("opens no file without a workspace", () => {
    expect(linkTarget("notes.md", null)).toBeNull();
  });
});

describe("splitBlocks", () => {
  const FENCE = "```";

  /** The cuts of `text`, which is also checked to be all of it. */
  const blocks = (text: string) => {
    const cut = splitBlocks(text);
    expect(cut.join("")).toBe(text);
    return cut;
  };

  it("cuts between blocks, the blank lines going to the piece after them", () => {
    expect(blocks("# Title\n\nA paragraph\nof two lines.\n\n\nAnother.\n")).toEqual([
      "# Title\n",
      "\nA paragraph\nof two lines.\n",
      "\n\nAnother.\n",
    ]);
  });

  it("gives nothing for no text, and one piece for a single block or blank lines alone", () => {
    expect(blocks("")).toEqual([]);
    expect(blocks("Just this")).toEqual(["Just this"]);
    expect(blocks("\n\n")).toEqual(["\n\n"]);
    expect(blocks("\n\nAfter blank lines")).toEqual(["\n\nAfter blank lines"]);
    expect(blocks("Ends with blank lines\n\n")).toEqual(["Ends with blank lines\n\n"]);
  });

  it("keeps a fenced code block whole, blank lines and all", () => {
    const code = `\n${FENCE}js\nconst a = 1;\n\nconst b = 2;\n${FENCE}\n`;
    expect(blocks(`Before.\n${code}\nAfter.`)).toEqual(["Before.\n", code, "\nAfter."]);
    const tildes = "~~~\none\n\ntwo\n~~~\n";
    expect(blocks(`${tildes}\nAfter.`)).toEqual([tildes, "\nAfter."]);
  });

  it("ends a fence only with one as long as it began, of the same marks", () => {
    const code = `${FENCE}${FENCE}\n${FENCE}\n\ninside\n~~~\n\nstill inside\n${FENCE}${FENCE}\n`;
    expect(blocks(`${code}\nAfter.`)).toEqual([code, "\nAfter."]);
  });

  it("keeps everything after a fence that is not closed yet in the last piece", () => {
    expect(blocks(`Text.\n\n${FENCE}html\n<p>\n\n</p>\n\nmore`)).toEqual([
      "Text.\n",
      `\n${FENCE}html\n<p>\n\n</p>\n\nmore`,
    ]);
  });

  it("does not take code in a line of text for a fence", () => {
    expect(blocks(`Some ${FENCE}a${FENCE} code\n\nNext.\n\n${FENCE}\nx\n\ny\n${FENCE}`)).toEqual([
      `Some ${FENCE}a${FENCE} code\n\nNext.\n`,
      `\n${FENCE}\nx\n\ny\n${FENCE}`,
    ]);
  });

  it("keeps a list whole: its items apart, and their paragraphs", () => {
    const list = "\n- one\n\n- two\n\n  more of two\n\n1. three\n";
    expect(blocks(`Before.\n${list}\nAfter.`)).toEqual(["Before.\n", list, "\nAfter."]);
  });

  it("keeps a list with code in an item whole, and with it the block after", () => {
    const list = `\n- one\n\n  ${FENCE}\n  code\n\n  code\n  ${FENCE}\n\n- two\n`;
    expect(blocks(`Before.\n${list}\nAfter.\n\nLast.`)).toEqual(["Before.\n", `${list}\nAfter.\n`, "\nLast."]);
  });

  it("starts another piece with a list that follows a paragraph", () => {
    expect(blocks("- a\n- b\n\nBetween.\n\n- c\n")).toEqual(["- a\n- b\n", "\nBetween.\n", "\n- c\n"]);
  });

  it("keeps a table whole, and code that is indented", () => {
    const table = "| a | b |\n|---|---|\n| 1 | 2 |\n";
    const indented = "\nCode:\n\n    first\n\n    second\n";
    expect(blocks(`${table}${indented}\nAfter.`)).toEqual([table, indented, "\nAfter."]);
  });

  it("stops cutting where the end of a block is not told by a blank line", () => {
    // HTML ends by rules of its own.
    expect(blocks("One.\n\n<pre>\n\nstill pre\n</pre>\n\nTwo.")).toEqual([
      "One.\n",
      "\n<pre>\n\nstill pre\n</pre>\n\nTwo.",
    ]);
    // A fence under a list item may be the item's, which ends where the list does.
    const rest = `\n- item\n ${FENCE}\n code\n\nafter\n\nmore`;
    expect(blocks(`One.\n${rest}`)).toEqual(["One.\n", rest]);
  });

  it("is one piece when links or footnotes are defined, as what refers to them may be anywhere", () => {
    const links = "See [the docs][docs].\n\nMore.\n\n[docs]: https://example.com\n";
    expect(blocks(links)).toEqual([links]);
    const notes = "A claim.[^1]\n\nMore.\n\n[^1]: Its source.\n";
    expect(blocks(notes)).toEqual([notes]);
  });

  it("reads lines that end as Windows ends them", () => {
    expect(blocks(`A.\r\n\r\n${FENCE}\r\nx\r\n\r\ny\r\n${FENCE}\r\n\r\nB.`)).toEqual([
      "A.\r\n",
      `\r\n${FENCE}\r\nx\r\n\r\ny\r\n${FENCE}\r\n`,
      "\r\nB.",
    ]);
  });

  it("leaves the pieces before the last two as they are while a reply grows", () => {
    const reply = `Intro.\n\n- a\n- b\n\n${FENCE}ts\nlet x;\n\nlet y;\n${FENCE}\n\nThe end of it.`;
    let before: string[] = [];
    for (let length = 1; length <= reply.length; length++) {
      const now = blocks(reply.slice(0, length));
      // The piece being written changes; the one before it gives up its last blank lines, once,
      // when the next block starts. Every other piece is what it was a letter ago.
      const settled = Math.max(0, before.length - 2);
      expect(now.slice(0, settled)).toEqual(before.slice(0, settled));
      before = now;
    }
    expect(before).toHaveLength(4);
  });
});

describe("splitBlocks: against the parser", () => {
  const FENCE = "```";
  const parser = unified().use(remarkParse).use(remarkGfm).use(remarkRehype);

  /** What `markdown` reads as: its blocks, without where in the text they were and the line breaks between them. */
  const read = (markdown: string): unknown[] => {
    const tree = parser.runSync(parser.parse(markdown)) as { children: { type: string; value?: string }[] };
    const blocks = tree.children.filter((node) => !(node.type === "text" && node.value?.trim() === ""));
    return JSON.parse(JSON.stringify(blocks, (key, value) => (key === "position" ? undefined : value)));
  };

  /** Lines an agent may write, and ones picked to trip a reader that goes by lines. */
  const LINES = [
    "Plain text.",
    "More text",
    "# Heading",
    "- item",
    "- another",
    "* starred",
    "1. first",
    "2) second",
    "  continued under an item",
    "   - nested",
    "    indented four",
    "\tindented by a tab",
    "> quoted",
    FENCE,
    `${FENCE}js`,
    `  ${FENCE}`,
    ` ${FENCE}`,
    `    ${FENCE}`,
    `- ${FENCE}`,
    `> ${FENCE}`,
    "~~~",
    `${FENCE}${FENCE}`,
    `${FENCE}inline${FENCE} code`,
    "| a | b |",
    "|---|---|",
    "---",
    "===",
    "<div>",
    "</div>",
    "<!-- note",
    "-->",
    "[ref]: https://example.com",
    "A [link][ref].",
    "",
    "",
    "",
  ];

  /** Numbers that look random and are the same each run. */
  const random = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  /** Checks `rounds` mixes of `lines`, and gives how many cuts they took. */
  const check = (lines: string[], rounds: number, seed: number) => {
    const next = random(seed);
    let cuts = 0;
    for (let round = 0; round < rounds; round++) {
      const mix = Array.from({ length: 2 + Math.floor(next() * 14) }, () => lines[Math.floor(next() * lines.length)]);
      const text = mix.join("\n");
      const pieces = splitBlocks(text);
      cuts += pieces.length - 1;
      expect(pieces.join(""), JSON.stringify(text)).toBe(text);
      expect(pieces.flatMap(read), JSON.stringify(text)).toEqual(read(text));
    }
    return cuts;
  };

  it("reads the pieces of any mix of lines as the whole reads", { timeout: 30_000 }, () => {
    check(LINES, 300, 7);
  });

  it("does so where it cuts most: without the lines that make it keep the rest whole", { timeout: 30_000 }, () => {
    const cutting = LINES.filter((line) => !line.startsWith("<") && !line.includes("-->") && !line.includes("[ref]"));
    // More blank lines, as between the blocks of a reply. The check means something: the mixes were cut, and often.
    expect(check([...cutting, ...Array<string>(12).fill("")], 300, 11)).toBeGreaterThan(60);
  });
});
