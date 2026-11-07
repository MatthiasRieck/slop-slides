import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  ArrowDown,
  ArrowDownLeft,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  FlipHorizontal2,
  FlipVertical2,
  Move,
  Rotate3d,
  RotateCcw,
  RotateCcwSquare,
  RotateCwSquare,
  StretchHorizontal,
  StretchVertical,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import {
  type AlignTarget,
  type AlignTo,
  type ArrangeMessage,
  type EditGeometry,
  type GeometryField,
  parseGeometryValue,
  quarterTurn,
  TILT_STEP,
} from "../lib/arrange";
import type { EditSelection, EditStyle } from "../lib/editTools";
import { cn } from "../lib/utils";
import { keepFocus, ToolButton } from "./Button";
import { DraftInput } from "./Field";
import { DropdownPanel, useDismiss } from "./Popover";
import { SectionLabel } from "./SectionLabel";

const ALIGN: { to: AlignTo; label: string; icon: ReactNode }[] = [
  { to: "left", label: "left edges", icon: <AlignStartVertical /> },
  { to: "center", label: "horizontal centers", icon: <AlignCenterVertical /> },
  { to: "right", label: "right edges", icon: <AlignEndVertical /> },
  { to: "top", label: "top edges", icon: <AlignStartHorizontal /> },
  { to: "middle", label: "vertical centers", icon: <AlignCenterHorizontal /> },
  { to: "bottom", label: "bottom edges", icon: <AlignEndHorizontal /> },
];

const FIELDS: { field: GeometryField; label: string; title: string }[] = [
  { field: "x", label: "X", title: "Distance from the slide's left edge" },
  { field: "y", label: "Y", title: "Distance from the slide's top edge" },
  { field: "w", label: "W", title: "Width" },
  { field: "h", label: "H", title: "Height" },
  { field: "rotation", label: "°", title: "Rotation in degrees" },
];

/**
 * The 3D rotate buttons, laid out the way they turn: the side a button names turns away, as when
 * pulling the tilt handle that way. `x` and `y` are steps around the horizontal and vertical axis.
 */
const TILTS: { side: string; x: number; y: number; icon: ReactNode }[] = [
  { side: "top left", x: 1, y: -1, icon: <ArrowUpLeft /> },
  { side: "top", x: 1, y: 0, icon: <ArrowUp /> },
  { side: "top right", x: 1, y: 1, icon: <ArrowUpRight /> },
  { side: "left", x: 0, y: -1, icon: <ArrowLeft /> },
  { side: "right", x: 0, y: 1, icon: <ArrowRight /> },
  { side: "bottom left", x: -1, y: -1, icon: <ArrowDownLeft /> },
  { side: "bottom", x: -1, y: 0, icon: <ArrowDown /> },
  { side: "bottom right", x: -1, y: 1, icon: <ArrowDownRight /> },
];

/**
 * The selection's place on the slide: align it with the slide or with its own bounds, distribute
 * and match the size of several elements, flip and quarter-turn it, and exact position, size and
 * rotation. Several elements have bounds to move, but no size or rotation to type. The panel
 * stays open for one change after another, also through the preview's reload after each save,
 * which clears the selection until the editor restores it.
 */
export function ArrangeControls(props: {
  geometry: EditGeometry | null;
  /** The selected element's look, for flipping it. */
  selection?: EditSelection | null;
  onArrange?: (message: ArrangeMessage) => void;
  onStyle?: (changes: EditStyle) => void;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<AlignTarget>("selection");
  const ref = useRef<HTMLDivElement>(null);
  // What the panel shows while the selection is away, so it does not jump or close.
  const shown = useRef<EditGeometry | null>(null);
  if (props.geometry) shown.current = props.geometry;
  const geometry = props.geometry ?? shown.current;
  const off = !props.geometry;
  const many = (geometry?.count ?? 0) > 1;
  const alignTo: AlignTarget = many ? target : "slide";
  const selection = props.selection ?? null;
  const flips = !off && !many && !!selection?.flippable;
  const rotation = geometry?.rotation ?? null;

  useDismiss(open, ref, () => setOpen(false));

  return (
    <div ref={ref} className="relative">
      <ToolButton
        keepFocus
        label="Arrange"
        title="Align, distribute, match size, flip, position and size"
        aria-expanded={open}
        active={open}
        disabled={off && !open}
        onClick={() => setOpen(!open)}
      >
        <Move />
      </ToolButton>
      {open && geometry && (
        <DropdownPanel role="dialog" aria-label="Arrange" className="flex w-max flex-col gap-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <SectionLabel>Align</SectionLabel>
            <fieldset aria-label="Align to" className="flex rounded-md border p-0.5">
              {(["slide", "selection"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={alignTo === t}
                  title={
                    t === "slide"
                      ? "Line each element up with the slide's edges or center"
                      : "Line the elements up with each other (two or more)"
                  }
                  disabled={off || (t === "selection" && !many)}
                  onMouseDown={keepFocus}
                  onClick={() => setTarget(t)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-30",
                    alignTo === t && "bg-accent text-foreground",
                  )}
                >
                  {t === "slide" ? "Slide" : "Selection"}
                </button>
              ))}
            </fieldset>
          </div>
          <div className="flex items-center gap-0.5">
            {ALIGN.map((a) => (
              <ToolButton
                key={a.to}
                keepFocus
                label={alignLabel(a.label, many, alignTo)}
                disabled={off}
                onClick={() => props.onArrange?.({ type: "slop:edit-align", to: a.to, target: alignTo })}
              >
                {a.icon}
              </ToolButton>
            ))}
            <div className="mx-1 h-4 w-px bg-border" />
            <ToolButton
              keepFocus
              label="Distribute horizontally"
              title="Even out the gaps side to side (three or more elements)"
              disabled={off || geometry.count < 3}
              onClick={() => props.onArrange?.({ type: "slop:edit-distribute", axis: "h" })}
            >
              <AlignHorizontalDistributeCenter />
            </ToolButton>
            <ToolButton
              keepFocus
              label="Distribute vertically"
              title="Even out the gaps top to bottom (three or more elements)"
              disabled={off || geometry.count < 3}
              onClick={() => props.onArrange?.({ type: "slop:edit-distribute", axis: "v" })}
            >
              <AlignVerticalDistributeCenter />
            </ToolButton>
          </div>
          <div className="flex items-center gap-0.5">
            <ToolButton
              keepFocus
              label="Match width"
              title="Give the others the first selected element's width (two or more elements)"
              disabled={off || !many}
              onClick={() => props.onArrange?.({ type: "slop:edit-match", axis: "w" })}
            >
              <StretchHorizontal />
            </ToolButton>
            <ToolButton
              keepFocus
              label="Match height"
              title="Give the others the first selected element's height (two or more elements)"
              disabled={off || !many}
              onClick={() => props.onArrange?.({ type: "slop:edit-match", axis: "h" })}
            >
              <StretchVertical />
            </ToolButton>
            <div className="mx-1 h-4 w-px bg-border" />
            <ToolButton
              keepFocus
              label="Flip horizontally"
              title={flips ? "Flip horizontally" : "Flip horizontally (images, shapes and drawings; not text or lines)"}
              active={flips && !!selection?.flipX}
              disabled={!flips}
              onClick={() => props.onStyle?.({ flipX: !selection?.flipX })}
            >
              <FlipHorizontal2 />
            </ToolButton>
            <ToolButton
              keepFocus
              label="Flip vertically"
              title={flips ? "Flip vertically" : "Flip vertically (images, shapes and drawings; not text or lines)"}
              active={flips && !!selection?.flipY}
              disabled={!flips}
              onClick={() => props.onStyle?.({ flipY: !selection?.flipY })}
            >
              <FlipVertical2 />
            </ToolButton>
            <div className="mx-1 h-4 w-px bg-border" />
            {([-1, 1] as const).map((step) => (
              <ToolButton
                key={step}
                keepFocus
                label={step < 0 ? "Rotate 90° counterclockwise" : "Rotate 90° clockwise"}
                disabled={off || rotation === null}
                onClick={() =>
                  rotation !== null &&
                  props.onArrange?.({ type: "slop:edit-geometry", rotation: quarterTurn(rotation, step) })
                }
              >
                {step < 0 ? <RotateCcwSquare /> : <RotateCwSquare />}
              </ToolButton>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            {FIELDS.map((f) => (
              <GeometryInput
                key={f.field}
                {...f}
                value={f.field === "rotation" ? geometry.rotation : geometry[f.field]}
                disabled={off || (many && f.field !== "x" && f.field !== "y")}
                onChange={(value) => props.onArrange?.({ type: "slop:edit-geometry", [f.field]: value })}
                onDone={props.onDone}
              />
            ))}
          </div>
          {many && <p className="text-muted-foreground">{geometry.count} elements selected</p>}
        </DropdownPanel>
      )}
    </div>
  );
}

/** What an align button says it does: with the slide, or with the other selected elements. */
function alignLabel(edges: string, many: boolean, target: AlignTarget) {
  if (!many) return `Align with the slide's ${edges}`;
  return target === "slide" ? `Align ${edges} with the slide` : `Align ${edges}`;
}

/**
 * Turns the selection in 3D, a step at a time, with a reset in the middle. The panel stays open
 * to press again, and through the preview's reload after a save, which clears the selection
 * until the editor restores it.
 */
export function TiltControls(props: { geometry: EditGeometry | null; onArrange?: (message: ArrangeMessage) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, () => setOpen(false));
  const off = !props.geometry;
  const tilt = (t: (typeof TILTS)[number]) => (
    <ToolButton
      keepFocus
      key={t.side}
      label={`Rotate ${t.side} ${TILT_STEP}° in 3D`}
      disabled={off}
      onClick={() => props.onArrange?.({ type: "slop:edit-tilt", x: t.x * TILT_STEP, y: t.y * TILT_STEP })}
    >
      {t.icon}
    </ToolButton>
  );
  return (
    <div ref={ref} className="relative">
      <ToolButton keepFocus label="3D rotate" active={open} disabled={off && !open} onClick={() => setOpen(!open)}>
        <Rotate3d />
      </ToolButton>
      {open && (
        <DropdownPanel role="dialog" aria-label="3D rotate" className="grid w-max grid-cols-3 gap-0.5 p-1">
          {TILTS.slice(0, 4).map(tilt)}
          <ToolButton
            keepFocus
            label="Reset the 3D rotation"
            disabled={off}
            onClick={() => props.onArrange?.({ type: "slop:edit-tilt", reset: true })}
          >
            <RotateCcw />
          </ToolButton>
          {TILTS.slice(4).map(tilt)}
        </DropdownPanel>
      )}
    </div>
  );
}

/** A number to type; it applies on Enter or when the field loses focus. */
function GeometryInput(props: {
  field: GeometryField;
  label: string;
  title: string;
  value: number | null;
  disabled: boolean;
  onChange: (value: number) => void;
  onDone: () => void;
}) {
  return (
    <label title={props.title} className="flex items-center gap-1 text-muted-foreground">
      {props.label}
      <DraftInput
        aria-label={props.title}
        disabled={props.disabled}
        value={props.value}
        parse={(text) => parseGeometryValue(props.field, text)}
        sanitize={(text) => text.replace(/[^\d.-]/g, "")}
        onChange={props.onChange}
        onDone={props.onDone}
        className="h-6 w-12 rounded-md border bg-transparent px-1 text-center text-foreground tabular-nums disabled:opacity-30"
      />
    </label>
  );
}
