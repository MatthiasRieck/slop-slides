// Dev-only: when the UI runs in a plain browser, fake the Tauri IPC with read-only data
// served by dev/browserPreview.ts. Never loaded inside the desktop app.
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
                {
                  id: "claude-opus-5-5",
                  label: "Claude Opus 5.5",
                  isDefault: true,
                  efforts: ["low", "medium", "high", "xhigh", "max"],
                  defaultEffort: "medium",
                  contextWindows: ["200k", "1m"],
                  defaultContextWindow: "1m",
                },
                {
                  id: "claude-sonnet-5",
                  label: "Claude Sonnet 5",
                  isDefault: false,
                  efforts: ["low", "medium", "high", "xhigh", "max"],
                  defaultEffort: "medium",
                  contextWindows: ["200k", "1m"],
                  defaultContextWindow: "200k",
                },
              ],
              error: null,
            },
            { id: "codex", installed: false, path: null, models: [], error: null },
            {
              id: "copilot",
              installed: true,
              path: "/mock/copilot",
              models: [
                {
                  id: "gpt-6-astra",
                  label: "GPT-6 Astra",
                  isDefault: false,
                  efforts: ["low", "medium", "high"],
                  defaultEffort: "medium",
                  contextWindows: [],
                  defaultContextWindow: null,
                },
                {
                  id: "claude-sonnet-5",
                  label: "Claude Sonnet 5",
                  isDefault: false,
                  efforts: [],
                  defaultEffort: null,
                  contextWindows: [],
                  defaultContextWindow: null,
                },
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
        case "save_asset":
          return `assets/${String(a.name)}`;
        case "copy_to_clipboard":
        case "copy_slide":
        case "new_window":
        case "present_on":
        case "close_presenter_view":
          return null;
        case "list_screens":
          return [];
        case "paste_slide":
        case "take_pending_folder":
          return null;
        case "paste_from_clipboard":
          return { kind: "nothing" };
        case "read_clipboard_text":
          return "";
        case "find_in_deck":
          return [];
        case "replace_in_deck":
          throw new Error("Replacing is not available in the browser preview.");
        case "session_provider":
          return null;
        case "voice_status":
          return { modelReady: false, modelBytes: 190_085_487, downloading: false, recording: false };
        case "download_voice_model":
        case "start_recording":
          throw new Error("Voice input requires the desktop app.");
        case "speech_status":
          return {
            available: false,
            modelReady: false,
            modelBytes: 2_498_383_610,
            downloading: false,
            rendering: null,
            voices: [{ id: "ryan", name: "Ryan", description: "Dynamic male voice", native: "en" }],
            languages: [{ id: "en", name: "English" }],
          };
        case "narration_audio":
          return [];
        case "download_speech_model":
        case "render_narration":
        case "set_narration_voice":
        case "set_narration_language":
          throw new Error("Narration requires the desktop app.");
        case "load_chat":
          return JSON.parse(localStorage.getItem(`mock-chat-${String(a.id)}`) ?? "null");
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
}
