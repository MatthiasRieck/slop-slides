import { describe, expect, it } from "vitest";

import { previewKind } from "./filePreview";

describe("previewKind", () => {
  it("shows images, PDFs where the window can, and text files", () => {
    expect(previewKind("assets/Photo.PNG", true)).toBe("image");
    expect(previewKind("exports/Talk.pdf", true)).toBe("pdf");
    expect(previewKind("exports/Talk.PDF", false)).toBe("none");
    for (const path of ["notes.md", "data/table.CSV", "a/b/config.yaml", "README", "talk.srt"]) {
      expect(previewKind(path, true), path).toBe("text");
    }
  });

  it("has nothing to show for other files", () => {
    for (const path of ["q3.pptx", "song.mp3", "archive.zip", "Makefile.bak", ".env", "data"]) {
      expect(previewKind(path, true), path).toBe("none");
    }
  });
});
