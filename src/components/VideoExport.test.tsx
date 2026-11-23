import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { VideoOptions } from "../lib/video";
import { useNarration } from "../narrationStore";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { invoke } from "../test/tauri";
import { VideoExportPanel } from "./VideoExport";

const DECK = deckFor(DECK_HTML);

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined);
  localStorage.removeItem("slopslide.video");
  useNarration.setState({ speech: null, audio: {}, audioDeck: null, render: null });
  useApp.setState({ deck: DECK, toasts: [] });
});

const onExport = vi.fn<(options: VideoOptions) => void>();
const onCancel = vi.fn<() => void>();

async function shown(slides = DECK.slides) {
  onExport.mockReset();
  onCancel.mockReset();
  render(<VideoExportPanel slides={slides} onExport={onExport} onCancel={onCancel} />);
  await act(async () => {});
}

const seconds = () => screen.getByRole("spinbutton", { name: "Seconds per slide" }) as HTMLInputElement;
const frameRate = () => screen.getByRole("combobox", { name: "Frame rate" }) as HTMLSelectElement;
const check = (name: string) => screen.getByRole("checkbox", { name });
const saveButton = () => screen.getByRole("button", { name: "Save video…" }) as HTMLButtonElement;

describe("VideoExportPanel", () => {
  it("names each of its fields, which start with what was picked last", async () => {
    await shown();
    expect(seconds().value).toBe("5");
    expect(seconds().type).toBe("number");
    expect(frameRate().value).toBe("30");
    expect([...frameRate().options].map((o) => o.textContent)).toContain("60 fps");
    expect(check("Play animations").getAttribute("aria-checked")).toBe("true");
    expect(check("Speak narration").getAttribute("aria-checked")).toBe("true");
    // Each checkbox says under its name what it does.
    expect(screen.getByText(/each slide is a still of its final frame/)).toBeTruthy();
    expect(screen.getByText("No shown slide has narration.")).toBeTruthy();
    expect(screen.getByText(/3 slides, 0:15 long/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("exports with what is picked, from the button and on Enter in a field", async () => {
    await shown();
    fireEvent.change(seconds(), { target: { value: "2" } });
    fireEvent.change(frameRate(), { target: { value: "60" } });
    fireEvent.click(check("Play animations"));
    expect(check("Play animations").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(saveButton());
    const picked = { secondsPerSlide: 2, fps: 60, animate: false, narration: true, pauseBefore: 0.5, pauseAfter: 1 };
    expect(onExport).toHaveBeenCalledWith(picked);
    fireEvent.submit(seconds().closest("form")!);
    expect(onExport).toHaveBeenCalledTimes(2);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("turns a checkbox by a press on its name, and with the space bar", async () => {
    await shown();
    fireEvent.click(screen.getByText("Speak narration"));
    expect(check("Speak narration").getAttribute("aria-checked")).toBe("false");
    check("Speak narration").focus();
    fireEvent.keyDown(check("Speak narration"), { key: " " });
    fireEvent.keyUp(check("Speak narration"), { key: " " });
    expect(check("Speak narration").getAttribute("aria-checked")).toBe("true");
  });

  it("says what is wrong in place of the summary, and does not export then", async () => {
    await shown();
    fireEvent.change(seconds(), { target: { value: "0" } });
    expect(screen.getByRole("alert").textContent).toMatch(/0.5 to 600 seconds/);
    expect(screen.queryByText(/slides, .* long/)).toBeNull();
    expect(saveButton().disabled).toBe(true);
    fireEvent.submit(seconds().closest("form")!);
    expect(onExport).not.toHaveBeenCalled();
  });

  it("cancels from its button, exporting nothing", async () => {
    await shown();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onExport).not.toHaveBeenCalled();
  });

  it("asks for the pauses around the narration only while it is spoken", async () => {
    const slides = DECK.slides.map((s, i) => ({ ...s, narration: i === 0 ? "Hello there." : "" }));
    useNarration.setState({
      audioDeck: DECK.id,
      audio: { [slides[0]!.id]: { slide: slides[0]!.id, state: "ready", seconds: 20 } },
    });
    await shown(slides);
    // The seconds are then for the slides that have no narration.
    expect(screen.getByRole("spinbutton", { name: "Seconds per slide without narration" })).toBeTruthy();
    const before = screen.getByRole("spinbutton", { name: "Pause before narration" }) as HTMLInputElement;
    expect(before.value).toBe("0.5");
    expect(screen.getByText("Pause before (s)")).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "Pause after narration" })).toBeTruthy();
    fireEvent.click(check("Speak narration"));
    expect(screen.queryByRole("spinbutton", { name: "Pause before narration" })).toBeNull();
    expect(seconds()).toBeTruthy();
  });
});
