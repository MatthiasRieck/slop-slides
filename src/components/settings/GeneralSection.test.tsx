import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultSettings } from "../../lib/settings";
import { useApp } from "../../store";
import { lastError } from "../../store/errors";
import { backend, calls, invoke, revealItemInDir, settingsBackend } from "../../test/tauri";
import { GeneralSection } from "./GeneralSection";

beforeEach(() => {
  invoke.mockReset();
  backend(settingsBackend());
  useApp.setState({ toasts: [], settings: defaultSettings() });
});

afterEach(() => document.documentElement.classList.remove("dark"));

const radio = (name: string) => screen.getByRole("radio", { name }) as HTMLInputElement;
const patches = () => calls("update_settings").map((args) => args.patch);

describe("GeneralSection", () => {
  describe("appearance", () => {
    it("follows the system until told otherwise", () => {
      render(<GeneralSection />);
      expect(radio("System").checked).toBe(true);
      expect(screen.getByRole("radiogroup", { name: "Appearance" })).toBeTruthy();
      expect(screen.getByText("System follows your computer's light or dark mode.")).toBeTruthy();
    });

    it("has the app's settings keep the choice, and shows the app in it once they have", async () => {
      render(<GeneralSection />);
      fireEvent.click(radio("Dark"));
      expect(patches()).toEqual([{ appearance: "dark" }]);
      await waitFor(() => expect(radio("Dark").checked).toBe(true));
      expect(useApp.getState().settings.appearance).toBe("dark");
      expect(document.documentElement.classList.contains("dark")).toBe(true);
      fireEvent.click(radio("Light"));
      await waitFor(() => expect(radio("Light").checked).toBe(true));
      expect(document.documentElement.classList.contains("dark")).toBe(false);
      fireEvent.click(radio("System"));
      expect(patches()).toEqual([{ appearance: "dark" }, { appearance: "light" }, { appearance: "system" }]);
      // The window's storage keeps none of it.
      expect(localStorage.getItem("slopslide.appearance")).toBeNull();
    });

    it("shows the choice the settings hold, also one made in another window", () => {
      useApp.setState({ settings: { ...defaultSettings(), appearance: "light" } });
      render(<GeneralSection />);
      expect(radio("Light").checked).toBe(true);
      act(() => useApp.setState({ settings: { ...defaultSettings(), appearance: "dark" } }));
      expect(radio("Dark").checked).toBe(true);
    });

    it("stays as it was, saying why, when the choice could not be kept", async () => {
      backend({
        update_settings: () => {
          throw "settings.json could not be written";
        },
      });
      render(<GeneralSection />);
      fireEvent.click(radio("Dark"));
      await waitFor(() => expect(lastError(useApp.getState())).toBe("settings.json could not be written"));
      expect(radio("System").checked).toBe(true);
    });
  });

  describe("undoing a chat message's changes", () => {
    it("asks each time until told otherwise", async () => {
      render(<GeneralSection />);
      expect(screen.getByRole("radiogroup", { name: "Undoing a chat message's changes" })).toBeTruthy();
      expect(screen.getByText("What happens to the chat when you undo what the agent did.")).toBeTruthy();
      expect(radio("Ask each time").checked).toBe(true);
      fireEvent.click(radio("Only undo the deck changes"));
      await waitFor(() => expect(radio("Only undo the deck changes").checked).toBe(true));
      fireEvent.click(radio("Also rewind the chat"));
      await waitFor(() => expect(radio("Also rewind the chat").checked).toBe(true));
      fireEvent.click(radio("Ask each time"));
      await waitFor(() => expect(radio("Ask each time").checked).toBe(true));
      expect(patches()).toEqual([{ rewind: "deck" }, { rewind: "rewind" }, { rewind: "ask" }]);
      expect(localStorage.getItem("slopslide.rewindChoice")).toBeNull();
    });

    it("shows the answer the rewind dialog was told to remember", () => {
      useApp.setState({ settings: { ...defaultSettings(), rewind: "deck" } });
      render(<GeneralSection />);
      expect(radio("Only undo the deck changes").checked).toBe(true);
    });
  });

  it("leaves showing the review marks to the View ribbon", () => {
    render(<GeneralSection />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText(/review marks/i)).toBeNull();
  });

  describe("the library", () => {
    it("shows where it is, beside the button that reveals it", async () => {
      backend({ library_folder: () => "/lib" });
      render(<GeneralSection />);
      const path = await screen.findByTestId("library-path");
      expect(path.textContent).toBe("/lib");
      expect(path.title).toBe("/lib");
      expect(path.nextElementSibling).toBe(screen.getByRole("button", { name: /Show in/ }));
      expect(screen.getByText("New decks from the start screen are kept in the SlopSlide library.")).toBeTruthy();
    });

    it("leaves the path out where there is none to read", async () => {
      invoke.mockImplementation(async () => {
        throw "no app";
      });
      render(<GeneralSection />);
      await act(async () => {});
      expect(screen.queryByTestId("library-path")).toBeNull();
      // Nothing to report until the user asks for the library.
      expect(lastError(useApp.getState())).toBeNull();
    });

    it("reveals the folder", async () => {
      backend({ library_folder: () => "/lib" });
      render(<GeneralSection />);
      fireEvent.click(screen.getByRole("button", { name: /Reveal|Show|Open/ }));
      await waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith("/lib"));
    });

    it("reports a folder it cannot find", async () => {
      invoke.mockImplementation(async () => {
        throw "cannot locate home folder";
      });
      render(<GeneralSection />);
      fireEvent.click(screen.getByRole("button", { name: /Reveal|Show|Open/ }));
      await waitFor(() => expect(lastError(useApp.getState())).toBe("cannot locate home folder"));
    });
  });
});
