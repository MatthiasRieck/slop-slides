import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { invoke } from "../test/tauri";
import { LintStatus } from "./LintStatus";

beforeEach(() => {
  invoke.mockReset();
  useApp.setState({ deck: deckFor(DECK_HTML) });
});

describe("lint status", () => {
  const issues = [
    { rule: "unclosed-tag", severity: "error" as const, message: "<div> is never closed.", line: 12, slide: "intro" },
    { rule: "title", severity: "warning" as const, message: "Needs a title.", line: 1, slide: null },
  ];

  it("shows a pending state until the first check finishes", () => {
    useApp.setState({ lint: null });
    render(<LintStatus />);
    expect(screen.getByTitle(/Checking deck\.html/)).toBeTruthy();
  });

  it("shows OK and re-checks on click", () => {
    const refreshLint = vi.fn(async () => {});
    useApp.setState({ lint: [], refreshLint });
    render(<LintStatus />);
    fireEvent.click(screen.getByRole("button", { name: /Lint OK/ }));
    expect(refreshLint).toHaveBeenCalled();
    expect(useApp.getState().composerFill).toBeNull();
  });

  it("counts errors and warnings and lists them in the tooltip", () => {
    useApp.setState({ lint: issues });
    render(<LintStatus />);
    const button = screen.getByRole("button", { name: /Lint: 1 error, 1 warning/ });
    expect(button.title).toContain("Line 12: <div> is never closed.");
    expect(button.className).toContain("text-destructive");
  });

  it("uses the warning style when there are only warnings", () => {
    useApp.setState({ lint: [issues[1]!, issues[1]!] });
    render(<LintStatus />);
    expect(screen.getByRole("button", { name: /Lint: 2 warnings/ }).className).toContain("text-warning");
  });

  it("fills the chat composer with fix instructions when clicked", () => {
    useApp.setState({ lint: issues, composerFill: null, running: false });
    render(<LintStatus />);
    fireEvent.click(screen.getByRole("button", { name: /Lint: 1 error/ }));
    const fill = useApp.getState().composerFill!;
    expect(fill.text).toContain("[unclosed-tag] (slide `intro`)");
    expect(fill.text).toContain("lint_deck");
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
    const button = screen.getByRole("button", { name: "Lint: 1 error" });
    expect(button.title).toContain(message);
    fireEvent.click(button);

    const prompt = useApp.getState().composerFill!.text;
    expect(prompt).toContain(`- line 337 error [slide-id-style] (slide \`intro\`): ${message}`);
    expect(prompt).toContain("without changing how the slides look");
    expect(prompt).toContain("run the lint_deck tool to verify");
    expect(useApp.getState().deck).toBe(deck);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("is disabled while the agent works", () => {
    useApp.setState({ lint: issues, running: true });
    render(<LintStatus />);
    expect((screen.getByRole("button", { name: /Lint: 1 error/ }) as HTMLButtonElement).disabled).toBe(true);
    useApp.setState({ running: false });
  });
});
