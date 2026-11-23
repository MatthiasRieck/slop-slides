import { ChevronRightIcon } from "lucide-react";
import * as React from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

function Trace({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="trace"
      className={cn(
        "flex w-full min-w-0 flex-col gap-2 *:has-[>[data-slot=trace-line]]:flex *:has-[>[data-slot=trace-line]]:w-fit *:has-[>[data-slot=trace-line]]:max-w-full *:has-[>[data-slot=trace-line]]:min-w-0 *:has-[>[data-slot=trace-line]]:rounded-md *:has-[>[data-slot=trace-line]]:text-left *:has-[>[data-slot=trace-line]]:outline-none *:has-[>[data-slot=trace-line]]:focus-visible:ring-3 *:has-[>[data-slot=trace-line]]:focus-visible:ring-ring/50",
        className,
      )}
      {...props}
    />
  );
}

function TraceLine({
  className,
  status,
  ...props
}: React.ComponentProps<"span"> & {
  status?: "running" | "error" | "pending";
}) {
  return (
    <span
      data-slot="trace-line"
      data-status={status}
      className={cn(
        "flex w-fit max-w-full min-w-0 items-center gap-2 text-sm text-muted-foreground transition-colors in-[a,button]:cursor-pointer in-[a:hover,button:hover]:text-foreground data-[status=error]:text-destructive data-[status=error]:in-[a:hover,button:hover]:text-destructive data-[status=pending]:opacity-60 data-[status=running]:*:data-[slot=trace-title]:shimmer",
        className,
      )}
      {...props}
    />
  );
}

function TraceIcon({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-icon"
      aria-hidden="true"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [[data-slot=trace-title]~&]:-ml-1",
        className,
      )}
      {...props}
    />
  );
}

function TraceTitle({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span data-slot="trace-title" className={cn("min-w-0 truncate motion-reduce:shimmer-none", className)} {...props} />
  );
}

function TraceDescription({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-description"
      className={cn("shrink-0 text-muted-foreground/70 tabular-nums", className)}
      {...props}
    />
  );
}

/**
 * A trace of a long conversation holds hundreds of collapsibles, nearly all of them never opened.
 * Until one is first opened it is plain markup (a button that says it is collapsed, and no
 * panel): Base UI's collapsible keeps state and effects for each, which is what showing such a
 * conversation again, or rendering it, would otherwise cost.
 */
const TraceCollapsibleContext = React.createContext<{
  /** Not opened yet: the trigger is a plain button and there is no content. */
  dormant: boolean;
  wake: () => void;
  /** The trigger that woke it had the focus, which the real trigger takes over. */
  refocus: React.RefObject<boolean>;
}>({ dormant: false, wake: () => {}, refocus: { current: false } });

function TraceCollapsible({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Collapsible>, "open"> &
  (
    | { open?: undefined }
    | {
        open: boolean;
        onOpenChange: NonNullable<React.ComponentProps<typeof Collapsible>["onOpenChange"]>;
      }
  )) {
  const [woken, setWoken] = React.useState(false);
  const refocus = React.useRef(false);
  const dormant = !woken && !props.open && !props.defaultOpen;
  const { onOpenChange } = props;
  const context = React.useMemo(
    () => ({
      dormant,
      wake: () => {
        refocus.current = true;
        setWoken(true);
        (onOpenChange as ((open: boolean) => void) | undefined)?.(true);
      },
      refocus,
    }),
    [dormant, onOpenChange],
  );
  const classes = cn("flex w-full min-w-0 flex-col", className);
  if (dormant) {
    return (
      <TraceCollapsibleContext.Provider value={context}>
        <div data-slot="trace-collapsible" className={typeof classes === "string" ? classes : undefined}>
          {props.children as React.ReactNode}
        </div>
      </TraceCollapsibleContext.Provider>
    );
  }
  return (
    <TraceCollapsibleContext.Provider value={context}>
      <Collapsible
        data-slot="trace-collapsible"
        className={classes}
        {...props}
        // Woken by a press on its plain trigger, it starts open when it keeps its own state.
        {...(props.open === undefined && woken && { defaultOpen: true })}
      />
    </TraceCollapsibleContext.Provider>
  );
}

const TRIGGER =
  "group/trace-collapsible-trigger flex w-fit max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-md text-left text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 has-[[data-status=error]]:text-destructive";

function TraceCollapsibleTrigger({ className, children, ...props }: React.ComponentProps<typeof CollapsibleTrigger>) {
  const { dormant, wake, refocus } = React.useContext(TraceCollapsibleContext);
  const chevron = (
    <TraceIcon className="transition-transform group-aria-expanded/trace-collapsible-trigger:rotate-90">
      <ChevronRightIcon />
    </TraceIcon>
  );
  const taken = React.useCallback(
    (element: HTMLElement | null) => {
      if (element && refocus.current) {
        refocus.current = false;
        element.focus({ preventScroll: true });
      }
    },
    [refocus],
  );
  if (dormant) {
    const { "aria-label": label, title, id, disabled, tabIndex } = props;
    return (
      <button
        type="button"
        data-slot="trace-collapsible-trigger"
        aria-expanded={false}
        aria-label={label}
        title={title}
        id={id}
        disabled={disabled}
        tabIndex={tabIndex}
        className={cn(TRIGGER, typeof className === "string" ? className : undefined)}
        onClick={wake}
      >
        {children}
        {chevron}
      </button>
    );
  }
  return (
    <CollapsibleTrigger ref={taken} data-slot="trace-collapsible-trigger" className={cn(TRIGGER, className)} {...props}>
      {children}
      {chevron}
    </CollapsibleTrigger>
  );
}

function TraceCollapsibleContent({ className, children, ...props }: React.ComponentProps<typeof CollapsibleContent>) {
  const { dormant } = React.useContext(TraceCollapsibleContext);
  if (dormant) return null;
  return (
    <CollapsibleContent
      data-slot="trace-collapsible-content"
      className="h-(--collapsible-panel-height) min-w-0 overflow-hidden transition-[height] duration-200 data-ending-style:h-0 data-starting-style:h-0"
      {...props}
    >
      <div
        data-slot="trace-collapsible-content-inner"
        className={cn(
          "mt-2 mb-1 ml-[calc(--spacing(2)-1px)] min-w-0 border-l pr-1 pl-4 leading-relaxed wrap-break-word text-muted-foreground",
          className,
        )}
      >
        {children}
      </div>
    </CollapsibleContent>
  );
}

export {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
};
