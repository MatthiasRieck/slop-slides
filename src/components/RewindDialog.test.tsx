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

  it("offers to rewind the chat by default", () => {
    render(<RewindDialog />);
    expect(screen.getByRole("dialog", { name: "Undo chat changes" }).textContent).toContain("“Bigger title”");
    expect((screen.getByRole("radio", { name: /Also rewind the chat/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(answerRewind).toHaveBeenCalledWith("rewind", false);
  });

  it("can keep the chat, and remember the answer", () => {
    render(<RewindDialog />);
    fireEvent.click(screen.getByRole("radio", { name: /Only undo the deck changes/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Don't ask again" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(answerRewind).toHaveBeenCalledWith("deck", true);
  });

  it("skipping leaves the chat alone", () => {
    render(<RewindDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(answerRewind).toHaveBeenCalledWith(null, false);
  });

  it("shows nothing once the message is gone from the chat", () => {
    useApp.setState({ messages: [] });
    render(<RewindDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
