import { describe, expect, it } from "vitest";

import { markdownText, rehypePieces } from "./markdown";
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
