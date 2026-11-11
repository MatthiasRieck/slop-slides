import { FileText, Globe, type LucideIcon, Pencil, Search, SquareTerminal } from "lucide-react";

import { basename, dirname } from "../../lib/utils";
import type { ChatPart } from "../../store";

export type ToolPart = Extract<ChatPart, { kind: "tool" }>;

/** How a tool call reads in the transcript: an icon, what it did, and what it did it to. */
export function describeTool(part: ToolPart, deckId: string): { icon: LucideIcon; label: string; target: string } {
  const input = part.input;
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  // Tool paths are absolute inside the deck folder; show them deck-relative.
  const folder = dirname(deckId).replaceAll("\\", "/");
  const relative = (path: string) => {
    const normalized = path.replaceAll("\\", "/");
    return folder && normalized.startsWith(`${folder}/`) ? normalized.slice(folder.length + 1) : normalized;
  };
  switch (part.name) {
    case "Write":
      return { icon: FileText, label: "Wrote", target: relative(str("file_path")) };
    case "Edit":
    case "MultiEdit":
      return { icon: Pencil, label: "Edited", target: relative(str("file_path")) };
    case "Read":
      return { icon: FileText, label: "Read", target: relative(str("file_path")) };
    case "Glob":
    case "Grep":
      return { icon: Search, label: "Searched", target: str("pattern") };
    case "WebSearch":
      return { icon: Globe, label: "Searched the web for", target: str("query") };
    case "WebFetch":
      return { icon: Globe, label: "Fetched", target: str("url") };
    case "Bash":
      return { icon: SquareTerminal, label: "Ran", target: str("command") };
    default:
      return { icon: FileText, label: part.name, target: "" };
  }
}

/** A tool call's arguments as the transcript lists them: text as it is, anything else as JSON. */
export function toolArguments(part: ToolPart): { name: string; value: string }[] {
  return Object.entries(part.input ?? {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => ({ name, value: typeof value === "string" ? value : JSON.stringify(value, null, 2) }));
}

/**
 * The slide of the deck a tool call edited, when its `target` (see {@link describeTool}) is the
 * deck file: found via an `id="…"` of one of `slideIds` in the edited text.
 */
export function editedSlide(part: ToolPart, target: string, deckId: string, slideIds: string[]): string | null {
  if (target !== basename(deckId)) return null;
  for (const key of ["new_string", "old_string"]) {
    const text = part.input[key];
    if (typeof text !== "string") continue;
    for (const match of text.matchAll(/\bid=["']([^"']+)["']/g)) {
      if (match[1] && slideIds.includes(match[1])) return match[1];
    }
  }
  return null;
}
