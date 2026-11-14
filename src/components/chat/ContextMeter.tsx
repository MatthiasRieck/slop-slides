import { contextNotice, contextPercent, formatCost, formatTokens, windowTokens } from "../../lib/context";
import { cn } from "../../lib/utils";
import { useApp } from "../../store";
import { chatContext, chatCost } from "../../store/messages";

/**
 * How full the agent's context window is, once that is worth knowing: from about 60% on, a tab
 * on the composer says so in plain words, with a way to compact the conversation and what to
 * do when it is nearly full. The exact count is in its tooltip; below that, how full the chat is
 * (and what it cost) is in the menu of effort and context window (see `ChatUsage`).
 */
export function ContextMeter() {
  const provider = useApp((s) => s.selection.provider);
  const selectedWindow = useApp((s) => s.selection.contextWindow);
  const context = useApp(chatContext);
  const cost = useApp(chatCost);
  const running = useApp((s) => s.running);
  if (!context) return null;

  // Claude runs the next turn with the chosen window, which may differ from the last one.
  const window = (provider === "claude" && windowTokens(selectedWindow)) || context.window;
  const { tokens } = context;
  const percent = contextPercent(tokens, window);
  const notice = contextNotice(percent);
  if (!notice || tokens === null) return null;
  const title = [
    `The conversation holds ${formatTokens(tokens)} tokens` +
      (window ? ` of the ${formatTokens(window)}-token context window.` : "."),
    cost !== null ? `About ${formatCost(cost)} at the provider's API prices so far.` : null,
  ]
    .filter(Boolean)
    .join(" ");

  // A tab resting on the composer's top edge, opaque so the image fan tucks behind it.
  return (
    <div
      title={title}
      className="relative z-10 mx-3 flex min-h-8 items-center gap-2.5 rounded-t-xl border border-b-0 bg-card bg-[linear-gradient(var(--muted),var(--muted))] px-3 py-1.5 text-xs"
    >
      <div
        role="progressbar"
        aria-label="How full the chat is"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent ?? 0)}
        className="h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-border"
      >
        {/* As wide as its track and moved into it from the left: moving takes no layout, a width changing does. */}
        <div
          className={cn(
            "h-full rounded-full transition-transform duration-500",
            notice.urgent ? "bg-destructive" : "bg-warning",
          )}
          style={{ transform: `translateX(${(percent ?? 0) - 100}%)` }}
        />
      </div>
      <p className="min-w-0 flex-1 leading-snug">
        <span className="font-medium text-foreground">{notice.text}</span>{" "}
        <span className="text-muted-foreground">{notice.advice}</span>
      </p>
      <button
        type="button"
        disabled={running}
        onClick={() => void useApp.getState().compact()}
        title={
          running
            ? "Compacting waits for the agent to finish"
            : "Summarize the conversation so far to make room (/compact)"
        }
        className="shrink-0 font-medium text-foreground hover:opacity-70 disabled:opacity-40"
      >
        Compact
      </button>
    </div>
  );
}
