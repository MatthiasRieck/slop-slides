import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriInvoke = vi.fn();
const tauriListen = vi.fn();
const ask = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => tauriInvoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: (...args: unknown[]) => tauriListen(...args) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: (...args: unknown[]) => ask(...args) }));

const BASE = "/s/tok";

/** platform.ts as a device sees it (`remote`), or as the window does. */
async function load(remote: boolean) {
  vi.resetModules();
  if (remote) window.__SLOPSLIDE_REMOTE__ = { base: BASE };
  else delete window.__SLOPSLIDE_REMOTE__;
  return import("./platform");
}

/** Records the EventSources the module opens and lets tests drive them. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  emit(event: string, payload: unknown) {
    this.onmessage?.({ data: JSON.stringify({ event, payload }) });
  }
}

const fetchMock = vi.fn();

beforeEach(() => {
  tauriInvoke.mockReset();
  tauriListen.mockReset();
  ask.mockReset();
  fetchMock.mockReset();
  FakeEventSource.last = null;
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  delete window.__SLOPSLIDE_REMOTE__;
  vi.unstubAllGlobals();
});

const reply = (status: number, body: string) => ({ ok: status < 400, status, text: async () => body });

describe("in the window", () => {
  it("runs commands over Tauri IPC, leaving out absent arguments", async () => {
    const platform = await load(false);
    expect(platform.isRemote).toBe(false);
    tauriInvoke.mockResolvedValue("x");
    await expect(platform.invoke("list_decks")).resolves.toBe("x");
    await platform.invoke("open_deck", { id: "talk" });
    expect(tauriInvoke.mock.calls).toEqual([["list_decks"], ["open_deck", { id: "talk" }]]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("listens to Tauri events and never needs to resync", async () => {
    const platform = await load(false);
    const stop = vi.fn();
    tauriListen.mockResolvedValue(stop);
    const handler = vi.fn();
    expect(await platform.listen("deck-changed", handler)).toBe(stop);
    expect(tauriListen).toHaveBeenCalledWith("deck-changed", handler);
    await platform.listen(platform.RESYNC_EVENT, handler);
    expect(tauriListen).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.last).toBeNull();
  });

  it("asks with the native dialog, falling back to the browser's", async () => {
    const platform = await load(false);
    ask.mockResolvedValue(true);
    await expect(platform.confirmDialog("Sure?", { title: "T" })).resolves.toBe(true);
    expect(ask).toHaveBeenCalledWith("Sure?", { title: "T" });
    ask.mockRejectedValue(new Error("no dialog plugin"));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await expect(platform.confirmDialog("Sure?", { title: "T" })).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledWith("Sure?");
  });
});

describe("on a device", () => {
  it("posts commands as JSON to the backend", async () => {
    const platform = await load(true);
    expect(platform.isRemote).toBe(true);
    fetchMock.mockResolvedValue(reply(200, '{"id":"talk"}'));
    await expect(platform.invoke("open_deck", { id: "talk" })).resolves.toEqual({ id: "talk" });
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/open_deck`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"id":"talk"}',
    });
    fetchMock.mockResolvedValue(reply(200, ""));
    await expect(platform.invoke("close_deck")).resolves.toBeUndefined();
    expect(fetchMock.mock.lastCall![1].body).toBe("{}");
    expect(tauriInvoke).not.toHaveBeenCalled();
  });

  it("rejects with the backend's message, like Tauri", async () => {
    const platform = await load(true);
    fetchMock.mockResolvedValue(reply(400, "deck not found: x"));
    await expect(platform.invoke("open_deck", { id: "x" })).rejects.toBe("deck not found: x");
    fetchMock.mockResolvedValue(reply(500, ""));
    await expect(platform.invoke("open_deck", { id: "x" })).rejects.toBe("open_deck failed (500)");
  });

  it("explains a stopped share and a lost connection", async () => {
    const platform = await load(true);
    fetchMock.mockResolvedValue(reply(404, ""));
    await expect(platform.invoke("list_decks")).rejects.toMatch(/stopped sharing/);
    fetchMock.mockRejectedValue(new TypeError("Load failed"));
    await expect(platform.invoke("list_decks")).rejects.toMatch(/Lost the connection/);
  });

  it("gets events from one server-sent event stream", async () => {
    const platform = await load(true);
    const changed = vi.fn();
    const agent = vi.fn();
    const stop = await platform.listen("deck-changed", changed);
    await platform.listen("agent-event", agent);
    const source = FakeEventSource.last!;
    expect(source.url).toBe(`${BASE}/events`);
    source.emit("deck-changed", { deckId: "talk", paths: ["deck.html"] });
    expect(changed).toHaveBeenCalledWith({ payload: { deckId: "talk", paths: ["deck.html"] } });
    expect(agent).not.toHaveBeenCalled();
    source.onmessage?.({ data: "not json" });
    stop();
    source.emit("deck-changed", {});
    expect(changed).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.last).toBe(source);
  });

  it("asks listeners to resync after reconnecting, not on the first connection", async () => {
    const platform = await load(true);
    const resync = vi.fn();
    await platform.listen(platform.RESYNC_EVENT, resync);
    const source = FakeEventSource.last!;
    source.onopen?.();
    expect(resync).not.toHaveBeenCalled();
    source.onerror?.();
    source.onopen?.();
    expect(resync).toHaveBeenCalledTimes(1);
    source.onopen?.();
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it("asks with the browser's dialog", async () => {
    const platform = await load(true);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await expect(platform.confirmDialog("Delete?", { title: "Delete deck" })).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith("Delete?");
    expect(ask).not.toHaveBeenCalled();
  });

  it("uploads files into the deck and links the export download", async () => {
    const platform = await load(true);
    fetchMock.mockResolvedValue(reply(200, '"assets/img-1.heic"'));
    const file = new File(["x"], "IMG 1.HEIC");
    await expect(platform.uploadAsset("my deck", file)).resolves.toBe("assets/img-1.heic");
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/upload/my%20deck?name=IMG%201.HEIC`, { method: "POST", body: file });
    fetchMock.mockResolvedValue(reply(400, "deck not found: x"));
    await expect(platform.uploadAsset("x", file)).rejects.toBe("deck not found: x");
    expect(platform.exportUrl("my deck")).toBe(`${BASE}/export/my%20deck`);
  });
});

describe("randomId", () => {
  it("makes UUIDs without crypto.randomUUID, which plain HTTP lacks", async () => {
    const platform = await load(true);
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const ids = new Set(Array.from({ length: 50 }, () => platform.randomId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("gives each client its own id", async () => {
    const first = (await load(false)).clientId;
    const second = (await load(false)).clientId;
    expect(first).not.toBe(second);
  });
});

describe("lockPageZoom", () => {
  it("turns off page zoom in the viewport and puts it back", async () => {
    const { DEVICE_VIEWPORT, lockPageZoom } = await import("./platform");
    const meta = document.createElement("meta");
    meta.name = "viewport";
    meta.content = "width=device-width, initial-scale=1.0";
    document.head.appendChild(meta);
    const unlock = lockPageZoom();
    expect(meta.content).toBe(DEVICE_VIEWPORT);
    expect(meta.content).toContain("maximum-scale=1");
    unlock();
    expect(meta.content).toBe("width=device-width, initial-scale=1.0");
    meta.remove();
  });

  it("adds a viewport when the page has none, and removes it again", async () => {
    const { lockPageZoom } = await import("./platform");
    const unlock = lockPageZoom();
    expect(document.querySelectorAll('meta[name="viewport"]')).toHaveLength(1);
    unlock();
    expect(document.querySelector('meta[name="viewport"]')).toBeNull();
  });

  it("cancels Safari's pinch gestures while locked", async () => {
    const { lockPageZoom } = await import("./platform");
    const pinch = () => {
      const event = new Event("gesturestart", { cancelable: true });
      document.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const unlock = lockPageZoom();
    expect(pinch()).toBe(true);
    unlock();
    expect(pinch()).toBe(false);
  });
});
