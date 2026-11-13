// @vitest-environment node
import { describe, expect, it } from "vitest";

import { codeSpans, linkTarget, markdownText, rehypePieces } from "./markdown";
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
