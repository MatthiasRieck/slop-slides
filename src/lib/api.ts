import { invoke } from "@tauri-apps/api/core";

import type { Provider, ProviderInfo } from "./models";

export interface DeckSummary {
  id: string;
  title: string;
  slideCount: number;
  firstSlide: string | null;
  updatedMs: number;
}

export interface Slide {
  /** The slide's `id` attribute in deck.html. */
  id: string;
  /** Changes when the slide's markup changes. */
  hash: string;
}

export interface Deck {
  id: string;
  title: string;
  path: string;
  slides: Slide[];
  /** Changes when anything outside the slides (styles, fonts) changes. */
  shellHash: string;
}

export interface CreatedSlide {
  deck: Deck;
  slide: string;
}

export type AgentEvent =
  | { type: "started"; sessionId: string | null }
  | { type: "thinking" }
  | { type: "textStart" }
  | { type: "textDelta"; text: string }
  | { type: "toolUse"; id: string; name: string; input: Record<string, unknown> }
  | { type: "toolResult"; id: string; isError: boolean }
  | {
      type: "result";
      isError: boolean;
      text: string | null;
      costUsd: number | null;
      durationMs: number | null;
    }
  | { type: "error"; message: string }
  | { type: "finished"; interrupted: boolean };

export interface AgentEventEnvelope {
  deckId: string;
  event: AgentEvent;
}

export interface DeckChanged {
  deckId: string;
  paths: string[];
}

export const api = {
  listDecks: () => invoke<DeckSummary[]>("list_decks"),
  createDeck: (title: string) => invoke<Deck>("create_deck", { title }),
  openDeck: (id: string) => invoke<Deck>("open_deck", { id }),
  closeDeck: () => invoke<void>("close_deck"),
  loadDeck: (id: string) => invoke<Deck>("load_deck", { id }),
  renameDeck: (id: string, title: string) => invoke<Deck>("rename_deck", { id, title }),
  deleteDeck: (id: string) => invoke<void>("delete_deck", { id }),
  reorderSlides: (id: string, slides: string[]) => invoke<Deck>("reorder_slides", { id, slides }),
  addSlide: (id: string, after: string | null) => invoke<CreatedSlide>("add_slide", { id, after }),
  duplicateSlide: (id: string, slide: string) =>
    invoke<CreatedSlide>("duplicate_slide", { id, slide }),
  deleteSlide: (id: string, slide: string) => invoke<Deck>("delete_slide", { id, slide }),
  importAssets: (id: string, paths: string[]) => invoke<string[]>("import_assets", { id, paths }),
  exportDeck: (id: string, dest: string) => invoke<void>("export_deck", { id, dest }),
  loadChat: (id: string) => invoke<unknown>("load_chat", { id }),
  saveChat: (id: string, chat: unknown) => invoke<void>("save_chat", { id, chat }),
  resetChat: (id: string) => invoke<void>("reset_chat", { id }),
  sendMessage: (
    deckId: string,
    prompt: string,
    selection: { provider: Provider; model: string; effort: string },
  ) => invoke<void>("send_message", { args: { deckId, prompt, ...selection } }),
  interruptAgent: (id: string) => invoke<void>("interrupt_agent", { id }),
  agentRunning: (id: string) => invoke<boolean>("agent_running", { id }),
  listProviders: () => invoke<ProviderInfo[]>("list_providers"),
};

export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}
