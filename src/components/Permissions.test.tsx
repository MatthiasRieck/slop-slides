import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasOpenLayer } from "../lib/layers";
import { forgetModes } from "../lib/permissions";
import { type ChatPart, useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { ask, invoke } from "../test/tauri";
import { tooltipOf } from "../test/ui";
import { ApprovalCard, ApprovalReview, COMPOSER_INPUT_ATTR, PermissionPicker } from "./Permissions";

const interrupt = vi.fn();
beforeEach(() => {
  invoke.mockReset().mockResolvedValue(["ask", "autoReview", "fullAccess", "custom"]);
  ask.mockReset().mockResolvedValue(true);
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
  await screen.findByRole("menuitemradio", { name: /Approve for me/ });
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
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Approve for me/ }));
    expect(mode()).toBe("autoReview");
    expect(picker().textContent).toContain("Approve for me");
    expect(invoke).toHaveBeenCalledWith("permission_modes", { provider: "codex", id: "/decks/talk" });
    invoke.mockResolvedValue(["ask", "fullAccess"]);
    act(() => useApp.setState({ selection: { ...useApp.getState().selection, provider: "claude" } }));
    expect(mode()).toBe("ask");
    expect(tooltipOf(picker())).toBe("Claude Code permissions: Ask for approval");
    fireEvent.click(picker());
    await screen.findByRole("menuitemradio", { name: /Full access/ });
    expect(invoke).toHaveBeenCalledWith("permission_modes", { provider: "claude", id: "/decks/talk" });
    expect(screen.queryByRole("menuitemradio", { name: /Approve for me/ })).toBeNull();
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
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Full access/ }));
    await waitFor(() => expect(mode()).toBe("fullAccess"));
    expect(ask.mock.calls[0]![0]).toContain("GitHub Copilot will be able");
  });

  it("confirms Full access and keeps the old mode when cancelled", async () => {
    ask.mockResolvedValueOnce(false);
    render(<PermissionPicker />);
    await openPicker();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Full access/ }));
    await waitFor(() => expect(ask).toHaveBeenCalled());
    expect(mode()).toBe("ask");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Full access/ }));
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
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Full access/ }));
    await waitFor(() => expect(mode()).toBe("fullAccess"));
    expect(ask).toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("set_permission_mode", { id: "/decks/talk", mode: "fullAccess" });
    expect(screen.queryByText(/next message/)).toBeNull();
  });

  it("applies a confirmation that resolves after a turn started", async () => {
    let resolve!: (value: boolean) => void;
    ask.mockReturnValue(
      new Promise<boolean>((r) => {
        resolve = r;
      }),
    );
    render(<PermissionPicker />);
    await openPicker();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Full access/ }));
    act(() => useApp.setState({ running: true }));
    await act(async () => resolve(true));
    expect(mode()).toBe("fullAccess");
    expect(invoke).toHaveBeenCalledWith("set_permission_mode", { id: "/decks/talk", mode: "fullAccess" });
  });

  it("tells that Codex applies a change from the next message", async () => {
    useApp.setState({ running: true });
    render(<PermissionPicker />);
    await openPicker();
    expect(screen.getByText("Codex applies a change from your next message.")).toBeTruthy();
  });

  it("keeps the old mode if the confirmation dialog fails", async () => {
    ask.mockRejectedValueOnce("Dialog unavailable");
    render(<PermissionPicker />);
    await openPicker();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Full access/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("Dialog unavailable");
    expect(mode()).toBe("ask");
  });

  it("shows only modes returned by Codex and reports an unavailable saved mode", async () => {
    invoke.mockResolvedValue(["ask", "custom"]);
    useApp.setState({ permissionModes: { claude: "ask", codex: "autoReview", copilot: "ask" } });
    render(<PermissionPicker />);
    fireEvent.click(picker());
    await screen.findByRole("menuitemradio", { name: /Use your existing/ });
    expect(screen.queryByRole("menuitemradio", { name: /Full access/ })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("saved mode is unavailable");
    expect(screen.getByRole("alert").getAttribute("data-slot")).toBe("field-error");
  });

  it("reports capability errors without inventing available modes", async () => {
    invoke.mockRejectedValue("CLI unavailable");
    render(<PermissionPicker />);
    fireEvent.click(picker());
    expect((await screen.findByRole("alert")).textContent).toBe("CLI unavailable");
    // The menu's complaints are all the same kind of line.
    expect(screen.getByRole("alert").getAttribute("data-slot")).toBe("field-error");
    expect(screen.queryByRole("menuitemradio", { name: /Full access/ })).toBeNull();
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
    expect(screen.getByRole("menuitemradio", { name: /Approve for me/ })).toBeTruthy();
    expect(invoke).toHaveBeenCalledTimes(2);
    await act(async () => answer(["ask", "fullAccess"]));
    expect(screen.queryByRole("menuitemradio", { name: /Approve for me/ })).toBeNull();
    expect(screen.getByRole("menuitemradio", { name: /Full access/ })).toBeTruthy();
  });

  it("keeps the modes it knows when asking again fails", async () => {
    render(<PermissionPicker />);
    await openPicker();
    fireEvent.keyDown(document, { key: "Escape" });
    invoke.mockRejectedValue("CLI unavailable");
    fireEvent.click(picker());
    await act(async () => {});
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("menuitemradio", { name: /Approve for me/ })).toBeTruthy();
  });

  it("checks the selected mode in the list", async () => {
    render(<PermissionPicker />);
    await openPicker();
    const selected = screen.getByRole("menuitemradio", { name: /Ask for approval/, checked: true });
    expect(selected.querySelector(".lucide-check")).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: /Approve for me/ }).querySelector(".lucide-check")).toBeNull();
    expect(screen.getAllByRole("menuitemradio", { checked: true })).toHaveLength(1);
  });

  it("is a menu of the modes, one of them checked, that counts as open while it is", async () => {
    render(<PermissionPicker />);
    expect(picker().getAttribute("aria-expanded")).toBe("false");
    await openPicker();
    expect(picker().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Permission modes" })).toBeTruthy();
    expect(screen.getAllByRole("menuitemradio").map((item) => item.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
      "false",
    ]);
    expect(hasOpenLayer()).toBe(true);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(hasOpenLayer()).toBe(false);
  });

  it("picks a mode with the keyboard, and gives the keyboard back to its button", async () => {
    const user = userEvent.setup();
    render(<PermissionPicker />);
    await user.click(picker());
    const wanted = await screen.findByRole("menuitemradio", { name: /Approve for me/ });
    for (let step = 0; step < 4 && document.activeElement !== wanted; step++) await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(wanted);
    await user.keyboard("{Enter}");
    expect(mode()).toBe("autoReview");
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(picker()));
  });

  it("stays open, the old mode still checked, until Full access is confirmed", async () => {
    let confirm!: (value: boolean) => void;
    ask.mockReturnValue(
      new Promise<boolean>((resolve) => {
        confirm = resolve;
      }),
    );
    render(<PermissionPicker />);
    await openPicker();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Full access/ }));
    expect(screen.getByRole("menuitemradio", { name: /Ask for approval/, checked: true })).toBeTruthy();
    await act(async () => confirm(true));
    expect(mode()).toBe("fullAccess");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("makes Full access stand out from the modes that ask: a warning color, and its name always on show", () => {
    render(<PermissionPicker />);
    const safe = screen.getByText("Ask for approval");
    expect(safe.className).toContain("hidden");
    expect(picker().className).not.toContain("text-warning");
    expect(picker().querySelector(".lucide-shield")).toBeTruthy();

    act(() => useApp.setState({ permissionModes: { claude: "ask", codex: "fullAccess", copilot: "ask" } }));
    expect(screen.getByText("Full access").className).not.toContain("hidden");
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
    expect(screen.queryByRole("button", { name: "Allow for session" })).toBeNull();
  });
  it("offers session approval only when supplied by Codex", async () => {
    const p = part();
    p.approval.decisions.push("acceptForSession");
    render(<ApprovalCard part={p} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow for session" }));
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
    expect(screen.queryByRole("button", { name: "Allow for session" })).toBeNull();
  });
  it("shows what is asked for as a block of code that wraps, scrolls and can be selected", () => {
    const p = part();
    p.approval.details = "cat /reference\nrm -rf /tmp/build";
    render(<ApprovalCard part={p} />);
    const details = screen.getByText(/cat \/reference/).closest("pre")!;
    expect(details.dataset.slot).toBe("code-block-content");
    expect(details.textContent).toBe("cat /reference\nrm -rf /tmp/build");
    expect(details.hasAttribute("data-wrap")).toBe(true);
    expect(details.tabIndex).toBe(0);
    expect(details.closest(".selectable")).not.toBeNull();
  });

  it("tells the answers apart: accepting is the main button, denying a quiet one, stopping set apart", () => {
    const p = part();
    p.approval.decisions.push("acceptForSession");
    render(<ApprovalCard part={p} />);
    const accept = screen.getByRole("button", { name: "Allow once" });
    const session = screen.getByRole("button", { name: "Allow for session" });
    const deny = screen.getByRole("button", { name: "Deny" });
    const stop = screen.getByRole("button", { name: "Stop" });
    // Filled, outlined, and neither: the three looks of a button.
    expect(accept.className).toContain("bg-primary");
    expect(session.className).toContain("border-border");
    expect(session.className).not.toContain("bg-primary");
    expect(deny.className).not.toContain("border-border");
    expect(deny.className).not.toContain("bg-primary");
    // Stop is no answer to the request: a text button on the far side, after a spacer.
    expect(stop.className).not.toContain("border-border");
    expect(stop.className).toContain("hover:underline");
    expect(tooltipOf(stop)).toBe("Stop the agent's turn");
    expect(stop.previousElementSibling!.className).toContain("flex-1");
    expect(stop.parentElement!.lastElementChild).toBe(stop);
  });

  it("stands out and is read out while it waits, and no longer once it is answered", () => {
    const { rerender } = render(<ApprovalCard part={part()} />);
    const card = screen.getByRole("region", { name: "Approval request" });
    expect(card.className).toContain("border-warning");
    // Built as the review beside it in the transcript is: an item, with its parts in their places.
    expect(card.tagName).toBe("SECTION");
    expect(card.dataset.slot).toBe("item");
    expect(card.querySelector("[data-slot=item-media] svg")).not.toBeNull();
    expect(screen.getByText("Run a command").dataset.slot).toBe("item-title");
    expect(screen.getByRole("button", { name: "Stop" }).closest("[data-slot=item-footer]")).not.toBeNull();
    const title = screen.getByText("Run a command");
    expect(title.getAttribute("aria-live")).toBe("assertive");
    expect(title.getAttribute("role")).toBe("status");
    rerender(<ApprovalCard part={{ ...part(), status: "resolved" }} />);
    expect(card.className).not.toContain("border-warning");
    expect(screen.getByText("Run a command").getAttribute("aria-live")).toBeNull();
  });

  it("takes the keyboard focus when it is on nothing, and then offers Enter", () => {
    render(<ApprovalCard part={part()} />);
    const accept = screen.getByRole("button", { name: "Allow once" });
    expect(document.activeElement).toBe(accept);
    const hint = screen.getByText("to allow once");
    expect(hint.textContent).toBe("Enter to allow once");
    expect(hint.querySelector("kbd")!.textContent).toBe("Enter");
    // Enter is the focused button's own key: nothing listens for it anywhere else.
    fireEvent.blur(accept);
    expect(screen.queryByText("to allow once")).toBeNull();
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
      expect(screen.queryByText(/^to allow/)).toBeNull();
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
    const failed = await screen.findByRole("alert");
    expect(failed.textContent).toBe("No longer pending");
    // An error notice like the chat's others, not a line of red text.
    expect(failed.getAttribute("data-slot")).toBe("alert");
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  });
  it.each(["expired", "resolved"] as const)("has no action buttons for a %s request", (status) => {
    render(<ApprovalCard part={{ ...part(), status }} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("does not offer approval when the agent has finished", () => {
    useApp.setState({ running: false });
    render(<ApprovalCard part={part()} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("displays the automatic reviewer result and reason", () => {
    render(<ApprovalReview part={{ kind: "approvalReview", id: "r", status: "denied", detail: "Outside scope" }} />);
    expect(screen.getByText("Automatic review · Denied")).toBeTruthy();
    expect(screen.getByText("Outside scope")).toBeTruthy();
  });
});
