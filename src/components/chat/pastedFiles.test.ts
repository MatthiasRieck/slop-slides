import { describe, expect, it } from "vitest";

import { pastedName, readBase64 } from "./pastedFiles";

describe("pastedName", () => {
  it.each([
    ["image.png", "image/png", "pasted-image.png"],
    ["Image.JPEG", "image/jpeg", "pasted-image.jpg"],
    ["", "image/jpeg", "pasted-image.jpg"],
    ["", "image/svg+xml", "pasted-image.svg"],
    ["", "", "pasted-image.png"],
    ["Holiday.jpeg", "image/jpeg", "Holiday.jpeg"],
  ])("names %j of type %j %j", (name, type, expected) => {
    expect(pastedName(new File(["x"], name, { type }))).toBe(expected);
  });
});

describe("readBase64", () => {
  it("reads the file without the data URL prefix", async () => {
    await expect(readBase64(new File(["hi"], "a.png", { type: "image/png" }))).resolves.toBe("aGk=");
  });
});
