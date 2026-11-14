import { Check, Search } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";

import { COMMANDS, commandChecked, commandContext, commandEnabled, runCommand } from "../commands";
import { closePalette } from "../commands/palette";
import { type Found, loadRecent, menuLabel, noteRecent, searchCommands } from "../lib/commands";
import { formatKeys, isMod } from "../lib/keys";
import { cn } from "../lib/utils";
import { Dialog } from "./Dialog";
import { inputClass } from "./Field";
import { SectionLabel } from "./SectionLabel";

/** A choice of the palette: a command, or going to a slide by its number. */
export interface PaletteItem {
  id: string;
  title: string;
  /** The menu it is in, by the name the menu bar shows. */
  group: string;
  keys?: string;
  hint?: string;
  /** True, or why it cannot run now. */
  enabled: true | string;
  /** On or off, for a command that is one or the other. */
  checked?: boolean;
  run: () => void;
}

/** The choices for `query` as the app is now: every command, and "Go to slide n" for a number. */
export function paletteItems(query: string): PaletteItem[] {
  const ctx = commandContext();
  const items: PaletteItem[] = COMMANDS.map((command) => ({
    id: command.id,
    title: command.title,
    group: menuLabel(command.menu),
    keys: command.keys,
    hint: command.hint,
    enabled: commandEnabled(command, ctx),
    checked: command.check ? commandChecked(command, ctx) : undefined,
    run: () => runCommand(command.id),
  }));
  const number = /^(?:(?:go\s*to\s*)?slide\s*)?(\d+)$/i.exec(query.trim());
  const slides = ctx.app.deck?.slides ?? [];
  const slide = number ? slides[Number(number[1]) - 1] : undefined;
  if (slide && !ctx.app.presenting) {
    items.unshift({
      id: "slide.goto",
      title: `Go to slide ${number![1]}`,
      group: "Slide",
      enabled: true,
      run: () => ctx.app.openSlide(slide.id),
    });
  }
  return items;
}

/** The choices `query` finds, the best first; a slide's number finds that slide before anything. */
function findItems(query: string, recent: string[]): Found<PaletteItem>[] {
  const items = paletteItems(query);
  const goto = items.find((item) => item.id === "slide.goto");
  const matches = searchCommands(
    items.filter((item) => item !== goto),
    query,
    recent,
  );
  // With nothing typed, what can run now comes before what cannot (after the recent ones); typed, the best match first.
  const usable = (found: Found<PaletteItem>) => found.item.enabled === true || recent.includes(found.item.id);
  const found = query.trim() ? matches : [...matches.filter(usable), ...matches.filter((match) => !usable(match))];
  return goto ? [{ item: goto, score: Number.POSITIVE_INFINITY, marks: [] }, ...found] : found;
}

/**
 * The command palette: every command of the app, found by typing part of its name or its menu's
 * ("zoom", "arrange group"), with its keys, those used last first. Commands that cannot run now
 * are greyed, saying why. It is used with the keyboard alone: typing narrows the list, ↑ ↓ (and
 * Home / End with ⌘) go through it, Enter runs the command marked, Escape (or ⇧⌘P again) closes it.
 * A number goes to that slide.
 */
export function CommandPalette() {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recent] = useState(loadRecent);
  const found = useMemo(() => findItems(query, recent), [query, recent]);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const optionId = (at: number) => `${id}-option-${at}`;
  const at = Math.min(active, Math.max(0, found.length - 1));
  const showsRecent = !query.trim() && recent.length > 0;

  // The choice marked stays in sight as it moves.
  useEffect(() => {
    list.current?.querySelector(`#${CSS.escape(optionId(at))}`)?.scrollIntoView?.({ block: "nearest" });
  });

  const choose = (item: PaletteItem | undefined) => {
    if (item?.enabled !== true) return;
    closePalette();
    if (item.id !== "slide.goto") noteRecent(item.id);
    // Once the palette has gone and given the focus back, so what the command focuses keeps it.
    setTimeout(item.run, 0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const count = found.length;
    const mod = isMod(event.nativeEvent);
    // Its own keys close it again.
    if (mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === "p") {
      event.preventDefault();
      closePalette();
      return;
    }
    let next: number | null = null;
    if (event.key === "ArrowDown") next = count ? (at + 1) % count : 0;
    else if (event.key === "ArrowUp") next = count ? (at - 1 + count) % count : 0;
    else if (mod && event.key === "Home") next = 0;
    else if (mod && event.key === "End") next = Math.max(0, count - 1);
    else if (event.key === "PageDown") next = Math.min(count - 1, at + 8);
    else if (event.key === "PageUp") next = Math.max(0, at - 8);
    else if (event.key === "Enter") {
      event.preventDefault();
      choose(found[at]?.item);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    setActive(Math.max(0, next));
  };

  return (
    <Dialog
      label="Command palette"
      onClose={closePalette}
      size="md"
      closeOnBackdrop
      className="mt-[12vh] gap-0 self-start overflow-hidden p-0"
      backdropTestId="command-palette-backdrop"
    >
      <label className="relative flex shrink-0 items-center border-b p-2">
        <Search aria-hidden className="pointer-events-none absolute left-4 size-4 text-muted-foreground" />
        <input
          data-autofocus
          role="combobox"
          aria-expanded
          aria-controls={`${id}-list`}
          aria-activedescendant={found.length > 0 ? optionId(at) : undefined}
          aria-autocomplete="list"
          aria-label="Find a command"
          placeholder="Find a command, or type a slide number"
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className={cn(inputClass, "h-9 border-0 bg-transparent pl-8 text-sm focus-visible:outline-none")}
        />
      </label>
      <div
        ref={list}
        id={`${id}-list`}
        role="listbox"
        aria-label="Commands"
        className="max-h-[min(60vh,26rem)] overflow-y-auto p-1 [scrollbar-width:thin]"
      >
        {found.length === 0 ? (
          <p role="status" className="px-3 py-6 text-center text-xs text-muted-foreground">
            No command matches “{query.trim()}”.
          </p>
        ) : (
          found.map(({ item, marks }, index) => (
            <div key={item.id}>
              {showsRecent && index === 0 && <ListHeading>Recent</ListHeading>}
              {showsRecent && index === recent.length && <ListHeading>All commands</ListHeading>}
              <PaletteRow
                id={optionId(index)}
                item={item}
                marks={marks}
                active={index === at}
                onPoint={() => setActive(index)}
                onChoose={() => choose(item)}
              />
            </div>
          ))
        )}
      </div>
    </Dialog>
  );
}

function ListHeading({ children }: { children: string }) {
  return (
    <SectionLabel role="presentation" className="block px-2 pb-0.5 pt-2">
      {children}
    </SectionLabel>
  );
}

/** A command in the list: its name (the letters typed marked), why it cannot run or what it does, its menu and its keys. */
function PaletteRow(props: {
  id: string;
  item: PaletteItem;
  marks: number[];
  active: boolean;
  onPoint: () => void;
  onChoose: () => void;
}) {
  const { item, active } = props;
  const disabled = item.enabled !== true;
  const note = disabled ? item.enabled : item.hint;
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: the field keeps the focus and marks the option (aria-activedescendant)
    // biome-ignore lint/a11y/useKeyWithClickEvents: the field's keys choose the option marked
    <div
      id={props.id}
      role="option"
      aria-selected={active}
      aria-disabled={disabled || undefined}
      onMouseMove={active ? undefined : props.onPoint}
      onClick={props.onChoose}
      className={cn(
        "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs",
        active && "bg-accent",
        disabled && "text-muted-foreground",
      )}
    >
      <Check
        aria-hidden
        className={cn("size-3.5 shrink-0 text-primary", !item.checked && "invisible", disabled && "opacity-50")}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("truncate", !disabled && "font-medium")}>
          <Marked text={item.title} marks={props.marks} />
          {item.checked !== undefined && <span className="sr-only">{item.checked ? ", on" : ", off"}</span>}
        </span>
        {note && <span className="truncate text-2xs text-muted-foreground">{note}</span>}
      </span>
      <span className="shrink-0 text-2xs text-muted-foreground">{item.group}</span>
      {item.keys && (
        <kbd className="min-w-10 shrink-0 text-right font-sans text-2xs text-muted-foreground tabular-nums">
          {formatKeys(item.keys)}
        </kbd>
      )}
    </div>
  );
}

/** `text` with the letters at `marks` in bold, as the query matched them. */
function Marked({ text, marks }: { text: string; marks: number[] }) {
  if (marks.length === 0) return text;
  const marked = new Set(marks);
  return [...text].map((char, at) =>
    marked.has(at) ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the letters of a title do not move
      <mark key={at} className="bg-transparent font-semibold text-primary">
        {char}
      </mark>
    ) : (
      char
    ),
  );
}
