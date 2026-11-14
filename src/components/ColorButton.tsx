import { Ban, Pipette } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { useDropdown } from "../hooks/useDropdown";
import { type DeckColor, EDIT_COLORS } from "../lib/editTools";
import { colorLabel, DECK_COLOR_MIXES, HEX_EXAMPLE, mixColor, parseHexInput, SWATCHES } from "../lib/palette";
import { cn } from "../lib/utils";
import { useApp } from "../store";
import type { EditPanel } from "../store/editing";
import { Button, keepFocus, toolButtonClass } from "./Button";
import { useEditPanelAsk } from "./editPanelAsk";
import { DropdownPanel } from "./Popover";

/** What a color well holds: a color, none at all, or something that is not one color. */
export type ColorState = "color" | "none" | "other";

/** What the well says it holds, after its name: the color with its name, "none", or that it is mixed. */
function stateLabel(value: string | null, other: boolean): string {
  if (value) return colorLabel(value);
  return other ? "mixed, or not a plain color" : "none";
}

/** The browser's screen color picker, where it has one (Chromium and WebView2 do, WebKit does not). */
interface EyeDropperWindow {
  EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> };
}

/** The most deck colors a row of the well shows. */
const DECK_COLUMNS = 8;

/**
 * A color well: the deck's colors with a lighter and a darker row of each, the colors picked
 * last, preset swatches, a hex value to type, the system's picker, where the browser has one a
 * picker for any color on screen, and with `none`, no color at all. Its bar shows what the
 * selection has: the color, a struck-through bar for none, or stripes when it is `other` than one
 * plain color (a gradient, or several elements that differ). Disabled, its tooltip is
 * `disabledReason`. With `panel`, it also opens when that popover is asked for from outside the
 * toolbar.
 *
 * The popover stays open while colors are tried, one after another; a press outside it or Escape
 * closes it. With `onPreview`, the color under the pointer shows on the slide before it is picked
 * (a call with `undefined` takes that back).
 */
export function ColorButton(props: {
  label: string;
  icon: ReactNode;
  value: string | null;
  /** The value is null because it is not one plain color, not because there is none. */
  other?: boolean;
  /** What the popover says about a value that is `other`, in place of its own words. */
  otherNote?: string;
  disabled?: boolean;
  disabledReason?: string;
  none?: boolean;
  /** Offers going back to the deck's own color under this name, which picks null. */
  defaultLabel?: string;
  deck?: DeckColor[];
  panel?: EditPanel;
  /** What goes under the colors: an action that goes with the color picked. */
  footer?: ReactNode;
  onChange: (color: string | null) => void;
  /** Shows a color on the slide while the pointer is on it; `undefined` ends that. */
  onPreview?: (color: string | null | undefined) => void;
  /** Hands the keyboard focus back after a typed value. */
  onDone?: () => void;
}) {
  const previewing = useRef(false);
  const endPreview = () => {
    if (!previewing.current) return;
    previewing.current = false;
    props.onPreview?.(undefined);
  };
  const { open, setOpen, ref, toggle } = useDropdown({ disabled: props.disabled, onClose: endPreview });
  const custom = useRef<HTMLInputElement>(null);
  const recent = useApp((s) => s.recentColors);
  const [hex, setHex] = useState("");
  const [invalid, setInvalid] = useState(false);
  // What the selection has, not what a preview shows of it: the ring stays on the color picked.
  const held = useRef({ value: props.value, other: !!props.other });
  if (!previewing.current) held.current = { value: props.value, other: !!props.other };
  const { value, other } = held.current;
  const state: ColorState = value ? "color" : other ? "other" : "none";
  const dropper = (window as EyeDropperWindow).EyeDropper;

  const preview = (color: string | null) => {
    if (!props.onPreview) return;
    previewing.current = true;
    props.onPreview(color);
  };
  const pick = (color: string | null) => {
    // The pick is what shows from now on: nothing is left to take back.
    previewing.current = false;
    held.current = { value: color, other: false };
    if (color) useApp.getState().noteColor(color);
    props.onChange(color);
    setHex(color ?? "");
    setInvalid(false);
  };
  const latest = useRef({ pick, preview });
  latest.current = { pick, preview };

  // The system color picker reports every color the user passes over, which shows on the slide;
  // the one they settle on is picked.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the input mounts and unmounts with the popover
  useEffect(() => {
    const input = custom.current;
    if (!input) return;
    const pass = () => latest.current.preview(input.value);
    const settle = () => latest.current.pick(input.value);
    input.addEventListener("input", pass);
    input.addEventListener("change", settle);
    return () => {
      input.removeEventListener("input", pass);
      input.removeEventListener("change", settle);
    };
  }, [open]);

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
  const pickFromScreen = async () => {
    if (!dropper) return;
    try {
      const picked = parseHexInput((await new dropper().open()).sRGBHex);
      if (picked) pick(picked);
    } catch {
      // Escape puts the picker away without a color.
    }
  };

  const tooltip =
    props.disabled && props.disabledReason
      ? props.disabledReason
      : `${props.label}: ${stateLabel(props.value, !!props.other)}`;
  const swatch = (color: string, label: string, title: string) => (
    <Swatch
      key={label}
      color={color}
      label={label}
      title={title}
      picked={value === color}
      onPick={() => pick(color)}
      onPreview={props.onPreview ? () => preview(color) : undefined}
    />
  );
  const deck = props.deck ?? [];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={props.label}
        title={tooltip}
        aria-expanded={open}
        disabled={props.disabled}
        onMouseDown={keepFocus}
        onClick={toggle}
        className={cn(toolButtonClass("toolbar", "xs", open), "flex flex-col items-center px-1 [&_svg]:!size-3.5")}
      >
        {props.icon}
        <span
          data-testid={`${props.label} swatch`}
          data-state={props.value ? "color" : props.other ? "other" : "none"}
          className={cn(
            "mt-0.5 h-1 w-4 rounded-sm border border-foreground/20 dark:border-foreground/40",
            !props.value &&
              !props.other &&
              "bg-[linear-gradient(to_top_right,transparent_42%,currentColor_42%,currentColor_58%,transparent_58%)]",
            !props.value &&
              props.other &&
              "bg-[repeating-linear-gradient(90deg,currentColor_0_2px,transparent_2px_4px)]",
          )}
          style={props.value ? { background: props.value } : undefined}
        />
      </button>
      {open && (
        <DropdownPanel
          role="dialog"
          aria-label={props.label}
          onMouseLeave={endPreview}
          className="flex w-max flex-col gap-2 text-foreground"
        >
          {state === "other" && (
            <p className="max-w-44 text-xs text-muted-foreground">
              {props.otherNote ?? "Mixed, or not a plain color. Picking a color replaces it."}
            </p>
          )}
          {deck.length > 0 && (
            <SwatchRow label="Deck colors" columns={Math.min(deck.length, DECK_COLUMNS)}>
              {deck.map((color) => swatch(color.value, `Deck color ${color.name}`, `${color.name} (${color.value})`))}
              {deck.length <= DECK_COLUMNS &&
                DECK_COLOR_MIXES.flatMap((amount) =>
                  deck.map((color) => {
                    const mixed = mixColor(color.value, amount);
                    const kind = amount > 0 ? "lighter" : "darker";
                    return swatch(mixed, `Deck color ${color.name}, ${kind}`, `${color.name}, ${kind} (${mixed})`);
                  }),
                )}
            </SwatchRow>
          )}
          {recent.length > 0 && (
            <SwatchRow label="Recent">
              {recent.map((color) => swatch(color, `Recent color ${colorLabel(color)}`, colorLabel(color)))}
            </SwatchRow>
          )}
          <SwatchRow label="Colors">
            {props.none && (
              <button
                type="button"
                aria-label="None"
                title={`No ${props.label.toLowerCase()}`}
                aria-pressed={state === "none"}
                onMouseDown={keepFocus}
                onMouseEnter={props.onPreview ? () => preview(null) : undefined}
                onClick={() => pick(null)}
                className={cn(
                  "flex size-5 items-center justify-center rounded-full border text-muted-foreground [&_svg]:size-3.5",
                  state === "none" && "ring-2 ring-foreground/60 ring-offset-1 ring-offset-card",
                )}
              >
                <Ban />
              </button>
            )}
            {EDIT_COLORS.map((color) => swatch(color, colorLabel(color), colorLabel(color)))}
          </SwatchRow>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              aria-label={`${props.label} as a hex value`}
              title="A hex color, six digits or three; Enter applies it"
              placeholder="#rrggbb"
              spellCheck={false}
              value={hex}
              onChange={(event) => {
                setHex(event.target.value);
                setInvalid(false);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                applyHex();
              }}
              aria-invalid={invalid || undefined}
              className={cn(
                "h-6 w-20 rounded border bg-transparent px-1 text-foreground tabular-nums",
                invalid && "border-destructive",
              )}
            />
            <label className="flex items-center gap-1">
              <input
                ref={custom}
                type="color"
                aria-label={`Custom ${props.label.toLowerCase()}`}
                defaultValue={props.value ?? SWATCHES.ink}
                className="h-5 w-8 cursor-pointer rounded border-0 bg-transparent p-0"
              />
              Custom
            </label>
            {dropper && (
              <button
                type="button"
                aria-label="Pick a color from the screen"
                title="Pick a color from anywhere on the screen"
                onMouseDown={keepFocus}
                onClick={() => void pickFromScreen()}
                className={cn(toolButtonClass("toolbar", "xs"), "[&_svg]:!size-3.5")}
              >
                <Pipette />
              </button>
            )}
          </div>
          {invalid && <p className="text-xs text-destructive">Type a hex color like {HEX_EXAMPLE}.</p>}
          {(props.defaultLabel || props.footer) && (
            <div className="flex flex-col items-stretch gap-1 border-t pt-2">
              {props.defaultLabel && (
                <Button
                  variant="ghost"
                  size="sm"
                  onMouseDown={keepFocus}
                  onMouseEnter={props.onPreview ? () => preview(null) : undefined}
                  onClick={() => pick(null)}
                >
                  {props.defaultLabel}
                </Button>
              )}
              {props.footer}
            </div>
          )}
        </DropdownPanel>
      )}
    </div>
  );
}

/** A captioned grid of swatches in a color well, `columns` to a row. */
function SwatchRow(props: { label: string; columns?: number; children: ReactNode }) {
  return (
    <fieldset aria-label={props.label} className="flex flex-col gap-1">
      <span className="text-[10px] leading-3 text-muted-foreground">{props.label}</span>
      <div
        className="grid w-max gap-1"
        style={{ gridTemplateColumns: `repeat(${props.columns ?? 6}, minmax(0, 1fr))` }}
      >
        {props.children}
      </div>
    </fieldset>
  );
}

/** One color to pick in a color well, ringed while it is the one picked; `onPreview` when the pointer comes onto it. */
function Swatch(props: {
  color: string;
  label: string;
  title: string;
  picked: boolean;
  onPick: () => void;
  onPreview?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.title}
      aria-pressed={props.picked}
      onMouseDown={keepFocus}
      onMouseEnter={props.onPreview}
      onClick={props.onPick}
      className={cn(
        "size-5 rounded-full border border-foreground/20 dark:border-foreground/40",
        props.picked && "ring-2 ring-foreground/60 ring-offset-1 ring-offset-card",
      )}
      style={{ background: props.color }}
    />
  );
}
