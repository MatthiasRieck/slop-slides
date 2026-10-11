// Dev-only: when the UI runs in a plain browser, fake the Tauri IPC with read-only data
// served by dev/browserPreview.ts. Never loaded inside the desktop app.
import { emptyNarration, type NarrationDocument, type NarrationManifest } from "./narration";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

export function installBrowserMock() {
  mockWindows("main");
  /** The dev server's answer to `/__api/<route>?<query>`; a 404 is an error. */
  const fromServer = async (route: string, query: Record<string, string> = {}) => {
    const res = await fetch(`/__api/${route}?${new URLSearchParams(query)}`);
    if (!res.ok) throw new Error(`not found: ${Object.values(query).join(" ") || route}`);
    return res.json();
  };
  mockIPC(
    async (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      switch (cmd) {
        // The library is the only folder the preview can open.
        case "library_folder":
          return fromServer("library");
        case "recent_workspaces":
          return [];
        case "open_workspace": {
          const path = String(a.path);
          return { path, name: path.split("/").pop() };
        }
        case "list_dir":
          return fromServer("dir", { path: String(a.path) });
        case "open_file":
          return fromServer("open", { path: String(a.path) });
        case "open_deck":
        case "load_deck":
          return fromServer("deck", { id: String(a.id) });
        case "list_providers":
          return [
            {
              id: "claude",
              installed: true,
              path: "/mock/claude",
              models: [
                { id: "claude-opus-5-5", label: "Claude Opus 5.5", isDefault: true, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", contextWindows: ["200k", "1m"], defaultContextWindow: "1m" },
                { id: "claude-sonnet-5", label: "Claude Sonnet 5", isDefault: false, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", contextWindows: ["200k", "1m"], defaultContextWindow: "200k" },
              ],
              error: null,
            },
            { id: "codex", installed: false, path: null, models: [], error: null },
            {
              id: "copilot",
              installed: true,
              path: "/mock/copilot",
              models: [
                { id: "gpt-6-astra", label: "GPT-6 Astra", isDefault: false, efforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindows: [], defaultContextWindow: null },
                { id: "claude-sonnet-5", label: "Claude Sonnet 5", isDefault: false, efforts: [], defaultEffort: null, contextWindows: [], defaultContextWindow: null },
              ],
              error: null,
            },
          ];
        case "agent_running":
          return false;
        case "list_templates":
          return (await fetch("/__api/templates")).json();
        case "stage_template":
          return `/home/.slopslides/sessions/preview/templates/${String(a.template)}.html`;
        case "permission_modes":
          if (a.provider === "codex") throw new Error("Codex permissions require the desktop app.");
          return ["ask", "fullAccess"];
        case "lint_deck":
          return [];
        case "save_deck_source":
          throw new Error("Saving is not available in the browser preview.");
        case "prepare_video":
        case "export_video": throw new Error("Narrated video requires the macOS desktop app.");
        case "cancel_video":
        case "release_video": return;
        case "speech_status": return { providers: [], job: null };
        case "speech_takes": return {};
        case "speech_history": return [];
        case "select_speech_take": throw new Error("Recording selection requires the desktop app.");
        case "load_narration":
          return JSON.parse(localStorage.getItem(`mock-narration-${String(a.id)}`) ?? "null") ?? emptyNarration();
        case "save_narration": {
          const key = `mock-narration-${String(a.id)}`;
          const previous: NarrationDocument = JSON.parse(localStorage.getItem(key) ?? "null") ?? emptyNarration();
          if (previous.version !== a.base) throw new Error("Narration changed in the browser preview.");
          const next = { manifest: { ...(a.manifest as NarrationManifest), revision: previous.manifest.revision + 1 }, version: crypto.randomUUID() };
          localStorage.setItem(key, JSON.stringify(next));
          return next;
        }
        case "save_asset":
          return `assets/${String(a.name)}`;
        case "session_provider":
          return null;
        case "load_chat":
          return JSON.parse(localStorage.getItem(`mock-chat-${String(a.id)}`) ?? "null");
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
}
