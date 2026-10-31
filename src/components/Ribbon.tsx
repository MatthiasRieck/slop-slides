import { ChevronDown } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import { popupShift, sectionsToCollapse } from "../lib/ribbon";
import { cn } from "../lib/utils";
import { keepFocus, useOutsideClose } from "./EditControls";

/**
 * Fits a ribbon's sections to its width. Returns the ref for the ribbon and the index of the first
 * collapsed section. Collapsed sections stay in the page, hidden, so they can still be measured.
 * Also keeps what pops up from the ribbon inside the bar around it, as the panel clips the rest.
 */
export function useRibbonFit() {
  const ref = useRef<HTMLDivElement>(null);
  const [collapsedFrom, setCollapsedFrom] = useState(Number.POSITIVE_INFINITY);

  useLayoutEffect(() => {
    const ribbon = ref.current;
    if (!ribbon) return;
    const place = () => {
      const bounds = (ribbon.parentElement ?? ribbon).getBoundingClientRect();
      for (const el of ribbon.querySelectorAll<HTMLElement>("[data-ribbon-body], [role=dialog]")) {
        el.style.marginLeft = "";
        if (!el.matches("[data-flyout], [role=dialog]")) continue;
        const box = el.getBoundingClientRect();
        el.style.marginLeft = `${popupShift(box.left, box.right, bounds.left, bounds.right)}px`;
      }
    };
    const measure = () => {
      const bodies = [...ribbon.querySelectorAll<HTMLElement>("[data-ribbon-body]")];
      // One more pixel for the line between sections.
      const widths = bodies.map((body) => body.offsetWidth + 1);
      setCollapsedFrom(bodies.length - sectionsToCollapse(widths, ribbon.clientWidth));
      place();
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(ribbon);
    // Popups come and go as their buttons are pressed, and a section's button with its collapsing.
    const popups = new MutationObserver(place);
    popups.observe(ribbon, { childList: true, subtree: true });
    return () => {
      resize.disconnect();
      popups.disconnect();
    };
  }, []);

  return { ref, collapsedFrom };
}

/**
 * A captioned group of tools in a ribbon. Collapsed, it is just `icon`, which opens its tools in a
 * flyout. `closeOn` closes the flyout when it changes, for tools that go on to work on the slide.
 */
export function RibbonSection(props: {
  title: string;
  icon: ReactNode;
  collapsed: boolean;
  closeOn?: unknown;
  children: ReactNode;
}) {
  const { collapsed } = props;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLFieldSetElement>(null);
  useOutsideClose(open, ref, () => setOpen(false));
  // biome-ignore lint/correctness/useExhaustiveDependencies: `closeOn` is only what to watch
  useEffect(() => setOpen(false), [props.closeOn]);
  if (open && !collapsed) setOpen(false);

  return (
    <fieldset
      ref={ref}
      aria-label={props.title}
      className={cn("relative flex h-16 min-w-0 shrink-0 border-r last:border-r-0", collapsed && "w-10")}
    >
      {collapsed && (
        <button
          type="button"
          aria-label={`${props.title} tools`}
          title={props.title}
          aria-expanded={open}
          onMouseDown={keepFocus}
          onClick={() => setOpen(!open)}
          className={cn(
            "mr-1 flex flex-1 flex-col items-center justify-center gap-1 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-4",
            open && "bg-accent text-foreground",
          )}
        >
          {props.icon}
          <ChevronDown className="!size-3" />
        </button>
      )}
      <div
        data-ribbon-body=""
        data-flyout={collapsed || undefined}
        style={collapsed && !open ? { visibility: "hidden" } : undefined}
        className={cn(
          "flex w-max flex-col items-center justify-between px-1.5",
          collapsed && "absolute top-full left-0 z-30 mt-1 gap-1 rounded-md border bg-card py-1.5 shadow-md",
        )}
      >
        <div className="flex flex-col gap-0.5">{props.children}</div>
        <span className="text-[10px] leading-3 text-muted-foreground">{props.title}</span>
      </div>
    </fieldset>
  );
}

/** One line of tools in a ribbon section. */
export function RibbonRow({ children }: { children: ReactNode }) {
  return <div className="flex h-6 items-center gap-0.5">{children}</div>;
}
