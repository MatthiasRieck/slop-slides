import { Check, ListFilter, Loader2 } from "lucide-react";

import { useChanges, visibleRows } from "../../changesStore";
import type { DeckChanges } from "../../lib/api";
import { useApp } from "../../store";
import { ToolButton } from "../Button";
import { SectionLabel } from "../SectionLabel";
import { ChangeRow, StylesRow } from "./ChangeRow";
import { changeCounts, isClean, lastVersion, MARKS, STYLES, slideNumbers } from "./changeRows";
import { CountBadge, SavedWithGit } from "./marks";
import { FirstVersionBox, VersionBox } from "./VersionBox";

/** Nothing to save: says so, and which version the deck is the same as. */
function NoChanges({ changes }: { changes: DeckChanges }) {
  const { commit } = changes;
  return (
    <div data-testid="no-changes" className="flex shrink-0 flex-col gap-1 border-b px-3 pb-3 text-xs">
      <p className="flex items-center gap-1.5 font-medium">
        <Check className="size-3.5 shrink-0 text-success" />
        No changes since the last version
      </p>
      {commit && (
        <p className="truncate text-muted-foreground" title={`${commit.subject} (${commit.hash})`}>
          {lastVersion(commit)}
        </p>
      )}
      <SavedWithGit changes={changes} className="text-2xs" />
    </div>
  );
}

/**
 * The left of Changes mode: saving the next version, and under it the slides, with the removed
 * ones in between, marked by what changed.
 */
export function ChangesRail() {
  const deck = useApp((s) => s.deck);
  const changes = useChanges((s) => (s.deck === deck?.id ? s.changes : null));
  const onlyChanges = useChanges((s) => s.onlyChanges);
  if (!deck) return null;
  const slides = changes?.slides ?? [];
  const numbers = slideNumbers(slides);
  const rows = visibleRows({ changes, onlyChanges });
  // A deck with no version yet has nothing to count or filter: every slide is just new.
  const first = changes?.tracking === "notCommitted";
  const compared = changes?.tracking === "committed";
  const counts = compared ? changeCounts(slides) : [];
  const stylesChanged = compared && !!changes?.stylesChanged;
  const clean = !!changes && isClean(changes);

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 px-3">
        <div className="flex min-w-0 items-center gap-1">
          {counts.length === 0 && !stylesChanged && <SectionLabel className="truncate">Changes</SectionLabel>}
          {stylesChanged && <CountBadge mark={STYLES} title="The shared styles changed" />}
          {counts.map(({ status, count }) => {
            const mark = MARKS[status];
            return <CountBadge key={status} mark={mark} title={`${count} ${mark.label.toLowerCase()}`} count={count} />;
          })}
        </div>
        {compared && (
          <ToolButton
            variant="panel"
            label={onlyChanges ? "Show every slide" : "Show only the slides that changed"}
            active={onlyChanges}
            onClick={() => useChanges.getState().setOnlyChanges(!onlyChanges)}
          >
            <ListFilter className="size-4" />
          </ToolButton>
        )}
      </div>
      {!changes && (
        <p role="status" className="flex items-center gap-1.5 px-3 pb-3 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Looking for changes…
        </p>
      )}
      {changes && clean && <NoChanges changes={changes} />}
      {changes && first && <FirstVersionBox deck={deck} changes={changes} />}
      {changes && compared && !clean && <VersionBox deck={deck} changes={changes} />}
      <ol className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-4 pt-2.5">
        {changes && stylesChanged && <StylesRow deck={deck.id} changes={changes} />}
        {rows.map((row) => (
          <ChangeRow
            key={row.key}
            deck={deck}
            row={row}
            number={numbers.get(row.key)}
            commit={changes?.commit?.hash}
            canInclude={compared}
          />
        ))}
        {changes && rows.length === 0 && slides.length > 0 && (
          <li className="px-1 pt-2 text-xs leading-relaxed text-muted-foreground">
            {stylesChanged ? "No slide changed, only the shared styles." : "No slide changed."}
          </li>
        )}
      </ol>
    </div>
  );
}
