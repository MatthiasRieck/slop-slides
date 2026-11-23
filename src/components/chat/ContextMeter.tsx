import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
  const told =
    tokens === null
      ? "The conversation was compacted. Its new size shows after the next message."
      : `The conversation holds ${tokens.toLocaleString("en-US")} tokens` +
        (window ? ` of the ${window.toLocaleString("en-US")}-token context window` : "");

  // A tab resting on the composer's top edge, opaque so the image fan tucks behind it.
  return (
    <div className="relative z-10 mx-3 flex h-8 items-center gap-2.5 rounded-t-xl border border-b-0 bg-card bg-[linear-gradient(var(--muted),var(--muted))] px-3 text-xs">
      <Tooltip>
        <TooltipTrigger render={<div data-testid="context-meter" className="flex min-w-0 items-center gap-2.5" />}>
          <Progress
            aria-label="Context used"
            value={percent === null ? null : Math.round(percent)}
            className={cn(
              "w-12 shrink-0 gap-0 **:data-[slot=progress-track]:h-1.5 **:data-[slot=progress-track]:bg-border",
              percent === null || percent < 70
                ? "**:data-[slot=progress-indicator]:bg-primary/70"
                : percent < 90
                  ? "**:data-[slot=progress-indicator]:bg-warning"
                  : "**:data-[slot=progress-indicator]:bg-destructive",
            )}
          />
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
        </TooltipTrigger>
        <TooltipContent>{told}</TooltipContent>
      </Tooltip>
      <div className="flex-1" />
      {percent !== null && percent > COMPACT_THRESHOLD && (
        <Button
          variant="ghost"
          size="2xs"
          disabled={running}
          onClick={() => void useApp.getState().compact()}
          tooltip="Summarize the conversation so far to free up context (/compact)"
          className="shrink-0"
        >
          Compact
        </Button>
      )}
    </div>
  );
}
