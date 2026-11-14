import { describe, expect, it } from "vitest";

import { foldUnchanged, lineDiff } from "./lineDiff";

const kinds = (before: string, after: string) => lineDiff(before, after).map((l) => `${l.kind[0]}${l.text}`);

describe("lineDiff", () => {
  it("marks the lines taken out and put in, the removed first, keeping the shared ones", () => {
    expect(kinds("a\nb\nc", "a\nB\nc")).toEqual(["sa", "rb", "aB", "sc"]);
    expect(kinds("a\nc", "a\nb\nc")).toEqual(["sa", "ab", "sc"]);
    expect(kinds("a\nb\nc\nd", "a\nc\nx\nd")).toEqual(["sa", "rb", "sc", "ax", "sd"]);
  });

  it("treats an empty text as no lines", () => {
    expect(kinds("", "new\nfile")).toEqual(["anew", "afile"]);
    expect(kinds("gone", "")).toEqual(["rgone"]);
    expect(lineDiff("", "")).toEqual([]);
  });

  it("gives up comparing a middle too large, showing it all removed and added", () => {
    const before = Array.from({ length: 300 }, (_, i) => `a${i}`).join("\n");
    const after = Array.from({ length: 300 }, (_, i) => `b${i}`).join("\n");
    const lines = lineDiff(`top\n${before}\nend`, `top\n${after}\nend`);
    expect(lines).toHaveLength(602);
    expect(lines[0]).toEqual({ kind: "same", text: "top" });
    expect(lines[1]!.kind).toBe("removed");
    expect(lines[301]!.kind).toBe("added");
  });
});

describe("foldUnchanged", () => {
  it("keeps two lines around each change and marks what lies between", () => {
    const before = Array.from({ length: 12 }, (_, i) => `l${i}`);
    const after = [...before];
    after[1] = "x1";
    after[10] = "x10";
    const folded = foldUnchanged(lineDiff(before.join("\n"), after.join("\n")));
    const shown = folded.map((l) => (l ? `${l.kind[0]}${l.text}` : "…"));
    expect(shown).toEqual(["sl0", "rl1", "ax1", "sl2", "sl3", "…", "sl8", "sl9", "rl10", "ax10", "sl11"]);
  });

  it("shows nothing for texts that are the same", () => {
    expect(foldUnchanged(lineDiff("a\nb", "a\nb"))).toEqual([]);
  });
});
