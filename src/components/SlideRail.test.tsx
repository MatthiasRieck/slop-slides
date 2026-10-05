import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { SlideRail } from "./SlideRail";

const HIDDEN_HTML = DECK_HTML.replace(`id="outro"`, `id="outro" data-hidden`);

const items = () => [...document.querySelectorAll("li")];
const thumbnail = (item: HTMLElement) => item.querySelector("button > div") as HTMLElement;

beforeEach(() => {
  invoke.mockReset();
  useApp.setState({ deck: deckFor(HIDDEN_HTML), selected: "intro", error: null });
});

describe("hidden slides in the rail", () => {
  it("mutes hidden slides and strikes them through", () => {
    render(<SlideRail />);
    const [intro, , outro] = items() as [HTMLLIElement, HTMLLIElement, HTMLLIElement];
    expect(thumbnail(outro).className).toMatch(/opacity-35/);
    expect(thumbnail(outro).className).toMatch(/grayscale/);
    expect(within(outro).getByTestId("hidden-mark")).toBeTruthy();
    expect(within(outro).getByText("3").className).toMatch(/line-through/);

    expect(thumbnail(intro).className).not.toMatch(/opacity-35/);
    expect(within(intro).queryByTestId("hidden-mark")).toBeNull();
  });

  it("still renders hidden slides in place, keeping their number", () => {
    render(<SlideRail />);
    expect(items()).toHaveLength(3);
    expect(screen.getByText("Slides · 3")).toBeTruthy();
    expect(items().map((item) => item.querySelector("span")?.textContent)).toEqual(["1", "2", "3"]);
    expect(thumbnail(items()[2]!)).toBeTruthy();
  });

  it("hides a shown slide", async () => {
    const next = deckFor(HIDDEN_HTML.replace(`id="intro"`, `id="intro" data-hidden`), "2");
    invoke.mockResolvedValue(next);
    render(<SlideRail />);
    await act(async () => fireEvent.click(within(items()[0]!).getByTitle("Hide slide")));
    expect(invoke).toHaveBeenCalledWith("set_slide_hidden", { id: "talk", slide: "intro", hidden: true });
    expect(useApp.getState().deck).toBe(next);
    expect(within(items()[0]!).getByTestId("hidden-mark")).toBeTruthy();
  });

  it("shows a hidden slide again", async () => {
    invoke.mockResolvedValue(deckFor(DECK_HTML, "2"));
    render(<SlideRail />);
    await act(async () => fireEvent.click(within(items()[2]!).getByTitle("Show slide")));
    expect(invoke).toHaveBeenCalledWith("set_slide_hidden", { id: "talk", slide: "outro", hidden: false });
    expect(screen.queryByTestId("hidden-mark")).toBeNull();
  });

  it("reports a failed toggle", async () => {
    invoke.mockRejectedValue("disk full");
    render(<SlideRail />);
    await act(async () => fireEvent.click(within(items()[0]!).getByTitle("Hide slide")));
    expect(useApp.getState().error).toBe("disk full");
    expect(useApp.getState().deck?.slides[0]?.hidden).toBe(false);
  });
});
