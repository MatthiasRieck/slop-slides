// @vitest-environment node
import { describe, expect, it } from "vitest";

import { pictureUrl } from "./thumbnails";

describe("the picture of a slide preview", () => {
  it("is under the picture prefix where the backend serves the preview", () => {
    expect(pictureUrl("slop://localhost/.file/talks/deck.html?embed&slide=a&v=1&static")).toBe(
      "slop://localhost/.thumb/.file/talks/deck.html?embed&slide=a&v=1&static",
    );
    expect(pictureUrl("http://slop.localhost/.template/t/deck.html?embed&slide=a&static")).toBe(
      "http://slop.localhost/.thumb/.template/t/deck.html?embed&slide=a&static",
    );
  });

  it("is none where nothing makes pictures", () => {
    expect(pictureUrl("/__deck/.file/talks/deck.html?embed&slide=a")).toBeNull();
    expect(pictureUrl("https://example.com/slop://localhost/")).toBeNull();
  });
});
