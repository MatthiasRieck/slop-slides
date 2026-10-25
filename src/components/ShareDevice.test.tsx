import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

import type { RemoteInfo } from "../lib/api";
import { ShareDevice, STATUS_POLL_MS } from "./ShareDevice";

const INFO: RemoteInfo = {
  url: "http://192.168.1.20:47419/s/tok/",
  qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',
  devices: 0,
};

/** Answers the sharing commands; `status` is what `remote_status` reports. */
function backend(status: RemoteInfo | null, start: () => RemoteInfo = () => INFO) {
  let current = status;
  invoke.mockImplementation(async (command: string) => {
    if (command === "remote_status") return current;
    if (command === "remote_start") return (current = start());
    if (command === "remote_stop") current = null;
    return undefined;
  });
  return { connect: (devices: number) => current && (current = { ...current, devices }) };
}

const calls = (command: string) => invoke.mock.calls.filter(([c]) => c === command);
const button = () => screen.getByRole("button", { name: "Use on another device" });

beforeEach(() => {
  invoke.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ShareDevice", () => {
  it("shows whether the app is shared", async () => {
    backend(INFO);
    render(<ShareDevice />);
    await vi.waitFor(() => expect(button().getAttribute("aria-pressed")).toBe("true"));
    expect(calls("remote_start")).toHaveLength(0);
  });

  it("starts sharing when opened and shows the QR code and address", async () => {
    backend(null);
    render(<ShareDevice />);
    await vi.waitFor(() => expect(calls("remote_status")).toHaveLength(1));
    expect(button().getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button());
    const qr = await screen.findByTestId("share-qr");
    expect(qr.querySelector("svg")).toBeTruthy();
    expect(screen.getByText(INFO.url)).toBeTruthy();
    expect(screen.getByText(/No device connected yet/)).toBeTruthy();
    expect(screen.getByText(/only share it on networks you trust/)).toBeTruthy();
    expect(calls("remote_start")).toHaveLength(1);
    expect(button().getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the number of connected devices current while open", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const server = backend(INFO);
    render(<ShareDevice />);
    fireEvent.click(button());
    await screen.findByTestId("share-qr");
    server.connect(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    });
    expect(screen.getByText(/2 devices connected/)).toBeTruthy();
    server.connect(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    });
    expect(screen.getByText(/1 device connected/)).toBeTruthy();
  });

  it("stops sharing, and can share again", async () => {
    backend(INFO);
    render(<ShareDevice />);
    await vi.waitFor(() => expect(button().getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(button());
    await screen.findByTestId("share-qr");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop sharing" })));
    expect(calls("remote_stop")).toHaveLength(1);
    expect(screen.getByText(/Sharing is off/)).toBeTruthy();
    expect(screen.queryByTestId("share-qr")).toBeNull();
    expect(button().getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Share again" }));
    await screen.findByTestId("share-qr");
    expect(calls("remote_start")).toHaveLength(1);
  });

  it("shows why sharing failed and lets the user retry", async () => {
    let fail = true;
    backend(null, () => {
      if (fail) throw "No network to share the app on: no interface";
      return INFO;
    });
    render(<ShareDevice />);
    fireEvent.click(button());
    expect(await screen.findByText(/No network to share the app on/)).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByTestId("share-qr");
  });

  it("closes with Escape or the close button; sharing goes on", async () => {
    backend(INFO);
    render(<ShareDevice />);
    fireEvent.click(button());
    await screen.findByTestId("share-qr");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(button());
    await screen.findByTestId("share-qr");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls("remote_stop")).toHaveLength(0);
  });
});

describe("ShareDevice on a device", () => {
  afterEach(() => {
    delete window.__SLOPSLIDE_REMOTE__;
  });

  it("is not offered: a device cannot share the app further", async () => {
    window.__SLOPSLIDE_REMOTE__ = { base: "/s/tok" };
    vi.resetModules();
    const { ShareDevice: OnDevice } = await import("./ShareDevice");
    const { container } = render(<OnDevice />);
    expect(container.innerHTML).toBe("");
  });
});
