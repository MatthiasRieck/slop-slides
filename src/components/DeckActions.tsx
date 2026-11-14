import { AppWindow, Check, ChevronDown, Play, type Share, SkipBack } from "lucide-react";

import { useDropdown } from "../hooks/useDropdown";
import { useMenuKeys } from "../hooks/useMenuKeys";
import type { Deck } from "../lib/api";
import { formatKeys } from "../lib/keys";
import { cn } from "../lib/utils";
import { useApp } from "../store";
import { Button, withShortcut } from "./Button";
import { ExportMenu } from "./ExportMenu";
import { PRESENT_KEYS, usePresent } from "./presenter/present";
import { ScreenPicker } from "./ScreenPicker";

/** Why the deck can be neither exported nor presented while it has no slide. */
const EMPTY_DECK = "Add a slide first";

/**
 * Export and present, in the top bar. Where the bar is short of room (see lib/topBar.ts), Export
 * shows its icon alone without `exportLabel`, and Present without `presentLabel`.
 */
export function DeckActions({
  exportLabel = true,
  presentLabel = true,
}: {
  exportLabel?: boolean;
  presentLabel?: boolean;
}) {
  const deck = useApp((s) => s.deck);
  if (!deck) return null;
  return <Actions deck={deck} exportLabel={exportLabel} presentLabel={presentLabel} />;
}

function Actions({ deck, exportLabel, presentLabel }: { deck: Deck; exportLabel: boolean; presentLabel: boolean }) {
  const picker = usePresent();

  const empty = deck.slides.length === 0;
  return (
    <div className="flex items-center gap-2">
      <ExportMenu label={exportLabel} disabledReason={empty ? EMPTY_DECK : null} />
      <PresentButton empty={empty} label={presentLabel} />
      {picker.screens && (
        <ScreenPicker
          screens={picker.screens}
          previews={picker.previews}
          onCancel={picker.close}
          onWindows={() => picker.presentInWindows(picker.from)}
          onStart={picker.start}
        />
      )}
    </div>
  );
}

/**
 * Present, from the slide selected, with a menu beside it for the other ways to start: from the
 * first slide, and in windows (the slides in this window, to share it in a call, and the
 * presenter view in a window of its own, which works on a single screen). ⌘↵ and ⇧⌘↵ do the
 * first two from anywhere (see `usePresentKeys`).
 */
function PresentButton({ empty, label }: { empty: boolean; label: boolean }) {
  const { open, setOpen, ref: menuRef } = useDropdown();
  const menu = useMenuKeys();
  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  const present = usePresent.getState();
  // Both starts, and their keys, present in windows while this is on.
  const windowed = usePresent((s) => s.windowed);

  return (
    <div ref={menuRef} className="relative flex">
      <Button
        variant="primary"
        size="xl"
        disabled={empty}
        aria-label={label ? undefined : "Present"}
        title={
          empty
            ? EMPTY_DECK
            : withShortcut(
                windowed ? "Present in windows from the current slide" : "Present from the current slide",
                PRESENT_KEYS.current,
              )
        }
        onClick={() => void present.present("current")}
        className="rounded-r-none shadow-sm"
      >
        <Play className="size-3.5 fill-current" />
        {label && "Present"}
      </Button>
      <Button
        variant="primary"
        size="xl"
        disabled={empty}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More ways to present"
        title={empty ? EMPTY_DECK : "More ways to present"}
        onClick={() => setOpen((v) => !v)}
        className="rounded-l-none border-l border-primary-foreground/20 px-1.5 shadow-sm"
      >
        <ChevronDown className="size-3" />
      </Button>
      {open && (
        <div
          role="menu"
          {...menu}
          className="enter-below absolute right-0 top-full z-dropdown mt-1 w-64 rounded-lg border bg-card p-1 shadow-popover outline-none"
        >
          <MenuItem
            icon={SkipBack}
            label="From the beginning"
            shortcut={PRESENT_KEYS.start}
            onClick={choose(() => void present.present("start"))}
          />
          <MenuItem
            icon={Play}
            label="From current slide"
            shortcut={PRESENT_KEYS.current}
            onClick={choose(() => void present.present("current"))}
          />
          <MenuItem
            icon={AppWindow}
            label="Present in windows"
            hint="Slides in this window, to share in a call; the presenter view in another"
            checked={windowed}
            onClick={() => present.setWindowed(!windowed)}
          />
        </div>
      )}
    </div>
  );
}

/**
 * One choice of a top bar menu: an icon, a label and, optionally, a hint under it and the keys
 * that do the same (`shortcut`, a `formatKeys` spec) at its end. With `checked`, it is a choice
 * that is on or off, with a check mark while on.
 */
export function MenuItem(props: {
  icon: typeof Share;
  label: string;
  hint?: string;
  shortcut?: string;
  checked?: boolean;
  onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      {...(props.checked === undefined
        ? { role: "menuitem" }
        : { role: "menuitemcheckbox", "aria-checked": props.checked })}
      onClick={props.onClick}
      className="flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs font-medium">{props.label}</span>
        {props.hint && <span className="text-2xs text-muted-foreground">{props.hint}</span>}
      </span>
      {props.shortcut && (
        <kbd className="shrink-0 font-sans text-2xs text-muted-foreground tabular-nums">
          {formatKeys(props.shortcut)}
        </kbd>
      )}
      {props.checked !== undefined && (
        <Check className={cn("mt-0.5 size-4 shrink-0 text-primary", !props.checked && "invisible")} />
      )}
    </button>
  );
}
