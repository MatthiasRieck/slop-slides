import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultSettings } from "../../lib/settings";
import { useApp } from "../../store";
import { lastError } from "../../store/errors";
import { backend, calls, invoke, open as openDialog, revealItemInDir, settingsBackend } from "../../test/tauri";
import { GeneralSection } from "./GeneralSection";

beforeEach(() => {
  invoke.mockReset();
  backend(settingsBackend());
  useApp.setState({ toasts: [], settings: defaultSettings() });
});

afterEach(() => document.documentElement.classList.remove("dark"));

const radio = (name: string) => screen.getByRole("radio", { name });
/** Whether the radio called `name` is the one picked. */
const picked = (name: string) => radio(name).getAttribute("aria-checked") === "true";
const patches = () => calls("update_settings").map((args) => args.patch);

describe("GeneralSection", () => {
  describe("appearance", () => {
    it("follows the system until told otherwise", () => {
      render(<GeneralSection />);
      expect(picked("System")).toBe(true);
      expect(screen.getByRole("radiogroup", { name: "Appearance" })).toBeTruthy();
      expect(screen.getByText("System follows your computer's light or dark mode.")).toBeTruthy();
    });

    it("has the app's settings keep the choice, and shows the app in it once they have", async () => {
      render(<GeneralSection />);
      fireEvent.click(radio("Dark"));
      expect(patches()).toEqual([{ appearance: "dark" }]);
      await waitFor(() => expect(picked("Dark")).toBe(true));
      expect(useApp.getState().settings.appearance).toBe("dark");
      expect(document.documentElement.classList.contains("dark")).toBe(true);
      fireEvent.click(radio("Light"));
      await waitFor(() => expect(picked("Light")).toBe(true));
      expect(document.documentElement.classList.contains("dark")).toBe(false);
      fireEvent.click(radio("System"));
      expect(patches()).toEqual([{ appearance: "dark" }, { appearance: "light" }, { appearance: "system" }]);
      // The window's storage keeps none of it.
      expect(localStorage.getItem("slopslide.appearance")).toBeNull();
    });

    it("shows the choice the settings hold, also one made in another window", () => {
      useApp.setState({ settings: { ...defaultSettings(), appearance: "light" } });
      render(<GeneralSection />);
      expect(picked("Light")).toBe(true);
      act(() => useApp.setState({ settings: { ...defaultSettings(), appearance: "dark" } }));
      expect(picked("Dark")).toBe(true);
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
      expect(picked("System")).toBe(true);
    });
  });

  describe("undoing a chat message's changes", () => {
    it("asks each time until told otherwise", async () => {
      render(<GeneralSection />);
      expect(screen.getByRole("radiogroup", { name: "Undoing a chat message's changes" })).toBeTruthy();
      expect(screen.getByText("What happens to the chat when you undo what the agent did.")).toBeTruthy();
      expect(picked("Ask each time")).toBe(true);
      fireEvent.click(radio("Only undo the deck changes"));
      await waitFor(() => expect(picked("Only undo the deck changes")).toBe(true));
      fireEvent.click(radio("Also rewind the chat"));
      await waitFor(() => expect(picked("Also rewind the chat")).toBe(true));
      fireEvent.click(radio("Ask each time"));
      await waitFor(() => expect(picked("Ask each time")).toBe(true));
      expect(patches()).toEqual([{ rewind: "deck" }, { rewind: "rewind" }, { rewind: "ask" }]);
      expect(localStorage.getItem("slopslide.rewindChoice")).toBeNull();
    });

    it("takes a press on an answer's words, and only one answer at a time", async () => {
      render(<GeneralSection />);
      fireEvent.click(screen.getByText("Also rewind the chat"));
      expect(patches()).toEqual([{ rewind: "rewind" }]);
      await waitFor(() => expect(picked("Also rewind the chat")).toBe(true));
      const group = screen.getByRole("radiogroup", { name: "Undoing a chat message's changes" });
      const answers = [...group.querySelectorAll("[role=radio]")];
      expect(answers.map((answer) => answer.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    });

    it("shows the answer the rewind dialog was told to remember", () => {
      useApp.setState({ settings: { ...defaultSettings(), rewind: "deck" } });
      render(<GeneralSection />);
      expect(picked("Only undo the deck changes")).toBe(true);
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
      expect(path.nextElementSibling).toBe(screen.getByRole("button", { name: "Change…" }));
      expect(screen.getByRole("button", { name: /Show in/ })).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Folder for new decks" })).toBeTruthy();
      // Only looked up, not made.
      expect(calls("library_folder")).toEqual([{ create: false }]);
      // The default folder is in use: there is none to go back to.
      expect(screen.queryByRole("button", { name: "Use default" })).toBeNull();
    });

    it("moves to the folder chosen, and back to the default one", async () => {
      let folder: string | null = null;
      const kept = settingsBackend();
      backend({
        ...kept,
        update_settings: (args) => {
          const next = kept.update_settings!(args) as { libraryFolder: string | null };
          folder = next.libraryFolder;
          return next;
        },
        library_folder: () => folder ?? "/lib",
      });
      openDialog.mockReset().mockResolvedValue("/Volumes/work/decks");
      render(<GeneralSection />);
      await screen.findByText("/lib");
      fireEvent.click(screen.getByRole("button", { name: "Change…" }));
      await screen.findByText("/Volumes/work/decks");
      expect(openDialog).toHaveBeenCalledWith({
        directory: true,
        title: "Choose the folder for new decks",
        defaultPath: "/lib",
        canCreateDirectories: true,
      });
      expect(patches()).toEqual([{ libraryFolder: "/Volumes/work/decks" }]);
      expect(useApp.getState().settings.libraryFolder).toBe("/Volumes/work/decks");

      fireEvent.click(screen.getByRole("button", { name: "Use default" }));
      await screen.findByText("/lib");
      expect(patches()[1]).toEqual({ libraryFolder: null });
      expect(screen.queryByRole("button", { name: "Use default" })).toBeNull();
    });

    it("stays where it is when the dialog is cancelled", async () => {
      backend({ ...settingsBackend(), library_folder: () => "/lib" });
      openDialog.mockReset().mockResolvedValue(null);
      render(<GeneralSection />);
      await screen.findByText("/lib");
      fireEvent.click(screen.getByRole("button", { name: "Change…" }));
      await waitFor(() => expect(openDialog).toHaveBeenCalled());
      expect(patches()).toEqual([]);
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
      fireEvent.click(screen.getByRole("button", { name: /Reveal|Show/ }));
      await waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith("/lib"));
      // Made where it is missing, to have something to show.
      expect(calls("library_folder")).toContainEqual({ create: true });
    });

    it("reports a folder it cannot find", async () => {
      invoke.mockImplementation(async () => {
        throw "cannot locate home folder";
      });
      render(<GeneralSection />);
      fireEvent.click(screen.getByRole("button", { name: /Reveal|Show/ }));
      await waitFor(() => expect(lastError(useApp.getState())).toBe("cannot locate home folder"));
    });
  });
});
