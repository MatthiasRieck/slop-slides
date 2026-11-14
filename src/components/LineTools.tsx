import { ArrowLeftRight, Spline } from "lucide-react";
import { useDropdown } from "../hooks/useDropdown";
import {
  DASHES,
  type Dash,
  type EditSelection,
  type EditStyle,
  HEAD_KINDS,
  type HeadKind,
  LINE_ROUTES,
  type LineRoute,
} from "../lib/editTools";
import { cn } from "../lib/utils";
import { keepFocus, ToolButton } from "./Button";
import { DropdownPanel } from "./Popover";
import { LabelPanelButton, PanelLabel, panelGrid } from "./ribbon/parts";

const DASH_LABELS: Record<Dash, string> = { solid: "Solid", dashed: "Dashed", dotted: "Dotted" };
/** How each dash is drawn in its sample, as an SVG `stroke-dasharray`. */
const DASH_ARRAYS: Record<Dash, string | undefined> = { solid: undefined, dashed: "5 3", dotted: "0.1 4" };
const HEAD_LABELS: Record<HeadKind, string> = { arrow: "Arrow", triangle: "Triangle", bar: "Bar", dot: "Dot" };
const ROUTE_LABELS: Record<LineRoute, { label: string; title: string }> = {
  straight: { label: "Straight", title: "Straight, or curved through the points you bend it at" },
  elbow: { label: "Elbow", title: "Turns at right angles, out of the sides of what its ends are stuck to" },
  curved: { label: "Curved", title: "One curve, out of the sides of what its ends are stuck to" },
};

/** A short line drawn the way `dash` draws lines and borders. */
function DashSample({ dash }: { dash: Dash }) {
  return (
    <svg viewBox="0 0 24 8" aria-hidden="true" className="!h-2 !w-6" fill="none" stroke="currentColor">
      <path d="M1 4 H23" strokeWidth="2" strokeLinecap="round" strokeDasharray={DASH_ARRAYS[dash]} />
    </svg>
  );
}

/**
 * How the selection's line or border is drawn: solid, dashed or dotted, each choice shown as a
 * line drawn that way. `mixed` when the selected elements differ: none of the choices is then
 * marked.
 */
export function DashPicker(props: {
  value: Dash;
  mixed?: boolean;
  vector: boolean;
  disabled: boolean;
  disabledReason?: string;
  onChange: (changes: EditStyle) => void;
  onDone?: () => void;
}) {
  const { open, setOpen, ref, toggle } = useDropdown({ disabled: props.disabled });
  const label = props.vector ? "Line style" : "Border style";
  return (
    <div ref={ref} className="relative">
      <ToolButton
        keepFocus
        label={label}
        title={`${label}: ${props.mixed ? "mixed" : DASH_LABELS[props.value].toLowerCase()}`}
        aria-expanded={open}
        active={open}
        disabled={props.disabled}
        disabledReason={props.disabledReason}
        onClick={toggle}
        className="flex h-6 items-center px-1"
      >
        {props.mixed ? (
          <span className="w-6 text-center text-xs leading-none">–</span>
        ) : (
          <DashSample dash={props.value} />
        )}
      </ToolButton>
      {open && (
        <DropdownPanel role="dialog" aria-label={label} className="flex w-max flex-col gap-0.5 p-1">
          {DASHES.map((dash) => (
            <ToolButton
              keepFocus
              key={dash}
              label={DASH_LABELS[dash]}
              active={!props.mixed && props.value === dash}
              onClick={() => {
                props.onChange({ dash });
                setOpen(false);
                props.onDone?.();
              }}
              className="flex h-6 items-center px-2"
            >
              <DashSample dash={dash} />
            </ToolButton>
          ))}
        </DropdownPanel>
      )}
    </div>
  );
}

/** The end of a line with `head` on it (or none), pointing right; `flip` draws it pointing left, for a line's start. */
function HeadSample({ head, flip }: { head: HeadKind | null; flip?: boolean }) {
  const shapes: Record<HeadKind, React.ReactNode> = {
    arrow: <path d="M14 3 L20 8 L14 13" />,
    triangle: <path d="M13 3 L21 8 L13 13 Z" fill="currentColor" />,
    bar: <path d="M20 3 V13" />,
    dot: <circle cx="18" cy="8" r="3" fill="currentColor" />,
  };
  return (
    <svg
      viewBox="0 0 24 16"
      aria-hidden="true"
      className={cn("!h-4 !w-6", flip && "-scale-x-100")}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={head === "arrow" || head === "bar" ? "M3 8 H20" : head ? "M3 8 H14" : "M3 8 H21"} />
      {head && shapes[head]}
    </svg>
  );
}

/**
 * The selected line's ends and route: a head at either end (or none), each drawn as it will
 * look, swapping the two ends, and whether the line goes straight (or curved through its
 * points), or as an elbow or curved connector between what its ends are stuck to. Shown for a
 * line only.
 */
export function LineButton(props: {
  selection: EditSelection;
  onChange: (changes: EditStyle) => void;
  onDone: () => void;
}) {
  const line = props.selection.line;
  const { open, ref, toggle } = useDropdown({ disabled: !line });
  if (!line) return null;
  const change = (changes: EditStyle) => {
    props.onChange(changes);
    props.onDone();
  };
  const heads = (end: "start" | "end") => (
    <fieldset aria-label={end === "start" ? "Start of the line" : "End of the line"} className="flex gap-0.5">
      {[null, ...HEAD_KINDS].map((head) => (
        <ToolButton
          keepFocus
          key={head ?? "none"}
          label={head ? HEAD_LABELS[head] : "None"}
          active={line[end] === head}
          onClick={() => change(end === "start" ? { headStart: head } : { headEnd: head })}
          className="flex h-6 items-center px-0.5"
        >
          <HeadSample head={head} flip={end === "start"} />
        </ToolButton>
      ))}
    </fieldset>
  );
  return (
    <div ref={ref} className="relative">
      <LabelPanelButton
        open={open}
        text="Line"
        label="Line ends and route"
        title="Line: arrowheads at either end, swapping them, and how the line goes"
        onClick={toggle}
      >
        <Spline />
      </LabelPanelButton>
      {open && (
        <DropdownPanel role="dialog" aria-label="Line ends and route" className={panelGrid}>
          <PanelLabel>Start</PanelLabel>
          {heads("start")}
          <PanelLabel>End</PanelLabel>
          {heads("end")}
          <span />
          <ToolButton
            keepFocus
            label="Swap ends"
            title="Swap ends: the start gets the end's head, and the end the start's"
            disabled={line.start === line.end}
            disabledReason="Both ends look the same"
            onClick={() => change({ headStart: line.end, headEnd: line.start })}
            className="flex w-max items-center gap-1 px-1.5 text-xs"
          >
            <ArrowLeftRight />
            Swap ends
          </ToolButton>
          <PanelLabel>Route</PanelLabel>
          <fieldset aria-label="Route" className="flex rounded-md border p-0.5">
            {LINE_ROUTES.map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={line.route === r}
                title={ROUTE_LABELS[r].title}
                onMouseDown={keepFocus}
                onClick={() => change({ route: r })}
                className={cn(
                  "rounded px-1.5 py-0.5 text-muted-foreground hover:text-foreground",
                  line.route === r && "bg-primary/10 text-primary hover:text-primary",
                )}
              >
                {ROUTE_LABELS[r].label}
              </button>
            ))}
          </fieldset>
        </DropdownPanel>
      )}
    </div>
  );
}

/** Icons for shapes lucide has none of, drawn like its own (24 × 24, a 2px round stroke). */
function ShapeIcon(props: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={props.d} />
    </svg>
  );
}

export const Parallelogram = () => <ShapeIcon d="M7 5h14l-4 14H3z" />;
export const Trapezoid = () => <ShapeIcon d="M7 5h10l4 14H3z" />;
/** A double-headed block arrow, as the tool draws it. */
export const DoubleArrow = () => <ShapeIcon d="M2 12l5-5v3h10V7l5 5-5 5v-3H7v3z" />;
/** One square bracket, as the tool draws it. */
export const Bracket = () => <ShapeIcon d="M15 4H9v16h6" />;
/** One curly brace, as the tool draws it. */
export const Brace = () => <ShapeIcon d="M15 4c-3 0-3 2-3 4s0 4-3 4c3 0 3 2 3 4s0 4 3 4" />;
/** Lines of text with an arrow up and down beside them: the room between lines. */
export const LineSpacing = () => (
  <ShapeIcon d="M11 6h10M11 12h10M11 18h10M5 5v14M2.5 7.5L5 5l2.5 2.5M2.5 16.5L5 19l2.5-2.5" />
);
/** One layer up the stack: a square moving up over another. */
export const ForwardOne = () => <ShapeIcon d="M4 14h10v6H4zM9 10V3M6 6l3-3 3 3M18 14h2M18 20h2M20 14v6" />;
/** One layer down the stack. */
export const BackwardOne = () => <ShapeIcon d="M4 4h10v6H4zM9 14v7M6 18l3 3 3-3M18 4h2M18 10h2M20 4v6" />;
/** "As wide as": two bars of the same width. */
export const SameWidth = () => <ShapeIcon d="M4 7h16M4 4v6M20 4v6M4 17h16M4 14v6M20 14v6" />;
/** "As tall as": two bars of the same height. */
export const SameHeight = () => <ShapeIcon d="M7 4v16M4 4h6M4 20h6M17 4v16M14 4h6M14 20h6" />;
