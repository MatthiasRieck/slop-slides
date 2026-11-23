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

import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { keepFocus } from "@/lib/focus";
import { openLayer } from "../lib/layers";
import { popupShift, sectionsToCollapse } from "../lib/ribbon";
import { cn } from "../lib/utils";

/** What pops up from a ribbon and is placed by it: a collapsed section's flyout, and the tools' own panels. */
const FLYOUTS = "[data-flyout]";
// A popover (the shadcn one, or the old `Popover`) is not in the ribbon, and places itself against the window.
const PANELS = "[role=dialog]:not([data-popover])";

/** Where a shadcn/ui popup renders, in the body: a press in one opened from a flyout is not a press outside it. */
const POPUPS = "[data-base-ui-portal]";

const isFrame = (source: MessageEventSource | null) =>
  Array.from(document.querySelectorAll("iframe")).some((frame) => frame.contentWindow === source);

/**
 * Whether a collapsed section's flyout is open, and the ref of the section around it. It is no
 * popover: a section's tools stay in the ribbon while it is collapsed (hidden, to be measured and
 * to keep what they hold), and the flyout only shows them, under the section's button. A press
 * outside the section closes it (one in a slide preview too, and none in a popup one of its tools
 * opened); so does Escape, with nothing open over it. Not collapsed, it is closed.
 */
function useFlyout(collapsed: boolean) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLFieldSetElement>(null);
  if (!collapsed && open) setOpen(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target || ref.current?.contains(target) || target.closest?.(POPUPS)) return;
      close();
    };
    // A press in a slide preview never reaches this window, but it is a press outside all the same.
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "slop:press" && isFrame(event.source)) close();
    };
    // Before anything else sees the press, so that nothing which keeps it to itself keeps the flyout open.
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("message", onMessage);
    const closeLayer = openLayer(close);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("message", onMessage);
      closeLayer();
    };
  }, [open]);
  return { open, setOpen, ref };
}

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
  const { open, setOpen, ref } = useFlyout(collapsed);
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
        <Button
          variant="tool"
          aria-label={`${props.title} tools`}
          tooltip={props.title}
          aria-expanded={open}
          onMouseDown={keepFocus}
          onClick={() => setOpen(!open)}
          className="mr-1 h-auto flex-1 flex-col gap-1 rounded-md px-0 [&_svg]:size-4"
        >
          {props.icon}
          <ChevronDown className="size-3!" />
        </Button>
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
}: Omit<ComponentProps<"select">, "onChange" | "size"> & {
  label?: string;
  disabledReason?: string;
  onPick: (value: string) => void;
  onDone?: () => void;
}) {
  return (
    <NativeSelect
      size="sm"
      aria-label={label}
      // The list's own tooltip: it shows on a disabled list too, which a tooltip of the app's cannot.
      title={rest.disabled && disabledReason ? disabledReason : (title ?? label)}
      {...rest}
      onChange={(event) => {
        onPick(event.target.value);
        onDone?.();
      }}
      // `className` sizes the box around the list, which fills it; the row of a ribbon is 24px high.
      className={cn(
        "[&_select]:h-6 [&_select]:py-0 [&_select]:pr-5 [&_select]:pl-1.5 [&_select]:text-xs [&_svg]:right-1 [&_svg]:size-3",
        className,
      )}
    />
  );
}

/**
 * A ribbon button with its name next to its icon, filling its row. `active` marks a choice as the
 * one made. `label` says in full what it does, as its name and its tooltip; disabled, it is plainly
 * off (it has no reason to give, and its short name is beside its icon).
 */
export function RibbonToggle(props: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="tool"
      size="xs"
      aria-label={props.label}
      {...(!props.disabled && { tooltip: props.label })}
      {...(props.active !== undefined && { "aria-pressed": props.active })}
      {...(props.disabled !== undefined && { disabled: props.disabled })}
      onClick={props.onClick}
      className="flex-1 justify-start px-1.5 font-normal [&_svg:not([class*='size-'])]:size-4"
    >
      {props.children}
    </Button>
  );
}
