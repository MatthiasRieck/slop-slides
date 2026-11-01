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
  Move,
  Rotate3d,
  RotateCcw,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import {
  type AlignTo,
  type ArrangeMessage,
  type EditGeometry,
  type GeometryField,
  parseGeometryValue,
  TILT_STEP,
} from "../lib/arrange";
import { ToolButton } from "./Button";
import { DraftInput } from "./Field";
import { DropdownPanel, useDismiss } from "./Popover";

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
 * The selection's place on the slide: align and distribute several elements, align one with the
 * slide, and exact position, size and rotation. Several elements have bounds to move, but no
 * size or rotation to type.
 */
export function ArrangeControls(props: {
  geometry: EditGeometry | null;
  onArrange?: (message: ArrangeMessage) => void;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { geometry } = props;
  const many = (geometry?.count ?? 0) > 1;

  useDismiss(open, ref, () => setOpen(false));
  if (!geometry && open) setOpen(false);

  return (
    <div ref={ref} className="relative">
      <ToolButton
        keepFocus
        label="Arrange"
        title="Align, distribute, position and size"
        aria-expanded={open}
        disabled={!geometry}
        onClick={() => setOpen(!open)}
      >
        <Move />
      </ToolButton>
      {open && geometry && (
        <DropdownPanel role="dialog" aria-label="Arrange" className="flex w-max flex-col gap-2 text-xs">
          <div className="flex items-center gap-0.5">
            {ALIGN.map((a) => {
              const label = many ? `Align ${a.label}` : `Align with the slide's ${a.label}`;
              return (
                <ToolButton
                  key={a.to}
                  keepFocus
                  label={label}
                  onClick={() => props.onArrange?.({ type: "slop:edit-align", to: a.to })}
                >
                  {a.icon}
                </ToolButton>
              );
            })}
            <div className="mx-1 h-4 w-px bg-border" />
            <ToolButton
              keepFocus
              label="Distribute horizontally"
              title="Even out the gaps side to side (three or more elements)"
              disabled={geometry.count < 3}
              onClick={() => props.onArrange?.({ type: "slop:edit-distribute", axis: "h" })}
            >
              <AlignHorizontalDistributeCenter />
            </ToolButton>
            <ToolButton
              keepFocus
              label="Distribute vertically"
              title="Even out the gaps top to bottom (three or more elements)"
              disabled={geometry.count < 3}
              onClick={() => props.onArrange?.({ type: "slop:edit-distribute", axis: "v" })}
            >
              <AlignVerticalDistributeCenter />
            </ToolButton>
          </div>
          <div className="flex items-center gap-1.5">
            {FIELDS.map((f) => (
              <GeometryInput
                key={f.field}
                {...f}
                value={f.field === "rotation" ? geometry.rotation : geometry[f.field]}
                disabled={many && f.field !== "x" && f.field !== "y"}
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
