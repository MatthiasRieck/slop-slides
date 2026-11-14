import { Image as ImageIcon, Paintbrush, Replace, Shapes, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDropdown } from "../hooks/useDropdown";
import type { ArrangeMessage } from "../lib/arrange";
import {
  type EditSelection,
  type EditStyle,
  type EditTool,
  FIT_LABELS,
  FIT_POSITION_NAMES,
  FIT_POSITIONS,
  type ImageFit,
  isMixed,
} from "../lib/editTools";
import { formatKeys } from "../lib/keys";
import { perFrame } from "../lib/perFrame";
import { cn } from "../lib/utils";
import { useApp } from "../store";
import { Button, keepFocus, ToolButton } from "./Button";
import { useEditPanelAsk } from "./editPanelAsk";
import { DraftInput } from "./Field";
import { DropdownPanel } from "./Popover";
import { RibbonSelect } from "./Ribbon";
import { LabelPanelButton, NEEDS_ELEMENT, PanelButton, PanelLabel, panelGrid } from "./ribbon/parts";

/** What the sliders of a panel need to show a value in the slide as they move and to apply the one they are let go at. */
interface LiveStyle {
  onStyle: (changes: EditStyle) => void;
  /** Previews a restyle in the slide while a slider is dragged, and takes a preview back. */
  onArrange?: (message: ArrangeMessage) => void;
  onDone: () => void;
}

/** A slider's callbacks for the style `style` makes of its value (see `Slider`). */
function live(props: LiveStyle, style: (value: number) => EditStyle) {
  return {
    onPreview: (value: number) => props.onArrange?.({ type: "slop:edit-style", style: style(value), preview: true }),
    onCancel: () => props.onArrange?.({ type: "slop:edit-style-cancel" }),
    onCommit: (value: number) => props.onStyle(style(value)),
    onDone: props.onDone,
  };
}

/** Whether the selection has a shape of its own to change: a shape the tools drew with a corner radius, or a figure with proportions. */
export function hasShapeTools(selection: EditSelection | null): boolean {
  return !!selection && (!!selection.adjust || (selection.kind === "shape" && selection.radius !== null));
}

/**
 * The effects any element takes: opacity and shadow, and for a box that is not one of the tools'
 * shapes (which have "Shape" for it) its corner radius. A value the selected elements do not
 * share shows as none until it is set for all of them.
 */
export function EffectsButton(props: LiveStyle & { selection: EditSelection | null }) {
  // The panel shows only with a selection, and comes back with it: saving reloads the slide's
  // preview, which reports the selection again.
  const { open, ref, toggle } = useDropdown();
  const s = props.selection;
  return (
    <div ref={ref} className="relative">
      <PanelButton
        open={open && !!s}
        label="Effects"
        title="Effects: opacity, shadow and corner radius"
        disabled={!s}
        disabledReason={NEEDS_ELEMENT}
        onClick={toggle}
      >
        <SlidersHorizontal />
      </PanelButton>
      {open && s && (
        <DropdownPanel role="dialog" aria-label="Effects" className={panelGrid}>
          <Slider
            label="Opacity"
            value={Math.round(s.opacity * 100)}
            mixed={isMixed(s, "opacity")}
            min={5}
            max={100}
            step={5}
            unit="%"
            {...live(props, (n) => ({ opacity: n / 100 }))}
          />
          <Slider
            label="Shadow"
            value={s.shadow}
            mixed={isMixed(s, "shadow")}
            max={80}
            step={2}
            unit="px"
            disabled={s.clipped}
            {...live(props, (shadow) => ({ shadow }))}
          />
          {!hasShapeTools(s) && (
            <Slider
              label="Corner radius"
              value={s.radius ?? 0}
              mixed={isMixed(s, "radius")}
              max={200}
              step={2}
              unit="px"
              disabled={s.radius === null}
              {...live(props, (radius) => ({ radius }))}
            />
          )}
        </DropdownPanel>
      )}
    </div>
  );
}

/** A shape's own look: its corner radius, and the proportions of a figure that has any (a star's points, a bubble's tail). */
export function ShapeButton(props: LiveStyle & { selection: EditSelection }) {
  const { open, ref, toggle } = useDropdown();
  const s = props.selection;
  return (
    <div ref={ref} className="relative">
      <LabelPanelButton
        open={open}
        text="Shape"
        label="Shape options"
        title="Shape: corner radius and proportions"
        onClick={toggle}
      >
        <Shapes />
      </LabelPanelButton>
      {open && (
        <DropdownPanel role="dialog" aria-label="Shape options" className={panelGrid}>
          {s.radius !== null && (
            <Slider
              label="Corner radius"
              value={s.radius}
              mixed={isMixed(s, "radius")}
              max={200}
              step={2}
              unit="px"
              {...live(props, (radius) => ({ radius }))}
            />
          )}
          {s.adjust && (
            <Slider
              label={s.adjust.label}
              value={s.adjust.value}
              min={s.adjust.min}
              max={s.adjust.max}
              step={s.adjust.step}
              // A star counts its points; the others go by a share of the shape's height.
              unit={s.adjust.label === "Points" ? "" : "%"}
              {...live(props, (adjust) => ({ adjust }))}
            />
          )}
        </DropdownPanel>
      )}
    </div>
  );
}

/**
 * The format painter: takes the selection's look and gives it to the next element clicked. The
 * look it takes is the copied look too (⌥⌘C), so it can be pasted again and on other slides
 * (⌥⌘V). A double-click keeps the painter in hand for one element after another.
 */
export function PainterButton(props: {
  tool: EditTool;
  selection: EditSelection | null;
  onTool: (tool: EditTool) => void;
  onArrange?: (message: ArrangeMessage) => void;
}) {
  const painting = props.tool === "paint";
  const kept = useApp((s) => s.editToolKept) && painting;
  const keys = `${formatKeys("mod+alt+c")} / ${formatKeys("mod+alt+v")}`;
  return (
    <ToolButton
      keepFocus
      label="Format painter"
      title={
        kept
          ? "Format painter, kept: click one element after another to give each this look; Escape puts it away"
          : `Format painter: click an element to give it this look, double-click to keep painting (${keys} copy and paste it)`
      }
      active={painting}
      disabled={!props.selection && !painting}
      disabledReason={NEEDS_ELEMENT}
      onClick={() => props.onTool(painting ? "select" : "paint")}
      onDoubleClick={() => {
        if (!props.selection) return;
        useApp.getState().setEditTool("paint", true);
        props.onArrange?.({ type: "slop:edit-tool-keep", tool: "paint", on: true });
      }}
      className="relative"
    >
      <Paintbrush />
      {kept && <KeptMark />}
    </ToolButton>
  );
}

/** The mark on a tool that stays in hand after it was used. */
export function KeptMark() {
  return <span aria-hidden="true" className="absolute right-0.5 bottom-0.5 size-1.5 rounded-full bg-primary" />;
}

/**
 * A slider with its value as a number to type beside it. While it is dragged the value shows in
 * the slide (`onPreview`), once per animation frame however fast it moves, and always the last
 * one before it is let go; the one it is let go at is applied, once (`onCommit`). A drag that
 * never lands (Escape, or the slider going away under the pointer) is taken back (`onCancel`).
 * A typed number applies on Enter or when the field loses focus, within the slider's range.
 * `mixed` (the selected elements differ) shows no number and the thumb in the middle until the
 * slider is moved or a number typed, which then goes to all of them.
 */
function Slider(props: {
  label: string;
  value: number;
  min?: number;
  max: number;
  step: number;
  unit: string;
  mixed?: boolean;
  disabled?: boolean;
  onPreview: (value: number) => void;
  onCommit: (value: number) => void;
  onCancel: () => void;
  onDone: () => void;
}) {
  const min = props.min ?? 0;
  const max = Math.max(props.max, props.value);
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  // Until it is moved, a mixed value has no place on the slider.
  const [moved, setMoved] = useState(false);
  const unset = !!props.mixed && !moved;
  useEffect(() => {
    if (!props.mixed) setMoved(false);
  }, [props.mixed]);
  const input = useRef<HTMLInputElement>(null);
  // A value was previewed that has not been applied or taken back yet.
  const previewing = useRef(false);
  const latest = useRef(props);
  latest.current = props;
  // The slider reports every value it passes; the slide need not draw more of them than the screen shows.
  const preview = useMemo(() => perFrame<number>((value) => latest.current.onPreview(value)), []);
  // React's onChange fires all along the drag; the browser's own `change` only when it ends.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const commit = () => {
      preview.flush();
      previewing.current = false;
      latest.current.onCommit(Number(el.value));
    };
    el.addEventListener("change", commit);
    return () => {
      el.removeEventListener("change", commit);
      preview.cancel();
      if (previewing.current) latest.current.onCancel();
    };
  }, [preview]);
  const cancel = () => {
    if (!previewing.current) return;
    previewing.current = false;
    preview.cancel();
    setDraft(props.value);
    props.onCancel();
  };
  return (
    <>
      <PanelLabel off={props.disabled}>{props.label}</PanelLabel>
      <span className="flex items-center gap-2">
        <input
          ref={input}
          type="range"
          aria-label={props.label}
          min={min}
          max={max}
          step={props.step}
          disabled={props.disabled}
          value={unset ? Math.round((min + max) / 2 / props.step) * props.step : draft}
          aria-valuetext={unset ? "Mixed" : undefined}
          onChange={(event) => {
            const value = Number(event.target.value);
            setMoved(true);
            setDraft(value);
            previewing.current = true;
            preview.push(value);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !previewing.current) return;
            // Only the drag is taken back; the popover stays.
            event.stopPropagation();
            cancel();
          }}
          className="h-4 w-28 disabled:opacity-40"
        />
        <span className="flex w-14 items-center justify-end gap-0.5 tabular-nums">
          <DraftInput
            aria-label={`${props.label} value`}
            title={`${props.label} (type a value and press Enter)`}
            disabled={props.disabled}
            value={unset ? null : draft}
            parse={(text) => {
              const value = Number(text.trim());
              return text.trim() && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : null;
            }}
            sanitize={(text) => text.replace(/[^\d]/g, "")}
            onChange={props.onCommit}
            onDone={props.onDone}
            className="h-5 w-9 rounded border bg-transparent px-0.5 text-right text-foreground disabled:opacity-40"
          />
          <span className="w-3 text-muted-foreground">{props.unit}</span>
        </span>
      </span>
    </>
  );
}

/**
 * The selected image's own tools: replacing it, how it fills its box and which part of it shows,
 * and its description. Flipping it is with the other flips, under Rotate. Shown for an image only.
 */
export function ImageButton(props: {
  selection: EditSelection;
  onStyle: (changes: EditStyle) => void;
  onReplace: () => void;
  onDone: () => void;
}) {
  const s = props.selection;
  const [alt, setAlt] = useState("");
  const saveAlt = () => {
    if (alt !== (s.alt ?? "")) props.onStyle({ alt });
  };
  const { open, ref, toggle } = useDropdown({ onClose: saveAlt });
  useEffect(() => setAlt(s.alt ?? ""), [s.alt]);
  // "Replace image…" in the context menu opens the same picker.
  useEditPanelAsk("replace-image", props.onReplace, { reveal: false });
  const fit = s.fit ?? "fill";
  // A stretched image fills its box whole: there is no part of it to choose.
  const placed = fit !== "fill";
  return (
    <div ref={ref} className="relative">
      <LabelPanelButton
        open={open}
        text="Image"
        label="Image options"
        title="Image: replace it, how it fills its box, and its description"
        onClick={toggle}
      >
        <ImageIcon />
      </LabelPanelButton>
      {open && (
        <DropdownPanel role="dialog" aria-label="Image options" className={panelGrid}>
          <Button
            variant="outline"
            size="sm"
            title="Replace the image with another file, keeping its size and place"
            onMouseDown={keepFocus}
            onClick={props.onReplace}
            className="col-span-2 justify-center"
          >
            <Replace />
            Replace image…
          </Button>
          <PanelLabel htmlFor="edit-image-fit">Fit</PanelLabel>
          <RibbonSelect
            id="edit-image-fit"
            title="How the image fills its box"
            value={fit}
            onPick={(next) => props.onStyle({ fit: next as ImageFit })}
            onDone={props.onDone}
            className="border"
          >
            {FIT_LABELS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </RibbonSelect>
          <PanelLabel off={!placed}>Position</PanelLabel>
          <fieldset
            aria-label="Image position"
            disabled={!placed}
            title={placed ? undefined : "A stretched image fills its box; pick another fit to choose which part shows"}
            className="grid w-max grid-cols-3 gap-0.5 disabled:opacity-40"
          >
            {FIT_POSITIONS.map((position, index) => (
              <button
                key={position}
                type="button"
                aria-label={`Position ${position}`}
                title={placed ? FIT_POSITION_NAMES[index] : undefined}
                aria-pressed={placed && s.fitPosition === position}
                onMouseDown={keepFocus}
                onClick={() => props.onStyle({ fitPosition: position })}
                className={cn(
                  "size-5 rounded-sm border enabled:hover:bg-accent disabled:cursor-default",
                  placed && s.fitPosition === position && "bg-primary/60 enabled:hover:bg-primary/60",
                )}
              />
            ))}
          </fieldset>
          <PanelLabel htmlFor="edit-image-alt">Description</PanelLabel>
          <input
            id="edit-image-alt"
            value={alt}
            title="What the image shows, for people who cannot see it (its alt text)"
            placeholder="What the image shows"
            onChange={(event) => setAlt(event.target.value)}
            onBlur={saveAlt}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                saveAlt();
                props.onDone();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setAlt(s.alt ?? "");
                props.onDone();
              }
            }}
            className="h-6 w-40 rounded border bg-transparent px-1"
          />
        </DropdownPanel>
      )}
    </div>
  );
}
