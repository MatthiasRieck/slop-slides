import { ArrowUp, Clock, CornerDownRight, Pencil, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { plural } from "../../lib/utils";
import { type QueuedMessage, useApp } from "../../store";

/** What goes along with a queued message, in a few words; empty when it is text alone. */
export function queuedExtras(item: QueuedMessage, slideIds: string[]): string {
  const { options } = item;
  const slide = options.slide ? slideIds.indexOf(options.slide) + 1 : 0;
  const count = options.attachments.length;
  return [
    slide > 0 && `Slide ${slide}`,
    count > 0 && plural(count, "attachment"),
    options.screenshot && "screenshot",
    options.element?.name,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Messages waiting for the agent's turn to end, above the composer, a list whose rows each hold
 * a line of a trace that has not run yet, with what goes along with it: each can steer the turn
 * now (or, while the agent is idle, be sent), go back into the composer, or be dropped.
 */
export function QueuedMessages({ onEdit }: { onEdit: (id: string) => void }) {
  const queue = useApp((s) => s.queue);
  const running = useApp((s) => s.running);
  // The slides change with every save of the deck, and are only named while something waits.
  const slides = useApp((s) => (s.queue.length > 0 ? s.deck?.slides : undefined));
  if (queue.length === 0) return null;
  const slideIds = (slides ?? []).map((slide) => slide.id);
  return (
    <section aria-label="Queued messages" className="mx-3 mb-1.5 rounded-xl border bg-card p-1 shadow-composer">
      <p className="px-2 pt-0.5 pb-1 text-2xs text-muted-foreground">
        {running ? "Sent when the agent finishes" : "Waiting: the last turn did not finish"}
      </p>
      <ul>
        {queue.map((item) => {
          const extras = queuedExtras(item, slideIds);
          return (
            <li
              key={item.id}
              className="flex min-w-0 items-center gap-1 rounded-lg py-0.5 pr-0.5 pl-2 hover:bg-muted/50"
            >
              <div className="min-w-0 flex-1">
                <TraceLine className="text-foreground">
                  <TraceIcon className="text-muted-foreground">
                    <Clock className="size-3.5" />
                  </TraceIcon>
                  <TraceTitle title={item.text}>{item.text}</TraceTitle>
                  {extras && <TraceDescription className="min-w-0 shrink truncate text-2xs">{extras}</TraceDescription>}
                </TraceLine>
              </div>
              {/* One made ready for a steer that came too late can only wait for the turn. */}
              {(!running || !item.ready) && (
                <Button
                  variant="tool"
                  size="icon-xs"
                  tooltip={running ? "Steer: send into the agent's turn now" : "Send now"}
                  onClick={() => void useApp.getState().steerQueued(item.id)}
                >
                  {running ? <CornerDownRight /> : <ArrowUp />}
                </Button>
              )}
              {!item.ready && (
                <Button variant="tool" size="icon-xs" tooltip="Edit" onClick={() => onEdit(item.id)}>
                  <Pencil />
                </Button>
              )}
              <Button
                variant="tool"
                size="icon-xs"
                tooltip="Remove"
                onClick={() => useApp.getState().takeQueued(item.id)}
              >
                <X />
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
