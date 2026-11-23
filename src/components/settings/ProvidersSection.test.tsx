import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import type { ProviderInfo, ProviderModel } from "../../lib/models";
import { defaultSettings, type EnvironmentCheck, patchSettings, type SettingsPatch } from "../../lib/settings";
import { useApp } from "../../store";
import { lastError } from "../../store/errors";
import { backend, calls, type Handler, invoke, listen } from "../../test/tauri";
import { lockReason, ProvidersSection } from "./ProvidersSection";

const model = (id: string, label: string): ProviderModel => ({
  id,
  label,
  isDefault: true,
  efforts: [],
  defaultEffort: null,
  contextWindows: [],
  defaultContextWindow: null,
});

const PROVIDERS: ProviderInfo[] = [
  {
    id: "claude",
    installed: true,
    path: "/usr/local/bin/claude",
    models: [model("claude-opus-5-5", "Claude Opus 5.5"), model("claude-sonnet-5", "Claude Sonnet 5")],
    error: null,
    version: "2.1.327",
    auth: "signedIn",
  },
  {
    id: "codex",
    installed: true,
    path: "/opt/bin/codex",
    models: [],
    error: "Codex reported no models. Run `codex` to sign in.",
    version: "0.99.0",
    auth: "signedOut",
  },
  { id: "copilot", installed: false, path: null, models: [], error: null, version: null, auth: "unknown" },
];

const ENVIRONMENT: EnvironmentCheck[] = [
  { id: "git", ok: true, detail: "/usr/bin/git" },
  { id: "mcpConfig", ok: true, detail: "No ~/.slopslides/mcp.json; nothing to load." },
];

const SELECTION = {
  provider: "claude",
  model: "claude-opus-5-5",
  label: "Claude Opus 5.5",
  effort: "medium",
  contextWindow: null,
} as const;

/** The backend as the section asks it: the providers, who is busy, the environment, and the settings it keeps. */
function serve(handlers: Record<string, Handler> = {}, initial: SettingsPatch = {}) {
  let settings = patchSettings(defaultSettings(), initial);
  useApp.setState({ settings });
  backend({
    list_providers: () => PROVIDERS,
    busy_providers: () => [],
    check_environment: () => ENVIRONMENT,
    update_settings: ({ patch }) => {
      settings = patchSettings(settings, patch as SettingsPatch);
      return settings;
    },
    ...handlers,
  });
}

beforeEach(() => {
  invoke.mockReset();
  useApp.setState({
    toasts: [],
    settings: defaultSettings(),
    providers: PROVIDERS,
    running: false,
    messages: [],
    sessionProvider: null,
    selection: SELECTION,
  });
});

const row = (id: string) => within(screen.getByTestId(`provider-${id}`));
const toggle = (name: string) => screen.getByRole("switch", { name });
/** Whether a provider's switch is locked: it says so, and takes no press. */
const locked = (name: string) => toggle(name).getAttribute("aria-disabled") === "true";
/** The section once its first check is through. */
async function shown() {
  render(<ProvidersSection />);
  await waitFor(() => expect(screen.queryByText("Checking…")).toBeNull());
}
const patches = () => calls("update_settings").map((args) => args.patch);

describe("ProvidersSection", () => {
  it("lists the three providers in order, each with what the check found", async () => {
    serve();
    await shown();
    expect(screen.getAllByRole("switch").map((s) => s.getAttribute("aria-label"))).toEqual([
      "Claude Code",
      "Codex",
      "GitHub Copilot",
    ]);
    const claude = row("claude");
    expect(claude.getByRole("heading", { name: "Claude Code" })).toBeTruthy();
    expect(claude.getByTestId("provider-version").textContent).toBe("2.1.327");
    expect(claude.getByTestId("provider-path").textContent).toBe("/usr/local/bin/claude");
    expect(claude.getByText("Ready")).toBeTruthy();
    expect(claude.getByText("Signed in · 2 models")).toBeTruthy();
    // The status is a badge, a dot in the colour of its tone before the word.
    const ready = claude.getByText("Ready");
    expect(ready.dataset.slot).toBe("badge");
    expect(ready.querySelector("[data-tone]")).toHaveProperty("className", expect.stringContaining("bg-success"));
  });

  it("says what is missing, with the command to copy", async () => {
    serve();
    await shown();
    const codex = row("codex");
    expect(codex.getByText("Not signed in")).toBeTruthy();
    expect(codex.getByText("codex login").tagName).toBe("CODE");
    expect(codex.getByRole("button", { name: "Copy codex login" })).toBeTruthy();
    expect(codex.getByTestId("provider-version").textContent).toBe("0.99.0");
    const copilot = row("copilot");
    expect(copilot.getByText("Not installed")).toBeTruthy();
    expect(copilot.getByRole("button", { name: "Copy npm i -g @github/copilot" })).toBeTruthy();
    expect(copilot.queryByTestId("provider-version")).toBeNull();
    expect(copilot.queryByTestId("provider-path")).toBeNull();
  });

  it("gives the error of a provider that needs attention", async () => {
    serve({
      list_providers: () =>
        PROVIDERS.map((p) => (p.id === "codex" ? { ...p, auth: "unknown", error: "timed out after 10 s" } : p)),
    });
    await shown();
    expect(row("codex").getByText("Needs attention")).toBeTruthy();
    expect(row("codex").getByText("timed out after 10 s")).toBeTruthy();
    expect(screen.getByTestId("provider-codex").querySelector("[data-tone='destructive']")).toBeTruthy();
  });

  it("checks as it opens: the providers, who is working, and the environment", async () => {
    let answer!: (providers: ProviderInfo[]) => void;
    serve({ list_providers: () => new Promise((resolve) => (answer = resolve)) });
    render(<ProvidersSection />);
    // Meanwhile every provider says so, and what was known stays in the store.
    expect(screen.getAllByText("Checking…").length).toBeGreaterThanOrEqual(3);
    expect(useApp.getState().providers).toBe(PROVIDERS);
    const again = screen.getByRole("button", { name: "Check again" }) as HTMLButtonElement;
    expect(again.disabled).toBe(true);
    // Busy, with a spinner that the button's name already speaks for.
    expect(again.getAttribute("aria-busy")).toBe("true");
    expect(again.querySelector("[data-slot=spinner]")!.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("status")).toBeNull();
    await waitFor(() => expect(calls("list_providers")).toHaveLength(1));
    await act(async () => answer(PROVIDERS));
    await waitFor(() => expect(screen.queryByText("Checking…")).toBeNull());
    expect(again.getAttribute("aria-busy")).toBeNull();
    expect(again.querySelector("[data-slot=spinner]")).toBeNull();
    expect(calls("list_providers")).toHaveLength(1);
    expect(calls("busy_providers")).toHaveLength(1);
    expect(calls("check_environment")).toHaveLength(1);
  });

  it("checks again when asked, showing what changed", async () => {
    let providers = PROVIDERS;
    serve({ list_providers: () => providers });
    await shown();
    providers = PROVIDERS.map((p) =>
      p.id === "copilot" ? { ...PROVIDERS[0]!, id: "copilot", path: "/bin/copilot" } : p,
    );
    const again = screen.getByRole("button", { name: "Check again" }) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    await act(async () => fireEvent.click(again));
    await waitFor(() => expect(row("copilot").getByText("Ready")).toBeTruthy());
    expect(calls("list_providers")).toHaveLength(2);
    expect(calls("busy_providers")).toHaveLength(2);
    expect(calls("check_environment")).toHaveLength(2);
  });

  it("turns a provider off and on through the app's settings", async () => {
    serve();
    await shown();
    expect(toggle("Codex").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle("Codex"));
    expect(patches()).toEqual([{ providers: { codex: { enabled: false } } }]);
    await waitFor(() => expect(toggle("Codex").getAttribute("aria-checked")).toBe("false"));
    expect(useApp.getState().settings.providers.codex.enabled).toBe(false);
    fireEvent.click(toggle("Codex"));
    await waitFor(() => expect(toggle("Codex").getAttribute("aria-checked")).toBe("true"));
    expect(patches()[1]).toEqual({ providers: { codex: { enabled: true } } });
  });

  it("shows a provider that is off dimmed, and checked all the same", async () => {
    serve({}, { providers: { codex: { enabled: false } } });
    await shown();
    const codex = screen.getByTestId("provider-codex");
    expect(codex.dataset.enabled).toBe("false");
    expect(within(codex).getByText("Turned off").dataset.slot).toBe("badge");
    expect(within(codex).getByText("Not signed in").closest(".opacity-60")).toBeTruthy();
    expect(within(codex).getByTestId("provider-path").textContent).toBe("/opt/bin/codex");
    // Its switch is not dimmed, and not locked: that is how it comes back.
    expect(toggle("Codex").closest(".opacity-60")).toBeNull();
    expect(locked("Codex")).toBe(false);
    expect(screen.getByTestId("provider-claude").dataset.enabled).toBe("true");
    expect(row("claude").queryByText("Turned off")).toBeNull();
  });

  it("locks the switch of the last provider that is on, saying why", async () => {
    serve({}, { providers: { codex: { enabled: false }, copilot: { enabled: false } } });
    await shown();
    expect(locked("Claude Code")).toBe(true);
    expect(row("claude").getByText("At least one provider has to stay on.")).toBeTruthy();
    expect(toggle("Claude Code").getAttribute("aria-describedby")).toBe(
      row("claude").getByText("At least one provider has to stay on.").id,
    );
    expect(locked("Codex")).toBe(false);
    fireEvent.click(toggle("Claude Code"));
    expect(patches()).toEqual([]);
  });

  it("locks the switch of a provider working in a chat of another window, saying why", async () => {
    serve({ busy_providers: () => ["codex"] });
    await shown();
    expect(locked("Codex")).toBe(true);
    expect(row("codex").getByText("Codex is working in a chat. Stop it or wait for it to finish.")).toBeTruthy();
    expect(locked("Claude Code")).toBe(false);
    expect(row("claude").queryByText(/is working in a chat/)).toBeNull();
  });

  it("locks the switch of the provider working in this window's chat, without asking", async () => {
    serve();
    await shown();
    expect(locked("Claude Code")).toBe(false);
    act(() => useApp.setState({ running: true, sessionProvider: "claude" }));
    expect(locked("Claude Code")).toBe(true);
    expect(row("claude").getByText("Claude Code is working in a chat. Stop it or wait for it to finish.")).toBeTruthy();
    act(() => useApp.setState({ running: false }));
    expect(locked("Claude Code")).toBe(false);
  });

  it("frees the switch as this window's turn ends, though the check found its provider busy", async () => {
    // The backend counts this window's turn too.
    let busy = ["claude"];
    serve({ busy_providers: () => busy });
    useApp.setState({ running: true, sessionProvider: "claude" });
    await shown();
    expect(locked("Claude Code")).toBe(true);
    busy = [];
    act(() => useApp.setState({ running: false }));
    await waitFor(() => expect(locked("Claude Code")).toBe(false));
    expect(row("claude").queryByText(/is working in a chat/)).toBeNull();
  });

  it("frees the switch as a turn in another window ends", async () => {
    let busy = ["codex"];
    serve({ busy_providers: () => busy });
    await shown();
    expect(locked("Codex")).toBe(true);
    const agentEvent = (event: unknown) =>
      act(async () => {
        for (const [name, handler] of listen.mock.calls) {
          if (name === "agent-event") handler({ payload: { chat: "/elsewhere/deck.html", event } });
        }
      });
    // What a turn says on its way asks nothing.
    const asked = calls("busy_providers").length;
    await agentEvent({ type: "text", text: "…" });
    expect(calls("busy_providers")).toHaveLength(asked);
    busy = [];
    await agentEvent({ type: "finished", interrupted: false });
    await waitFor(() => expect(locked("Codex")).toBe(false));
  });

  it("keeps the newest answer of who is busy, whatever order the answers come in", async () => {
    // The check's question is answered only after the one a turn's end asked.
    let answerFirst: (busy: string[]) => void = () => {};
    let asked = 0;
    serve({
      busy_providers: () => (asked++ === 0 ? new Promise((resolve) => (answerFirst = resolve)) : []),
    });
    useApp.setState({ running: true, sessionProvider: "claude" });
    render(<ProvidersSection />);
    await waitFor(() => expect(asked).toBe(1));
    act(() => useApp.setState({ running: false }));
    await waitFor(() => expect(asked).toBe(2));
    await act(async () => answerFirst(["claude"]));
    await waitFor(() => expect(screen.queryByText("Checking…")).toBeNull());
    expect(locked("Claude Code")).toBe(false);
  });

  it("shows the backend's reason for a refused change, the switch staying on and locking", async () => {
    const reason = "Codex is working in a chat. Stop it or wait for it to finish before turning it off.";
    let busy: string[] = [];
    serve({
      busy_providers: () => busy,
      update_settings: () => {
        // A chat in another window started after the check.
        busy = ["codex"];
        throw reason;
      },
    });
    await shown();
    await act(async () => fireEvent.click(toggle("Codex")));
    expect(lastError(useApp.getState())).toBe(reason);
    expect(toggle("Codex").getAttribute("aria-checked")).toBe("true");
    expect(useApp.getState().settings.providers.codex.enabled).toBe(true);
    await waitFor(() => expect(locked("Codex")).toBe(true));
  });

  it("shows what the agents need from the computer", async () => {
    serve({
      check_environment: () => [
        { id: "git", ok: false, detail: "git was not found." },
        { id: "mcpConfig", ok: true, detail: "No ~/.slopslides/mcp.json; nothing to load." },
      ],
    });
    await shown();
    expect(screen.getByRole("heading", { name: "Environment" })).toBeTruthy();
    const git = screen.getByTestId("environment-git");
    expect(within(git).getByText("git")).toBeTruthy();
    expect(within(git).getByText("git was not found.")).toBeTruthy();
    expect(git.querySelector("[data-tone='destructive']")).toBeTruthy();
    const mcp = screen.getByTestId("environment-mcpConfig");
    expect(within(mcp).getByText("No ~/.slopslides/mcp.json; nothing to load.")).toBeTruthy();
    expect(mcp.querySelector("[data-tone='success']")).toBeTruthy();
  });

  it("says so when the environment could not be checked, and still shows the providers", async () => {
    serve({
      check_environment: () => {
        throw "The home folder could not be located.";
      },
      busy_providers: () => {
        throw "no";
      },
    });
    await shown();
    expect(screen.getByText("Could not check")).toBeTruthy();
    expect(screen.getByText("The home folder could not be located.")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Could not checkThe home folder could not be located.");
    expect(row("claude").getByText("Ready")).toBeTruthy();
    expect(locked("Claude Code")).toBe(false);
  });
});

describe("lockReason", () => {
  it("is null while a provider can be turned off", () => {
    expect(lockReason("codex", 2, false)).toBeNull();
  });

  it("names the running chat before the last provider", () => {
    expect(lockReason("copilot", 1, true)).toBe(
      "GitHub Copilot is working in a chat. Stop it or wait for it to finish.",
    );
    expect(lockReason("copilot", 1, false)).toBe("At least one provider has to stay on.");
  });
});
