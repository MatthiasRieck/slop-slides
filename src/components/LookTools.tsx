import { Blend, Crop, Paintbrush, Replace } from "lucide-react";
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
} from "../lib/editTools";
import { perFrame } from "../lib/perFrame";
import { cn } from "../lib/utils";
import { keepFocus, ToolButton } from "./Button";
import { DraftInput } from "./Field";
import { DropdownPanel } from "./Popover";
import { RibbonSelect } from "./Ribbon";

/**
 * The toolbar's tools for how an element looks, beyond text, fill and border: opacity, shadow and
 * corner radius; the format painter; replacing, fitting and describing the selected image. Mounted
 * in EditToolbar.
 */
export function LookTools(props: {
  tool: EditTool;
  selection: EditSelection | null;
  onTool: (tool: EditTool) => void;
  onStyle: (changes: EditStyle) => void;
  /** Previews a restyle in the slide while a slider is dragged, and takes a preview back. */
  onArrange?: (message: ArrangeMessage) => void;
  onPickImage?: (replace: boolean) => void;
  onReturnFocus: () => void;
}) {
  const { selection } = props;
  const painting = props.tool === "paint";
  return (
    <>
      <AppearanceButton
        selection={selection}
        onStyle={props.onStyle}
        onArrange={props.onArrange}
        onDone={props.onReturnFocus}
      />
      <ToolButton
        keepFocus
        label="Format painter"
        title="Copy this look to the next element clicked"
        active={painting}
        disabled={!selection && !painting}
        disabledReason="Select an element"
        onClick={() => props.onTool(painting ? "select" : "paint")}
      >
        <Paintbrush />
      </ToolButton>
      <ImageButton
        selection={selection?.image ? selection : null}
        onStyle={props.onStyle}
        onReplace={() => props.onPickImage?.(true)}
        onDone={props.onReturnFocus}
      />
    </>
  );
}

const popoverPanel = "grid w-max grid-cols-[auto_auto] items-center gap-x-2 gap-y-1.5 text-xs";

/** Opacity, shadow and corner radius of the selection, and a shape's proportions. */
function AppearanceButton(props: {
  selection: EditSelection | null;
  onStyle: (changes: EditStyle) => void;
  onArrange?: (message: ArrangeMessage) => void;
  onDone: () => void;
}) {
  // The panel shows only with a selection, and comes back with it: saving reloads the slide's
  // preview, which reports the selection again.
  const { open, ref, toggle } = useDropdown();
  const s = props.selection;
  /** What a slider needs to show its value in the slide as it moves and to apply the one it is let go at. */
  const live = (style: (value: number) => EditStyle) => ({
    onPreview: (value: number) => props.onArrange?.({ type: "slop:edit-style", style: style(value), preview: true }),
    onCancel: () => props.onArrange?.({ type: "slop:edit-style-cancel" }),
    onCommit: (value: number) => props.onStyle(style(value)),
    onDone: props.onDone,
  });
  return (
    <div ref={ref} className="relative">
      <ToolButton
        keepFocus
        label="Appearance"
        title="Opacity, shadow, corner radius and a shape's proportions"
        aria-expanded={open}
        disabled={!s}
        disabledReason="Select an element"
        onClick={toggle}
      >
        <Blend />
      </ToolButton>
      {open && s && (
        <DropdownPanel role="dialog" aria-label="Appearance" className={popoverPanel}>
          <Slider
            label="Opacity"
            value={Math.round(s.opacity * 100)}
            min={5}
            max={100}
            step={5}
            unit="%"
            {...live((n) => ({ opacity: n / 100 }))}
          />
          <Slider
            label="Shadow"
            value={s.shadow}
            max={80}
            step={2}
            unit="px"
            disabled={s.clipped}
            {...live((shadow) => ({ shadow }))}
          />
          <Slider
            label="Corner radius"
            value={s.radius ?? 0}
            max={200}
            step={2}
            unit="px"
            disabled={s.radius === null}
            {...live((radius) => ({ radius }))}
          />
          {s.adjust && (
            <Slider
              label={s.adjust.label}
              value={s.adjust.value}
              min={s.adjust.min}
              max={s.adjust.max}
              step={s.adjust.step}
              // A star counts its points; the others go by a share of the shape's height.
              unit={s.adjust.label === "Points" ? "" : "%"}
              {...live((adjust) => ({ adjust }))}
            />
          )}
        </DropdownPanel>
      )}
    </div>
  );
}

/**
 * A slider with its value as a number to type beside it. While it is dragged the value shows in
 * the slide (`onPreview`), once per animation frame however fast it moves, and always the last
 * one before it is let go; the one it is let go at is applied, once (`onCommit`). A drag that
 * never lands (Escape, or the slider going away under the pointer) is taken back (`onCancel`).
 * A typed number applies on Enter or when the field loses focus, within the slider's range.
 */
function Slider(props: {
  label: string;
  value: number;
  min?: number;
  max: number;
  step: number;
  unit: string;
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
      <span className={cn("text-muted-foreground", props.disabled && "opacity-30")}>{props.label}</span>
      <span className="flex items-center gap-2">
        <input
          ref={input}
          type="range"
          aria-label={props.label}
          min={min}
          max={max}
          step={props.step}
          disabled={props.disabled}
          value={draft}
          onChange={(event) => {
            const value = Number(event.target.value);
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
            value={draft}
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

/** Replacing, fitting and describing the selected image. Flipping it is with the other flips, under Position and size. */
function ImageButton(props: {
  selection: EditSelection | null;
  onStyle: (changes: EditStyle) => void;
  onReplace: () => void;
  onDone: () => void;
}) {
  const s = props.selection;
  const [alt, setAlt] = useState("");
  const saveAlt = () => {
    if (s && alt !== (s.alt ?? "")) props.onStyle({ alt });
  };
  const { open, ref, toggle } = useDropdown({ onClose: saveAlt });
  useEffect(() => setAlt(s?.alt ?? ""), [s?.alt]);
  return (
    <div ref={ref} className="relative">
      <ToolButton
        keepFocus
        label="Image options"
        title="Replace, fit and describe the image"
        aria-expanded={open}
        disabled={!s}
        disabledReason="Select an image"
        onClick={toggle}
      >
        <Crop />
      </ToolButton>
      {open && s && (
        <DropdownPanel role="dialog" aria-label="Image options" className={popoverPanel}>
          <span className="text-muted-foreground">Image</span>
          <span className="flex items-center gap-0.5">
            <ToolButton keepFocus label="Replace the image, keeping its size and place" onClick={props.onReplace}>
              <Replace />
            </ToolButton>
          </span>
          <label htmlFor="edit-image-fit" className="text-muted-foreground">
            Fit
          </label>
          <RibbonSelect
            id="edit-image-fit"
            title="How the image fills its box"
            value={s.fit ?? "fill"}
            onPick={(fit) => props.onStyle({ fit: fit as ImageFit })}
            onDone={props.onDone}
            className="border"
          >
            {FIT_LABELS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </RibbonSelect>
          <span className="text-muted-foreground">Position</span>
          <fieldset aria-label="Image position" className="grid w-max grid-cols-3 gap-0.5">
            {FIT_POSITIONS.map((position, index) => (
              <button
                key={position}
                type="button"
                aria-label={`Position ${position}`}
                title={FIT_POSITION_NAMES[index]}
                aria-pressed={s.fitPosition === position}
                onMouseDown={keepFocus}
                onClick={() => props.onStyle({ fitPosition: position })}
                className={cn(
                  "size-5 rounded-sm border hover:bg-accent",
                  s.fitPosition === position && "bg-foreground/60 hover:bg-foreground/60",
                )}
              />
            ))}
          </fieldset>
          <label htmlFor="edit-image-alt" className="text-muted-foreground">
            Alt text
          </label>
          <input
            id="edit-image-alt"
            value={alt}
            placeholder="Describe the image"
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
