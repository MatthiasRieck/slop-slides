import { afterEach, describe, expect, it, vi } from "vitest";

import { appWindow } from "../test/tauri";
import { requestAttention } from "./attention";

afterEach(() => vi.restoreAllMocks());

describe("requestAttention", () => {
  it("asks the window to be noticed while it is not in use", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    requestAttention();
    await vi.waitFor(() => expect(appWindow.requestUserAttention).toHaveBeenCalledWith(2));
  });

  it("does nothing while the window has the focus", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    requestAttention();
    await Promise.resolve();
    expect(appWindow.requestUserAttention).not.toHaveBeenCalled();
  });

  it("goes without when the window cannot ask", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    appWindow.requestUserAttention.mockRejectedValueOnce(new Error("not allowed"));
    expect(() => requestAttention()).not.toThrow();
    await vi.waitFor(() => expect(appWindow.requestUserAttention).toHaveBeenCalledOnce());
  });
});
