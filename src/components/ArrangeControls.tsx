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
  BringToFront,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CopyPlus,
  FlipHorizontal2,
  FlipVertical2,
  Group,
  Layers,
  Link2,
  Link2Off,
  Lock,
  LockOpen,
  Move,
  RectangleHorizontal,
  RotateCcw,
  RotateCcwSquare,
  RotateCwSquare,
  SendToBack,
  Ungroup,
} from "lucide-react";
import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import { useDropdown } from "../hooks/useDropdown";
import {
  type AlignTarget,
  type AlignTo,
  type ArrangeMessage,
  type DistributeAxis,
  type EditGeometry,
  type GeometryField,
  parseGeometryValue,
  TILT_STEP,
} from "../lib/arrange";
import type { StackOrder } from "../lib/editTools";
import { cn } from "../lib/utils";
import { Button, keepFocus, ToolButton } from "./Button";
import { useEditPanelAsk } from "./editPanelAsk";
import { DraftInput } from "./Field";
import { BackwardOne, ForwardOne, SameHeight, SameWidth } from "./LineTools";
import { DropdownPanel } from "./Popover";
import { MenuDivider, MenuPanel, MenuRow, NEEDS_ELEMENT, PanelButton, PanelLabel } from "./ribbon/parts";
import { useEditorState, useSlideReport } from "./stage/editorState";

export const DISTRIBUTE: { axis: DistributeAxis; label: string; title: string; icon: ReactNode }[] = [
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

/** The six ways to line the selection up; the context menu offers the same. */
export const ALIGN: { to: AlignTo; label: string; icon: ReactNode }[] = [
  { to: "left", label: "Align left", icon: <AlignStartVertical /> },
  { to: "center", label: "Align center", icon: <AlignCenterVertical /> },
  { to: "right", label: "Align right", icon: <AlignEndVertical /> },
  { to: "top", label: "Align top", icon: <AlignStartHorizontal /> },
  { to: "middle", label: "Align middle", icon: <AlignCenterHorizontal /> },
  { to: "bottom", label: "Align bottom", icon: <AlignEndHorizontal /> },
];

/** The four ways up and down the stack, with the keys that do the same. */
export const ORDER: { to: StackOrder; label: string; shortcut: string; icon: ReactNode }[] = [
  { to: "front", label: "Bring to front", shortcut: "mod+shift+]", icon: <BringToFront /> },
  { to: "forward", label: "Bring forward", shortcut: "mod+]", icon: <ForwardOne /> },
  { to: "backward", label: "Send backward", shortcut: "mod+[", icon: <BackwardOne /> },
  { to: "back", label: "Send to back", shortcut: "mod+shift+[", icon: <SendToBack /> },
];

/** How long a number typed during the preview's reload waits for the selection to come back. */
const RELOAD_MS = 2000;

const FIELDS: Record<GeometryField, { label: string; title: string }> = {
  x: { label: "X", title: "Distance from the slide's left edge" },
  y: { label: "Y", title: "Distance from the slide's top edge" },
  w: { label: "W", title: "Width" },
  h: { label: "H", title: "Height" },
  rotation: { label: "°", title: "Rotation in degrees" },
};

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

const FLIP_REASON = "Text and plain boxes have nothing to flip";

/** Whether the selection has anything to flip: each of several elements, and of what a group holds, flips if it can. */
function useFlips() {
  return useSlideReport(
    (report) =>
      (report.geometry?.count ?? 0) > 1 || !!report.selection?.flippable || (!!report.selection?.group && true),
  );
}

/**
 * Lining the selection up, as one button and its menu: the six alignments (one element with the
 * slide; several with each other, or each with the slide while "Align with the slide" is on),
 * then distributing three or more, and giving two or more the first one's width or height. Of
 * where the selection is, it reads only how many elements that are, which a drag does not change.
 */
export const AlignMenu = memo(function AlignMenu(props: { onArrange?: (message: ArrangeMessage) => void }) {
  const [toSlide, setToSlide] = useState(false);
  const { open, setOpen, ref, toggle } = useDropdown();
  const count = useSlideReport((report) => report.geometry?.count ?? 0);
  const many = count > 1;
  const target: AlignTarget = many && !toSlide ? "selection" : "slide";
  const run = (message: ArrangeMessage) => {
    props.onArrange?.(message);
    setOpen(false);
  };
  return (
    <div ref={ref} className="relative">
      <PanelButton
        open={open}
        label="Align"
        title={many ? "Align: line the selected elements up and space them out" : "Align with the slide"}
        disabled={count === 0}
        disabledReason={NEEDS_ELEMENT}
        onClick={toggle}
      >
        <AlignStartVertical />
      </PanelButton>
      {open && (
        <MenuPanel label="Align">
          {ALIGN.map((a) => (
            <MenuRow
              key={a.to}
              icon={a.icon}
              label={a.label}
              title={`${a.label} ${target === "slide" ? "with the slide" : "with each other"}`}
              onClick={() => run({ type: "slop:edit-align", to: a.to, target })}
            />
          ))}
          <MenuDivider />
          <MenuRow
            icon={<RectangleHorizontal />}
            label="Align with the slide"
            title={
              toSlide
                ? "Several elements each line up with the slide's edges or center; turn off to line them up with each other"
                : "Line several elements up with the slide's edges or center, not with each other"
            }
            checked={!many || toSlide}
            disabled={!many}
            disabledReason="One element always aligns with the slide"
            onClick={() => setToSlide(!toSlide)}
          />
          <MenuDivider />
          {DISTRIBUTE.map((d) => (
            <MenuRow
              key={d.axis}
              icon={d.icon}
              label={d.label}
              title={d.title}
              disabled={count < 3}
              disabledReason="Select three or more elements"
              onClick={() => run({ type: "slop:edit-distribute", axis: d.axis })}
            />
          ))}
          <MenuRow
            icon={<SameWidth />}
            label="Match width"
            title="Give the others the first selected element's width"
            disabled={!many}
            disabledReason="Select two or more elements"
            onClick={() => run({ type: "slop:edit-match", axis: "w" })}
          />
          <MenuRow
            icon={<SameHeight />}
            label="Match height"
            title="Give the others the first selected element's height"
            disabled={!many}
            disabledReason="Select two or more elements"
            onClick={() => run({ type: "slop:edit-match", axis: "h" })}
          />
        </MenuPanel>
      )}
    </div>
  );
});

/** Up and down the stack, as a menu that names each way and its keys. */
export const OrderMenu = memo(function OrderMenu(props: { onOrder: (to: StackOrder) => void }) {
  const { open, setOpen, ref, toggle } = useDropdown();
  const nothing = useSlideReport((report) => report.selection === null);
  return (
    <div ref={ref} className="relative">
      <PanelButton
        open={open}
        label="Order"
        title="Order: bring forward or send backward"
        disabled={nothing}
        disabledReason={NEEDS_ELEMENT}
        onClick={toggle}
      >
        <BringToFront />
      </PanelButton>
      {open && (
        <MenuPanel label="Order">
          {ORDER.map((o) => (
            <MenuRow
              key={o.to}
              icon={o.icon}
              label={o.label}
              shortcut={o.shortcut}
              onClick={() => {
                props.onOrder(o.to);
                setOpen(false);
              }}
            />
          ))}
        </MenuPanel>
      )}
    </div>
  );
});

/** Quarter turns and flips, as a menu: every selected element turns around its own center, and flips if it can. */
export const RotateMenu = memo(function RotateMenu(props: { onArrange?: (message: ArrangeMessage) => void }) {
  const { open, setOpen, ref, toggle } = useDropdown();
  const nothing = useSlideReport((report) => report.geometry === null);
  const flips = useFlips();
  const run = (message: ArrangeMessage) => {
    props.onArrange?.(message);
    setOpen(false);
  };
  return (
    <div ref={ref} className="relative">
      <PanelButton
        open={open}
        label="Rotate and flip"
        disabled={nothing}
        disabledReason={NEEDS_ELEMENT}
        onClick={toggle}
      >
        <RotateCwSquare />
      </PanelButton>
      {open && (
        <MenuPanel label="Rotate and flip">
          <MenuRow
            icon={<RotateCwSquare />}
            label="Rotate right 90°"
            shortcut="mod+alt+r"
            onClick={() => run({ type: "slop:edit-rotate", step: 1 })}
          />
          <MenuRow
            icon={<RotateCcwSquare />}
            label="Rotate left 90°"
            onClick={() => run({ type: "slop:edit-rotate", step: -1 })}
          />
          <MenuDivider />
          <MenuRow
            icon={<FlipHorizontal2 />}
            label="Flip horizontally"
            shortcut="mod+alt+shift+h"
            disabled={!flips}
            disabledReason={FLIP_REASON}
            onClick={() => run({ type: "slop:edit-flip", axis: "x" })}
          />
          <MenuRow
            icon={<FlipVertical2 />}
            label="Flip vertically"
            shortcut="mod+alt+shift+v"
            disabled={!flips}
            disabledReason={FLIP_REASON}
            onClick={() => run({ type: "slop:edit-flip", axis: "y" })}
          />
        </MenuPanel>
      )}
    </div>
  );
});

/**
 * The selection's exact place and size, in one popover: its position, size and rotation as
 * numbers, quarter turns and flips, matching the size of several elements, and the 3D rotation.
 * Several elements have bounds to move, but no size or rotation to type. The panel stays open for
 * one change after another, also through the preview's reload after each save, which clears the
 * selection until the editor restores it. "Position and size…" in the context menu opens it too.
 */
export const PositionControls = memo(function PositionControls(props: PositionProps) {
  const { open, setOpen, ref, toggle } = useDropdown();
  // The button only says whether there is a selection; where it is, the open panel follows.
  const off = useSlideReport((report) => report.geometry === null);
  useEditPanelAsk("position", () => {
    if (!off) setOpen(true);
  });
  return (
    <div ref={ref} className="relative">
      <PanelButton
        open={open}
        label="Position and size"
        title="Position and size: exact numbers, rotation and 3D rotation"
        disabled={off && !open}
        disabledReason={NEEDS_ELEMENT}
        onClick={toggle}
      >
        <Move />
      </PanelButton>
      {open && <PositionPanel {...props} />}
    </div>
  );
});

interface PositionProps {
  onArrange?: (message: ArrangeMessage) => void;
  onDone?: () => void;
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
  const keepRatio = useEditorState((s) => s.keepRatio);
  const [tilting, setTilting] = useState(false);
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
  const field = (name: GeometryField) => (
    <GeometryInput
      field={name}
      {...FIELDS[name]}
      value={name === "rotation" ? geometry.rotation : geometry[name]}
      disabled={many && name !== "x" && name !== "y"}
      onChange={(value) => arrangeField({ type: "slop:edit-geometry", [name]: value })}
      onDone={onDone}
    />
  );
  const tilt = (t: (typeof TILTS)[number]) => (
    <ToolButton
      keepFocus
      key={t.side}
      label={`Rotate ${t.side} ${TILT_STEP}° in 3D`}
      disabled={off}
      disabledReason={NEEDS_ELEMENT}
      onClick={() => props.onArrange?.({ type: "slop:edit-tilt", x: t.x * TILT_STEP, y: t.y * TILT_STEP })}
    >
      {t.icon}
    </ToolButton>
  );

  return (
    <DropdownPanel
      role="dialog"
      aria-label="Position and size"
      className="grid w-max grid-cols-[auto_auto] items-center gap-x-3 gap-y-2 text-xs text-foreground"
    >
      <PanelLabel>Position</PanelLabel>
      <div className="flex items-center gap-1.5">
        {field("x")}
        <span className="w-6" />
        {field("y")}
      </div>
      <PanelLabel off={many}>Size</PanelLabel>
      <div className="flex items-center gap-1.5">
        {field("w")}
        <ToolButton
          keepFocus
          label="Lock aspect ratio"
          title={
            keepRatio
              ? "Resizes keep the aspect ratio (Shift frees it); a typed width or height brings the other along"
              : "Keep the aspect ratio when resizing, without holding Shift"
          }
          active={keepRatio && !many}
          disabled={many}
          disabledReason="Several elements have no one size; group them to size them as one"
          onClick={() => props.onKeepRatio?.(!keepRatio)}
        >
          {keepRatio ? <Link2 /> : <Link2Off />}
        </ToolButton>
        {field("h")}
      </div>
      <PanelLabel>Rotate</PanelLabel>
      <div className="flex items-center gap-0.5">
        {field("rotation")}
        <span className="w-1" />
        <ToolButton
          keepFocus
          label="Rotate left 90°"
          disabled={off}
          disabledReason={NEEDS_ELEMENT}
          onClick={() => props.onArrange?.({ type: "slop:edit-rotate", step: -1 })}
        >
          <RotateCcwSquare />
        </ToolButton>
        <ToolButton
          keepFocus
          label="Rotate right 90°"
          shortcut="mod+alt+r"
          disabled={off}
          disabledReason={NEEDS_ELEMENT}
          onClick={() => props.onArrange?.({ type: "slop:edit-rotate", step: 1 })}
        >
          <RotateCwSquare />
        </ToolButton>
        <ToolButton
          keepFocus
          label="Flip horizontally"
          shortcut="mod+alt+shift+h"
          active={flips && !many && !!selection?.flipX}
          disabled={!flips}
          disabledReason={off ? NEEDS_ELEMENT : FLIP_REASON}
          onClick={() => props.onArrange?.({ type: "slop:edit-flip", axis: "x" })}
        >
          <FlipHorizontal2 />
        </ToolButton>
        <ToolButton
          keepFocus
          label="Flip vertically"
          shortcut="mod+alt+shift+v"
          active={flips && !many && !!selection?.flipY}
          disabled={!flips}
          disabledReason={off ? NEEDS_ELEMENT : FLIP_REASON}
          onClick={() => props.onArrange?.({ type: "slop:edit-flip", axis: "y" })}
        >
          <FlipVertical2 />
        </ToolButton>
      </div>
      {many && (
        <>
          <PanelLabel>Match</PanelLabel>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              title="Give the others the first selected element's width"
              disabled={off}
              onMouseDown={keepFocus}
              onClick={() => props.onArrange?.({ type: "slop:edit-match", axis: "w" })}
            >
              Width
            </Button>
            <Button
              size="sm"
              title="Give the others the first selected element's height"
              disabled={off}
              onMouseDown={keepFocus}
              onClick={() => props.onArrange?.({ type: "slop:edit-match", axis: "h" })}
            >
              Height
            </Button>
          </div>
          <p className="col-span-2 max-w-64 text-muted-foreground">
            {geometry.count} elements selected: they move together. Group them to size or turn them as one.
          </p>
        </>
      )}
      <div className="col-span-2 border-t pt-1.5">
        <button
          type="button"
          aria-expanded={tilting}
          onMouseDown={keepFocus}
          onClick={() => setTilting(!tilting)}
          className="flex items-center gap-1 rounded-md py-0.5 pr-1.5 text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
        >
          {tilting ? <ChevronDown /> : <ChevronRight />}
          3D rotate
        </button>
        {tilting && (
          <fieldset aria-label="3D rotate" className="mt-1 ml-4 grid w-max grid-cols-3 gap-0.5">
            {TILTS.slice(0, 4).map(tilt)}
            <ToolButton
              keepFocus
              label="Reset the 3D rotation"
              disabled={off}
              disabledReason={NEEDS_ELEMENT}
              onClick={() => props.onArrange?.({ type: "slop:edit-tilt", reset: true })}
            >
              <RotateCcw />
            </ToolButton>
            {TILTS.slice(4).map(tilt)}
          </fieldset>
        )}
      </div>
    </DropdownPanel>
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
 * Groups the selection or, when it is a group, takes it apart; and locks or unlocks the
 * selection so it cannot be picked, moved or deleted by accident. With them, duplicating it.
 */
export const GroupControls = memo(function GroupControls(props: { onArrange?: (message: ArrangeMessage) => void }) {
  const count = useSlideReport((report) => report.geometry?.count ?? 0);
  const selected = useSlideReport((report) => report.selection !== null);
  const group = useSlideReport((report) => !!report.selection?.group);
  const locked = useSlideReport((report) => !!report.selection?.locked);
  // One group selected is taken apart; several elements, groups among them, are grouped.
  const ungroups = group && count < 2;
  return (
    <>
      {ungroups ? (
        <ToolButton
          keepFocus
          label="Ungroup"
          shortcut="mod+shift+g"
          title="Ungroup: take the group apart, everything staying where it is"
          onClick={() => props.onArrange?.({ type: "slop:edit-ungroup" })}
        >
          <Ungroup />
        </ToolButton>
      ) : (
        <ToolButton
          keepFocus
          label="Group"
          shortcut="mod+g"
          title="Group the selected elements, to move, size and style them as one"
          disabled={count < 2}
          disabledReason="Select two or more elements to group them, or a group to take it apart"
          onClick={() => props.onArrange?.({ type: "slop:edit-group" })}
        >
          <Group />
        </ToolButton>
      )}
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
        disabledReason={NEEDS_ELEMENT}
        onClick={() => props.onArrange?.({ type: "slop:edit-lock", locked: !locked })}
      >
        {locked ? <Lock /> : <LockOpen />}
      </ToolButton>
      <ToolButton
        keepFocus
        label="Duplicate"
        shortcut="mod+d"
        disabled={!selected}
        disabledReason={NEEDS_ELEMENT}
        onClick={() => props.onArrange?.({ type: "slop:edit-duplicate" })}
      >
        <CopyPlus />
      </ToolButton>
    </>
  );
});

/**
 * What is on the slide, the top-most first, and in a group what it holds: pick one to select it
 * (also one that is locked or covered by others), lock or unlock it, or move it up or down past
 * the next one, wherever the editor can (it says so for each layer). The panel stays open through
 * the preview's reload after each change.
 */
export const LayersPanel = memo(function LayersPanel(props: { onArrange?: (message: ArrangeMessage) => void }) {
  const { open, ref, toggle } = useDropdown();
  const layers = useSlideReport((report) => report.layers);
  const send = (message: ArrangeMessage) => props.onArrange?.(message);
  return (
    <div ref={ref} className="relative">
      <PanelButton
        open={open}
        label="Layers"
        title="Layers: what is on the slide, to pick, lock and restack"
        disabled={!layers.length && !open}
        disabledReason="Nothing on this slide"
        onClick={toggle}
      >
        <Layers />
      </PanelButton>
      {open && (
        <DropdownPanel
          role="dialog"
          aria-label="Layers"
          className="flex max-h-80 w-64 flex-col overflow-y-auto text-xs text-foreground"
        >
          {!layers.length && <p className="px-1 py-0.5 text-muted-foreground">Nothing on this slide</p>}
          <ul aria-label="Layers, the top-most first" className="flex flex-col">
            {layers.map((layer) => (
              <li
                key={layer.path.join(".")}
                className={cn("group flex items-center gap-0.5 rounded", layer.selected && "bg-primary/10")}
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
                  disabledReason="It is in something locked: unlock that"
                  onClick={() => send({ type: "slop:edit-lock", locked: !layer.locked, path: layer.path })}
                >
                  {layer.locked || layer.held ? <Lock /> : <LockOpen />}
                </ToolButton>
                <ToolButton
                  keepFocus
                  label={`Move ${layer.name} up`}
                  disabled={!layer.canUp}
                  disabledReason="It is the top-most already"
                  onClick={() => send({ type: "slop:edit-order", to: "forward", path: layer.path, any: true })}
                >
                  <ChevronUp />
                </ToolButton>
                <ToolButton
                  keepFocus
                  label={`Move ${layer.name} down`}
                  disabled={!layer.canDown}
                  disabledReason="It is at the bottom already"
                  onClick={() => send({ type: "slop:edit-order", to: "backward", path: layer.path, any: true })}
                >
                  <ChevronDown />
                </ToolButton>
              </li>
            ))}
          </ul>
        </DropdownPanel>
      )}
    </div>
  );
});
