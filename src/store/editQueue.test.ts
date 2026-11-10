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
});
