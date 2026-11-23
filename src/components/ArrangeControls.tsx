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
import { Fragment, memo, type ReactNode, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { FieldSet } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { NativeSelectOption } from "@/components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { keepFocus } from "@/lib/focus";
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
import { DraftInput } from "./DraftInput";
import { RibbonSelect } from "./Ribbon";
import { type SizeMode, useEditorState, useSlideReport } from "./stage/editorState";
import { SLIDE_TOOL, unlessOff } from "./toolProps";

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

/** A control's name beside it in a ribbon popover. */
const LABEL = "text-xs font-normal text-muted-foreground";

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
      {ALIGN.map((a) => {
        const label = alignLabel(a.label, many, target);
        return (
          <Button
            key={a.to}
            {...SLIDE_TOOL}
            aria-label={label}
            {...unlessOff(off, NOTHING_SELECTED, label)}
            onClick={() => props.onArrange?.({ type: "slop:edit-align", to: a.to, target })}
          >
            {a.icon}
          </Button>
        );
      })}
      <Button
        {...SLIDE_TOOL}
        aria-label="Align with the slide"
        aria-pressed={many && toSlide}
        {...unlessOff(
          !many,
          "Select two or more elements (one element always aligns with the slide)",
          toSlide
            ? "Several elements each line up with the slide's edges or center; press to line them up with each other"
            : "Line several elements up with the slide's edges or center, not with each other",
        )}
        onClick={() => setToSlide(!toSlide)}
      >
        <Frame />
      </Button>
      {DISTRIBUTE.map((d) => (
        <Button
          key={d.axis}
          {...SLIDE_TOOL}
          aria-label={d.label}
          {...unlessOff(count < 3, "Select three or more elements", d.title)}
          onClick={() => props.onArrange?.({ type: "slop:edit-distribute", axis: d.axis })}
        >
          {d.icon}
        </Button>
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
  const [open, setOpen] = useState(false);
  // The button only says whether there is a selection; where it is, the open panel follows.
  const off = useSlideReport((report) => report.geometry === null);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            {...SLIDE_TOOL}
            aria-label="Position and size"
            {...unlessOff(
              off && !open,
              NOTHING_SELECTED,
              "Position, size and rotation as numbers, match size, flip, quarter turns and 3D rotation",
            )}
          />
        }
      >
        <Scaling />
      </PopoverTrigger>
      <PopoverContent
        aria-label="Position and size"
        initialFocus={false}
        finalFocus={false}
        className="w-max gap-2 p-2 text-xs"
      >
        <PositionPanel {...props} />
      </PopoverContent>
    </Popover>
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
 * What the open Position and size popover holds. It reads where the selection is by itself, so
 * the numbers follow a drag frame by frame while nothing else of the toolbar renders.
 */
function PositionPanel(props: PositionProps) {
  const id = useId();
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
  const tilt = (t: (typeof TILTS)[number]) => {
    const label = `Rotate ${t.side} ${TILT_STEP}° in 3D`;
    return (
      <Button
        key={t.side}
        {...SLIDE_TOOL}
        aria-label={label}
        {...unlessOff(off, NOTHING_SELECTED, label)}
        onClick={() => props.onArrange?.({ type: "slop:edit-tilt", x: t.x * TILT_STEP, y: t.y * TILT_STEP })}
      >
        {t.icon}
      </Button>
    );
  };

  return (
    <>
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
              <Button
                {...SLIDE_TOOL}
                aria-label="Lock aspect ratio"
                tooltip={
                  keepRatio
                    ? "Resizes keep the aspect ratio (Shift frees it); a typed width or height brings the other along"
                    : "Keep the aspect ratio when resizing, without holding Shift"
                }
                aria-pressed={keepRatio}
                onClick={() => props.onKeepRatio?.(!keepRatio)}
              >
                {keepRatio ? <Link2 /> : <Link2Off />}
              </Button>
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
        <Label htmlFor={`${id}-size-mode`} className={LABEL}>
          Handles
        </Label>
        <RibbonSelect
          id={`${id}-size-mode`}
          label="Size mode"
          title="Resize changes the box; Stretch scales its contents too"
          value={sizeMode}
          onPick={(mode) => props.onSizeMode(mode as SizeMode)}
          onDone={onDone}
          className="border"
        >
          <NativeSelectOption value="resize">Resize the box</NativeSelectOption>
          <NativeSelectOption value="stretch">Stretch the contents</NativeSelectOption>
        </RibbonSelect>
      </div>
      <div className="flex items-center gap-0.5">
        <Button
          {...SLIDE_TOOL}
          aria-label="Match width"
          {...unlessOff(
            off || !many,
            "Select two or more elements",
            "Give the others the first selected element's width",
          )}
          onClick={() => props.onArrange?.({ type: "slop:edit-match", axis: "w" })}
        >
          <StretchHorizontal />
        </Button>
        <Button
          {...SLIDE_TOOL}
          aria-label="Match height"
          {...unlessOff(
            off || !many,
            "Select two or more elements",
            "Give the others the first selected element's height",
          )}
          onClick={() => props.onArrange?.({ type: "slop:edit-match", axis: "h" })}
        >
          <StretchVertical />
        </Button>
        <Separator orientation="vertical" className="mx-1 h-4 data-vertical:self-center" />
        <Button
          {...SLIDE_TOOL}
          aria-label="Flip horizontally"
          aria-pressed={flips && !many && !!selection?.flipX}
          {...unlessOff(!flips, flipReason, "Flip horizontally", "mod+shift+h")}
          onClick={() => props.onArrange?.({ type: "slop:edit-flip", axis: "x" })}
        >
          <FlipHorizontal2 />
        </Button>
        <Button
          {...SLIDE_TOOL}
          aria-label="Flip vertically"
          aria-pressed={flips && !many && !!selection?.flipY}
          {...unlessOff(!flips, flipReason, "Flip vertically", "mod+shift+v")}
          onClick={() => props.onArrange?.({ type: "slop:edit-flip", axis: "y" })}
        >
          <FlipVertical2 />
        </Button>
        <Separator orientation="vertical" className="mx-1 h-4 data-vertical:self-center" />
        {([-1, 1] as const).map((step) => {
          const label = step < 0 ? "Rotate 90° counterclockwise" : "Rotate 90° clockwise";
          return (
            <Button
              key={step}
              {...SLIDE_TOOL}
              aria-label={label}
              {...unlessOff(off || rotation === null, off ? NOTHING_SELECTED : "Select one element", label)}
              onClick={() =>
                rotation !== null &&
                props.onArrange?.({ type: "slop:edit-geometry", rotation: quarterTurn(rotation, step) })
              }
            >
              {step < 0 ? <RotateCcwSquare /> : <RotateCwSquare />}
            </Button>
          );
        })}
      </div>
      <div className="flex items-start gap-2">
        <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">3D rotate</span>
        <FieldSet aria-label="3D rotate" className="grid w-max grid-cols-3 gap-0.5">
          {TILTS.slice(0, 4).map(tilt)}
          <Button
            {...SLIDE_TOOL}
            aria-label="Reset the 3D rotation"
            {...unlessOff(off, NOTHING_SELECTED, "Reset the 3D rotation")}
            onClick={() => props.onArrange?.({ type: "slop:edit-tilt", reset: true })}
          >
            <RotateCcw />
          </Button>
          {TILTS.slice(4).map(tilt)}
        </FieldSet>
      </div>
    </>
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
    <Button
      {...SLIDE_TOOL}
      aria-label="Snap to guides"
      tooltip={
        snap
          ? `Snap to guides: moves and resizes snap to the slide and other elements (hold ${held} while dragging to move freely)`
          : `Snap to guides is off (hold ${held} while dragging to snap)`
      }
      aria-pressed={snap}
      onClick={() => useApp.getState().setEditSnap(!snap)}
    >
      <Magnet />
    </Button>
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
    <Label className={cn(LABEL, "gap-1")}>
      {props.label}
      <DraftInput
        aria-label={props.title}
        tooltip={props.title}
        disabled={props.disabled}
        value={props.value}
        parse={(text) => parseGeometryValue(props.field, text)}
        sanitize={(text) => text.replace(/[^\d.-]/g, "")}
        onChange={props.onChange}
        onDone={props.onDone}
        className="w-12 text-center text-foreground"
      />
    </Label>
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
      <Button
        {...SLIDE_TOOL}
        aria-label="Group"
        {...unlessOff(
          count < 2,
          "Select two or more elements",
          "Group the selected elements, to move, size and style them as one",
          "mod+g",
        )}
        onClick={() => props.onArrange?.({ type: "slop:edit-group" })}
      >
        <Group />
      </Button>
      <Button
        {...SLIDE_TOOL}
        aria-label="Ungroup"
        {...unlessOff(!group, "Select a group", "Ungroup", "mod+shift+g")}
        onClick={() => props.onArrange?.({ type: "slop:edit-ungroup" })}
      >
        <Ungroup />
      </Button>
      <Button
        {...SLIDE_TOOL}
        aria-label={locked ? "Unlock" : "Lock"}
        aria-pressed={locked}
        {...unlessOff(
          !selected,
          NOTHING_SELECTED,
          locked
            ? "Unlock, so it can be picked and moved again"
            : "Lock, so it cannot be picked, moved or deleted by accident (right-click it or use Layers to unlock it)",
          "mod+alt+l",
        )}
        onClick={() => props.onArrange?.({ type: "slop:edit-lock", locked: !locked })}
      >
        {locked ? <Lock /> : <LockOpen />}
      </Button>
    </>
  );
});

/**
 * What is on the slide, the top-most first, and in a group what it holds: pick one to select it
 * (also one that is locked or covered by others), lock or unlock it, or move it up or down past
 * the next one. The panel stays open through the preview's reload after each change.
 */
export const LayersPanel = memo(function LayersPanel(props: { onArrange?: (message: ArrangeMessage) => void }) {
  const [open, setOpen] = useState(false);
  const none = useSlideReport((report) => report.layers.length === 0);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            {...SLIDE_TOOL}
            aria-label="Layers"
            {...unlessOff(none && !open, "Nothing on this slide", "What is on the slide, to pick, lock and restack")}
          />
        }
      >
        <Layers />
      </PopoverTrigger>
      <PopoverContent
        aria-label="Layers"
        initialFocus={false}
        finalFocus={false}
        className="max-h-80 w-64 gap-0 overflow-y-auto p-2 text-xs"
      >
        <LayersList onArrange={props.onArrange} />
      </PopoverContent>
    </Popover>
  );
});

/** What the open Layers popover holds; it follows the slide's layers by itself. */
function LayersList(props: { onArrange?: (message: ArrangeMessage) => void }) {
  const layers = useSlideReport((report) => report.layers);
  const send = (message: ArrangeMessage) => props.onArrange?.(message);
  return (
    <>
      {!layers.length && <p className="px-1 py-0.5 text-muted-foreground">Nothing on this slide</p>}
      <ul aria-label="Layers, the top-most first" className="flex flex-col">
        {layers.map((layer) => {
          // Up and down go past the next layer of its own kind: in its group, or on the slide.
          const peers = layers.filter((other) => other.depth === layer.depth && samePlace(other.path, layer.path));
          const at = peers.indexOf(layer);
          return (
            <li
              key={layer.path.join(".")}
              className={cn("group flex items-center gap-0.5 rounded-md", layer.selected && "bg-accent")}
              style={{ paddingLeft: layer.depth * 12 }}
            >
              <Button
                variant="ghost"
                size="xs"
                aria-current={layer.selected || undefined}
                onMouseDownCapture={keepFocus}
                onClick={() => send({ type: "slop:edit-select", path: layer.path })}
                className={cn(
                  "min-w-0 flex-1 shrink justify-start px-1 font-normal",
                  (layer.locked || layer.held) && "text-muted-foreground",
                )}
              >
                {/* The whole name, for one too long for the row. */}
                <span title={layer.name} className="truncate">
                  {layer.name}
                </span>
              </Button>
              <Button
                {...SLIDE_TOOL}
                tooltip={`${layer.locked ? "Unlock" : "Lock"} ${layer.name}`}
                aria-pressed={layer.locked}
                disabled={layer.held}
                onClick={() => send({ type: "slop:edit-lock", locked: !layer.locked, path: layer.path })}
              >
                {layer.locked || layer.held ? <Lock /> : <LockOpen />}
              </Button>
              <Button
                {...SLIDE_TOOL}
                tooltip={`Move ${layer.name} up`}
                disabled={at <= 0}
                onClick={() => send({ type: "slop:edit-order", to: "forward", path: layer.path, any: true })}
              >
                <ArrowUp />
              </Button>
              <Button
                {...SLIDE_TOOL}
                tooltip={`Move ${layer.name} down`}
                disabled={at < 0 || at >= peers.length - 1}
                onClick={() => send({ type: "slop:edit-order", to: "backward", path: layer.path, any: true })}
              >
                <ArrowDown />
              </Button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Whether two layers sit in the same group (or both on the slide), by their paths. */
function samePlace(a: number[], b: number[]) {
  return a.length === b.length && a.slice(0, -1).every((step, i) => step === b[i]);
}
