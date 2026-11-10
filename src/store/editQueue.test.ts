import { beforeEach, describe, expect, it, vi } from "vitest";

describe("the deck file's save queue", () => {
  let queue: typeof import("./editQueue");
  beforeEach(async () => {
    vi.resetModules();
    queue = await import("./editQueue");
  });

  it("runs changes one after another, each once the one before is done, resolving to its result", async () => {
    const order: string[] = [];
    const slow = queue.queueEdit(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("slow");
      return 1;
    });
    const fast = queue.queueEdit(async () => {
      order.push("fast");
      return "two";
    });
    expect(await Promise.all([slow, fast])).toEqual([1, "two"]);
    expect(order).toEqual(["slow", "fast"]);
  });

  it("tells when every change queued so far is done", async () => {
    let done = false;
    void queue.queueEdit(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      done = true;
    });
    await queue.editsSaved();
    expect(done).toBe(true);
  });

  it("goes on after a change that fails, which its caller is told of, keeping the order", async () => {
    const order: string[] = [];
    const first = queue.queueEdit(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("first");
      return 1;
    });
    const failing = queue.queueEdit(async () => {
      order.push("failing");
      throw new Error("disk full");
    });
    const after = queue.queueEdit(async () => {
      order.push("after");
      return "saved";
    });
    await expect(failing).rejects.toThrow("disk full");
    expect(await Promise.all([first, after])).toEqual([1, "saved"]);
    expect(order).toEqual(["first", "failing", "after"]);
  });

  it("tells when everything queued has settled, a failed change too", async () => {
    let later = false;
    const failing = queue.queueEdit(async () => {
      throw new Error("conflict");
    });
    void queue.queueEdit(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      later = true;
    });
    await expect(queue.editsSaved()).resolves.toBeUndefined();
    expect(later).toBe(true);
    await expect(failing).rejects.toThrow("conflict");
  });

  it("goes on after a change that throws before it awaits anything", async () => {
    const failing = queue.queueEdit((() => {
      throw new Error("bad change");
    }) as () => Promise<never>);
    await expect(failing).rejects.toThrow("bad change");
    expect(await queue.queueEdit(async () => "still runs")).toBe("still runs");
  });
});
