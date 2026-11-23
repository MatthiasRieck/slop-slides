import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import "../test/tauri";
import { type NarrationRecorder, RecordingStatus } from "./NarrationRecorder";
import { type Listener, TeleprompterNotice } from "./Teleprompter";

const MB = 1e6;

function listener(change: Partial<Listener> = {}): Listener {
  return {
    phase: "off",
    modelBytes: 150 * MB,
    progress: null,
    error: null,
    download: vi.fn(async () => {}),
    decline: vi.fn(),
    ...change,
  };
}

describe("TeleprompterNotice", () => {
  it("says nothing while there is nothing to say", () => {
    const { container } = render(<TeleprompterNotice teleprompter={listener()} />);
    expect(container.textContent).toBe("");
  });

  it("says what went wrong, as an alert", () => {
    render(<TeleprompterNotice teleprompter={listener({ phase: "offer", error: "The microphone is silent." })} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("The microphone is silent.");
    expect(alert.dataset.slot).toBe("alert");
    // The failure, not the offer it came from.
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  });

  it("offers the speech model on first use, saying what it is for and how large it is", () => {
    const teleprompter = listener({ phase: "offer" });
    render(<TeleprompterNotice teleprompter={teleprompter} purpose="What you say is transcribed." />);
    expect(screen.getByText("Download the speech model?")).toBeTruthy();
    expect(screen.getByText(/^What you say is transcribed\. The model \(.+\) is downloaded once/)).toBeTruthy();
    // An offer is no alert: nothing went wrong.
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(teleprompter.decline).toHaveBeenCalledOnce();
    expect(teleprompter.download).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(teleprompter.download).toHaveBeenCalledOnce();
  });

  it("its buttons leave the focus where it was, so Space still advances the slide", () => {
    render(<TeleprompterNotice teleprompter={listener({ phase: "offer" })} />);
    for (const name of ["Not now", "Download"]) {
      const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      screen.getByRole("button", { name }).dispatchEvent(down);
      expect(down.defaultPrevented).toBe(true);
    }
  });

  it("shows that the model downloads before the download says how far it is", () => {
    render(<TeleprompterNotice teleprompter={listener({ phase: "downloading" })} />);
    const bar = screen.getByRole("progressbar", { name: "Downloading the speech model…" });
    // Not known yet: the bar runs without a value.
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(screen.queryByTestId("download-progress")).toBeNull();
  });

  it("shows how much of the model is here, in bytes and as a bar", () => {
    const progress = { received: 30 * MB, total: 120 * MB };
    render(<TeleprompterNotice teleprompter={listener({ phase: "downloading", progress })} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
    expect(screen.getByTestId("download-progress").textContent).toBe("30 MB of 120 MB");
  });

  it("fills the bar at most, and runs it without a value for a download of unknown size", () => {
    const { rerender } = render(
      <TeleprompterNotice teleprompter={listener({ phase: "downloading", progress: { received: 9, total: 3 } })} />,
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
    rerender(
      <TeleprompterNotice teleprompter={listener({ phase: "downloading", progress: { received: 9, total: 0 } })} />,
    );
    expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false);
  });
});

describe("RecordingStatus", () => {
  const recorder = (change: Partial<NarrationRecorder>) =>
    ({ phase: "off", mode: "text", since: null, ...change }) as NarrationRecorder;

  it("says nothing unless it records or saves", () => {
    const { container } = render(<RecordingStatus recorder={recorder({})} locked={false} />);
    expect(container.textContent).toBe("");
  });

  it("says that the recording is being saved, once", () => {
    render(<RecordingStatus recorder={recorder({ phase: "saving" })} locked={false} />);
    // The spinner beside the words is not a second status.
    expect(screen.getByRole("status").textContent).toBe("Saving the recording…");
    expect(screen.getByRole("status").querySelector("[data-slot=spinner]")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("says what is recorded, for how long, and when the slide keeps none of it", () => {
    const since = Date.now() - 65_000;
    const { rerender } = render(
      <RecordingStatus recorder={recorder({ phase: "recording", mode: "audio", since })} locked={false} />,
    );
    expect(screen.getByRole("status").textContent).toMatch(/^Recording audio: .*1:05$/);
    expect(screen.getByTestId("recording-level")).toBeTruthy();
    rerender(<RecordingStatus recorder={recorder({ phase: "recording", mode: "text", since })} locked={false} />);
    expect(screen.getByRole("status").textContent).toMatch(/^Recording text: /);
    rerender(<RecordingStatus recorder={recorder({ phase: "recording", mode: "text", since })} locked />);
    expect(screen.getByRole("status").textContent).toMatch(/^This slide is locked/);
  });
});
