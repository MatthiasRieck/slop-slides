import { COMPACT_THRESHOLD, contextPercent, formatTokens, windowTokens } from "../../lib/context";
import { cn } from "../../lib/utils";
import { useApp } from "../../store";
import { chatContext } from "../../store/messages";

/**
 * How much of the agent's context window the conversation fills, with a way to compact it
 * once it gets large. Hidden until the selected provider reports its usage.
 */
export function ContextMeter() {
  const provider = useApp((s) => s.selection.provider);
  const selectedWindow = useApp((s) => s.selection.contextWindow);
  const context = useApp(chatContext);
  const running = useApp((s) => s.running);
  if (!context) return null;

  // Claude runs the next turn with the chosen window, which may differ from the last one.
  const window = (provider === "claude" && windowTokens(selectedWindow)) || context.window;
  const { tokens } = context;
  const percent = contextPercent(tokens, window);
  const title =
    tokens === null
      ? "The conversation was compacted. Its new size shows after the next message."
      : `The conversation holds ${tokens.toLocaleString("en-US")} tokens` +
        (window ? ` of the ${window.toLocaleString("en-US")}-token context window` : "");

  // A tab resting on the composer's top edge, opaque so the image fan tucks behind it.
  return (
    <div
      title={title}
      className="relative z-10 mx-3 flex h-8 items-center gap-2.5 rounded-t-xl border border-b-0 bg-card bg-[linear-gradient(var(--muted),var(--muted))] px-3 text-xs"
    >
      <div
        role="progressbar"
        aria-label="Context used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : Math.round(percent)}
        className="h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-border"
      >
        {/* As wide as its track and moved into it from the left: moving takes no layout, a width changing does. */}
        <div
          className={cn(
            "h-full rounded-full transition-transform duration-500",
            percent === null || percent < 70 ? "bg-primary/70" : percent < 90 ? "bg-warning" : "bg-destructive",
          )}
          style={{ transform: `translateX(${(percent ?? 0) - 100}%)` }}
        />
      </div>
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="shrink-0 font-medium tabular-nums text-foreground">
          {tokens === null ? "Compacted" : `${formatTokens(tokens)} tokens`}
        </span>
        <span className="truncate tabular-nums text-muted-foreground">
          {tokens === null
            ? "New size shows after the next message"
            : percent !== null && window
              ? `${Math.round(percent)}% of ${formatTokens(window)} context used`
              : "in context"}
        </span>
      </span>
      <div className="flex-1" />
      {percent !== null && percent > COMPACT_THRESHOLD && (
        <button
          type="button"
          disabled={running}
          onClick={() => void useApp.getState().compact()}
          title="Summarize the conversation so far to free up context (/compact)"
          className="shrink-0 font-medium text-foreground hover:opacity-70 disabled:opacity-40"
        >
          Compact
        </button>
      )}
    </div>
  );
}
