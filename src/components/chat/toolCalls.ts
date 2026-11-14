import { Eye, FileText, Globe, type LucideIcon, Pencil, Search, SquareTerminal, Wrench } from "lucide-react";

import { basename, dirname, plural } from "../../lib/utils";
import type { ChatPart } from "../../store";

export type ToolPart = Extract<ChatPart, { kind: "tool" }>;
export type ApprovalPart = Extract<ChatPart, { kind: "approval" }>;
/** What a group of steps holds: tool calls, and the requests among them that were answered. */
export type StepPart = ToolPart | ApprovalPart;

/** The kinds of things a tool call does, which a group of steps is summed up by. */
export type ToolKind = "edit" | "read" | "search" | "web" | "command" | "look" | "other";

/** How a tool call reads in the transcript: an icon, what it did, and what it did it to. */
export interface ToolDescription {
  icon: LucideIcon;
  label: string;
  target: string;
  /** What the call is doing while it runs, for the reply's status line: "Editing deck.html…". */
  doing: string;
  kind: ToolKind;
}

/**
 * The app's own tools (see src-tauri/src/mcp.rs), in plain words, with the argument that says
 * what each was used on.
 */
const APP_TOOLS: Record<string, { label: string; doing: string; target: string; kind?: ToolKind }> = {
  lint_deck: { label: "Checked the deck's HTML", doing: "Checking the deck…", target: "path" },
  open_file: { label: "Opened", doing: "Opening a file…", target: "path" },
  render_slide: { label: "Looked at the slides", doing: "Looking at the slides…", target: "path", kind: "look" },
  set_narration_audio: { label: "Set the narration audio of", doing: "Setting narration audio…", target: "slide" },
  narration_timeline: {
    label: "Read the narration timeline",
    doing: "Reading the narration timeline…",
    target: "path",
  },
  narration_beats: { label: "Set the narration beats of", doing: "Setting narration beats…", target: "slide" },
  generate_narration_audio: {
    label: "Generated narration audio",
    doing: "Generating narration audio…",
    target: "path",
  },
  export_deck: { label: "Exported the deck as", doing: "Exporting the deck…", target: "format" },
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
  /** "Editing deck.html…": what is done to the file, named without its folders. */
  const onFile = (verb: string, path: string) => (path ? `${verb} ${basename(path)}…` : `${verb} a file…`);
  switch (part.name) {
    case "Write": {
      const target = relative(str("file_path"));
      return { icon: FileText, label: "Wrote", target, doing: onFile("Writing", target), kind: "edit" };
    }
    case "Edit":
    case "MultiEdit": {
      const target = relative(str("file_path"));
      return { icon: Pencil, label: "Edited", target, doing: onFile("Editing", target), kind: "edit" };
    }
    case "Read": {
      const target = relative(str("file_path"));
      return { icon: FileText, label: "Read", target, doing: onFile("Reading", target), kind: "read" };
    }
    case "Glob":
    case "Grep":
      return { icon: Search, label: "Searched", target: str("pattern"), doing: "Searching the files…", kind: "search" };
    case "WebSearch":
      return {
        icon: Globe,
        label: "Searched the web for",
        target: str("query"),
        doing: "Searching the web…",
        kind: "web",
      };
    case "WebFetch":
      return { icon: Globe, label: "Fetched", target: str("url"), doing: "Reading a web page…", kind: "web" };
    case "Bash":
      return {
        icon: SquareTerminal,
        label: "Ran",
        target: str("command"),
        doing: "Running a command…",
        kind: "command",
      };
    default: {
      const name = toolName(part.name);
      const own = APP_TOOLS[name];
      if (own) {
        const icon = own.kind === "look" ? Eye : Wrench;
        return { icon, label: own.label, target: str(own.target), doing: own.doing, kind: own.kind ?? "other" };
      }
      return { icon: Wrench, label: readable(name), target: "", doing: `${readable(name)}…`, kind: "other" };
    }
  }
}

/** A tool call's arguments as the transcript lists them: text as it is, anything else as JSON. */
export function toolArguments(part: ToolPart): { name: string; value: string }[] {
  return Object.entries(part.input ?? {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => ({ name, value: typeof value === "string" ? value : JSON.stringify(value, null, 2) }));
}

/** One replacement of text a tool call made in a file: what was there, and what took its place. */
export interface TextEdit {
  before: string;
  after: string;
}

/**
 * The replacements an edit made, to show as a before and after: one for `Edit`, each of its
 * `edits` for `MultiEdit`, and the whole new text for `Write`. Null for every other tool, and
 * for an edit whose arguments are not the texts this expects.
 */
export function textEdits(part: ToolPart): TextEdit[] | null {
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const edit = (input: Record<string, unknown>): TextEdit | null => {
    const before = text(input.old_string);
    const after = text(input.new_string);
    return before === null || after === null ? null : { before, after };
  };
  if (part.name === "Edit") {
    const one = edit(part.input);
    return one ? [one] : null;
  }
  if (part.name === "MultiEdit") {
    if (!Array.isArray(part.input.edits)) return null;
    const all = part.input.edits.map((item) => (item && typeof item === "object" ? edit(item) : null));
    return all.length > 0 && all.every((item) => item !== null) ? (all as TextEdit[]) : null;
  }
  if (part.name === "Write") {
    const content = text(part.input.content);
    return content === null ? null : [{ before: "", after: content }];
  }
  return null;
}

/** No ids: what {@link editedIds} gives for every tool call that is not an edit of the deck file. */
const NO_IDS: readonly string[] = [];

/** The texts an edit of a file wrote and replaced, the new ones first. */
function editedTexts(part: ToolPart): string[] {
  const texts: string[] = [];
  const take = (input: Record<string, unknown>, key: string) => {
    if (typeof input[key] === "string") texts.push(input[key] as string);
  };
  const edits = Array.isArray(part.input.edits) ? (part.input.edits as Record<string, unknown>[]) : [];
  for (const key of ["new_string", "old_string"]) {
    take(part.input, key);
    for (const edit of edits) if (edit && typeof edit === "object") take(edit, key);
  }
  return texts;
}

/**
 * The ids (`id="…"`) written in the text a tool call edited, in the order to look for a slide
 * among them: those of the new text, then those of the text it took the place of. Empty unless
 * its `target` (see {@link describeTool}) is the deck file. Reading them takes a search through
 * the edit, so a tool call is asked once (see `ToolRow`), not each time the deck changes.
 */
export function editedIds(part: ToolPart, target: string, deckId: string): readonly string[] {
  if (target !== basename(deckId)) return NO_IDS;
  const ids: string[] = [];
  for (const text of editedTexts(part)) {
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
 * A reply's parts as the transcript lays them out: steps in a row are one group. `key` tells a
 * part from the others of its reply for as long as the reply lasts.
 */
export type PartGroup = { kind: "part"; part: ChatPart; key: string } | { kind: "steps"; steps: StepPart[] };

/** What tells a part that has a name of its own from the others of its reply. */
export function partKey(part: Exclude<ChatPart, { kind: "text" }>): string {
  return part.kind === "approval" ? part.approval.id : part.id;
}

/** Whether `part` is a step: a tool call, or a request that was answered (one that waits stands out by itself). */
function isStep(part: ChatPart): part is StepPart {
  return part.kind === "tool" || (part.kind === "approval" && part.status !== "pending");
}

/**
 * Lays out a reply's parts: steps that follow one another go into one group, so that a turn of
 * thirty edits is one line. A step on its own stays as it is, as does everything else. Text that
 * is blank does not show, so it does not part two steps either.
 *
 * While the reply comes in (`streaming`), the transcript stays as calm: the steps done fold as
 * they go, and only the newest step of the reply's end, the one running or just finished, shows
 * as a row of its own after them.
 *
 * A text has no name, so its key is its place among the texts that show. That place stays: text
 * only comes in at the end, while a blank text before it may go at any time (the agent takes it
 * out when it calls a tool), which is why its place among all parts would not do.
 */
export function groupParts(parts: ChatPart[], streaming = false): PartGroup[] {
  const groups: PartGroup[] = [];
  let run: StepPart[] = [];
  let texts = 0;
  const single = (step: StepPart) => groups.push({ kind: "part", part: step, key: partKey(step) });
  const close = (atEnd = false) => {
    // The newest step of a reply still coming in shows by itself.
    const newest = atEnd && streaming && run.length > 1 ? run.pop() : undefined;
    const [first] = run;
    if (run.length > 1) groups.push({ kind: "steps", steps: run });
    else if (first) single(first);
    if (newest) single(newest);
    run = [];
  };
  for (const part of parts) {
    if (isStep(part)) {
      run.push(part);
    } else if (part.kind !== "text") {
      close();
      groups.push({ kind: "part", part, key: partKey(part) });
    } else if (part.text.trim()) {
      close();
      groups.push({ kind: "part", part, key: `text-${texts++}` });
    }
  }
  close(true);
  return groups;
}

/** What a step of a group counts as: its kind, and what tells it from another of its kind. */
export interface StepFact {
  kind: ToolKind;
  /** What the call was used on. */
  target: string;
  /** Whether that is the deck file. */
  onDeck: boolean;
  /** The ids its edit of the deck names (see {@link editedIds}). */
  ids: readonly string[];
  failed: boolean;
}

/**
 * What each tool call of a group of steps did, read once: summing the group up again as the
 * deck changes (see {@link stepsLabel}) then takes no search through the edits.
 */
export function stepFacts(steps: readonly StepPart[], deckId: string): StepFact[] {
  return steps.flatMap((step) => {
    if (step.kind !== "tool") return [];
    const { kind, target } = describeTool(step, deckId);
    const onDeck = !!deckId && target === basename(deckId);
    return [{ kind, target, onDeck, ids: editedIds(step, target, deckId), failed: step.status === "error" }];
  });
}

/** How many kinds of steps a group names before the rest are counted as "more". */
const KINDS_NAMED = 3;

/**
 * What a group of steps did, by kind, in the order the kinds first came: "Edited 3 slides, read
 * 2 files, ran 1 command · 1 failed". Edits of the deck count the slides they touched (`slides`
 * numbers the deck's), edits of anything else the files; after three kinds the rest are "N more".
 */
export function stepsLabel(facts: readonly StepFact[], slides: ReadonlyMap<string, number>): string {
  const kinds: ToolKind[] = [];
  for (const fact of facts) if (!kinds.includes(fact.kind)) kinds.push(fact.kind);
  const of = (kind: ToolKind) => facts.filter((fact) => fact.kind === kind);
  const phrase = (kind: ToolKind): string => {
    const steps = of(kind);
    const distinct = (values: string[]) => new Set(values.filter(Boolean)).size;
    switch (kind) {
      case "edit": {
        const edited = new Set<string>();
        const files = new Set<string>();
        // An edit of the deck that names no slide (its styles, say) is an edit of the deck.
        let deck = false;
        for (const step of steps) {
          const slide = step.onDeck ? editedSlide(step.ids, slides) : null;
          if (slide) edited.add(slide);
          else if (step.onDeck) deck = true;
          else files.add(step.target);
        }
        return [
          edited.size > 0 ? `edited ${plural(edited.size, "slide")}` : deck && "edited the deck",
          files.size > 0 && `edited ${plural(files.size, "file")}`,
        ]
          .filter(Boolean)
          .join(", ");
      }
      case "read":
        return `read ${plural(distinct(steps.map((step) => step.target)) || steps.length, "file")}`;
      case "search":
        return steps.length === 1 ? "searched the files" : `searched the files ${steps.length} times`;
      case "web":
        return steps.length === 1 ? "used the web" : `used the web ${steps.length} times`;
      case "command":
        return `ran ${plural(steps.length, "command")}`;
      case "look":
        return "looked at the slides";
      case "other":
        return `${plural(steps.length, "other step")}`;
    }
  };
  const named = kinds.slice(0, KINDS_NAMED).map(phrase);
  const more = kinds.slice(KINDS_NAMED).reduce((count, kind) => count + of(kind).length, 0);
  if (more > 0) named.push(`${more} more`);
  const text = named.join(", ") || plural(facts.length, "step");
  const failed = facts.filter((fact) => fact.failed).length;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}${failed ? ` · ${failed} failed` : ""}`;
}
