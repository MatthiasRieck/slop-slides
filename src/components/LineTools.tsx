import { Spline } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { keepFocus } from "@/lib/focus";
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
import { RibbonSelect } from "./Ribbon";
import { QUIET_LABEL } from "./styles";
import { TOOLBAR_POPUP } from "./toolProps";

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
  disabledReason?: string;
  onChange: (changes: EditStyle) => void;
  onDone?: () => void;
}) {
  return (
    <RibbonSelect
      label={props.vector ? "Line style" : "Border style"}
      disabled={props.disabled}
      disabledReason={props.disabledReason}
      value={props.value}
      onPick={(dash) => props.onChange({ dash: dash as Dash })}
      onDone={props.onDone}
      className="w-20 enabled:hover:bg-accent"
    >
      {DASHES.map((d) => (
        <NativeSelectOption key={d} value={d}>
          {DASH_LABELS[d]}
        </NativeSelectOption>
      ))}
    </RibbonSelect>
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
  const [open, setOpen] = useState(false);
  // Only a line has ends: with anything else selected the panel closes, and stays closed.
  if (!line && open) setOpen(false);
  const id = useId();
  const change = (changes: EditStyle) => {
    props.onChange(changes);
    props.onDone();
  };
  const head = (end: "start" | "end") => (
    <NativeSelect
      id={`${id}-${end}`}
      size="sm"
      value={line?.[end] ?? ""}
      onChange={(event) =>
        change(
          end === "start"
            ? { headStart: (event.target.value || null) as HeadKind | null }
            : { headEnd: (event.target.value || null) as HeadKind | null },
        )
      }
    >
      <NativeSelectOption value="">None</NativeSelectOption>
      {HEAD_KINDS.map((k) => (
        <NativeSelectOption key={k} value={k}>
          {HEAD_LABELS[k]}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="tool"
            size="icon-xs"
            aria-label="Line ends and route"
            tooltip={line ? "Arrowheads at either end, and how the line goes" : "Select a line"}
            disabled={!line}
            keepFocus
          />
        }
      >
        <Spline />
      </PopoverTrigger>
      {line && (
        <PopoverContent
          {...TOOLBAR_POPUP}
          aria-label="Line ends and route"
          initialFocus={false}
          finalFocus={false}
          className="grid w-max grid-cols-[auto_auto] items-center gap-x-2 gap-y-1.5 p-2 text-xs"
        >
          <Label htmlFor={`${id}-start`} className={QUIET_LABEL}>
            Start
          </Label>
          {head("start")}
          <Label htmlFor={`${id}-end`} className={QUIET_LABEL}>
            End
          </Label>
          {head("end")}
          <span className={QUIET_LABEL}>Route</span>
          <ToggleGroup
            aria-label="Route"
            size="xs"
            variant="outline"
            spacing={0}
            value={[line.route]}
            // Pressing the route it has changes nothing: a line always has one.
            onValueChange={([route]) => route && change({ route: route as LineRoute })}
          >
            {LINE_ROUTES.map((r) => (
              <Tooltip key={r}>
                <TooltipTrigger render={<ToggleGroupItem value={r} onMouseDownCapture={keepFocus} />}>
                  {ROUTE_LABELS[r].label}
                </TooltipTrigger>
                <TooltipContent>{ROUTE_LABELS[r].title}</TooltipContent>
              </Tooltip>
            ))}
          </ToggleGroup>
        </PopoverContent>
      )}
    </Popover>
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
