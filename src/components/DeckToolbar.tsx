import { deckMode, useApp } from "../store";
import { NarrationPanel } from "./NarrationPanel";
import { NotesPanel } from "./NotesPanel";

/**
 * The band under the top bar, for the modes that work on the slide's text: Narration and Notes.
 * In View and Edit the stage draws its own row of tools, which work on the slide it shows.
 */
export function DeckToolbar() {
  const hasDeck = useApp((s) => s.deck !== null);
  const mode = useApp(deckMode);
  if (!hasDeck) return null;
  if (mode === "narration") return <NarrationPanel />;
  if (mode === "notes") return <NotesPanel />;
  return null;
}
