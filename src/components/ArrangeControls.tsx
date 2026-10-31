import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  Move,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import {
  type AlignTo,
  type ArrangeMessage,
  type EditGeometry,
  type GeometryField,
  parseGeometryValue,
} from "../lib/arrange";

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

/** Keeps focus (and the text selection) in the slide when a button is pressed. */
function keepFocus(event: React.MouseEvent) {
  event.preventDefault();
}

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

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);
  if (!geometry && open) setOpen(false);

  const button =
    "rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-4";
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Arrange"
        title="Align, distribute, position and size"
        aria-expanded={open}
        disabled={!geometry}
        onMouseDown={keepFocus}
        onClick={() => setOpen(!open)}
        className={button}
      >
        <Move />
      </button>
      {open && geometry && (
        <div
          role="dialog"
          aria-label="Arrange"
          className="absolute top-full left-1/2 z-30 mt-1 flex w-max -translate-x-1/2 flex-col gap-2 rounded-md border bg-card p-2 text-xs shadow-md"
        >
          <div className="flex items-center gap-0.5">
            {ALIGN.map((a) => {
              const label = many ? `Align ${a.label}` : `Align with the slide's ${a.label}`;
              return (
                <button
                  key={a.to}
                  type="button"
                  aria-label={label}
                  title={label}
                  onMouseDown={keepFocus}
                  onClick={() => props.onArrange?.({ type: "slop:edit-align", to: a.to })}
                  className={button}
                >
                  {a.icon}
                </button>
              );
            })}
            <div className="mx-1 h-4 w-px bg-border" />
            <button
              type="button"
              aria-label="Distribute horizontally"
              title="Even out the gaps side to side (three or more elements)"
              disabled={geometry.count < 3}
              onMouseDown={keepFocus}
              onClick={() => props.onArrange?.({ type: "slop:edit-distribute", axis: "h" })}
              className={button}
            >
              <AlignHorizontalDistributeCenter />
            </button>
            <button
              type="button"
              aria-label="Distribute vertically"
              title="Even out the gaps top to bottom (three or more elements)"
              disabled={geometry.count < 3}
              onMouseDown={keepFocus}
              onClick={() => props.onArrange?.({ type: "slop:edit-distribute", axis: "v" })}
              className={button}
            >
              <AlignVerticalDistributeCenter />
            </button>
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
        </div>
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
  const shown = props.value === null ? "" : String(props.value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const apply = () => {
    const value = parseGeometryValue(props.field, draft);
    if (value === null || value === props.value) setDraft(shown);
    else props.onChange(value);
  };
  return (
    <label title={props.title} className="flex items-center gap-1 text-muted-foreground">
      {props.label}
      <input
        type="text"
        inputMode="numeric"
        aria-label={props.title}
        disabled={props.disabled}
        placeholder="–"
        value={draft}
        onChange={(event) => setDraft(event.target.value.replace(/[^\d.-]/g, ""))}
        onBlur={apply}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            apply();
            props.onDone();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(shown);
            props.onDone();
          }
        }}
        className="h-6 w-12 rounded-md border bg-transparent px-1 text-center text-foreground tabular-nums disabled:opacity-30"
      />
    </label>
  );
}
