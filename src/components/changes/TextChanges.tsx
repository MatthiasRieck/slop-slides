import { ChevronDown, ChevronRight } from "lucide-react";
import { useId } from "react";

import { useChanges } from "../../changesStore";
import type { TextChange } from "../../lib/api";
import { type TextPart, wordDiff } from "../../lib/textDiff";
import { cn, plural } from "../../lib/utils";
import { Button } from "../Button";

const PLACES: Record<TextChange["where"], string> = {
  slide: "On the slide",
  notes: "Speaker notes",
  narration: "Narration",
};

/** One version of a text, with the words the other version lacks marked: struck out before, underlaid after. */
function Version({ name, parts, mark }: { name: string; parts: TextPart[]; mark: "removed" | "added" }) {
  const Marked = mark === "removed" ? "del" : "ins";
  return (
    <>
      <dt className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{name}</dt>
      <dd className="selectable min-w-0 whitespace-pre-wrap break-words text-foreground">
        {parts.length === 0 && <span className="text-muted-foreground">Nothing</span>}
        {parts.map((part, at) =>
          part.changed ? (
            <Marked
              // biome-ignore lint/suspicious/noArrayIndexKey: the parts of a text have no other identity, and never reorder
              key={at}
              className={cn(
                "rounded-sm px-0.5",
                mark === "removed"
                  ? "bg-destructive/15 text-destructive line-through"
                  : "bg-success/15 text-success no-underline",
              )}
            >
              {part.text}
            </Marked>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <span key={at}>{part.text}</span>
          ),
        )}
      </dd>
    </>
  );
}

/**
 * What changed in a slide's words, under its picture: each text that differs, on the slide, in
 * its speaker notes and in its narration, as it was and as it is, with the changed words marked.
 * A changed number is hard to find by dragging a divider over two pictures, and notes and
 * narration are in no picture at all. Folded, it stays folded from slide to slide.
 */
export function TextChanges({ changes }: { changes: TextChange[] }) {
  const open = useChanges((s) => s.textOpen);
  const list = useId();
  if (changes.length === 0) return null;
  return (
    <section aria-label="Text changes" className="flex max-h-[38%] shrink-0 flex-col border-t bg-background text-xs">
      <Button
        variant="ghost"
        size="lg"
        aria-expanded={open}
        aria-controls={list}
        onClick={() => useChanges.getState().setTextOpen(!open)}
        className="w-full shrink-0 justify-start rounded-none px-3 font-medium"
      >
        {open ? <ChevronDown /> : <ChevronRight />}
        Text changes
        <span className="font-normal text-muted-foreground">{plural(changes.length, "place")}</span>
      </Button>
      {open && (
        <ol id={list} className="flex min-h-0 flex-col gap-3 overflow-y-auto px-3 pb-3 pt-1">
          {changes.map((change, at) => {
            const diff = wordDiff(change.before, change.after);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: a slide's text changes are listed in order and never reorder
              <li key={at} data-testid="changed-text" className="flex flex-col gap-1">
                <span className="text-muted-foreground">{PLACES[change.where]}</span>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 leading-relaxed">
                  <Version name="Before" parts={diff.before} mark="removed" />
                  <Version name="After" parts={diff.after} mark="added" />
                </dl>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
