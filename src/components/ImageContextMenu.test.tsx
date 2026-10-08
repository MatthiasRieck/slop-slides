import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JSDOM } from "jsdom";
import IMAGE_MENU from "../../src-tauri/assets/image-menu.js?raw";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, save, openUrl } = vi.hoisted(() => ({
  invoke: vi.fn(), save: vi.fn(), openUrl: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save, ask: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { ImageContextMenu } from "./ImageContextMenu";

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  invoke.mockResolvedValue(undefined);
  save.mockResolvedValue("/downloads/photo.png");
  useApp.setState({ deck: deckFor(DECK_HTML), error: null });
});

function setup() {
  const result = render(<><iframe src="/__deck/talk/deck.html?show" /><ImageContextMenu /></>);
  const frame = result.container.querySelector("iframe")!;
  const message = (src = "http://localhost:3000/__deck/talk/assets/caf%C3%A9%20%231.png?v=2", source: MessageEventSource | null = frame.contentWindow) =>
    act(() => window.dispatchEvent(new MessageEvent("message", { source, data: { type: "slop:image-menu", src } })));
  return { ...result, message, frame };
}

// Use the test page's origin, which also serves the browser-preview deck.
async function menuFor(src = new URL("/__deck/talk/assets/caf%C3%A9%20%231.png?v=2", location.href).href) {
  const result = setup();
  result.message(src);
  expect(screen.getByRole("menu", { name: "Image actions" })).toBeTruthy();
  return result;
}

describe("image context menu", () => {
  it.each([
    ["Download image…", "save_deck_image"],
    ["Open image in another window", "open_deck_image"],
  ])("routes a real iframe right-click and pointer selection of %s to native IPC", async (label, command) => {
    const { frame } = setup();
    const slide = new JSDOM('<img src="assets/photo.png">', {
      url: frame.src,
      runScripts: "outside-only",
    });
    try {
      // Deliver the sandbox message through the host's actual message listener.
      Object.defineProperty(slide.window, "parent", { value: {
        postMessage: (data: unknown) => window.dispatchEvent(new MessageEvent("message", {
          source: frame.contentWindow, data,
        })),
      } });
      slide.window.eval(IMAGE_MENU);
      const contextMenu = new slide.window.MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, clientX: 200, clientY: 100,
      });
      act(() => { slide.window.document.querySelector("img")!.dispatchEvent(contextMenu); });
      expect(contextMenu.defaultPrevented).toBe(true);
      // Includes pointerdown/up; a plain fireEvent.click would miss backdrop interception.
      await userEvent.click(screen.getByRole("menuitem", { name: label }));
      await waitFor(() => expect(invoke).toHaveBeenCalledWith(command, {
        id: "talk", source: "assets/photo.png",
        ...(command === "save_deck_image" ? { dest: "/downloads/photo.png" } : {}),
      }));
      expect(screen.queryByRole("menu")).toBeNull();
      expect(invoke).toHaveBeenCalledTimes(1);
    } finally {
      slide.window.close();
    }
  });
  it("saves the original deck asset and opens it through native file handling", async () => {
    await menuFor();
    fireEvent.click(screen.getByRole("menuitem", { name: "Download image…" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("save_deck_image", { id: "talk", source: "assets/café #1.png", dest: "/downloads/photo.png" }));
    act(() => window.dispatchEvent(new MessageEvent("message", {
      source: document.querySelector("iframe")!.contentWindow,
      data: { type: "slop:image-menu", src: new URL("/__deck/talk/assets/caf%C3%A9%20%231.png", location.href).href },
    })));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open image in another window" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_deck_image", { id: "talk", source: "assets/café #1.png" }));
  });
  it("does nothing when the save dialog is canceled", async () => {
    save.mockResolvedValueOnce(null);
    await menuFor();
    fireEvent.click(screen.getByRole("menuitem", { name: "Download image…" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(invoke).not.toHaveBeenCalled();
  });
  it("opens remote images with the system browser", async () => {
    await menuFor("https://example.com/photo.jpg");
    fireEvent.click(screen.getByRole("menuitem", { name: "Open image in another window" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://example.com/photo.jpg"));
  });
  it("downloads remote image bytes before saving them", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => new Blob(["hi"], { type: "image/png" }) })));
    await menuFor("https://example.com/photo.png");
    fireEvent.click(screen.getByRole("menuitem", { name: "Download image…" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("save_deck_image", { id: "talk", source: "data:image/png;base64,aGk=", dest: "/downloads/photo.png" }));
  });
  it("reports a failed remote download", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
    await menuFor("https://example.com/photo.png");
    fireEvent.click(screen.getByRole("menuitem", { name: "Download image…" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(useApp.getState().error).toContain("Image download failed (404)"));
    expect(invoke).not.toHaveBeenCalled();
  });
  it("sends embedded image data to the native image handler", async () => {
    await menuFor("data:image/png;base64,aGk=");
    fireEvent.click(screen.getByRole("menuitem", { name: "Open image in another window" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_deck_image", { id: "talk", source: "data:image/png;base64,aGk=" }));
  });
  it("reports action errors instead of failing silently", async () => {
    await menuFor();
    invoke.mockRejectedValueOnce("Image no longer exists");
    fireEvent.click(screen.getByRole("menuitem", { name: "Open image in another window" }));
    await waitFor(() => expect(useApp.getState().error).toContain("Image no longer exists"));
  });
  it("ignores messages from other windows and decks", () => {
    const { message, frame } = setup();
    message(undefined, window);
    frame.src = "/__deck/other/deck.html?show";
    message();
    expect(screen.queryByRole("menu")).toBeNull();
  });
  it("opens the currently clicked image after the menu is dismissed and reopened", async () => {
    const { message } = await menuFor();
    fireEvent.pointerDown(screen.getByTestId("image-menu-backdrop"));
    expect(screen.queryByRole("menu")).toBeNull();
    message(new URL("/__deck/talk/assets/second.png", location.href).href);
    fireEvent.click(screen.getByRole("menuitem", { name: "Open image in another window" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_deck_image", { id: "talk", source: "assets/second.png" }));
  });
  it("supports keyboard selection and dismissal without forwarding keys to the presenter", async () => {
    await menuFor();
    const download = screen.getByRole("menuitem", { name: "Download image…" });
    const open = screen.getByRole("menuitem", { name: "Open image in another window" });
    expect(document.activeElement).toBe(download);
    fireEvent.keyDown(download, { key: "ArrowDown" });
    expect(document.activeElement).toBe(open);
    fireEvent.keyDown(open, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
  it("positions the menu at the image click in a scaled iframe", () => {
    const { frame } = setup();
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({ left: 100, top: 100, width: 960, height: 540 } as DOMRect);
    Object.defineProperty(frame, "clientWidth", { value: 1920 });
    Object.defineProperty(frame, "clientHeight", { value: 1080 });
    act(() => window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      data: { type: "slop:image-menu", src: new URL("/__deck/talk/assets/photo.png", location.href).href, x: 200, y: 100 },
    })));
    expect(screen.getByRole("menu").style.left).toBe("200px");
    expect(screen.getByRole("menu").style.top).toBe("150px");
  });
});
