import { beforeEach, describe, expect, it, vi } from "vitest";

import { isWrite, resetSaves, savesSettled, trackingSaves, useSaves } from "./saves";

/** A promise settled from outside. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => resetSaves());

describe("trackingSaves", () => {
  it("counts a write while it runs and passes its result on", async () => {
    const write = deferred<string>();
    const invoke = trackingSaves(vi.fn((_command: string, _args?: unknown) => write.promise));
    const result = invoke("update_slide", { id: "d" });
    expect(useSaves.getState()).toEqual({ pending: 1, failed: false });
    write.resolve("deck");
    await expect(result).resolves.toBe("deck");
    expect(useSaves.getState()).toEqual({ pending: 0, failed: false });
  });

  it("does not count what only reads", async () => {
    const send = vi.fn(async (_command: string, _args?: unknown) => "deck");
    const invoke = trackingSaves(send);
    await invoke("load_deck", { id: "d" });
    expect(send).toHaveBeenCalledWith("load_deck", { id: "d" });
    expect(useSaves.getState().pending).toBe(0);
    expect(isWrite("load_deck")).toBe(false);
    expect(isWrite("save_review")).toBe(true);
  });

  it("says that the last write failed, until one works again", async () => {
    const invoke = trackingSaves(async (command: string) => {
      if (command === "update_slide") throw new Error("disk full");
      return "ok";
    });
    await expect(invoke("update_slide")).rejects.toThrow("disk full");
    expect(useSaves.getState()).toEqual({ pending: 0, failed: true });
    await invoke("save_review");
    expect(useSaves.getState().failed).toBe(false);
  });

  it("lets go of a write that throws at once", () => {
    const invoke = trackingSaves(((): Promise<unknown> => {
      throw new Error("no backend");
    }) as (command: string) => Promise<unknown>);
    expect(() => invoke("update_slide")).toThrow("no backend");
    expect(useSaves.getState()).toEqual({ pending: 0, failed: true });
  });
});

describe("savesSettled", () => {
  it("resolves at once with nothing under way, else when the last write ends", async () => {
    await savesSettled();
    const first = deferred<void>();
    const second = deferred<void>();
    const writes = [first, second];
    const invoke = trackingSaves((_command: string) => writes.shift()!.promise);
    void invoke("update_slide");
    void invoke("save_review");
    let settled = false;
    void savesSettled().then(() => {
      settled = true;
    });
    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    second.resolve();
    await vi.waitFor(() => expect(settled).toBe(true));
  });
});
