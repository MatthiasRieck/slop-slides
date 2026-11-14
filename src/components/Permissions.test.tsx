import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetModes } from "../lib/permissions";
import { type ChatPart, useApp } from "../store";
import { useConfirmQuestion } from "../store/confirm";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { invoke } from "../test/tauri";
import { ApprovalCard, ApprovalReview, COMPOSER_INPUT_ATTR, PermissionPicker } from "./Permissions";

const interrupt = vi.fn();
beforeEach(() => {
  invoke.mockReset().mockResolvedValue(["ask", "autoReview", "fullAccess", "custom"]);
  useConfirmQuestion.setState({ question: null, waiting: [] });
  interrupt.mockReset();
  forgetModes();
  useApp.setState({
    workspace: { path: "/decks/talk", name: "talk" },
    chatKey: "/decks/talk",
    deck: deckFor(DECK_HTML),
    selection: { provider: "codex", model: "m", label: "M", effort: "high", contextWindow: null },
    permissionModes: { claude: "ask", codex: "ask", copilot: "ask" },
    running: false,
    interrupt,
  });
});
const picker = () => screen.getByRole("button", { name: "Permissions" });
const mode = () => useApp.getState().permissionModes[useApp.getState().selection.provider];
const openPicker = async () => {
  fireEvent.click(picker());
  await screen.findByRole("button", { name: /Approve for me/ });
};
/** Answers the question the app asks in its own dialog, once it is asked. */
const answer = async (yes: boolean) => {
  await waitFor(() => expect(useConfirmQuestion.getState().question).not.toBeNull());
  const question = useConfirmQuestion.getState().question!;
  await act(async () => question.answer(yes));
  return question;
};
const part = (): Extract<ChatPart, { kind: "approval" }> => ({
  kind: "approval",
  status: "pending",
  approval: {
    id: "r1",
    title: "Run a command",
    reason: "Read reference",
    details: "cat /reference",
    acceptLabel: "Allow once",
    decisions: ["accept", "decline"],
  },
});

describe("permission picker", () => {
  it("applies the chosen mode to the selected provider only", async () => {
    render(<PermissionPicker />);
    await openPicker();
    fireEvent.click(screen.getByRole("button", { name: /Approve for me/ }));
    await waitFor(() => expect(mode()).toBe("autoReview"));
    expect(picker().textContent).toContain("Approve for me");
    expect(invoke).toHaveBeenCalledWith("permission_modes", { provider: "codex", id: "/decks/talk" });
    invoke.mockResolvedValue(["ask", "fullAccess"]);
    act(() => useApp.setState({ selection: { ...useApp.getState().selection, provider: "claude" } }));
    expect(mode()).toBe("ask");
    expect(picker().title).toBe("Claude Code permissions: Ask for approval");
    fireEvent.click(picker());
    await screen.findByRole("button", { name: /Full access/ });
    expect(invoke).toHaveBeenCalledWith("permission_modes", { provider: "claude", id: "/decks/talk" });
    expect(screen.queryByRole("button", { name: /Approve for me/ })).toBeNull();
    expect(useApp.getState().permissionModes.codex).toBe("autoReview");
  });

  it("asks the backend for modes only when opened", async () => {
    render(<PermissionPicker />);
    expect(invoke).not.toHaveBeenCalled();
    await openPicker();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("names the provider in the Full access warning", async () => {
    invoke.mockResolvedValue(["ask", "fullAccess"]);
    useApp.setState({ selection: { ...useApp.getState().selection, provider: "copilot" } });
    render(<PermissionPicker />);
    fireEvent.click(picker());
    fireEvent.click(await screen.findByRole("button", { name: /Full access/ }));
    const question = await answer(true);
    expect(question.message).toContain("GitHub Copilot will be able");
    expect(question.destructive).toBe(true);
    await waitFor(() => expect(mode()).toBe("fullAccess"));
  });

  it("confirms Full access in the app's own dialog and keeps the old mode when cancelled", async () => {
    render(<PermissionPicker />);
    await openPicker();
    fireEvent.click(screen.getByRole("button", { name: /Full access/ }));
    expect((await answer(false)).confirmLabel).toBe("Turn on Full access");
    expect(mode()).toBe("ask");
    fireEvent.click(screen.getByRole("button", { name: /Full access/ }));
    await answer(true);
    await waitFor(() => expect(mode()).toBe("fullAccess"));
  });

  it("changes the running turn's mode after confirming", async () => {
    invoke.mockImplementation(async (command: string) =>
      command === "permission_modes" ? ["ask", "fullAccess"] : undefined,
    );
    useApp.setState({ running: true, selection: { ...useApp.getState().selection, provider: "claude" } });
    render(<PermissionPicker />);
    expect((picker() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(picker());
    fireEvent.click(await screen.findByRole("button", { name: /Full access/ }));
    await answer(true);
    await waitFor(() => expect(mode()).toBe("fullAccess"));
    expect(invoke).toHaveBeenCalledWith("set_permission_mode", { id: "/decks/talk", mode: "fullAccess" });
    expect(screen.queryByText(/next message/)).toBeNull();
  });

  it("applies a confirmation that resolves after a turn started", async () => {
    render(<PermissionPicker />);
    await openPicker();
    fireEvent.click(screen.getByRole("button", { name: /Full access/ }));
    await waitFor(() => expect(useConfirmQuestion.getState().question).not.toBeNull());
    act(() => useApp.setState({ running: true }));
    await answer(true);
    expect(mode()).toBe("fullAccess");
    expect(invoke).toHaveBeenCalledWith("set_permission_mode", { id: "/decks/talk", mode: "fullAccess" });
  });

  it("tells that Codex applies a change from the next message", async () => {
    useApp.setState({ running: true });
    render(<PermissionPicker />);
    await openPicker();
    expect(screen.getByText("Codex applies a change from your next message.")).toBeTruthy();
  });

  it("asks nothing for the modes that ask", async () => {
    render(<PermissionPicker />);
    await openPicker();
    fireEvent.click(screen.getByRole("button", { name: /Approve for me/ }));
    await waitFor(() => expect(mode()).toBe("autoReview"));
    expect(useConfirmQuestion.getState().question).toBeNull();
  });

  it("shows only modes returned by Codex and reports an unavailable saved mode", async () => {
    invoke.mockResolvedValue(["ask", "custom"]);
    useApp.setState({ permissionModes: { claude: "ask", codex: "autoReview", copilot: "ask" } });
    render(<PermissionPicker />);
    fireEvent.click(picker());
    await screen.findByRole("button", { name: /Use your existing/ });
    expect(screen.queryByRole("button", { name: /Full access/ })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("saved mode is unavailable");
  });

  it("reports capability errors without inventing available modes", async () => {
    invoke.mockRejectedValue("CLI unavailable");
    render(<PermissionPicker />);
    fireEvent.click(picker());
    expect((await screen.findByRole("alert")).textContent).toBe("CLI unavailable");
    expect(screen.queryByRole("button", { name: /Full access/ })).toBeNull();
  });

  it("dismisses on Escape", async () => {
    render(<PermissionPicker />);
    await openPicker();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Permission modes" })).toBeNull();
  });

  it("shows the modes it knows at once the next time, and asks again in the background", async () => {
    render(<PermissionPicker />);
    await openPicker();
    fireEvent.keyDown(document, { key: "Escape" });
    let answer!: (modes: string[]) => void;
    invoke.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    fireEvent.click(picker());
    // No "Checking…": what was offered before is there while the answer is on its way.
    expect(screen.queryByText(/Checking/)).toBeNull();
    expect(screen.getByRole("button", { name: /Approve for me/ })).toBeTruthy();
    expect(invoke).toHaveBeenCalledTimes(2);
    await act(async () => answer(["ask", "fullAccess"]));
    expect(screen.queryByRole("button", { name: /Approve for me/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Full access/ })).toBeTruthy();
  });

  it("keeps the modes it knows when asking again fails", async () => {
    render(<PermissionPicker />);
    await openPicker();
    fireEvent.keyDown(document, { key: "Escape" });
    invoke.mockRejectedValue("CLI unavailable");
    fireEvent.click(picker());
    await act(async () => {});
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: /Approve for me/ })).toBeTruthy();
  });

  it("checks the selected mode in the list", async () => {
    render(<PermissionPicker />);
    await openPicker();
    const selected = screen.getByRole("button", { name: /Ask for approval/, pressed: true });
    expect(selected.querySelector(".lucide-check")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Approve for me/ }).querySelector(".lucide-check")).toBeNull();
  });

  it("makes Full access stand out from the modes that ask: a warning color, and its name always on show", () => {
    render(<PermissionPicker />);
    const safe = screen.getByText("Ask for approval");
    expect(safe.className).toContain("hidden");
    expect(picker().className).not.toContain("text-warning");
    expect(picker().querySelector(".lucide-shield")).toBeTruthy();

    act(() => useApp.setState({ permissionModes: { claude: "ask", codex: "fullAccess", copilot: "ask" } }));
    // Named also where room is short, in a word.
    expect(screen.getByText("Full").className).toContain("@[26rem]:hidden");
    expect(screen.getByText("Full access").className).toContain("@[26rem]:inline");
    expect(picker().className).toContain("text-warning");
    expect(picker().querySelector(".lucide-shield-alert")).toBeTruthy();
  });
});

describe("approval card", () => {
  beforeEach(() => {
    useApp.setState({ running: true });
    invoke.mockResolvedValue(undefined);
  });
  it.each(["Allow once", "Deny"])("sends %s with the exact deck and request ID, once", async (label) => {
    render(<ApprovalCard part={part()} />);
    const button = screen.getByRole("button", { name: label });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith("respond_approval", {
      chat: "/decks/talk",
      id: "r1",
      decision: label === "Deny" ? "decline" : "accept",
    });
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Always allow in this chat" })).toBeNull();
    // Answered, it is one line that says how.
    expect(screen.getByText(label === "Deny" ? "Denied:" : "Allowed once:", { exact: false })).toBeTruthy();
  });
  it("offers to allow for the rest of the chat only when the agent offers it, saying what it covers", async () => {
    const p = part();
    p.approval.decisions.push("acceptForSession");
    p.approval.sessionScope = "commands starting with `cat`";
    render(<ApprovalCard part={p} />);
    const covers = screen.getByText(/covers/);
    expect(covers.textContent).toBe(
      '"Always allow in this chat" covers commands starting with cat, until you start a new chat.',
    );
    expect(covers.querySelector("code")!.textContent).toBe("cat");
    fireEvent.click(screen.getByRole("button", { name: "Always allow in this chat" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("respond_approval", {
        chat: "/decks/talk",
        id: "r1",
        decision: "acceptForSession",
      }),
    );
  });
  it("shows an MCP tool confirmation and sends the user's decision through the existing card", async () => {
    const p = part();
    p.approval.title = "Use an MCP tool";
    p.approval.reason = "Allow lint_deck?\nThis checks the presentation.";
    p.approval.details = '{"server":"slopslide","tool_params":{}}';
    render(<ApprovalCard part={p} />);
    expect(screen.getByText("Use an MCP tool")).toBeTruthy();
    expect(screen.getByText(/This checks the presentation/).textContent).toContain("\n");
    expect(screen.getByText(/tool_params/).textContent).toContain("slopslide");
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("respond_approval", {
        chat: "/decks/talk",
        id: "r1",
        decision: "accept",
      }),
    );
    expect(screen.queryByRole("button", { name: "Always allow in this chat" })).toBeNull();
    expect(screen.queryByText(/covers/)).toBeNull();
  });
  it("tells the answers apart: accepting is the main button, denying a quiet one, stopping set apart", () => {
    const p = part();
    p.approval.decisions.push("acceptForSession");
    render(<ApprovalCard part={p} />);
    const accept = screen.getByRole("button", { name: "Allow once" });
    const session = screen.getByRole("button", { name: "Always allow in this chat" });
    const deny = screen.getByRole("button", { name: "Deny" });
    const stop = screen.getByRole("button", { name: "Stop" });
    expect(accept.className).toContain("bg-primary");
    expect(session.className).toContain("border");
    expect(session.className).not.toContain("bg-primary");
    expect(deny.className).not.toContain("border");
    expect(deny.className).not.toContain("bg-primary");
    // Stop is no answer to the request: a text button on the far side, after a spacer.
    expect(stop.className).not.toContain("border");
    expect(stop.previousElementSibling!.className).toContain("flex-1");
    expect(stop.parentElement!.lastElementChild).toBe(stop);
  });

  it("stands out and is read out while it waits, and is one quiet line once it is answered", () => {
    const { rerender } = render(<ApprovalCard part={part()} />);
    const card = screen.getByRole("region", { name: "Approval request" });
    expect(card.className).toContain("border-warning");
    const title = screen.getByText("Run a command");
    expect(title.getAttribute("aria-live")).toBe("assertive");
    expect(title.getAttribute("role")).toBe("status");
    rerender(<ApprovalCard part={{ ...part(), status: "resolved", decision: "acceptForSession" }} />);
    expect(screen.queryByRole("region", { name: "Approval request" })).toBeNull();
    expect(screen.getByText(/Always allowed in this chat/).textContent).toBe(
      "Always allowed in this chat: Run a command",
    );
    // What was asked unfolds beneath it.
    expect(screen.queryByText("cat /reference")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show what was asked: Run a command" }));
    expect(screen.getByText("cat /reference")).toBeTruthy();
  });

  it("takes the keyboard focus when it is on nothing, and then names its keys", () => {
    render(<ApprovalCard part={part()} />);
    const accept = screen.getByRole("button", { name: "Allow once" });
    expect(document.activeElement).toBe(accept);
    expect(screen.getByText("Enter to allow once · Esc to deny", { exact: false })).toBeTruthy();
    // Enter is the focused button's own key: nothing listens for it anywhere else.
    fireEvent.blur(accept);
    expect(screen.queryByText(/to allow once/)).toBeNull();
  });

  it("denies with Escape while the focus is on it", async () => {
    render(<ApprovalCard part={part()} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Allow once" }), { key: "Escape" });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("respond_approval", { chat: "/decks/talk", id: "r1", decision: "decline" }),
    );
  });

  it("keeps how it was answered with the chat", async () => {
    const reply = {
      id: "a",
      role: "assistant" as const,
      parts: [part()],
      status: "streaming" as const,
      thinking: false,
      error: null,
      costUsd: null,
      durationMs: null,
      createdAt: 0,
    };
    useApp.setState({ messages: [reply] });
    render(<ApprovalCard part={part()} />);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => {
      const saved = useApp.getState().messages[0];
      expect(saved?.role === "assistant" && saved.parts[0]).toMatchObject({ decision: "decline" });
    });
  });

  it("takes the focus from the empty message input, but not from a draft or another field", () => {
    const input = document.createElement("textarea");
    input.setAttribute(COMPOSER_INPUT_ATTR, "");
    const other = document.createElement("input");
    document.body.append(input, other);
    try {
      input.focus();
      const first = render(<ApprovalCard part={part()} />);
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Allow once" }));
      first.unmount();

      input.value = "Half a sentence";
      input.focus();
      const second = render(<ApprovalCard part={part()} />);
      expect(document.activeElement).toBe(input);
      expect(screen.queryByText(/^Enter to/)).toBeNull();
      second.unmount();

      other.focus();
      render(<ApprovalCard part={part()} />);
      expect(document.activeElement).toBe(other);
    } finally {
      input.remove();
      other.remove();
    }
  });

  it("does not answer to Enter pressed elsewhere", () => {
    const other = document.createElement("input");
    document.body.append(other);
    try {
      other.focus();
      render(<ApprovalCard part={part()} />);
      fireEvent.keyDown(other, { key: "Enter" });
      fireEvent.keyDown(document.body, { key: "Enter" });
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      other.remove();
    }
  });

  it("does not take the focus for a request that is already closed", () => {
    render(<ApprovalCard part={{ ...part(), status: "expired" }} />);
    expect(document.activeElement).toBe(document.body);
  });

  it("stops the turn without sending an approval", () => {
    render(<ApprovalCard part={part()} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(interrupt).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
  });
  it("reports a failed response and allows a retry", async () => {
    invoke.mockRejectedValueOnce("No longer pending");
    render(<ApprovalCard part={part()} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect((await screen.findByRole("alert")).textContent).toBe("No longer pending");
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  });
  it.each([
    ["expired", "Not answered: Run a command"],
    ["resolved", "Answered: Run a command"],
  ] as const)("has no answer buttons for a %s request, and says what became of it", (status, line) => {
    render(<ApprovalCard part={{ ...part(), status }} />);
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
    expect(screen.getByText(line.split(":")[0]!, { exact: false }).textContent).toBe(line);
  });
  it("does not offer approval when the agent has finished", () => {
    useApp.setState({ running: false });
    render(<ApprovalCard part={part()} />);
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    expect(screen.getByText(/Not answered/)).toBeTruthy();
  });
  it("displays the automatic reviewer result and reason", () => {
    render(<ApprovalReview part={{ kind: "approvalReview", id: "r", status: "denied", detail: "Outside scope" }} />);
    expect(screen.getByText("Automatic review · Denied")).toBeTruthy();
    expect(screen.getByText("Outside scope")).toBeTruthy();
  });
});
