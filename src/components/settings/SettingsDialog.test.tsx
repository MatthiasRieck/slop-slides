import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "1.2.3") }));

import { openSettings, useApp } from "../../store";
import { invoke } from "../../test/tauri";
import { SettingsDialog } from "./SettingsDialog";

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined);
  useApp.setState({ settingsSection: null, presenting: false, toasts: [] });
});

const dialog = () => screen.queryByRole("dialog", { name: "Settings" });
const tab = (name: string) => screen.getByRole("tab", { name });
const selected = () => screen.getAllByRole("tab").filter((t) => t.getAttribute("aria-selected") === "true");
/** The name over the section shown. */
const shown = () => screen.getByRole("heading", { level: 3 }).textContent;

describe("SettingsDialog", () => {
  it("is not there until the settings are opened, then opens on General", () => {
    render(<SettingsDialog />);
    expect(dialog()).toBeNull();
    act(() => openSettings());
    expect(dialog()).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Settings" })).toBeTruthy();
    expect(shown()).toBe("General");
    expect(selected()).toEqual([tab("General")]);
    expect(screen.getByRole("radiogroup", { name: "Appearance" })).toBeTruthy();
  });

  it("lists its sections in order: General, Providers, Keyboard shortcuts, About", () => {
    useApp.setState({ settingsSection: "general" });
    render(<SettingsDialog />);
    const list = screen.getByRole("tablist", { name: "Settings" });
    expect(list.getAttribute("aria-orientation")).toBe("vertical");
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "General",
      "Providers",
      "Keyboard shortcuts",
      "About",
    ]);
  });

  it.each([
    ["general", "General"],
    ["providers", "Providers"],
    ["keyboard", "Keyboard shortcuts"],
    ["about", "About"],
  ] as const)("opens on the section asked for: %s", (section, name) => {
    render(<SettingsDialog />);
    act(() => openSettings(section));
    expect(shown()).toBe(name);
    expect(selected()).toEqual([tab(name)]);
    const pane = screen.getByRole("tabpanel");
    expect(pane.getAttribute("aria-labelledby")).toBe(tab(name).id);
    expect(tab(name).getAttribute("aria-controls")).toBe(pane.id);
  });

  it("shows each section's own contents", async () => {
    useApp.setState({ settingsSection: "providers" });
    render(<SettingsDialog />);
    expect(screen.getByTestId("providers-section")).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    fireEvent.click(tab("Keyboard shortcuts"));
    expect(screen.getByRole("searchbox", { name: "Filter shortcuts" })).toBeTruthy();
    expect(screen.queryByTestId("providers-section")).toBeNull();
    fireEvent.click(tab("About"));
    expect((await screen.findByTestId("app-version")).textContent).toBe("SlopSlide 1.2.3");
    fireEvent.click(tab("General"));
    expect(screen.getByRole("radio", { name: "Ask each time" })).toBeTruthy();
  });

  it("goes to the section picked on the left", () => {
    useApp.setState({ settingsSection: "general" });
    render(<SettingsDialog />);
    fireEvent.click(tab("About"));
    expect(useApp.getState().settingsSection).toBe("about");
    expect(shown()).toBe("About");
    expect(selected()).toEqual([tab("About")]);
  });

  it("goes through the sections with the arrow keys, Tab stopping at the one shown only", () => {
    useApp.setState({ settingsSection: "providers" });
    render(<SettingsDialog />);
    expect(screen.getAllByRole("tab").map((t) => t.tabIndex)).toEqual([-1, 0, -1, -1]);
    // The focus starts on the section shown.
    expect(document.activeElement).toBe(tab("Providers"));
    fireEvent.keyDown(tab("Providers"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(tab("Keyboard shortcuts"));
    fireEvent.keyDown(tab("Keyboard shortcuts"), { key: "ArrowUp" });
    fireEvent.keyDown(tab("Providers"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(tab("General"));
    fireEvent.keyDown(tab("General"), { key: "End" });
    expect(document.activeElement).toBe(tab("About"));
    // The arrows move the focus; Enter (a press of the button) picks.
    expect(useApp.getState().settingsSection).toBe("providers");
    fireEvent.click(tab("About"));
    expect(useApp.getState().settingsSection).toBe("about");
  });

  it("starts in the filter box when opened on the keyboard shortcuts, so typing filters at once", () => {
    useApp.setState({ settingsSection: "keyboard" });
    render(<SettingsDialog />);
    expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Filter shortcuts" }));
  });

  it("closes on Escape and from the close button, and gives focus back", () => {
    render(
      <>
        <button type="button">Before</button>
        <SettingsDialog />
      </>,
    );
    const before = screen.getByText("Before");
    const open = () => {
      before.focus();
      act(() => openSettings());
      expect(dialog()!.contains(document.activeElement)).toBe(true);
    };
    const closed = () => {
      expect(dialog()).toBeNull();
      expect(useApp.getState().settingsSection).toBeNull();
      expect(document.activeElement).toBe(before);
    };
    open();
    fireEvent.keyDown(dialog()!, { key: "Escape" });
    closed();
    open();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    closed();
  });

  it("stays open when the backdrop is pressed, and on ? pressed in it", () => {
    useApp.setState({ settingsSection: "general" });
    render(<SettingsDialog />);
    fireEvent.pointerDown(screen.getByTestId("settings-backdrop"));
    fireEvent.click(screen.getByTestId("settings-backdrop"));
    fireEvent.keyDown(dialog()!, { key: "?" });
    expect(dialog()).toBeTruthy();
    expect(useApp.getState().settingsSection).toBe("general");
  });

  it("keeps keys pressed in it from the app under it", () => {
    useApp.setState({ settingsSection: "general" });
    render(<SettingsDialog />);
    let reached = false;
    const listen = () => {
      reached = true;
    };
    window.addEventListener("keydown", listen);
    fireEvent.keyDown(dialog()!, { key: "ArrowRight" });
    fireEvent.keyDown(dialog()!, { key: ",", ctrlKey: true });
    window.removeEventListener("keydown", listen);
    expect(reached).toBe(false);
  });
});
