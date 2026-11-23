import { Ban } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { quietFocus } from "@/lib/focus";
import { type DeckColor, EDIT_COLORS } from "../lib/editTools";
import { colorLabel, parseHexInput, SWATCHES } from "../lib/palette";
import { cn } from "../lib/utils";
import { useApp } from "../store";
import type { EditPanel } from "../store/editing";
import { useEditPanelAsk } from "./editPanelAsk";
import { QUIET_LABEL } from "./styles";
import { TOOLBAR_POPUP } from "./toolProps";

/** What a color well holds: a color, none at all, or something that is not one color. */
export type ColorState = "color" | "none" | "other";

/** What the well says it holds, after its name: the color with its name, "none", or that it is mixed. */
function stateLabel(value: string | null, other: boolean): string {
  if (value) return colorLabel(value);
  return other ? "mixed, or not a plain color" : "none";
}

/**
 * A color well: the deck's colors, the colors picked last, preset swatches, a hex value to type,
 * the system's picker, and with `none`, no color at all. Its bar shows what the selection has:
 * the color, a struck-through bar for none, or stripes when it is `other` than one plain color
 * (a gradient, or several elements that differ). Disabled, its tooltip is `disabledReason`.
 * With `panel`, it also opens when that popover is asked for from outside the toolbar.
 *
 * Its popover leaves the focus, and with it the text selection, in the slide.
 */
export function ColorButton(props: {
  label: string;
  icon: ReactNode;
  value: string | null;
  /** The value is null because it is not one plain color, not because there is none. */
  other?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  none?: boolean;
  deck?: DeckColor[];
  panel?: EditPanel;
  onChange: (color: string | null) => void;
  /** Hands the keyboard focus back after a typed value. */
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // What it works on went away: it closes, and stays closed when that comes back.
  if (props.disabled && open) setOpen(false);
  const recent = useApp((s) => s.recentColors);
  const [hex, setHex] = useState("");
  const [invalid, setInvalid] = useState(false);
  const state: ColorState = props.value ? "color" : props.other ? "other" : "none";

  const pick = (color: string | null) => {
    if (color) useApp.getState().noteColor(color);
    props.onChange(color);
    setOpen(false);
  };
  const pickRef = useRef(pick);
  pickRef.current = pick;

  // The system color picker reports every color the user passes over; only the one they settle
  // on counts, which the browser's own `change` says (React's `onChange` is its `input`).
  const custom = useCallback((input: HTMLInputElement | null) => {
    if (!input) return;
    const settle = () => pickRef.current(input.value);
    input.addEventListener("change", settle);
    return () => input.removeEventListener("change", settle);
  }, []);

  // The field starts on the current color each time the popover opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only opening resets what was typed
  useEffect(() => {
    setHex(props.value ?? "");
    setInvalid(false);
  }, [open]);

  useEditPanelAsk(props.panel ?? null, () => {
    if (!props.disabled) setOpen(true);
  });

  const applyHex = () => {
    const color = parseHexInput(hex);
    if (!color) {
      setInvalid(true);
      return;
    }
    pick(color);
    props.onDone?.();
  };

  const tooltip =
    props.disabled && props.disabledReason
      ? props.disabledReason
      : `${props.label}: ${stateLabel(props.value, !!props.other)}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="tool"
            size="xs"
            aria-label={props.label}
            tooltip={tooltip}
            disabled={props.disabled}
            keepFocus
            className="flex-col gap-0.5 px-1"
          />
        }
      >
        {props.icon}
        <span
          data-testid={`${props.label} swatch`}
          data-state={state}
          className={cn(
            "h-1 w-4 rounded-sm border border-foreground/20",
            state === "none" &&
              "bg-[linear-gradient(to_top_right,transparent_42%,currentColor_42%,currentColor_58%,transparent_58%)]",
            state === "other" && "bg-[repeating-linear-gradient(90deg,currentColor_0_2px,transparent_2px_4px)]",
          )}
          style={props.value ? { background: props.value } : undefined}
        />
      </PopoverTrigger>
      <PopoverContent
        {...TOOLBAR_POPUP}
        aria-label={props.label}
        align="start"
        initialFocus={false}
        finalFocus={false}
        className="w-max gap-2 p-2"
      >
        {state === "other" && (
          <p className="max-w-40 text-xs text-muted-foreground">Mixed, or not a plain color. Pick one to replace it.</p>
        )}
        {!!props.deck?.length && (
          <SwatchRow label="Deck colors">
            {props.deck.map((color) => (
              <Swatch
                key={color.name}
                color={color.value}
                label={`Deck color ${color.name}`}
                tooltip={`${color.name} (${color.value})`}
                picked={props.value === color.value}
                onPick={() => pick(color.value)}
              />
            ))}
          </SwatchRow>
        )}
        {recent.length > 0 && (
          <SwatchRow label="Recent">
            {recent.map((color) => (
              <Swatch
                key={color}
                color={color}
                label={`Recent color ${colorLabel(color)}`}
                tooltip={colorLabel(color)}
                picked={false}
                onPick={() => pick(color)}
              />
            ))}
          </SwatchRow>
        )}
        <SwatchRow label="Colors">
          {props.none && (
            <Button
              variant="outline"
              size="icon-2xs"
              aria-label="None"
              tooltip={`No ${props.label.toLowerCase()}`}
              aria-pressed={state === "none"}
              keepFocus
              onClick={() => pick(null)}
              className={cn(
                "rounded-full text-muted-foreground",
                state === "none" && "ring-2 ring-foreground/60 ring-offset-1 ring-offset-popover",
              )}
            >
              <Ban />
            </Button>
          )}
          {EDIT_COLORS.map((color) => (
            <Swatch
              key={color}
              color={color}
              label={colorLabel(color)}
              tooltip={colorLabel(color)}
              picked={props.value === color}
              onPick={() => pick(color)}
            />
          ))}
        </SwatchRow>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <Input
                aria-label={`${props.label} as a hex value`}
                placeholder="#rrggbb"
                spellCheck={false}
                value={hex}
                onChange={(event) => {
                  setHex(event.target.value);
                  setInvalid(false);
                }}
                // The hint is for the pointer: it does not stay up while the value is typed.
                onFocus={quietFocus}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  applyHex();
                }}
                aria-invalid={invalid || undefined}
                className="h-6 w-20 rounded-md px-1 py-0 text-xs tabular-nums"
              />
            </TooltipTrigger>
            <TooltipContent>A hex color, six digits or three; Enter applies it</TooltipContent>
          </Tooltip>
          <Label className={cn("gap-1", QUIET_LABEL)}>
            <Input
              ref={custom}
              type="color"
              aria-label={`Custom ${props.label.toLowerCase()}`}
              defaultValue={props.value ?? SWATCHES.ink}
              className="h-5 w-8 cursor-pointer rounded-sm border-0 p-0"
            />
            Custom
          </Label>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A captioned row of swatches in a color well. */
function SwatchRow(props: { label: string; children: ReactNode }) {
  return (
    <FieldSet className="gap-1">
      <FieldLegend
        variant="label"
        className="mb-0 leading-3 font-normal text-muted-foreground data-[variant=label]:text-[10px]"
      >
        {props.label}
      </FieldLegend>
      <div className="grid w-max grid-cols-6 gap-1">{props.children}</div>
    </FieldSet>
  );
}

/** One color to pick in a color well, ringed while it is the one picked. */
function Swatch(props: { color: string; label: string; tooltip: string; picked: boolean; onPick: () => void }) {
  return (
    <Button
      variant="outline"
      size="icon-2xs"
      aria-label={props.label}
      tooltip={props.tooltip}
      aria-pressed={props.picked}
      keepFocus
      onClick={props.onPick}
      className={cn(
        "rounded-full border-foreground/20 dark:border-foreground/20",
        props.picked && "ring-2 ring-foreground/60 ring-offset-1 ring-offset-popover",
      )}
      style={{ background: props.color }}
    />
  );
}
