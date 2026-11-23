import { describe, expect, it } from "vitest";

import { loadHighlighter } from "./highlighter";

describe("loadHighlighter", () => {
  it("gives every block of a language the same highlighter, so asking again changes nothing", async () => {
    const first = await loadHighlighter("html");
    expect(first).not.toBeNull();
    // A chat shown again asks for each of its blocks: the same object keeps their colored lines.
    expect(await loadHighlighter("html")).toBe(first);
    expect(loadHighlighter("html")).toBe(loadHighlighter("html"));
  });

  it("has none for a language it does not know", async () => {
    expect(await loadHighlighter("no-such-language")).toBeNull();
  });
});
