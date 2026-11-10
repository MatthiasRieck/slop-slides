// @vitest-environment node
import { Channel as CoreChannel, invoke as coreInvoke } from "@tauri-apps/api/core";
import { emit as eventEmit, listen as eventListen } from "@tauri-apps/api/event";
import { ask as dialogAsk, open as dialogOpen, save as dialogSave } from "@tauri-apps/plugin-dialog";
import { revealItemInDir as openerReveal } from "@tauri-apps/plugin-opener";
import { describe, expect, it } from "vitest";
import { ask, Channel, emit, invoke, listen, open, revealItemInDir, save } from "./tauri";

describe("shared Tauri mocks", () => {
  it("stand in for the @tauri-apps modules in every test file", () => {
    expect(coreInvoke).toBe(invoke);
    expect(CoreChannel).toBe(Channel);
    expect(eventListen).toBe(listen);
    expect(eventEmit).toBe(emit);
    expect(dialogAsk).toBe(ask);
    expect(dialogSave).toBe(save);
    expect(dialogOpen).toBe(open);
    expect(openerReveal).toBe(revealItemInDir);
  });

  it("keep implementations across tests but record calls afresh", async () => {
    invoke.mockResolvedValue("kept");
    await coreInvoke("first");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("start each test with an empty call history", async () => {
    expect(invoke).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
    expect(revealItemInDir).not.toHaveBeenCalled();
    await expect(coreInvoke("second")).resolves.toBe("kept");
  });
});
