import { useState } from "react";

import { useChanges } from "../../changesStore";
import type { Deck, DeckChanges } from "../../lib/api";
import { formatKeys } from "../../lib/keys";
import { plural } from "../../lib/utils";
import { confirmAction } from "../../store/confirm";
import { Button } from "../Button";
import { canDiscardAll, includedCount, lockedChange, suggestMessage } from "./changeRows";
import { SavedWithGit } from "./marks";

/**
 * What the next version is called, and whether it takes everything. The message starts as a
 * suggestion made from what changed (see `suggestMessage`), which follows the changes until it is
 * typed over; a message left empty falls back to it, so saving never waits for words. A first
 * version takes `everything`, whatever is picked.
 */
function useVersion(deck: Deck, changes: DeckChanges, everything = false) {
  // What the user typed; null while the suggestion stands.
  const [typed, setTyped] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const suggestion = suggestMessage(changes);
  // Nothing picked: the version takes everything there is.
  const all = everything || changes.stagedFiles === 0;

  const save = async () => {
    if (saving) return;
    setSaving(true);
    const { commit, commitAll } = useChanges.getState();
    const message = typed?.trim() || suggestion;
    if (await (all ? commitAll : commit)(deck.id, message)) setTyped(null);
    setSaving(false);
  };
  return { message: typed ?? suggestion, suggestion, untouched: typed === null, setTyped, saving, save, all };
}

/** The field for what the next version is called. Focused untouched, its suggestion is selected: typing replaces it. */
function MessageField(props: { version: ReturnType<typeof useVersion> }) {
  const { message, suggestion, untouched, setTyped, save } = props.version;
  return (
    <textarea
      aria-label="What changed"
      placeholder={suggestion}
      title="What this version is called, to find it again later. The suggestion is made from what changed"
      rows={2}
      value={message}
      onChange={(event) => setTyped(event.currentTarget.value)}
      onFocus={(event) => {
        if (untouched) event.currentTarget.select();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void save();
      }}
      className="w-full resize-none rounded-md border border-input bg-background px-1.5 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
    />
  );
}

/**
 * Saving the next version of a deck that has one: what it is called, the button that saves it,
 * picking everything or nothing for it, and discarding every change at once. With nothing picked
 * the button saves all there is.
 */
export function VersionBox({ deck, changes }: { deck: Deck; changes: DeckChanges }) {
  const version = useVersion(deck, changes);
  const { stagedFiles, stagedElsewhere, hasUnstaged } = changes;
  const included = includedCount(changes);
  const locked = lockedChange(deck.slides, changes);

  const discardAll = async () => {
    const confirmed = await confirmAction({
      title: "Discard all changes to this deck?",
      message: `Every slide and the shared styles go back to how they were in the last version${
        changes.commit ? ` (“${changes.commit.subject}”)` : ""
      }: new slides are taken out and removed ones come back. ${formatKeys("mod+z")} brings the slides' changes back, but not files such as images that went back with them.`,
      confirmLabel: "Discard all changes",
      destructive: true,
    });
    if (confirmed) void useChanges.getState().restoreAll(deck.id);
  };

  return (
    <div data-testid="version-box" className="flex shrink-0 flex-col gap-1.5 border-b px-3 pb-3">
      <MessageField version={version} />
      <Button
        variant="primary"
        busy={version.saving}
        title={
          version.all
            ? "Save a version of everything that changed in this deck"
            : "Save a version of only what is ticked"
        }
        shortcut="mod+enter"
        onClick={() => void version.save()}
        className="justify-center"
      >
        <span className="truncate">
          {version.all ? "Save version" : included > 0 ? `Save ${plural(included, "change")}` : "Save what is ticked"}
        </span>
      </Button>
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1 text-xs text-muted-foreground">
        <span className="mr-0.5">Include</span>
        <Button
          variant="ghost"
          size="xs"
          title="Tick every change in this deck"
          disabled={!hasUnstaged}
          onClick={() => void useChanges.getState().stageAll(deck.id)}
        >
          All
        </Button>
        <Button
          variant="ghost"
          size="xs"
          title="Clear every tick in this deck's folder: the next version takes in everything again"
          disabled={stagedFiles === stagedElsewhere}
          onClick={() => void useChanges.getState().unstageAll(deck.id)}
        >
          None
        </Button>
        {canDiscardAll(changes) && (
          <Button
            variant="ghost"
            size="xs"
            disabled={locked !== null}
            title={
              locked !== null
                ? `Slide ${locked} is locked; unlock it to discard its changes`
                : "Put the whole deck back as it was in the last version"
            }
            onClick={() => void discardAll()}
            className="ml-auto text-destructive enabled:hover:bg-destructive/10 enabled:hover:text-destructive"
          >
            Discard all…
          </Button>
        )}
      </div>
      {stagedElsewhere > 0 && (
        <p className="text-2xs leading-snug text-muted-foreground">
          Also saves {plural(stagedElsewhere, "included file")} outside this deck's folder.
        </p>
      )}
      <SavedWithGit changes={changes} className="text-2xs" />
    </div>
  );
}

/**
 * A deck that has no version yet: one calm explanation and the way out of it, in place of a
 * change mark and a discard button on every slide.
 */
export function FirstVersionBox({ deck, changes }: { deck: Deck; changes: DeckChanges }) {
  const version = useVersion(deck, changes, true);
  return (
    <div data-testid="first-version" className="flex shrink-0 flex-col gap-1.5 border-b px-3 pb-3">
      <p className="text-xs font-medium">Nothing saved yet</p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Save a first version of this deck. From then on, this list shows what changed since, slide by slide.
      </p>
      <MessageField version={version} />
      <Button
        variant="primary"
        busy={version.saving}
        title="Save this deck, as it is now, as its first version"
        shortcut="mod+enter"
        onClick={() => void version.save()}
        className="justify-center"
      >
        Save first version
      </Button>
      <SavedWithGit changes={changes} className="text-2xs" />
    </div>
  );
}
