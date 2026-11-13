import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryEntry } from "../lib/api";
import { useApp } from "../store";
import { RewindDialog } from "./RewindDialog";

const TURN: HistoryEntry = { id: "e1", source: "chat", label: "Bigger title", time: 0, message: "u1" };
const answerRewind = vi.fn(async () => {});
const real = useApp.getState().answerRewind;

beforeEach(() => {
  answerRewind.mockClear();
  useApp.setState({
    answerRewind,
    rewindAsk: TURN,
    messages: [{ id: "u1", role: "user", text: "Bigger title", slide: null, attachments: [], createdAt: 0 }],
  });
});
afterEach(() => useApp.setState({ answerRewind: real, rewindAsk: null, messages: [] }));

describe("RewindDialog", () => {
  it("shows nothing until a turn's changes are undone", () => {
    useApp.setState({ rewindAsk: null });
    render(<RewindDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says what happened and asks what becomes of the chat", () => {
    render(<RewindDialog />);
    const dialog = screen.getByRole("dialog", { name: "Undo chat changes" });
    expect(screen.getByRole("heading").textContent).toBe("You undid the agent's changes. What about the chat?");
    expect(dialog.textContent).toContain("“Bigger title”");
  });

  it("rewinds the chat with its main button, which has the focus", () => {
    render(<RewindDialog />);
    const rewind = screen.getByRole("button", { name: /^Rewind the chat too/ });
    expect(document.activeElement).toBe(rewind);
    expect(rewind.className).toContain("bg-primary");
    expect(rewind.textContent).toContain("returns to the message box");
    fireEvent.click(rewind);
    expect(answerRewind).toHaveBeenCalledWith("rewind", false);
  });

  it("can keep the chat and tell the agent, and remember the answer", () => {
    render(<RewindDialog />);
    const remember = screen.getByRole("checkbox", { name: /^Don't ask again/ });
    // Where to take the answer back is said beside it.
    expect(remember.closest("label")!.textContent).toContain("You can change this in the app settings.");
    fireEvent.click(remember);
    const keep = screen.getByRole("button", { name: /^Keep the chat, tell the agent/ });
    expect(keep.textContent).toContain("Your next message tells the agent");
    fireEvent.click(keep);
    expect(answerRewind).toHaveBeenCalledWith("deck", true);
  });

  it("explains what doing nothing means, and leaves the chat alone", () => {
    render(<RewindDialog />);
    expect(screen.getByText(/without telling the agent/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Do nothing" }));
    expect(answerRewind).toHaveBeenCalledWith(null, false);
  });

  it("does nothing on Escape", () => {
    render(<RewindDialog />);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(answerRewind).toHaveBeenCalledWith(null, false);
  });

  it("shows nothing once the message is gone from the chat", () => {
    useApp.setState({ messages: [] });
    render(<RewindDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
