import { Blend, Crop, Paintbrush, Replace } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelectOption } from "@/components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
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
import { DraftInput } from "./DraftInput";
import { RibbonSelect } from "./Ribbon";
import { QUIET_LABEL } from "./styles";

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
  const paintable = !!selection || painting;
  return (
    <>
      <AppearanceButton
        selection={selection}
        onStyle={props.onStyle}
        onArrange={props.onArrange}
        onDone={props.onReturnFocus}
      />
      <Button
        variant="tool"
        size="icon-xs"
        aria-label="Format painter"
        tooltip={paintable ? "Copy this look to the next element clicked" : "Select an element"}
        aria-pressed={painting}
        disabled={!paintable}
        keepFocus
        onClick={() => props.onTool(painting ? "select" : "paint")}
      >
        <Paintbrush />
      </Button>
      <ImageButton
        selection={selection?.image ? selection : null}
        onStyle={props.onStyle}
        onReplace={() => props.onPickImage?.(true)}
        onDone={props.onReturnFocus}
      />
    </>
  );
}

const popoverPanel = "grid w-max grid-cols-[auto_auto] items-center gap-x-2 gap-y-1.5 p-2 text-xs";

/** Opacity, shadow and corner radius of the selection, and a shape's proportions. */
function AppearanceButton(props: {
  selection: EditSelection | null;
  onStyle: (changes: EditStyle) => void;
  onArrange?: (message: ArrangeMessage) => void;
  onDone: () => void;
}) {
  // The panel shows only with a selection, and comes back with it: saving reloads the slide's
  // preview, which reports the selection again.
  const [open, setOpen] = useState(false);
  const s = props.selection;
  /** What a slider needs to show its value in the slide as it moves and to apply the one it is let go at. */
  const live = (style: (value: number) => EditStyle) => ({
    onPreview: (value: number) => props.onArrange?.({ type: "slop:edit-style", style: style(value), preview: true }),
    onCancel: () => props.onArrange?.({ type: "slop:edit-style-cancel" }),
    onCommit: (value: number) => props.onStyle(style(value)),
    onDone: props.onDone,
  });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="tool"
            size="icon-xs"
            aria-label="Appearance"
            tooltip={s ? "Opacity, shadow, corner radius and a shape's proportions" : "Select an element"}
            disabled={!s}
            keepFocus
          />
        }
      >
        <Blend />
      </PopoverTrigger>
      {s && (
        <PopoverContent aria-label="Appearance" initialFocus={false} finalFocus={false} className={popoverPanel}>
          <LookSlider
            label="Opacity"
            value={Math.round(s.opacity * 100)}
            min={5}
            max={100}
            step={5}
            unit="%"
            {...live((n) => ({ opacity: n / 100 }))}
          />
          <LookSlider
            label="Shadow"
            value={s.shadow}
            max={80}
            step={2}
            unit="px"
            disabled={s.clipped}
            {...live((shadow) => ({ shadow }))}
          />
          <LookSlider
            label="Corner radius"
            value={s.radius ?? 0}
            max={200}
            step={2}
            unit="px"
            disabled={s.radius === null}
            {...live((radius) => ({ radius }))}
          />
          {s.adjust && (
            <LookSlider
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
        </PopoverContent>
      )}
    </Popover>
  );
}

/**
 * A slider with its value as a number to type beside it. While it is dragged the value shows in
 * the slide (`onPreview`), once per animation frame however fast it moves, and always the last
 * one before it is let go; the one it is let go at is applied, once (`onCommit`). A drag that
 * never lands (Escape, or the slider going away under the pointer) is taken back (`onCancel`).
 * A typed number applies on Enter or when the field loses focus, within the slider's range.
 */
function LookSlider(props: {
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
  const id = useId();
  const min = props.min ?? 0;
  const max = Math.max(props.max, props.value);
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  // A value was previewed that has not been applied or taken back yet.
  const previewing = useRef(false);
  const latest = useRef(props);
  latest.current = props;
  // The slider reports every value it passes; the slide need not draw more of them than the screen shows.
  const preview = useMemo(() => perFrame<number>((value) => latest.current.onPreview(value)), []);
  // The slider going away under the pointer takes back what it showed.
  useEffect(
    () => () => {
      preview.cancel();
      if (previewing.current) latest.current.onCancel();
    },
    [preview],
  );
  // The drag under way was given up: what is left of it, and its letting go, change nothing.
  const givenUp = useRef(false);
  const cancel = () => {
    if (!previewing.current) return;
    previewing.current = false;
    givenUp.current = true;
    preview.cancel();
    setDraft(props.value);
    props.onCancel();
  };
  return (
    <>
      <span id={id} className={cn(QUIET_LABEL, props.disabled && "opacity-30")}>
        {props.label}
      </span>
      <span className="flex items-center gap-2">
        <Slider
          aria-labelledby={id}
          min={min}
          max={max}
          step={props.step}
          disabled={props.disabled}
          value={draft}
          // A new press starts a new drag, whatever became of the last one.
          onPointerDownCapture={() => {
            givenUp.current = false;
          }}
          // Every value it passes along the drag, and with the arrow keys.
          onValueChange={(next) => {
            if (givenUp.current) return;
            const value = Array.isArray(next) ? (next[0] ?? draft) : next;
            setDraft(value);
            previewing.current = true;
            preview.push(value);
          }}
          // The one it is let go at; a press that moved it nowhere applies nothing.
          onValueCommitted={(next) => {
            const wasGivenUp = givenUp.current;
            givenUp.current = false;
            if (wasGivenUp || !previewing.current) return;
            const value = Array.isArray(next) ? (next[0] ?? draft) : next;
            preview.flush();
            previewing.current = false;
            props.onCommit(value);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !previewing.current) return;
            // Only the drag is taken back; the popover stays.
            event.stopPropagation();
            cancel();
          }}
          className="w-28"
        />
        <span className="flex w-14 items-center justify-end gap-0.5 tabular-nums">
          <DraftInput
            aria-label={`${props.label} value`}
            tooltip={`${props.label} (type a value and press Enter)`}
            disabled={props.disabled}
            value={draft}
            parse={(text) => {
              const value = Number(text.trim());
              return text.trim() && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : null;
            }}
            sanitize={(text) => text.replace(/[^\d]/g, "")}
            onChange={props.onCommit}
            onDone={props.onDone}
            className="h-5 w-9 px-0.5 text-right"
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
  const id = useId();
  const [open, setOpen] = useState(false);
  const [alt, showAlt] = useState("");
  // The description as typed, also before the field shows it: Escape puts the image's own back,
  // and the panel that closes on the same key must find nothing to save.
  const typed = useRef("");
  const setAlt = (text: string) => {
    typed.current = text;
    showAlt(text);
  };
  const saveAlt = () => {
    if (s && typed.current !== (s.alt ?? "")) props.onStyle({ alt: typed.current });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: `setAlt` only sets what is typed
  useEffect(() => setAlt(s?.alt ?? ""), [s?.alt]);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // What was typed as the image's description is kept as the panel closes.
        if (!next && open) saveAlt();
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="tool"
            size="icon-xs"
            aria-label="Image options"
            tooltip={s ? "Replace, fit and describe the image" : "Select an image"}
            disabled={!s}
            keepFocus
          />
        }
      >
        <Crop />
      </PopoverTrigger>
      {s && (
        <PopoverContent aria-label="Image options" initialFocus={false} finalFocus={false} className={popoverPanel}>
          <span className={QUIET_LABEL}>Image</span>
          <span className="flex items-center gap-0.5">
            <Button
              variant="tool"
              size="icon-xs"
              tooltip="Replace the image, keeping its size and place"
              keepFocus
              onClick={props.onReplace}
            >
              <Replace />
            </Button>
          </span>
          <Label htmlFor={`${id}-fit`} className={QUIET_LABEL}>
            Fit
          </Label>
          <RibbonSelect
            id={`${id}-fit`}
            title="How the image fills its box"
            value={s.fit ?? "fill"}
            onPick={(fit) => props.onStyle({ fit: fit as ImageFit })}
            onDone={props.onDone}
            className="border"
          >
            {FIT_LABELS.map((f) => (
              <NativeSelectOption key={f.value} value={f.value}>
                {f.label}
              </NativeSelectOption>
            ))}
          </RibbonSelect>
          <span className={QUIET_LABEL}>Position</span>
          <FieldSet aria-label="Image position" className="grid w-max grid-cols-3 gap-0.5">
            {FIT_POSITIONS.map((position, index) => (
              <Button
                key={position}
                variant="outline"
                size="icon-2xs"
                aria-label={`Position ${position}`}
                tooltip={FIT_POSITION_NAMES[index]}
                aria-pressed={s.fitPosition === position}
                keepFocus
                onClick={() => props.onStyle({ fitPosition: position })}
                className="rounded-sm aria-pressed:bg-foreground/60 aria-pressed:hover:bg-foreground/60"
              />
            ))}
          </FieldSet>
          <Label htmlFor={`${id}-alt`} className={QUIET_LABEL}>
            Alt text
          </Label>
          <Input
            id={`${id}-alt`}
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
            className="h-6 w-40 rounded-md px-1 py-0 text-xs"
          />
        </PopoverContent>
      )}
    </Popover>
  );
}
