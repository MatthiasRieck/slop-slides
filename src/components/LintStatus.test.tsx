import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toastTexts, useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { invoke } from "../test/tauri";
import { LintStatus } from "./LintStatus";

beforeEach(() => {
  invoke.mockReset();
  useApp.setState({ deck: deckFor(DECK_HTML), lintError: null, toasts: [], codeReveal: null });
});

/** A check that finds `found` when asked again. */
const checking = (found: unknown[]) =>
  vi.fn(async () => {
    useApp.setState({ lint: found as never });
    return true;
  });

describe("the deck check", () => {
  const issues = [
    { rule: "unclosed-tag", severity: "error" as const, message: "<div> is never closed.", line: 12, slide: "intro" },
    { rule: "title", severity: "warning" as const, message: "Needs a title.", line: 1, slide: null },
  ];
  const open = () => fireEvent.click(screen.getByRole("button", { name: /^2 problems in the deck/ }));

  it("says it is checking until the first check finishes", () => {
    useApp.setState({ lint: null });
    render(<LintStatus />);
    expect(screen.getByRole("status", { name: "Checking the deck for problems" }).textContent).toBe("Checking…");
  });

  it("says No problems when the deck passes, checks again on a click and says what came of it", async () => {
    const refreshLint = checking([]);
    useApp.setState({ lint: [], refreshLint });
    render(<LintStatus />);
    const button = screen.getByRole("button", { name: "No problems" });
    expect(button.textContent).toBe("No problems");
    expect(button.title).not.toMatch(/lint/i);
    await act(async () => fireEvent.click(button));
    expect(refreshLint).toHaveBeenCalled();
    expect(toastTexts(useApp.getState(), "success")).toEqual(["No problems found in the deck"]);
    expect(useApp.getState().composerFill).toBeNull();
  });

  it("hides its words where the row under the slide is narrow, and keeps its name", () => {
    useApp.setState({ lint: [] });
    render(<LintStatus nameClass="narrow" />);
    expect(screen.getByText("No problems").className).toBe("narrow");
  });

  it("says that the check failed, and tries again on a click", async () => {
    const refreshLint = vi.fn(async () => false);
    useApp.setState({ lint: null, lintError: "deck not found", refreshLint });
    render(<LintStatus />);
    const button = screen.getByRole("button", { name: /could not be checked/ });
    expect(button.textContent).toBe("Check failed");
    expect(button.title).toContain("deck not found");
    await act(async () => fireEvent.click(button));
    expect(refreshLint).toHaveBeenCalledOnce();
    expect(toastTexts(useApp.getState(), "success")).toEqual([]);
    useApp.setState({ lintError: null });
  });

  it("says how many problems there are, in words, colored by the worst of them", () => {
    useApp.setState({ lint: issues });
    const { unmount } = render(<LintStatus />);
    const button = screen.getByRole("button", { name: "2 problems in the deck: 1 error, 1 warning" });
    expect(button.textContent).toBe("2problems");
    expect(button.className).toContain("text-destructive");
    unmount();
    useApp.setState({ lint: [issues[1]!] });
    render(<LintStatus />);
    const warned = screen.getByRole("button", { name: "1 problem in the deck: 1 warning" });
    expect(warned.textContent).toBe("1problem");
    expect(warned.className).toContain("text-warning");
  });

  it("lists every problem on a click, errors first, by slide number, and fills nothing in by itself", () => {
    const many = [
      issues[1]!,
      ...Array.from({ length: 12 }, (_, i) => ({ ...issues[0]!, line: 20 + i, message: `Problem ${i}` })),
    ];
    useApp.setState({ lint: many, composerFill: null, running: false });
    render(<LintStatus />);
    fireEvent.click(screen.getByRole("button", { name: /^13 problems/ }));
    const list = within(screen.getByRole("dialog", { name: "Problems in the deck" }));
    const rows = list.getAllByRole("listitem");
    expect(rows).toHaveLength(13);
    expect(rows[0]!.textContent).toContain("Slide 1");
    expect(rows[0]!.textContent).not.toContain("intro");
    expect(rows[0]!.textContent).toContain("Problem 0");
    expect(within(rows[0]!).getByLabelText("Error")).toBeTruthy();
    expect(rows[12]!.textContent).toContain("Deck");
    expect(rows[12]!.textContent).toContain("Needs a title.");
    expect(within(rows[12]!).getByLabelText("Warning")).toBeTruthy();
    expect(useApp.getState().composerFill).toBeNull();
  });

  it("goes to the slide of a problem pressed in the list", () => {
    useApp.setState({ lint: issues, selected: "outro" });
    render(<LintStatus />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /never closed/ }));
    expect(useApp.getState().selected).toBe("intro");
    // One that is on no slide is only said.
    expect(screen.queryByRole("button", { name: /Needs a title/ })).toBeNull();
  });

  it("opens the line of a problem in the deck's code, on its slide", () => {
    useApp.setState({ lint: issues, selected: "outro", sidebarTab: "chat" });
    render(<LintStatus />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "Show line 12 in the code" }));
    expect(useApp.getState()).toMatchObject({ selected: "intro", sidebarTab: "code", codeReveal: 12 });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("fills the chat composer with fix instructions from the list, marked as asking the agent, and closes it", () => {
    useApp.setState({ lint: issues, composerFill: null, running: false });
    render(<LintStatus />);
    open();
    const ask = screen.getByRole("button", { name: "Fix the problems…" });
    expect(ask.title).toMatch(/· asks the agent$/);
    fireEvent.click(ask);
    const fill = useApp.getState().composerFill!;
    expect(fill.text).toContain("[unclosed-tag] (slide `intro`)");
    expect(fill.text).toContain("lint_deck");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("checks again from the list, and says what it found", async () => {
    const refreshLint = checking([issues[0]]);
    useApp.setState({ lint: issues, refreshLint });
    render(<LintStatus />);
    open();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Check again" })));
    expect(refreshLint).toHaveBeenCalledOnce();
    expect(toastTexts(useApp.getState(), "success")).toEqual(["Checked again: 1 problem in the deck"]);
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
    fireEvent.click(screen.getByRole("button", { name: /^1 problem in the deck/ }));
    expect(screen.getByRole("dialog").textContent).toContain(message);
    fireEvent.click(screen.getByRole("button", { name: "Fix the problems…" }));

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
    open();
    const ask = screen.getByRole("button", { name: "Fix the problems…" }) as HTMLButtonElement;
    expect(ask.disabled).toBe(true);
    expect(ask.title).toContain("at work");
    useApp.setState({ running: false });
  });
});
