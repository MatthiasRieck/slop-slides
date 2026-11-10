import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { listen } from "../test/tauri";
import { useTauriEvent } from "./useTauriEvent";

type Handler = (event: { payload: unknown }) => void;

/** Subscribes like the backend's `listen`, keeping each handler and counting unlistens. */
function backend() {
  const handlers: Handler[] = [];
  const unlisten = vi.fn();
  listen.mockImplementation(async (_name: string, handler: Handler) => {
    handlers.push(handler);
    return unlisten;
  });
  return { handlers, unlisten, send: (payload: unknown) => act(() => handlers.at(-1)?.({ payload })) };
}

afterEach(() => listen.mockReset().mockImplementation(async () => () => {}));

describe("useTauriEvent", () => {
  it("hands payloads to the latest handler without listening again", () => {
    const events = backend();
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ handler }) => useTauriEvent("voice-level", handler), {
      initialProps: { handler: first },
    });
    expect(listen).toHaveBeenCalledWith("voice-level", expect.any(Function));
    events.send(0.5);
    rerender({ handler: second });
    events.send(0.25);
    expect(first).toHaveBeenCalledWith(0.5);
    expect(second).toHaveBeenCalledWith(0.25);
    expect(listen).toHaveBeenCalledOnce();
  });

  it("listens only while enabled, ignoring what comes after it stopped", async () => {
    const events = backend();
    const handler = vi.fn();
    const { rerender } = renderHook(({ enabled }) => useTauriEvent("voice-download", handler, enabled), {
      initialProps: { enabled: false },
    });
    expect(listen).not.toHaveBeenCalled();
    rerender({ enabled: true });
    expect(listen).toHaveBeenCalledOnce();
    rerender({ enabled: false });
    await act(async () => {});
    expect(events.unlisten).toHaveBeenCalledOnce();
    events.send("late");
    expect(handler).not.toHaveBeenCalled();
  });
});
