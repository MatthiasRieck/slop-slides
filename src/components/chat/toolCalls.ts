import { FileText, Globe, type LucideIcon, Pencil, Search, SquareTerminal, Wrench } from "lucide-react";

import { basename, dirname } from "../../lib/utils";
import type { ChatPart } from "../../store";

export type ToolPart = Extract<ChatPart, { kind: "tool" }>;

/** How a tool call reads in the transcript: an icon, what it did, and what it did it to. */
export interface ToolDescription {
  icon: LucideIcon;
  label: string;
  target: string;
}

/**
 * The app's own tools (see src-tauri/src/mcp.rs), in plain words, with the argument that says
 * what each was used on.
 */
const APP_TOOLS: Record<string, { label: string; target: string }> = {
  lint_deck: { label: "Checked the deck's HTML", target: "path" },
  open_file: { label: "Opened", target: "path" },
  render_slide: { label: "Looked at the slides", target: "path" },
  set_narration_audio: { label: "Set the narration audio of", target: "slide" },
  narration_timeline: { label: "Read the narration timeline", target: "path" },
  narration_beats: { label: "Set the narration beats of", target: "slide" },
  generate_narration_audio: { label: "Generated narration audio", target: "path" },
  export_deck: { label: "Exported the deck as", target: "format" },
};

/** A tool's own name: what agents put before it for a tool of an MCP server (`mcp__server__`) is left out. */
export function toolName(name: string): string {
  return name.match(/^mcp__.+?__(.+)$/)?.[1] ?? name;
}

/** A tool's name as words: `fetch_page` and `fetchPage` read "Fetch page". */
function readable(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  // A name of one word keeps its capitals (`WebFetch` is two words, `Skill` one).
  return words.charAt(0).toUpperCase() + (words.includes(" ") ? words.slice(1).toLowerCase() : words.slice(1));
}

export function describeTool(part: ToolPart, deckId: string): ToolDescription {
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
    default: {
      const name = toolName(part.name);
      const own = APP_TOOLS[name];
      if (own) return { icon: Wrench, label: own.label, target: str(own.target) };
      return { icon: Wrench, label: readable(name), target: "" };
    }
  }
}

/** A tool call's arguments as the transcript lists them: text as it is, anything else as JSON. */
export function toolArguments(part: ToolPart): { name: string; value: string }[] {
  return Object.entries(part.input ?? {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => ({ name, value: typeof value === "string" ? value : JSON.stringify(value, null, 2) }));
}

/** No ids: what {@link editedIds} gives for every tool call that is not an edit of the deck file. */
const NO_IDS: readonly string[] = [];

/**
 * The ids (`id="…"`) written in the text a tool call edited, in the order to look for a slide
 * among them: those of the new text, then those of the text it took the place of. Empty unless
 * its `target` (see {@link describeTool}) is the deck file. Reading them takes a search through
 * the edit, so a tool call is asked once (see `ToolRow`), not each time the deck changes.
 */
export function editedIds(part: ToolPart, target: string, deckId: string): readonly string[] {
  if (target !== basename(deckId)) return NO_IDS;
  const ids: string[] = [];
  for (const key of ["new_string", "old_string"]) {
    const text = part.input[key];
    if (typeof text !== "string") continue;
    for (const match of text.matchAll(/\bid=["']([^"']+)["']/g)) {
      if (match[1]) ids.push(match[1]);
    }
  }
  return ids.length > 0 ? ids : NO_IDS;
}

/** The slide a tool call edited: the first of the `ids` its edit names that is a slide. */
export function editedSlide(ids: readonly string[], slides: ReadonlyMap<string, number>): string | null {
  return ids.find((id) => slides.has(id)) ?? null;
}

/**
 * A reply's parts as the transcript lays them out: tool calls in a row are one group of steps.
 * `key` tells a part from the others of its reply for as long as the reply lasts.
 */
export type PartGroup = { kind: "part"; part: ChatPart; key: string } | { kind: "steps"; tools: ToolPart[] };

/** What tells a part that has a name of its own from the others of its reply. */
function partKey(part: Exclude<ChatPart, { kind: "text" }>): string {
  return part.kind === "approval" ? part.approval.id : part.id;
}

/**
 * Lays out a reply's parts. With `fold`, tool calls that follow one another go into one group
 * of steps, so that a turn of thirty edits is one line; without it (while the reply comes in)
 * each shows as it happens. A tool call on its own stays as it is, as does everything else. Text
 * that is blank does not show, so it does not part two tool calls either.
 *
 * A text has no name, so its key is its place among the texts that show. That place stays: text
 * only comes in at the end, while a blank text before it may go at any time (the agent takes it
 * out when it calls a tool), which is why its place among all parts would not do.
 */
export function groupParts(parts: ChatPart[], fold = true): PartGroup[] {
  const groups: PartGroup[] = [];
  let run: ToolPart[] = [];
  let texts = 0;
  const close = () => {
    const [first] = run;
    if (run.length > 1) groups.push({ kind: "steps", tools: run });
    else if (first) groups.push({ kind: "part", part: first, key: first.id });
    run = [];
  };
  for (const part of parts) {
    if (part.kind === "tool" && fold) {
      run.push(part);
    } else if (part.kind !== "text") {
      close();
      groups.push({ kind: "part", part, key: partKey(part) });
    } else if (part.text.trim()) {
      close();
      groups.push({ kind: "part", part, key: `text-${texts++}` });
    }
  }
  close();
  return groups;
}

/** What a group of steps is called: "12 steps", and how many of them failed. */
export function stepsLabel(tools: ToolPart[]): string {
  const failed = tools.filter((tool) => tool.status === "error").length;
  return `${tools.length} steps${failed ? ` · ${failed} failed` : ""}`;
}
