import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { invoke } from "../test/tauri";
import { LintStatus } from "./LintStatus";

beforeEach(() => {
  invoke.mockReset();
  useApp.setState({ deck: deckFor(DECK_HTML), lintError: null });
});

describe("lint status", () => {
  const issues = [
    { rule: "unclosed-tag", severity: "error" as const, message: "<div> is never closed.", line: 12, slide: "intro" },
    { rule: "title", severity: "warning" as const, message: "Needs a title.", line: 1, slide: null },
  ];

  it("shows a pending state until the first check finishes", () => {
    useApp.setState({ lint: null });
    render(<LintStatus />);
    expect(screen.getByTitle(/Checking deck\.html/).textContent).toBe("");
  });

  it("shows only a checkmark when the deck passes, and re-checks on click", () => {
    const refreshLint = vi.fn(async () => {});
    useApp.setState({ lint: [], refreshLint });
    render(<LintStatus />);
    const button = screen.getByRole("button", { name: "Lint OK" });
    expect(button.textContent).toBe("");
    expect(button.querySelector("svg")).toBeTruthy();
    fireEvent.click(button);
    expect(refreshLint).toHaveBeenCalled();
    expect(useApp.getState().composerFill).toBeNull();
  });

  it("says that the check failed, and tries again on a click", () => {
    const refreshLint = vi.fn(async () => {});
    useApp.setState({ lint: null, lintError: "deck not found", refreshLint });
    render(<LintStatus />);
    const button = screen.getByRole("button", { name: /Lint: the check failed/ });
    expect(button.textContent).toBe("Check failed");
    expect(button.title).toContain("deck not found");
    expect(screen.queryByTitle(/Checking/)).toBeNull();
    fireEvent.click(button);
    expect(refreshLint).toHaveBeenCalledOnce();
    useApp.setState({ lintError: null });
  });

  it("says how many problems there are, in words, colored by the worst of them", () => {
    useApp.setState({ lint: issues });
    const { unmount } = render(<LintStatus />);
    const button = screen.getByRole("button", { name: "Lint: 1 error, 1 warning" });
    expect(button.textContent).toBe("2 problems");
    expect(button.className).toContain("text-destructive");
    unmount();
    useApp.setState({ lint: [issues[1]!] });
    render(<LintStatus />);
    const warned = screen.getByRole("button", { name: "Lint: 1 warning" });
    expect(warned.textContent).toBe("1 problem");
    expect(warned.className).toContain("text-warning");
  });

  it("lists every problem on a click, errors first, and fills nothing in by itself", () => {
    const many = [
      issues[1]!,
      ...Array.from({ length: 12 }, (_, i) => ({ ...issues[0]!, line: 20 + i, message: `Problem ${i}` })),
    ];
    useApp.setState({ lint: many, composerFill: null, running: false });
    render(<LintStatus />);
    fireEvent.click(screen.getByRole("button", { name: /Lint: 12 errors, 1 warning/ }));
    const list = within(screen.getByRole("dialog", { name: "Problems in the deck file" }));
    const rows = list.getAllByRole("listitem");
    expect(rows).toHaveLength(13);
    expect(rows[0]!.textContent).toContain("Line 20");
    expect(rows[0]!.textContent).toContain("Problem 0");
    expect(within(rows[0]!).getByLabelText("Error")).toBeTruthy();
    expect(rows[12]!.textContent).toContain("Needs a title.");
    expect(within(rows[12]!).getByLabelText("Warning")).toBeTruthy();
    expect(useApp.getState().composerFill).toBeNull();
  });

  it("goes to the slide of a problem pressed in the list", () => {
    useApp.setState({ lint: issues, selected: "outro" });
    render(<LintStatus />);
    fireEvent.click(screen.getByRole("button", { name: /Lint: 1 error/ }));
    fireEvent.click(screen.getByRole("button", { name: /never closed/ }));
    expect(useApp.getState().selected).toBe("intro");
    // One that is on no slide is only said.
    expect(screen.queryByRole("button", { name: /Needs a title/ })).toBeNull();
  });

  it("fills the chat composer with fix instructions from the list, and closes it", () => {
    useApp.setState({ lint: issues, composerFill: null, running: false });
    render(<LintStatus />);
    fireEvent.click(screen.getByRole("button", { name: /Lint: 1 error/ }));
    fireEvent.click(screen.getByRole("button", { name: "Ask the agent to fix" }));
    const fill = useApp.getState().composerFill!;
    expect(fill.text).toContain("[unclosed-tag] (slide `intro`)");
    expect(fill.text).toContain("lint_deck");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("checks again from the list", () => {
    const refreshLint = vi.fn(async () => {});
    useApp.setState({ lint: issues, refreshLint });
    render(<LintStatus />);
    fireEvent.click(screen.getByRole("button", { name: /Lint: 1 error/ }));
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(refreshLint).toHaveBeenCalledOnce();
  });

  it("hands slide id style errors to the agent without editing the deck", () => {
    const message =
      "CSS targets slide id `intro`; add a reusable layout class and replace its id-based selectors, preserving its appearance.";
    const deck = deckFor(DECK_HTML);
    useApp.setState({
      deck,
      lint: [{ rule: "slide-id-style", severity: "error", message, line: 337, slide: "intro" }],
      composerFill: null,
      running: false,
    });
    render(<LintStatus />);
    fireEvent.click(screen.getByRole("button", { name: "Lint: 1 error" }));
    expect(screen.getByRole("dialog").textContent).toContain(message);
    fireEvent.click(screen.getByRole("button", { name: "Ask the agent to fix" }));

    const prompt = useApp.getState().composerFill!.text;
    expect(prompt).toContain(`- line 337 error [slide-id-style] (slide \`intro\`): ${message}`);
    expect(prompt).toContain("without changing how the slides look");
    expect(prompt).toContain("run the lint_deck tool to verify");
    expect(useApp.getState().deck).toBe(deck);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("still lists the problems while the agent works, but cannot ask it then", () => {
    useApp.setState({ lint: issues, running: true });
    render(<LintStatus />);
    fireEvent.click(screen.getByRole("button", { name: /Lint: 1 error/ }));
    const ask = screen.getByRole("button", { name: "Ask the agent to fix" }) as HTMLButtonElement;
    expect(ask.disabled).toBe(true);
    expect(ask.title).toContain("at work");
    useApp.setState({ running: false });
  });
});
