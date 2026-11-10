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
  Group,
  Layers,
  Link2,
  Link2Off,
  Lock,
  LockOpen,
  Move,
  Rotate3d,
  RotateCcw,
  RotateCcwSquare,
  RotateCwSquare,
  StretchHorizontal,
  StretchVertical,
  Ungroup,
} from "lucide-react";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";

import {
  type AlignTarget,
  type AlignTo,
  type ArrangeMessage,
  type EditGeometry,
  type EditLayer,
  type GeometryField,
  parseGeometryValue,
  quarterTurn,
  TILT_STEP,
} from "../lib/arrange";
import type { EditSelection, EditStyle } from "../lib/editTools";
import { cn } from "../lib/utils";
import { keepFocus, ToolButton } from "./Button";
import { useDropdown } from "./editing/useDropdown";
import { DraftInput } from "./Field";
import { DropdownPanel } from "./Popover";
import { SectionLabel } from "./SectionLabel";

const ALIGN: { to: AlignTo; label: string; icon: ReactNode }[] = [
  { to: "left", label: "left edges", icon: <AlignStartVertical /> },
  { to: "center", label: "horizontal centers", icon: <AlignCenterVertical /> },
  { to: "right", label: "right edges", icon: <AlignEndVertical /> },
  { to: "top", label: "top edges", icon: <AlignStartHorizontal /> },
  { to: "middle", label: "vertical centers", icon: <AlignCenterHorizontal /> },
  { to: "bottom", label: "bottom edges", icon: <AlignEndHorizontal /> },
];

/** How long a number typed during the preview's reload waits for the selection to come back. */
const RELOAD_MS = 2000;

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
  /** Resizes keep the aspect ratio: by the handles, and a typed width or height brings the other along. */
  keepRatio?: boolean;
  onKeepRatio?: (on: boolean) => void;
}) {
  const { open, ref, toggle } = useDropdown();
  const [target, setTarget] = useState<AlignTarget>("selection");
  // What the panel shows while the selection is away, so it does not jump or close.
  const shown = useRef<EditGeometry | null>(null);
  if (props.geometry) shown.current = props.geometry;
  const geometry = props.geometry ?? shown.current;
  const off = !props.geometry;
  // A number typed while the preview reloads after a save (Tab from one field to the next
  // applies the first), for the selection the editor restores. The fields stay enabled through
  // the reload, so the one being typed in keeps its focus. A selection that does not come back
  // soon is gone, and what was typed for it goes too.
  const pending = useRef<{ message: ArrangeMessage; at: number }[]>([]);
  const onArrange = useRef(props.onArrange);
  onArrange.current = props.onArrange;
  useEffect(() => {
    if (!props.geometry) return;
    const queued = pending.current.filter((p) => Date.now() - p.at <= RELOAD_MS);
    pending.current = [];
    for (const p of queued) onArrange.current?.(p.message);
  }, [props.geometry]);
  const arrangeField = (message: ArrangeMessage) => {
    if (off) pending.current.push({ message, at: Date.now() });
    else props.onArrange?.(message);
  };
  const many = (geometry?.count ?? 0) > 1;
  const alignTo: AlignTarget = many ? target : "slide";
  const selection = props.selection ?? null;
  const flips = !off && !many && !!selection?.flippable;
  const rotation = geometry?.rotation ?? null;

  return (
    <div ref={ref} className="relative">
      <ToolButton
        keepFocus
        label="Arrange"
        title="Align, distribute, match size, flip, position and size"
        aria-expanded={open}
        active={open}
        disabled={off && !open}
        onClick={toggle}
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
              <Fragment key={f.field}>
                <GeometryInput
                  {...f}
                  value={f.field === "rotation" ? geometry.rotation : geometry[f.field]}
                  disabled={many && f.field !== "x" && f.field !== "y"}
                  onChange={(value) => arrangeField({ type: "slop:edit-geometry", [f.field]: value })}
                  onDone={props.onDone}
                />
                {f.field === "w" && (
                  <ToolButton
                    keepFocus
                    label="Lock aspect ratio"
                    title={
                      props.keepRatio
                        ? "Resizes keep the aspect ratio (Shift frees it); a typed width or height brings the other along"
                        : "Keep the aspect ratio when resizing, without holding Shift"
                    }
                    active={!!props.keepRatio}
                    onClick={() => props.onKeepRatio?.(!props.keepRatio)}
                  >
                    {props.keepRatio ? <Link2 /> : <Link2Off />}
                  </ToolButton>
                )}
              </Fragment>
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
  const { open, ref, toggle } = useDropdown();
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
      <ToolButton keepFocus label="3D rotate" active={open} disabled={off && !open} onClick={toggle}>
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

/**
 * Groups the selection (⌘G), takes a group apart (⇧⌘G), and locks or unlocks the selection so
 * it cannot be picked, moved or deleted by accident.
 */
export function GroupControls(props: {
  geometry: EditGeometry | null;
  selection: EditSelection | null;
  onArrange?: (message: ArrangeMessage) => void;
}) {
  const count = props.geometry?.count ?? 0;
  const locked = !!props.selection?.locked;
  return (
    <>
      <ToolButton
        keepFocus
        label="Group (⌘G)"
        title="Group the selected elements, to move, size and style them as one (two or more)"
        disabled={count < 2}
        onClick={() => props.onArrange?.({ type: "slop:edit-group" })}
      >
        <Group />
      </ToolButton>
      <ToolButton
        keepFocus
        label="Ungroup (⇧⌘G)"
        disabled={!props.selection?.group}
        onClick={() => props.onArrange?.({ type: "slop:edit-ungroup" })}
      >
        <Ungroup />
      </ToolButton>
      <ToolButton
        keepFocus
        label={locked ? "Unlock" : "Lock"}
        title={
          locked
            ? "Unlock, so it can be picked and moved again"
            : "Lock, so it cannot be picked, moved or deleted by accident (unlock it from the Layers panel)"
        }
        active={locked}
        disabled={!props.selection}
        onClick={() => props.onArrange?.({ type: "slop:edit-lock", locked: !locked })}
      >
        {locked ? <Lock /> : <LockOpen />}
      </ToolButton>
    </>
  );
}

/**
 * What is on the slide, the top-most first, and in a group what it holds: pick one to select it
 * (also one that is locked or covered by others), lock or unlock it, or move it up or down past
 * the next one. The panel stays open through the preview's reload after each change.
 */
export function LayersPanel(props: { layers: EditLayer[]; onArrange?: (message: ArrangeMessage) => void }) {
  const { open, ref, toggle } = useDropdown();
  const { layers } = props;
  const send = (message: ArrangeMessage) => props.onArrange?.(message);
  return (
    <div ref={ref} className="relative">
      <ToolButton
        keepFocus
        label="Layers"
        title="What is on the slide, to pick, lock and restack"
        aria-expanded={open}
        active={open}
        disabled={!layers.length && !open}
        onClick={toggle}
      >
        <Layers />
      </ToolButton>
      {open && (
        <DropdownPanel
          role="dialog"
          aria-label="Layers"
          className="flex max-h-80 w-64 flex-col overflow-y-auto text-xs"
        >
          {!layers.length && <p className="px-1 py-0.5 text-muted-foreground">Nothing on this slide</p>}
          <ul aria-label="Layers, the top-most first" className="flex flex-col">
            {layers.map((layer) => {
              // Up and down go past the next layer of its own kind: in its group, or on the slide.
              const peers = layers.filter((other) => other.depth === layer.depth && samePlace(other.path, layer.path));
              const at = peers.indexOf(layer);
              return (
                <li
                  key={layer.path.join(".")}
                  className={cn("group flex items-center gap-0.5 rounded", layer.selected && "bg-accent")}
                  style={{ paddingLeft: layer.depth * 12 }}
                >
                  <button
                    type="button"
                    aria-current={layer.selected || undefined}
                    title={layer.name}
                    onMouseDown={keepFocus}
                    onClick={() => send({ type: "slop:edit-select", path: layer.path })}
                    className={cn(
                      "min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left hover:bg-accent",
                      (layer.locked || layer.held) && "text-muted-foreground",
                    )}
                  >
                    {layer.name}
                  </button>
                  <ToolButton
                    keepFocus
                    label={`${layer.locked ? "Unlock" : "Lock"} ${layer.name}`}
                    active={layer.locked}
                    disabled={layer.held}
                    onClick={() => send({ type: "slop:edit-lock", locked: !layer.locked, path: layer.path })}
                  >
                    {layer.locked || layer.held ? <Lock /> : <LockOpen />}
                  </ToolButton>
                  <ToolButton
                    keepFocus
                    label={`Move ${layer.name} up`}
                    disabled={at <= 0}
                    onClick={() => send({ type: "slop:edit-order", to: "forward", path: layer.path, any: true })}
                  >
                    <ArrowUp />
                  </ToolButton>
                  <ToolButton
                    keepFocus
                    label={`Move ${layer.name} down`}
                    disabled={at < 0 || at >= peers.length - 1}
                    onClick={() => send({ type: "slop:edit-order", to: "backward", path: layer.path, any: true })}
                  >
                    <ArrowDown />
                  </ToolButton>
                </li>
              );
            })}
          </ul>
        </DropdownPanel>
      )}
    </div>
  );
}

/** Whether two layers sit in the same group (or both on the slide), by their paths. */
function samePlace(a: number[], b: number[]) {
  return a.length === b.length && a.slice(0, -1).every((step, i) => step === b[i]);
}
