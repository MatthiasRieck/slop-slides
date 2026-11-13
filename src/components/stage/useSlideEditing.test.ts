import { describe, expect, it } from "vitest";
import { unlessSame } from "./useSlideEditing";

describe("unlessSame", () => {
  it("keeps the report it had when the next one says the same, so typing does not re-render the toolbar", () => {
    const was = { slide: "intro", selection: { kind: "text", bold: false, color: "#111111" } };
    expect(unlessSame(was, { slide: "intro", selection: { kind: "text", bold: false, color: "#111111" } })).toBe(was);
  });

  it("takes a report that differs, or the first one", () => {
    const was = { slide: "intro", selection: { kind: "text", bold: false } };
    const bold = { slide: "intro", selection: { kind: "text", bold: true } };
    expect(unlessSame(was, bold)).toBe(bold);
    expect(unlessSame<typeof was | null>(null, was)).toBe(was);
    expect(unlessSame<typeof was | null>(was, null)).toBeNull();
  });
});
