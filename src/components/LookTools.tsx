import { Blend, FlipHorizontal2, FlipVertical2, Image, Paintbrush, Replace } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { type EditSelection, type EditStyle, type EditTool, FIT_POSITIONS, type ImageFit } from "../lib/editTools";
import { cn } from "../lib/utils";
import { keepFocus, ToolButton, useOutsideClose } from "./EditControls";

const FITS: { value: ImageFit; label: string }[] = [
  { value: "contain", label: "Fit" },
  { value: "cover", label: "Fill" },
  { value: "fill", label: "Stretch" },
];

/**
 * The toolbar's tools for how an element looks, beyond text, fill and border: opacity, shadow and
 * corner radius; the format painter; fitting, flipping and describing the selected image. Mounted
 * in EditToolbar.
 */
export function LookTools(props: {
  tool: EditTool;
  selection: EditSelection | null;
  onTool: (tool: EditTool) => void;
  onStyle: (changes: EditStyle) => void;
  onPickImage?: (replace: boolean) => void;
  onReturnFocus: () => void;
}) {
  const { selection } = props;
  const painting = props.tool === "paint";
  return (
    <>
      <AppearanceButton selection={selection} onStyle={props.onStyle} onDone={props.onReturnFocus} />
      <ToolButton
        label="Copy this look to the next element clicked"
        active={painting}
        disabled={!selection && !painting}
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

/**
 * A popover's state. Its panel shows only with a selection, and comes back with it: saving
 * reloads the slide's preview, which reports the selection again.
 */
function usePopover(onClose?: () => void) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose(open, ref, () => {
    onClose?.();
    setOpen(false);
  });
  return { open, setOpen, ref };
}

const popoverButton =
  "rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-4";
const popoverPanel =
  "absolute top-full left-1/2 z-30 mt-1 grid w-max -translate-x-1/2 grid-cols-[auto_auto] items-center gap-x-2 gap-y-1.5 rounded-md border bg-card p-2 text-xs shadow-md";

/** Opacity, shadow and corner radius of the selection. */
function AppearanceButton(props: {
  selection: EditSelection | null;
  onStyle: (changes: EditStyle) => void;
  onDone: () => void;
}) {
  const { open, setOpen, ref } = usePopover();
  const s = props.selection;
  const change = (changes: EditStyle) => {
    props.onStyle(changes);
    props.onDone();
  };
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Appearance"
        title="Opacity, shadow and corner radius"
        aria-expanded={open}
        disabled={!s}
        onMouseDown={keepFocus}
        onClick={() => setOpen(!open)}
        className={popoverButton}
      >
        <Blend />
      </button>
      {open && s && (
        <div role="dialog" aria-label="Appearance" className={popoverPanel}>
          <Slider
            label="Opacity"
            value={Math.round(s.opacity * 100)}
            min={5}
            max={100}
            step={5}
            unit="%"
            onCommit={(n) => change({ opacity: n / 100 })}
          />
          <Slider
            label="Shadow"
            value={s.shadow}
            max={80}
            step={2}
            unit="px"
            disabled={s.clipped}
            onCommit={(shadow) => change({ shadow })}
          />
          <Slider
            label="Corner radius"
            value={s.radius ?? 0}
            max={200}
            step={2}
            unit="px"
            disabled={s.radius === null}
            onCommit={(radius) => change({ radius })}
          />
        </div>
      )}
    </div>
  );
}

/** A slider showing its value as it moves; only the value it is let go at is applied. */
function Slider(props: {
  label: string;
  value: number;
  min?: number;
  max: number;
  step: number;
  unit: string;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const input = useRef<HTMLInputElement>(null);
  const onCommit = useRef(props.onCommit);
  onCommit.current = props.onCommit;
  // React's onChange fires all along the drag, and each applied value saves the slide.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const commit = () => onCommit.current(Number(el.value));
    el.addEventListener("change", commit);
    return () => el.removeEventListener("change", commit);
  }, []);
  return (
    <>
      <span className={cn("text-muted-foreground", props.disabled && "opacity-30")}>{props.label}</span>
      <span className="flex items-center gap-2">
        <input
          ref={input}
          type="range"
          aria-label={props.label}
          min={props.min ?? 0}
          max={Math.max(props.max, props.value)}
          step={props.step}
          disabled={props.disabled}
          value={draft}
          onChange={(event) => setDraft(Number(event.target.value))}
          className="h-4 w-28 disabled:opacity-30"
        />
        <span className="w-10 text-right tabular-nums">
          {draft}
          {props.unit}
        </span>
      </span>
    </>
  );
}

/** Replacing, fitting, flipping and describing the selected image. */
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
  const { open, setOpen, ref } = usePopover(saveAlt);
  useEffect(() => setAlt(s?.alt ?? ""), [s?.alt]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Image"
        title="Replace, fit, flip and describe the image"
        aria-expanded={open}
        disabled={!s}
        onMouseDown={keepFocus}
        onClick={() => setOpen(!open)}
        className={popoverButton}
      >
        <Image />
      </button>
      {open && s && (
        <div role="dialog" aria-label="Image" className={popoverPanel}>
          <span className="text-muted-foreground">Image</span>
          <span className="flex items-center gap-0.5">
            <ToolButton label="Replace the image, keeping its size and place" onClick={props.onReplace}>
              <Replace />
            </ToolButton>
            <ToolButton label="Flip horizontally" active={s.flipX} onClick={() => props.onStyle({ flipX: !s.flipX })}>
              <FlipHorizontal2 />
            </ToolButton>
            <ToolButton label="Flip vertically" active={s.flipY} onClick={() => props.onStyle({ flipY: !s.flipY })}>
              <FlipVertical2 />
            </ToolButton>
          </span>
          <label htmlFor="edit-image-fit" className="text-muted-foreground">
            Fit
          </label>
          <select
            id="edit-image-fit"
            value={s.fit ?? "fill"}
            onChange={(event) => props.onStyle({ fit: event.target.value as ImageFit })}
            className="h-6 rounded border bg-transparent px-1"
          >
            {FITS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          <span className="text-muted-foreground">Position</span>
          <fieldset aria-label="Image position" className="grid w-max grid-cols-3 gap-0.5">
            {FIT_POSITIONS.map((position) => (
              <button
                key={position}
                type="button"
                aria-label={`Position ${position}`}
                title={position}
                aria-pressed={s.fitPosition === position}
                onMouseDown={keepFocus}
                onClick={() => props.onStyle({ fitPosition: position })}
                className={cn("size-3 rounded-sm border", s.fitPosition === position && "bg-foreground/60")}
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
        </div>
      )}
    </div>
  );
}
