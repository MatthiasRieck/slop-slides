import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const listeners = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  }),
}));

import { useApp } from "../store";
import { fakeCanvas2D } from "../test/fakeCanvas";
import { VoiceInput, type VoiceInputHandle } from "./VoiceInput";

const handlers = () => ({ onStart: vi.fn(), onPartial: vi.fn(), onEnd: vi.fn() });

const MODEL_BYTES = 190_085_487;

/** Answers voice commands like the backend would; `ready` says whether the model is there. */
function backend(options: { ready: boolean; transcript?: string; startError?: string }) {
  let ready = options.ready;
  let finishDownload: () => void = () => {};
  invoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "voice_status":
        return { modelReady: ready, modelBytes: MODEL_BYTES, downloading: false, recording: false };
      case "download_voice_model":
        return new Promise<void>((resolve) => {
          finishDownload = () => {
            ready = true;
            resolve();
          };
        });
      case "start_recording":
        if (options.startError) throw options.startError;
        return undefined;
      case "stop_recording":
        return options.transcript ?? "";
      default:
        return undefined;
    }
  });
  return { finishDownload: () => finishDownload() };
}

const commands = () => invoke.mock.calls.map(([cmd]) => cmd);
const micButton = () => screen.getByRole("button", { name: /dictat|downloading|starting|transcribing/i });

beforeEach(() => {
  invoke.mockReset();
  listeners.clear();
  useApp.setState({ error: null });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("VoiceInput", () => {
  it("records when the model is downloaded and hands over the transcript on stop", async () => {
    backend({ ready: true, transcript: "Make the title bigger." });
    const h = handlers();
    render(<VoiceInput {...h} />);

    fireEvent.click(micButton());
    await waitFor(() => expect(micButton().getAttribute("aria-pressed")).toBe("true"));
    expect(commands()).toEqual(["voice_status", "start_recording"]);
    expect(h.onStart).toHaveBeenCalledOnce();

    fireEvent.click(micButton());
    await waitFor(() => expect(h.onEnd).toHaveBeenCalledWith("Make the title bigger.", false));
    expect(commands()).toContain("stop_recording");
    expect(micButton().getAttribute("aria-pressed")).toBe("false");
  });

  it("passes on the live transcript while recording", async () => {
    backend({ ready: true });
    const h = handlers();
    render(<VoiceInput {...h} />);
    fireEvent.click(micButton());
    await waitFor(() => expect(listeners.has("voice-partial")).toBe(true));
    act(() => listeners.get("voice-partial")!({ payload: "Make the" }));
    act(() => listeners.get("voice-partial")!({ payload: "Make the title bigger" }));
    expect(h.onPartial.mock.calls).toEqual([["Make the"], ["Make the title bigger"]]);
    expect(h.onEnd).not.toHaveBeenCalled();
  });

  it("shows the input level while recording", async () => {
    backend({ ready: true });
    render(<VoiceInput {...handlers()} />);
    fireEvent.click(micButton());
    await waitFor(() => expect(listeners.has("voice-level")).toBe(true));
    act(() => listeners.get("voice-level")!({ payload: 1 }));
    expect(screen.getByTestId("voice-level").style.transform).toBe("scale(1.35)");
  });

  it("ends with no text when nothing was said", async () => {
    backend({ ready: true, transcript: "" });
    const h = handlers();
    render(<VoiceInput {...h} />);
    fireEvent.click(micButton());
    await waitFor(() => expect(micButton().getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(micButton());
    await waitFor(() => expect(commands()).toContain("stop_recording"));
    await waitFor(() => expect((micButton() as HTMLButtonElement).disabled).toBe(false));
    expect(h.onEnd).toHaveBeenCalledWith("", false);
  });

  it("discards the recording on Escape", async () => {
    backend({ ready: true, transcript: "never used" });
    const h = handlers();
    render(<VoiceInput {...h} />);
    fireEvent.click(micButton());
    await waitFor(() => expect(micButton().getAttribute("aria-pressed")).toBe("true"));
    // The Escape handler is attached in the same effect flush as the recording listeners,
    // which can land after the commit that shows the pressed button.
    await waitFor(() => expect(listeners.has("voice-partial")).toBe(true));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(commands()).toContain("cancel_recording");
    expect(commands()).not.toContain("stop_recording");
    expect(micButton().getAttribute("aria-pressed")).toBe("false");
    expect(h.onEnd).toHaveBeenCalledWith("", false);
  });

  it("shows a waveform only while dictating", async () => {
    backend({ ready: true, transcript: "Done." });
    const h = handlers();
    render(<VoiceInput {...h} />);
    expect(screen.queryByTestId("voice-waveform")).toBeNull();
    fireEvent.click(micButton());
    await waitFor(() => expect(screen.queryByTestId("voice-waveform")).not.toBeNull());
    fireEvent.click(micButton());
    await waitFor(() => expect(h.onEnd).toHaveBeenCalled());
    expect(screen.queryByTestId("voice-waveform")).toBeNull();
  });

  it("draws the level as bars that build up over time", async () => {
    const ctx = fakeCanvas2D();
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(ctx as unknown as RenderingContext);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(24);
    vi.spyOn(performance, "now").mockReturnValue(0);
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    backend({ ready: true });
    render(<VoiceInput {...handlers()} />);
    fireEvent.click(micButton());
    await waitFor(() => expect(listeners.has("voice-level")).toBe(true));

    act(() => listeners.get("voice-level")!({ payload: 0.5 }));
    frame(180);
    expect(ctx.strokes).toHaveLength(3);
  });

  it("stops recording and asks for the text to be sent", async () => {
    backend({ ready: true, transcript: "Ship it." });
    const h = handlers();
    const voice = createRef<VoiceInputHandle>();
    render(<VoiceInput ref={voice} {...h} />);
    fireEvent.click(micButton());
    await waitFor(() => expect(micButton().getAttribute("aria-pressed")).toBe("true"));
    act(() => voice.current!.finishAndSend());
    await waitFor(() => expect(h.onEnd).toHaveBeenCalledWith("Ship it.", true));
    expect(commands().filter((c) => c === "stop_recording")).toHaveLength(1);
  });

  it("sends once the transcription that is already running finishes", async () => {
    let finish: (text: string) => void = () => {};
    backend({ ready: true });
    const answer = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "stop_recording" ? new Promise<string>((resolve) => (finish = resolve)) : answer(cmd),
    );
    const h = handlers();
    const voice = createRef<VoiceInputHandle>();
    render(<VoiceInput ref={voice} {...h} />);
    fireEvent.click(micButton());
    await waitFor(() => expect(micButton().getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(micButton());
    await waitFor(() => expect(commands()).toContain("stop_recording"));
    act(() => voice.current!.finishAndSend());
    await act(async () => finish("Late."));
    expect(h.onEnd).toHaveBeenCalledWith("Late.", true);
    expect(commands().filter((c) => c === "stop_recording")).toHaveLength(1);
  });

  it("doesn't send when transcribing fails", async () => {
    backend({ ready: true });
    const answer = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "stop_recording") throw "Transcription failed.";
      return answer(cmd);
    });
    const h = handlers();
    const voice = createRef<VoiceInputHandle>();
    render(<VoiceInput ref={voice} {...h} />);
    fireEvent.click(micButton());
    await waitFor(() => expect(micButton().getAttribute("aria-pressed")).toBe("true"));
    act(() => voice.current!.finishAndSend());
    await waitFor(() => expect(useApp.getState().error).toBe("Transcription failed."));
    expect(h.onEnd).toHaveBeenCalledWith("", false);
  });

  it("releases the microphone when it goes away mid-recording", async () => {
    backend({ ready: true });
    const { unmount } = render(<VoiceInput {...handlers()} />);
    fireEvent.click(micButton());
    await waitFor(() => expect(micButton().getAttribute("aria-pressed")).toBe("true"));
    unmount();
    expect(commands()).toContain("cancel_recording");
  });

  it("offers to download the model first, shows progress, then starts recording", async () => {
    const server = backend({ ready: false });
    render(<VoiceInput {...handlers()} />);

    fireEvent.click(micButton());
    expect(await screen.findByText("Download the speech model?")).toBeTruthy();
    expect(screen.getByText(/190 MB/)).toBeTruthy();
    expect(screen.getByText(/~\/\.slopslides\/models/)).toBeTruthy();
    expect(commands()).not.toContain("download_voice_model");

    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(listeners.has("voice-download")).toBe(true));
    act(() => listeners.get("voice-download")!({ payload: { received: MODEL_BYTES / 2, total: MODEL_BYTES } }));
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
    expect(screen.getByText("95 MB of 190 MB")).toBeTruthy();

    await act(async () => server.finishDownload());
    await waitFor(() => expect(micButton().getAttribute("aria-pressed")).toBe("true"));
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(commands()).toEqual(["voice_status", "download_voice_model", "start_recording"]);
  });

  it("downloads nothing when the offer is declined", async () => {
    backend({ ready: false });
    render(<VoiceInput {...handlers()} />);
    fireEvent.click(micButton());
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByText("Download the speech model?")).toBeNull();
    expect(commands()).toEqual(["voice_status"]);
  });

  it("reports a microphone that cannot be opened", async () => {
    backend({ ready: true, startError: "No microphone found." });
    render(<VoiceInput {...handlers()} />);
    fireEvent.click(micButton());
    await waitFor(() => expect(useApp.getState().error).toBe("No microphone found."));
    expect(micButton().getAttribute("aria-pressed")).toBe("false");
    expect((micButton() as HTMLButtonElement).disabled).toBe(false);
  });
});
