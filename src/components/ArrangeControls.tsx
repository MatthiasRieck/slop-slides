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
  Frame,
  Group,
  Layers,
  Link2,
  Link2Off,
  Lock,
  LockOpen,
  Magnet,
  RotateCcw,
  RotateCcwSquare,
  RotateCwSquare,
  Scaling,
  StretchHorizontal,
  StretchVertical,
  Ungroup,
} from "lucide-react";
import { Fragment, memo, type ReactNode, useEffect, useRef, useState } from "react";
import { useDropdown } from "../hooks/useDropdown";
import {
  type AlignTarget,
  type AlignTo,
  type ArrangeMessage,
  type DistributeAxis,
  type EditGeometry,
  type GeometryField,
  parseGeometryValue,
  quarterTurn,
  TILT_STEP,
} from "../lib/arrange";
import { formatKeys } from "../lib/keys";
import { cn } from "../lib/utils";
import { useApp } from "../store";
import { keepFocus, ToolButton } from "./Button";
import { DraftInput } from "./Field";
import { DropdownPanel } from "./Popover";
import { RibbonSelect } from "./Ribbon";
import { SectionLabel } from "./SectionLabel";
import { type SizeMode, useEditorState, useSlideReport } from "./stage/editorState";

const DISTRIBUTE: { axis: DistributeAxis; label: string; title: string; icon: ReactNode }[] = [
  {
    axis: "h",
    label: "Distribute horizontally",
    title: "Even out the gaps side to side",
    icon: <AlignHorizontalDistributeCenter />,
  },
  {
    axis: "v",
    label: "Distribute vertically",
    title: "Even out the gaps top to bottom",
    icon: <AlignVerticalDistributeCenter />,
  },
];

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

const NOTHING_SELECTED = "Select an element";

/** What an align button says it does: with the slide, or with the other selected elements. */
function alignLabel(edges: string, many: boolean, target: AlignTarget) {
  if (!many) return `Align with the slide's ${edges}`;
  return target === "slide" ? `Align ${edges} with the slide` : `Align ${edges}`;
}

/**
 * Lines the selection up and spaces it out, at the ribbon's top level: one element aligns with
 * the slide; several align with each other, or each with the slide while the toggle is on; three
 * or more can be distributed. Of where the selection is, it reads only how many elements that
 * are, which a drag does not change.
 */
export const AlignControls = memo(function AlignControls(props: { onArrange?: (message: ArrangeMessage) => void }) {
  const [toSlide, setToSlide] = useState(false);
  const count = useSlideReport((report) => report.geometry?.count ?? 0);
  const off = count === 0;
  const many = count > 1;
  const target: AlignTarget = many && !toSlide ? "selection" : "slide";
  return (
    <>
      {ALIGN.map((a) => (
        <ToolButton
          key={a.to}
          keepFocus
          label={alignLabel(a.label, many, target)}
          disabled={off}
          disabledReason={NOTHING_SELECTED}
          onClick={() => props.onArrange?.({ type: "slop:edit-align", to: a.to, target })}
        >
          {a.icon}
        </ToolButton>
      ))}
      <ToolButton
        keepFocus
        label="Align with the slide"
        title={
          toSlide
            ? "Several elements each line up with the slide's edges or center; press to line them up with each other"
            : "Line several elements up with the slide's edges or center, not with each other"
        }
        active={many && toSlide}
        disabled={!many}
        disabledReason="Select two or more elements (one element always aligns with the slide)"
        onClick={() => setToSlide(!toSlide)}
      >
        <Frame />
      </ToolButton>
      {DISTRIBUTE.map((d) => (
        <ToolButton
          key={d.axis}
          keepFocus
          label={d.label}
          title={d.title}
          disabled={count < 3}
          disabledReason="Select three or more elements"
          onClick={() => props.onArrange?.({ type: "slop:edit-distribute", axis: d.axis })}
        >
          {d.icon}
        </ToolButton>
      ))}
    </>
  );
});

/**
 * The selection's exact place and size, in one popover: how the handles change its size, its
 * position, size and rotation as numbers, matching the size of several elements, flips, quarter
 * turns and the 3D rotation. Several elements have bounds to move, but no size or rotation to
 * type. The panel stays open for one change after another, also through the preview's reload
 * after each save, which clears the selection until the editor restores it.
 */
export const PositionControls = memo(function PositionControls(props: PositionProps) {
  const { open, ref, toggle } = useDropdown();
  // The button only says whether there is a selection; where it is, the open panel follows.
  const off = useSlideReport((report) => report.geometry === null);
  return (
    <div ref={ref} className="relative">
      <ToolButton
        keepFocus
        label="Position and size"
        title="Position, size and rotation as numbers, match size, flip, quarter turns and 3D rotation"
        aria-expanded={open}
        active={open}
        disabled={off && !open}
        disabledReason={NOTHING_SELECTED}
        onClick={toggle}
      >
        <Scaling />
      </ToolButton>
      {open && <PositionPanel {...props} />}
    </div>
  );
});

interface PositionProps {
  onArrange?: (message: ArrangeMessage) => void;
  onDone?: () => void;
  onSizeMode: (mode: SizeMode) => void;
  /** Resizes keep the aspect ratio: by the handles, and a typed width or height brings the other along. */
  onKeepRatio?: (on: boolean) => void;
}

/**
 * The open Position and size popover. It reads where the selection is by itself, so the numbers
 * follow a drag frame by frame while nothing else of the toolbar renders.
 */
function PositionPanel(props: PositionProps) {
  const reported = useSlideReport((report) => report.geometry);
  // The selected element's look, for flipping it.
  const selection = useSlideReport((report) => report.selection);
  const sizeMode = useEditorState((s) => s.sizeMode);
  const keepRatio = useEditorState((s) => s.keepRatio);
  // What the panel shows while the selection is away, so it does not jump or close.
  const shown = useRef<EditGeometry | null>(null);
  if (reported) shown.current = reported;
  const geometry = reported ?? shown.current;
  const off = !reported;
  // A number typed while the preview reloads after a save (Tab from one field to the next
  // applies the first), for the selection the editor restores. The fields stay enabled through
  // the reload, so the one being typed in keeps its focus. A selection that does not come back
  // soon is gone, and what was typed for it goes too.
  const pending = useRef<{ message: ArrangeMessage; at: number }[]>([]);
  const onArrange = useRef(props.onArrange);
  onArrange.current = props.onArrange;
  useEffect(() => {
    if (!reported) return;
    const queued = pending.current.filter((p) => Date.now() - p.at <= RELOAD_MS);
    pending.current = [];
    for (const p of queued) onArrange.current?.(p.message);
  }, [reported]);
  if (!geometry) return null;
  const arrangeField = (message: ArrangeMessage) => {
    if (off) pending.current.push({ message, at: Date.now() });
    else props.onArrange?.(message);
  };
  const onDone = () => props.onDone?.();
  const many = geometry.count > 1;
  // Each of several elements flips if it can; one says itself whether it does.
  const flips = !off && (many || !!selection?.flippable || !!selection?.group);
  const flipReason = off ? NOTHING_SELECTED : "Text and plain boxes have nothing to flip";
  const rotation = geometry.rotation;
  const tilt = (t: (typeof TILTS)[number]) => (
    <ToolButton
      keepFocus
      key={t.side}
      label={`Rotate ${t.side} ${TILT_STEP}° in 3D`}
      disabled={off}
      disabledReason={NOTHING_SELECTED}
      onClick={() => props.onArrange?.({ type: "slop:edit-tilt", x: t.x * TILT_STEP, y: t.y * TILT_STEP })}
    >
      {t.icon}
    </ToolButton>
  );

  return (
    <DropdownPanel role="dialog" aria-label="Position and size" className="flex w-max flex-col gap-2 text-xs">
      <div className="flex items-center gap-1.5">
        {FIELDS.map((f) => (
          <Fragment key={f.field}>
            <GeometryInput
              {...f}
              value={f.field === "rotation" ? geometry.rotation : geometry[f.field]}
              disabled={many && f.field !== "x" && f.field !== "y"}
              onChange={(value) => arrangeField({ type: "slop:edit-geometry", [f.field]: value })}
              onDone={onDone}
            />
            {f.field === "w" && (
              <ToolButton
                keepFocus
                label="Lock aspect ratio"
                title={
                  keepRatio
                    ? "Resizes keep the aspect ratio (Shift frees it); a typed width or height brings the other along"
                    : "Keep the aspect ratio when resizing, without holding Shift"
                }
                active={keepRatio}
                onClick={() => props.onKeepRatio?.(!keepRatio)}
              >
                {keepRatio ? <Link2 /> : <Link2Off />}
              </ToolButton>
            )}
          </Fragment>
        ))}
      </div>
      {many && (
        <p className="text-muted-foreground">
          {geometry.count} elements selected: they move together; group them to size or turn them as one
        </p>
      )}
      <div className="flex items-center gap-2">
        <label htmlFor="edit-size-mode" className="text-muted-foreground">
          Handles
        </label>
        <RibbonSelect
          id="edit-size-mode"
          label="Size mode"
          title="Resize changes the box; Stretch scales its contents too"
          value={sizeMode}
          onPick={(mode) => props.onSizeMode(mode as SizeMode)}
          onDone={onDone}
          className="border"
        >
          <option value="resize">Resize the box</option>
          <option value="stretch">Stretch the contents</option>
        </RibbonSelect>
      </div>
      <div className="flex items-center gap-0.5">
        <ToolButton
          keepFocus
          label="Match width"
          title="Give the others the first selected element's width"
          disabled={off || !many}
          disabledReason="Select two or more elements"
          onClick={() => props.onArrange?.({ type: "slop:edit-match", axis: "w" })}
        >
          <StretchHorizontal />
        </ToolButton>
        <ToolButton
          keepFocus
          label="Match height"
          title="Give the others the first selected element's height"
          disabled={off || !many}
          disabledReason="Select two or more elements"
          onClick={() => props.onArrange?.({ type: "slop:edit-match", axis: "h" })}
        >
          <StretchVertical />
        </ToolButton>
        <div className="mx-1 h-4 w-px bg-border" />
        <ToolButton
          keepFocus
          label="Flip horizontally"
          shortcut="mod+shift+h"
          active={flips && !many && !!selection?.flipX}
          disabled={!flips}
          disabledReason={flipReason}
          onClick={() => props.onArrange?.({ type: "slop:edit-flip", axis: "x" })}
        >
          <FlipHorizontal2 />
        </ToolButton>
        <ToolButton
          keepFocus
          label="Flip vertically"
          shortcut="mod+shift+v"
          active={flips && !many && !!selection?.flipY}
          disabled={!flips}
          disabledReason={flipReason}
          onClick={() => props.onArrange?.({ type: "slop:edit-flip", axis: "y" })}
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
            disabledReason={off ? NOTHING_SELECTED : "Select one element"}
            onClick={() =>
              rotation !== null &&
              props.onArrange?.({ type: "slop:edit-geometry", rotation: quarterTurn(rotation, step) })
            }
          >
            {step < 0 ? <RotateCcwSquare /> : <RotateCwSquare />}
          </ToolButton>
        ))}
      </div>
      <div className="flex items-start gap-2">
        <SectionLabel>3D rotate</SectionLabel>
        <fieldset aria-label="3D rotate" className="grid w-max grid-cols-3 gap-0.5">
          {TILTS.slice(0, 4).map(tilt)}
          <ToolButton
            keepFocus
            label="Reset the 3D rotation"
            disabled={off}
            disabledReason={NOTHING_SELECTED}
            onClick={() => props.onArrange?.({ type: "slop:edit-tilt", reset: true })}
          >
            <RotateCcw />
          </ToolButton>
          {TILTS.slice(4).map(tilt)}
        </fieldset>
      </div>
    </DropdownPanel>
  );
}

/**
 * Whether dragging and resizing snap to the guides, remembered between slides and launches. The
 * slide editor is told by the stage (see useSlideEditing).
 */
export function SnapToggle() {
  const snap = useApp((s) => s.editSnap);
  const held = formatKeys("mod");
  return (
    <ToolButton
      keepFocus
      label="Snap to guides"
      title={
        snap
          ? `Snap to guides: moves and resizes snap to the slide and other elements (hold ${held} while dragging to move freely)`
          : `Snap to guides is off (hold ${held} while dragging to snap)`
      }
      active={snap}
      onClick={() => useApp.getState().setEditSnap(!snap)}
    >
      <Magnet />
    </ToolButton>
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
        className="h-6 w-12 rounded-md border bg-transparent px-1 text-center text-foreground tabular-nums disabled:opacity-40"
      />
    </label>
  );
}

/**
 * Groups the selection, takes a group apart, and locks or unlocks the selection so it cannot be
 * picked, moved or deleted by accident.
 */
export const GroupControls = memo(function GroupControls(props: { onArrange?: (message: ArrangeMessage) => void }) {
  const count = useSlideReport((report) => report.geometry?.count ?? 0);
  const selected = useSlideReport((report) => report.selection !== null);
  const group = useSlideReport((report) => !!report.selection?.group);
  const locked = useSlideReport((report) => !!report.selection?.locked);
  return (
    <>
      <ToolButton
        keepFocus
        label="Group"
        shortcut="mod+g"
        title="Group the selected elements, to move, size and style them as one"
        disabled={count < 2}
        disabledReason="Select two or more elements"
        onClick={() => props.onArrange?.({ type: "slop:edit-group" })}
      >
        <Group />
      </ToolButton>
      <ToolButton
        keepFocus
        label="Ungroup"
        shortcut="mod+shift+g"
        disabled={!group}
        disabledReason="Select a group"
        onClick={() => props.onArrange?.({ type: "slop:edit-ungroup" })}
      >
        <Ungroup />
      </ToolButton>
      <ToolButton
        keepFocus
        label={locked ? "Unlock" : "Lock"}
        shortcut="mod+alt+l"
        title={
          locked
            ? "Unlock, so it can be picked and moved again"
            : "Lock, so it cannot be picked, moved or deleted by accident (right-click it or use Layers to unlock it)"
        }
        active={locked}
        disabled={!selected}
        disabledReason={NOTHING_SELECTED}
        onClick={() => props.onArrange?.({ type: "slop:edit-lock", locked: !locked })}
      >
        {locked ? <Lock /> : <LockOpen />}
      </ToolButton>
    </>
  );
});

/**
 * What is on the slide, the top-most first, and in a group what it holds: pick one to select it
 * (also one that is locked or covered by others), lock or unlock it, or move it up or down past
 * the next one. The panel stays open through the preview's reload after each change.
 */
export const LayersPanel = memo(function LayersPanel(props: { onArrange?: (message: ArrangeMessage) => void }) {
  const { open, ref, toggle } = useDropdown();
  const layers = useSlideReport((report) => report.layers);
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
        disabledReason="Nothing on this slide"
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
});

/** Whether two layers sit in the same group (or both on the slide), by their paths. */
function samePlace(a: number[], b: number[]) {
  return a.length === b.length && a.slice(0, -1).every((step, i) => step === b[i]);
}
