import { describe, expect, it } from "vitest";

import { relativePath, workspaceName } from "./paths";

describe("paths in the workspace", () => {
  const WS = { path: "/ws", name: "ws" };

  it("names paths relative to the workspace folder", () => {
    expect(relativePath(WS, "/ws/talks/q3.html")).toBe("talks/q3.html");
    expect(relativePath({ path: "/ws/", name: "ws" }, "/ws/a.html")).toBe("a.html");
    expect(relativePath({ path: "C:\\ws", name: "ws" }, "C:\\ws\\talks\\q3.html")).toBe("talks/q3.html");
    expect(relativePath(WS, "/wsx/a.html")).toBeNull();
    expect(relativePath(null, "/ws/a.html")).toBeNull();
  });

  it("names a file outside the workspace by its name", () => {
    expect(workspaceName(WS, "/ws/talks/q3.html")).toBe("talks/q3.html");
    expect(workspaceName(WS, "/elsewhere/q3.html")).toBe("q3.html");
    expect(workspaceName(null, "/ws/deck.html")).toBe("deck.html");
  });
});
