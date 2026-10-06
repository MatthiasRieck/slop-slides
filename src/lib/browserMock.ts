// Dev-only: when the UI runs in a plain browser, fake the Tauri IPC with read-only data
// served by dev/browserPreview.ts. Never loaded inside the desktop app.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

interface RawDeck {
  id: string;
  title: string;
  path: string;
  slides: { id: string; hash: string; hidden: boolean; moved: boolean }[];
  sections: { index: number; title: string; before: number }[];
  shellHash: string;
  updatedMs: number;
}

export function installBrowserMock() {
  mockWindows("main");
  const decks = async () => (await (await fetch("/__api/decks")).json()) as RawDeck[];
  const deck = async (id: unknown) => {
    const found = (await decks()).find((d) => d.id === id);
    if (!found) throw new Error(`deck not found: ${String(id)}`);
    return { id: found.id, title: found.title, path: found.path, slides: found.slides, sections: found.sections, shellHash: found.shellHash };
  };
  mockIPC(
    async (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      switch (cmd) {
        case "list_decks":
          return (await decks()).map((d) => ({
            id: d.id,
            title: d.title,
            slideCount: d.slides.length,
            firstSlide: d.slides[0]?.id ?? null,
            updatedMs: d.updatedMs,
          }));
        case "open_deck":
        case "load_deck":
          return deck(a.id);
        case "list_providers":
          return [
            {
              id: "claude",
              installed: true,
              path: "/mock/claude",
              models: [
                { id: "claude-opus-5-5", label: "Claude Opus 5.5", isDefault: true, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
                { id: "claude-sonnet-5", label: "Claude Sonnet 5", isDefault: false, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
              ],
              error: null,
            },
            { id: "codex", installed: false, path: null, models: [], error: null },
          ];
        case "agent_running":
          return false;
        case "lint_deck":
          return [];
        case "save_deck_source":
          throw new Error("Saving is not available in the browser preview.");
        case "load_chat":
          return JSON.parse(localStorage.getItem(`mock-chat-${String(a.id)}`) ?? "null");
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
}
