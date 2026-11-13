import { ArrowUp, CornerDownRight, Pencil, X } from "lucide-react";

import { plural } from "../../lib/utils";
import { type QueuedMessage, useApp } from "../../store";
import { ToolButton } from "../Button";

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
 * Messages waiting for the agent's turn to end, above the composer, each with what goes along
 * with it: each can steer the turn now (or, while the agent is idle, be sent), go back into the
 * composer, or be dropped.
 */
export function QueuedMessages({ onEdit }: { onEdit: (id: string) => void }) {
  const queue = useApp((s) => s.queue);
  const running = useApp((s) => s.running);
  const slides = useApp((s) => s.deck?.slides);
  if (queue.length === 0) return null;
  const slideIds = (slides ?? []).map((slide) => slide.id);
  return (
    <section
      aria-label="Queued messages"
      className="mx-3 mb-1.5 rounded-xl border bg-card/95 p-1 shadow-composer backdrop-blur-xl"
    >
      <p className="px-2 pt-0.5 pb-1 text-2xs text-muted-foreground">
        {running ? "Sent when the agent finishes" : "Waiting: the last turn did not finish"}
      </p>
      <ul>
        {queue.map((item) => {
          const extras = queuedExtras(item, slideIds);
          return (
            <li
              key={item.id}
              className="flex items-center gap-1 rounded-lg py-0.5 pr-0.5 pl-2 text-sm hover:bg-accent/50"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate" title={item.text}>
                  {item.text}
                </span>
                {extras && <span className="truncate text-2xs text-muted-foreground">{extras}</span>}
              </span>
              {/* One made ready for a steer that came too late can only wait for the turn. */}
              {(!running || !item.ready) && (
                <ToolButton
                  label={running ? "Steer: send into the agent's turn now" : "Send now"}
                  onClick={() => void useApp.getState().steerQueued(item.id)}
                >
                  {running ? <CornerDownRight className="size-3.5" /> : <ArrowUp className="size-3.5" />}
                </ToolButton>
              )}
              {!item.ready && (
                <ToolButton label="Edit" onClick={() => onEdit(item.id)}>
                  <Pencil className="size-3.5" />
                </ToolButton>
              )}
              <ToolButton label="Remove" onClick={() => useApp.getState().takeQueued(item.id)}>
                <X className="size-3.5" />
              </ToolButton>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
