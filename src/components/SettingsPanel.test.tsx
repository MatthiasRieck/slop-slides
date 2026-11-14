import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getVersion = vi.hoisted(() => vi.fn<() => Promise<string>>());
vi.mock("@tauri-apps/api/app", () => ({ getVersion }));

import { APPEARANCE_KEY, TEXT_SIZE_KEY } from "../lib/theme";
import { REWIND_KEY, useApp } from "../store";
import { lastError } from "../store/errors";
import { invoke, revealItemInDir } from "../test/tauri";
import { AppSettings } from "./AppSettings";
import { SettingsPanel } from "./SettingsPanel";

beforeEach(() => {
  localStorage.clear();
  invoke.mockReset();
  getVersion.mockReset().mockRejectedValue("no app");
  useApp.setState({ toasts: [] });
});

const radio = (name: string) => screen.getByRole("radio", { name }) as HTMLInputElement;
/** Shows the section `name` from the list on the left. */
const section = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));

describe("SettingsPanel", () => {
  it("shows its sections in a list, Appearance first, one at a time", () => {
    render(<SettingsPanel />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Appearance", "Chat", "Library", "About"]);
    expect(screen.getByRole("tab", { name: "Appearance" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
      screen.getByRole("tab", { name: "Appearance" }).id,
    );
    section("Chat");
    expect(screen.queryByRole("radiogroup", { name: "Appearance" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Undoing a chat message's changes" })).toBeTruthy();
  });

  it("goes through its sections with the arrow keys", () => {
    render(<SettingsPanel />);
    const tabs = screen.getAllByRole("tab");
    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
  });

  it("asks each time on undoing a chat message's changes until told otherwise", () => {
    render(<SettingsPanel />);
    section("Chat");
    expect(radio("Ask each time").checked).toBe(true);
    fireEvent.click(radio("Only undo the deck changes"));
    expect(localStorage.getItem(REWIND_KEY)).toBe("deck");
    fireEvent.click(radio("Also rewind the chat"));
    expect(localStorage.getItem(REWIND_KEY)).toBe("rewind");
    fireEvent.click(radio("Ask each time"));
    expect(localStorage.getItem(REWIND_KEY)).toBeNull();
  });

  it("shows the answer the rewind dialog was told to remember", () => {
    localStorage.setItem(REWIND_KEY, "deck");
    render(<SettingsPanel />);
    section("Chat");
    expect(radio("Only undo the deck changes").checked).toBe(true);
  });

  it("leaves showing the review marks to the View ribbon", () => {
    render(<SettingsPanel />);
    section("Chat");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText(/review marks/i)).toBeNull();
  });

  describe("appearance", () => {
    const dark = () => document.documentElement.classList.contains("dark");
    /** Makes the system show dark or light. */
    const system = (isDark: boolean) =>
      vi
        .spyOn(window, "matchMedia")
        .mockImplementation(
          (query) => ({ matches: isDark, media: query, addEventListener() {}, removeEventListener() {} }) as never,
        );

    afterEach(() => {
      vi.restoreAllMocks();
      document.documentElement.classList.remove("dark");
    });

    it("follows the system until told otherwise", () => {
      render(<SettingsPanel />);
      expect(radio("System").checked).toBe(true);
      expect(screen.getByRole("radiogroup", { name: "Appearance" })).toBeTruthy();
    });

    it("shows the app light or dark right away, and remembers the choice", () => {
      system(false);
      render(<SettingsPanel />);
      fireEvent.click(radio("Dark"));
      expect(dark()).toBe(true);
      expect(localStorage.getItem(APPEARANCE_KEY)).toBe("dark");
      expect(radio("Dark").checked).toBe(true);
      fireEvent.click(radio("Light"));
      expect(dark()).toBe(false);
      expect(localStorage.getItem(APPEARANCE_KEY)).toBe("light");
    });

    it("goes back to what the system shows", () => {
      system(true);
      localStorage.setItem(APPEARANCE_KEY, "light");
      render(<SettingsPanel />);
      expect(radio("Light").checked).toBe(true);
      fireEvent.click(radio("System"));
      expect(dark()).toBe(true);
      expect(localStorage.getItem(APPEARANCE_KEY)).toBeNull();
    });
  });

  it("shows where the library is, beside the button that reveals it", async () => {
    invoke.mockImplementation(async (command: string) => (command === "library_folder" ? "/lib" : null));
    render(<SettingsPanel />);
    section("Library");
    const path = await screen.findByTestId("library-path");
    expect(path.textContent).toBe("/lib");
    expect(path.title).toBe("/lib");
    expect(path.nextElementSibling).toBe(screen.getByRole("button", { name: /Show in/ }));
  });

  it("says which version of the app this is", async () => {
    getVersion.mockResolvedValue("1.2.3");
    render(<SettingsPanel />);
    section("About");
    expect((await screen.findByTestId("app-version")).textContent).toBe("Version 1.2.3");
  });

  it("leaves the version out where there is none to read", async () => {
    invoke.mockImplementation(async () => {
      throw "no app";
    });
    render(<SettingsPanel />);
    section("About");
    await act(async () => {});
    expect(screen.queryByTestId("app-version")).toBeNull();
    section("Library");
    await act(async () => {});
    expect(screen.queryByTestId("library-path")).toBeNull();
    // Nothing to report until the user asks for the library.
    expect(lastError(useApp.getState())).toBeNull();
  });

  it("reveals the library folder", async () => {
    invoke.mockImplementation(async (command: string) => (command === "library_folder" ? "/lib" : null));
    render(<SettingsPanel />);
    section("Library");
    fireEvent.click(screen.getByRole("button", { name: /Reveal|Show|Open/ }));
    await waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith("/lib"));
  });

  it("reports a library folder it cannot find", async () => {
    invoke.mockImplementation(async () => {
      throw "cannot locate home folder";
    });
    render(<SettingsPanel />);
    section("Library");
    fireEvent.click(screen.getByRole("button", { name: /Reveal|Show|Open/ }));
    await waitFor(() => expect(lastError(useApp.getState())).toContain("cannot locate home folder"));
  });

  describe("interface text size", () => {
    afterEach(() => {
      document.documentElement.style.fontSize = "";
    });

    it("is Default until chosen, and scales the app's text right away, remembering it", () => {
      render(<SettingsPanel />);
      expect(radio("Default").checked).toBe(true);
      fireEvent.click(radio("Large"));
      expect(document.documentElement.style.fontSize).toBe("112.5%");
      expect(localStorage.getItem(TEXT_SIZE_KEY)).toBe("large");
      fireEvent.click(radio("Default"));
      expect(document.documentElement.style.fontSize).toBe("");
      expect(localStorage.getItem(TEXT_SIZE_KEY)).toBeNull();
    });
  });

  it("closes itself for the keyboard shortcuts, from About", () => {
    useApp.setState({ appSettingsOpen: true, shortcutHelpOpen: false });
    render(<SettingsPanel />);
    section("About");
    fireEvent.click(screen.getByRole("button", { name: "Show keyboard shortcuts" }));
    expect(useApp.getState()).toMatchObject({ appSettingsOpen: false, shortcutHelpOpen: true });
  });
});

describe("AppSettings", () => {
  it("shows the settings in a dialog while asked to, and closes on Escape", () => {
    useApp.setState({ appSettingsOpen: false });
    render(<AppSettings />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => useApp.getState().openAppSettings());
    expect(screen.getByRole("dialog", { name: "App settings" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Appearance" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    act(() => {});
    expect(useApp.getState().appSettingsOpen).toBe(false);
  });
});
