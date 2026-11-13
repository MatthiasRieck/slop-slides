import { Spline } from "lucide-react";
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

const DASH_LABELS: Record<Dash, string> = { solid: "Solid", dashed: "Dashed", dotted: "Dotted" };
const HEAD_LABELS: Record<HeadKind, string> = { arrow: "Arrow", triangle: "Triangle", bar: "Bar", dot: "Dot" };
const ROUTE_LABELS: Record<LineRoute, { label: string; title: string }> = {
  straight: { label: "Straight", title: "Straight, or curved through the points you bend it at" },
  elbow: { label: "Elbow", title: "Turns at right angles, out of the sides of what its ends are stuck to" },
  curved: { label: "Curved", title: "One curve, out of the sides of what its ends are stuck to" },
};

/** How the selection's line or border is drawn: solid, dashed or dotted. */
export function DashSelect(props: {
  value: Dash;
  vector: boolean;
  disabled: boolean;
  onChange: (changes: EditStyle) => void;
}) {
  const label = props.vector ? "Line style" : "Border style";
  return (
    <select
      aria-label={label}
      title={label}
      disabled={props.disabled}
      value={props.value}
      onChange={(event) => props.onChange({ dash: event.target.value as Dash })}
      className="h-6 w-20 rounded-md bg-transparent px-1 text-xs hover:bg-accent disabled:opacity-40"
    >
      {DASHES.map((d) => (
        <option key={d} value={d}>
          {DASH_LABELS[d]}
        </option>
      ))}
    </select>
  );
}

/**
 * The selected line's ends and route: a head at either end (or none), and whether it goes
 * straight (or curved through its points), or as an elbow or curved connector between what its
 * ends are stuck to. Disabled for anything but a line.
 */
export function LineButton(props: {
  selection: EditSelection | null;
  onChange: (changes: EditStyle) => void;
  onDone: () => void;
}) {
  const line = props.selection?.line ?? null;
  const { open, ref, toggle } = useDropdown({ disabled: !line });
  const change = (changes: EditStyle) => {
    props.onChange(changes);
    props.onDone();
  };
  const head = (end: "start" | "end") => (
    <select
      id={`edit-line-${end}`}
      value={line?.[end] ?? ""}
      onChange={(event) =>
        change(
          end === "start"
            ? { headStart: (event.target.value || null) as HeadKind | null }
            : { headEnd: (event.target.value || null) as HeadKind | null },
        )
      }
      className="h-6 rounded border bg-transparent px-1"
    >
      <option value="">None</option>
      {HEAD_KINDS.map((k) => (
        <option key={k} value={k}>
          {HEAD_LABELS[k]}
        </option>
      ))}
    </select>
  );
  return (
    <div ref={ref} className="relative">
      <ToolButton
        keepFocus
        label="Line ends and route"
        title={line ? "Arrowheads at either end, and how the line goes" : "Line ends and route (select a line)"}
        aria-expanded={open}
        disabled={!line}
        onClick={toggle}
      >
        <Spline />
      </ToolButton>
      {open && line && (
        <DropdownPanel
          role="dialog"
          aria-label="Line ends and route"
          className="grid w-max grid-cols-[auto_auto] items-center gap-x-2 gap-y-1.5 text-xs"
        >
          <label htmlFor="edit-line-start" className="text-muted-foreground">
            Start
          </label>
          {head("start")}
          <label htmlFor="edit-line-end" className="text-muted-foreground">
            End
          </label>
          {head("end")}
          <span className="text-muted-foreground">Route</span>
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
                  line.route === r && "bg-accent text-foreground",
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
