import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { REWIND_KEY, useApp } from "../store";
import { lastError } from "../store/errors";
import { invoke, revealItemInDir } from "../test/tauri";
import { SettingsPanel } from "./SettingsPanel";

beforeEach(() => {
  localStorage.clear();
  useApp.setState({ reviewVisible: true, toasts: [] });
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

  it("shows or hides the review marks", () => {
    render(<SettingsPanel />);
    const box = screen.getByRole("checkbox", { name: /review marks/ }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(useApp.getState().reviewVisible).toBe(false);
    expect(box.checked).toBe(false);
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
