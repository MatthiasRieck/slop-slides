import { Ban } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { useDropdown } from "../hooks/useDropdown";
import { type DeckColor, EDIT_COLORS } from "../lib/editTools";
import { colorLabel, parseHexInput, SWATCHES } from "../lib/palette";
import { cn } from "../lib/utils";
import { useApp } from "../store";
import type { EditPanel } from "../store/editing";
import { keepFocus, toolButtonClass } from "./Button";
import { useEditPanelAsk } from "./editPanelAsk";
import { DropdownPanel } from "./Popover";

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
  const { open, setOpen, ref, toggle } = useDropdown({ disabled: props.disabled });
  const custom = useRef<HTMLInputElement>(null);
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

  // The system color picker reports every color the user passes over; only the one they settle on counts.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the input mounts and unmounts with the popover
  useEffect(() => {
    const input = custom.current;
    if (!input) return;
    const settle = () => pickRef.current(input.value);
    input.addEventListener("change", settle);
    return () => input.removeEventListener("change", settle);
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

  const tooltip =
    props.disabled && props.disabledReason
      ? props.disabledReason
      : `${props.label}: ${stateLabel(props.value, !!props.other)}`;

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
          data-state={state}
          className={cn(
            "mt-0.5 h-1 w-4 rounded-sm border border-foreground/20",
            state === "none" &&
              "bg-[linear-gradient(to_top_right,transparent_42%,currentColor_42%,currentColor_58%,transparent_58%)]",
            state === "other" && "bg-[repeating-linear-gradient(90deg,currentColor_0_2px,transparent_2px_4px)]",
          )}
          style={props.value ? { background: props.value } : undefined}
        />
      </button>
      {open && (
        <DropdownPanel role="dialog" aria-label={props.label} className="flex w-max flex-col gap-2">
          {state === "other" && (
            <p className="max-w-40 text-xs text-muted-foreground">
              Mixed, or not a plain color. Pick one to replace it.
            </p>
          )}
          {!!props.deck?.length && (
            <SwatchRow label="Deck colors">
              {props.deck.map((color) => (
                <Swatch
                  key={color.name}
                  color={color.value}
                  label={`Deck color ${color.name}`}
                  title={`${color.name} (${color.value})`}
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
                  title={colorLabel(color)}
                  picked={false}
                  onPick={() => pick(color)}
                />
              ))}
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
                onClick={() => pick(null)}
                className={cn(
                  "flex size-5 items-center justify-center rounded-full border text-muted-foreground [&_svg]:size-3.5",
                  state === "none" && "ring-2 ring-foreground/60 ring-offset-1 ring-offset-card",
                )}
              >
                <Ban />
              </button>
            )}
            {EDIT_COLORS.map((color) => (
              <Swatch
                key={color}
                color={color}
                label={colorLabel(color)}
                title={colorLabel(color)}
                picked={props.value === color}
                onPick={() => pick(color)}
              />
            ))}
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
          </div>
        </DropdownPanel>
      )}
    </div>
  );
}

/** A captioned row of swatches in a color well. */
function SwatchRow(props: { label: string; children: ReactNode }) {
  return (
    <fieldset aria-label={props.label} className="flex flex-col gap-1">
      <span className="text-[10px] leading-3 text-muted-foreground">{props.label}</span>
      <div className="grid w-max grid-cols-6 gap-1">{props.children}</div>
    </fieldset>
  );
}

/** One color to pick in a color well, ringed while it is the one picked. */
function Swatch(props: { color: string; label: string; title: string; picked: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.title}
      aria-pressed={props.picked}
      onMouseDown={keepFocus}
      onClick={props.onPick}
      className={cn(
        "size-5 rounded-full border border-foreground/20",
        props.picked && "ring-2 ring-foreground/60 ring-offset-1 ring-offset-card",
      )}
      style={{ background: props.color }}
    />
  );
}
