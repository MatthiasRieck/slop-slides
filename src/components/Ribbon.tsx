import { ChevronDown } from "lucide-react";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import { useDropdown } from "../hooks/useDropdown";
import { popupShift, sectionsToCollapse } from "../lib/ribbon";
import { cn } from "../lib/utils";
import { keepFocus, toolButtonClass } from "./Button";

/** What pops up from a ribbon and is placed by it: a collapsed section's flyout, and the tools' own panels. */
const FLYOUTS = "[data-flyout]";
// A `Popover` places itself, against the window.
const PANELS = "[role=dialog]:not([data-popover])";

/**
 * Fits a ribbon's sections to its width. Returns the ref for the ribbon and the index of the first
 * collapsed section. Collapsed sections stay in the page, hidden, so they can still be measured.
 * Also keeps what pops up from the ribbon inside the bar around it, as the panel clips the rest.
 *
 * A ribbon resizes with every tick of a panel's separator being dragged, so a resize reads as
 * little of the layout as it can: the sections' widths are measured once and again only after
 * what is in the ribbon changed, and what pops up is put back and measured together, not one by
 * one with a layout of the page for each.
 */
export function useRibbonFit() {
  const ref = useRef<HTMLDivElement>(null);
  const [collapsedFrom, setCollapsedFrom] = useState(Number.POSITIVE_INFINITY);

  useLayoutEffect(() => {
    const ribbon = ref.current;
    if (!ribbon) return;
    // Each section's width, with one more pixel for the line between sections; null until
    // measured, and once the ribbon's content changed.
    let widths: number[] | null = null;
    // The width the sections were last fit to.
    let room = -1;
    const shifted = new Set<HTMLElement>();
    /** Moves each of `popups` back inside `bounds`, reading where all of them are before moving any. */
    const shift = (popups: HTMLElement[], bounds: DOMRect) => {
      const boxes = popups.map((el) => el.getBoundingClientRect());
      popups.forEach((el, i) => {
        const box = boxes[i]!;
        el.style.marginLeft = `${popupShift(box.left, box.right, bounds.left, bounds.right)}px`;
        shifted.add(el);
      });
    };
    const place = () => {
      for (const el of shifted) el.style.marginLeft = "";
      shifted.clear();
      const flyouts = [...ribbon.querySelectorAll<HTMLElement>(FLYOUTS)];
      const panels = [...ribbon.querySelectorAll<HTMLElement>(PANELS)];
      if (flyouts.length + panels.length === 0) return;
      const bounds = (ribbon.parentElement ?? ribbon).getBoundingClientRect();
      // The flyouts first: a panel in one moves with it.
      shift(flyouts, bounds);
      shift(panels, bounds);
    };
    const fitSections = () => {
      const width = ribbon.clientWidth;
      if (widths && width === room) return;
      widths ??= [...ribbon.querySelectorAll<HTMLElement>("[data-ribbon-body]")].map((body) => body.offsetWidth + 1);
      room = width;
      setCollapsedFrom(widths.length - sectionsToCollapse(widths, width));
      place();
    };
    fitSections();
    const resize = new ResizeObserver(fitSections);
    resize.observe(ribbon);
    // Popups come and go as their buttons are pressed, and a section's button with its collapsing.
    const changes = new MutationObserver(() => {
      widths = null;
      place();
    });
    changes.observe(ribbon, { childList: true, characterData: true, subtree: true });
    return () => {
      resize.disconnect();
      changes.disconnect();
    };
  }, []);

  return { ref, collapsedFrom };
}

const RevealContext = createContext<() => void>(() => {});

/**
 * Brings the tools of the ribbon section around the caller into view, at once: opens its flyout
 * if the section is collapsed. For a tool a keyboard shortcut reaches, such as the search field.
 * Outside a ribbon it does nothing.
 */
export function useRibbonReveal() {
  return useContext(RevealContext);
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
  const { open, setOpen, ref } = useDropdown<HTMLFieldSetElement>({ disabled: !collapsed });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `closeOn` is only what to watch
  useEffect(() => setOpen(false), [props.closeOn]);
  const collapsedNow = useRef(collapsed);
  collapsedNow.current = collapsed;
  const reveal = useCallback(() => {
    if (collapsedNow.current) flushSync(() => setOpen(true));
  }, [setOpen]);

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
        <div className="flex flex-col gap-0.5">
          <RevealContext value={reveal}>{props.children}</RevealContext>
        </div>
        <span className="text-[10px] leading-3 text-muted-foreground">{props.title}</span>
      </div>
    </fieldset>
  );
}

/** One line of tools in a ribbon section. */
export function RibbonRow({ children }: { children: ReactNode }) {
  return <div className="flex h-6 items-center gap-0.5">{children}</div>;
}

/**
 * A list to pick from in a ribbon or one of its popovers. `label` names it and is its tooltip
 * (`title` replaces the tooltip); disabled, the tooltip is `disabledReason`, saying what it waits
 * for. A pick calls `onDone`, which hands the keyboard focus back to the slide: a native select
 * keeps it on some platforms, and the arrows and Delete would then go to the list, not the slide.
 */
export function RibbonSelect({
  label,
  disabledReason,
  onPick,
  onDone,
  className,
  title,
  ...rest
}: Omit<ComponentProps<"select">, "onChange"> & {
  label?: string;
  disabledReason?: string;
  onPick: (value: string) => void;
  onDone?: () => void;
}) {
  return (
    <select
      aria-label={label}
      title={rest.disabled && disabledReason ? disabledReason : (title ?? label)}
      {...rest}
      onChange={(event) => {
        onPick(event.target.value);
        onDone?.();
      }}
      className={cn(
        "h-6 rounded-md bg-transparent px-1 text-xs disabled:cursor-default disabled:opacity-40",
        className,
      )}
    />
  );
}

/** A ribbon button with its name next to its icon, filling its row. `active` marks a choice as the one made. */
export function RibbonToggle(props: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.active}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(toolButtonClass("toolbar", "sm", props.active), "flex flex-1 items-center gap-1 px-1.5 text-xs")}
    >
      {props.children}
    </button>
  );
}
