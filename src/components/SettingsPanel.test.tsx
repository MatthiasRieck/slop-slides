import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getVersion = vi.hoisted(() => vi.fn<() => Promise<string>>());
vi.mock("@tauri-apps/api/app", () => ({ getVersion }));

import { APPEARANCE_KEY } from "../lib/theme";
import { REWIND_KEY, useApp } from "../store";
import { lastError } from "../store/errors";
import { invoke, revealItemInDir } from "../test/tauri";
import { SettingsPanel } from "./SettingsPanel";

beforeEach(() => {
  localStorage.clear();
  invoke.mockReset();
  getVersion.mockReset().mockRejectedValue("no app");
  useApp.setState({ toasts: [] });
});

const radio = (name: string) => screen.getByRole("radio", { name }) as HTMLInputElement;

describe("SettingsPanel", () => {
  it("asks each time on undoing a chat message's changes until told otherwise", () => {
    render(<SettingsPanel />);
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
    expect(radio("Only undo the deck changes").checked).toBe(true);
  });

  it("leaves showing the review marks to the View ribbon", () => {
    render(<SettingsPanel />);
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
    const path = await screen.findByTestId("library-path");
    expect(path.textContent).toBe("/lib");
    expect(path.title).toBe("/lib");
    expect(path.nextElementSibling).toBe(screen.getByRole("button", { name: /Show in/ }));
  });

  it("says which version of the app this is", async () => {
    getVersion.mockResolvedValue("1.2.3");
    render(<SettingsPanel />);
    expect((await screen.findByTestId("app-version")).textContent).toBe("SlopSlide 1.2.3");
  });

  it("leaves the version out where there is none to read", async () => {
    invoke.mockImplementation(async () => {
      throw "no app";
    });
    render(<SettingsPanel />);
    await act(async () => {});
    expect(screen.queryByTestId("app-version")).toBeNull();
    expect(screen.queryByTestId("library-path")).toBeNull();
    // Nothing to report until the user asks for the library.
    expect(lastError(useApp.getState())).toBeNull();
  });

  it("reveals the library folder", async () => {
    invoke.mockImplementation(async (command: string) => (command === "library_folder" ? "/lib" : null));
    render(<SettingsPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Reveal|Show|Open/ }));
    await waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith("/lib"));
  });

  it("reports a library folder it cannot find", async () => {
    invoke.mockImplementation(async () => {
      throw "cannot locate home folder";
    });
    render(<SettingsPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Reveal|Show|Open/ }));
    await waitFor(() => expect(lastError(useApp.getState())).toBe("cannot locate home folder"));
  });
});
