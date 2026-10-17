import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  ArrowDown,
  ArrowUp,
  Ban,
  Baseline,
  Bold,
  BringToFront,
  Circle,
  Italic,
  Minus,
  MousePointer2,
  PaintBucket,
  PenLine,
  Plus,
  SendToBack,
  Square,
  SquareDashed,
  SquareRoundCorner,
  Trash2,
  Type,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  BORDER_WIDTHS,
  EDIT_COLORS,
  stepFontSize,
  toolbarState,
  type EditSelection,
  type EditStyle,
  type EditTool,
  type StackOrder,
  type TextAlign,
  type ToolFamily,
  type VerticalAlign,
} from "../lib/editTools";
import { cn } from "../lib/utils";

const TOOLS: { tool: EditTool; label: string; icon: ReactNode }[] = [
  { tool: "select", label: "Select and move (V)", icon: <MousePointer2 /> },
  { tool: "text", label: "Add text (T)", icon: <Type /> },
  { tool: "rect", label: "Add a rectangle (R)", icon: <Square /> },
  { tool: "rounded", label: "Add a rounded rectangle", icon: <SquareRoundCorner /> },
  { tool: "ellipse", label: "Add an ellipse (O)", icon: <Circle /> },
  { tool: "draw", label: "Draw freehand (D)", icon: <PenLine /> },
];

const ALIGN: { value: TextAlign; label: string; icon: ReactNode }[] = [
  { value: "left", label: "Align text left", icon: <AlignLeft /> },
  { value: "center", label: "Center text", icon: <AlignCenter /> },
  { value: "right", label: "Align text right", icon: <AlignRight /> },
];

const VALIGN: { value: VerticalAlign; label: string; icon: ReactNode }[] = [
  { value: "top", label: "Align text to the top", icon: <AlignVerticalJustifyStart /> },
  { value: "middle", label: "Center text vertically", icon: <AlignVerticalJustifyCenter /> },
  { value: "bottom", label: "Align text to the bottom", icon: <AlignVerticalJustifyEnd /> },
];

const ORDER: { to: StackOrder; label: string; icon: ReactNode }[] = [
  { to: "front", label: "Bring to front", icon: <BringToFront /> },
  { to: "forward", label: "Bring forward", icon: <ArrowUp /> },
  { to: "backward", label: "Send backward", icon: <ArrowDown /> },
  { to: "back", label: "Send to back", icon: <SendToBack /> },
];

/**
 * The tools above the slide in edit mode: add text, shapes and freehand drawings, restyle the
 * selection (text color and size, bold, italic, alignment, fill, border), move it up or down
 * the stack, or delete it. With nothing selected, the styles are those of what the current
 * tool adds.
 */
export function EditToolbar(props: {
  tool: EditTool;
  selection: EditSelection | null;
  styles: Record<ToolFamily, EditStyle>;
  onTool: (tool: EditTool) => void;
  onStyle: (changes: EditStyle) => void;
  onOrder: (to: StackOrder) => void;
  onDelete: () => void;
}) {
  const state = toolbarState(props.selection, props.tool, props.styles);
  const style = state?.style ?? {};
  const textOff = !state?.text;
  const fontSize = style.fontSize ?? 48;

  return (
    <div role="toolbar" aria-label="Edit tools" className="flex flex-wrap items-center justify-center gap-0.5 rounded-lg border bg-card px-1 py-0.5 shadow-sm">
      {TOOLS.map((t) => (
        <ToolButton key={t.tool} label={t.label} active={props.tool === t.tool} onClick={() => props.onTool(t.tool)}>
          {t.icon}
        </ToolButton>
      ))}
      <Divider />
      <ColorButton label="Text color" icon={<Baseline />} value={style.color ?? null} disabled={textOff} onChange={(color) => props.onStyle({ color })} />
      <ToolButton label="Smaller text" disabled={textOff} onClick={() => props.onStyle({ fontSize: stepFontSize(fontSize, -1) })}>
        <Minus />
      </ToolButton>
      <span aria-label="Font size" className={cn("w-7 text-center text-xs tabular-nums", textOff && "opacity-30")}>
        {state?.text ? fontSize : "–"}
      </span>
      <ToolButton label="Larger text" disabled={textOff} onClick={() => props.onStyle({ fontSize: stepFontSize(fontSize, 1) })}>
        <Plus />
      </ToolButton>
      <ToolButton label="Bold" active={!textOff && !!style.bold} disabled={textOff} onClick={() => props.onStyle({ bold: !style.bold })}>
        <Bold />
      </ToolButton>
      <ToolButton label="Italic" active={!textOff && !!style.italic} disabled={textOff} onClick={() => props.onStyle({ italic: !style.italic })}>
        <Italic />
      </ToolButton>
      <Divider />
      {ALIGN.map((a) => (
        <ToolButton key={a.value} label={a.label} active={!textOff && style.align === a.value} disabled={textOff} onClick={() => props.onStyle({ align: a.value })}>
          {a.icon}
        </ToolButton>
      ))}
      {VALIGN.map((a) => (
        <ToolButton
          key={a.value}
          label={a.label}
          active={!textOff && !!state?.valign && style.valign === a.value}
          disabled={textOff || !state?.valign}
          onClick={() => props.onStyle({ valign: a.value })}
        >
          {a.icon}
        </ToolButton>
      ))}
      <Divider />
      <ColorButton label="Fill" icon={<PaintBucket />} value={style.fill ?? null} disabled={!state} none onChange={(fill) => props.onStyle({ fill })} />
      <ColorButton
        label={state?.vector ? "Line color" : "Border color"}
        icon={<SquareDashed />}
        value={style.stroke ?? null}
        disabled={!state}
        none
        onChange={(stroke) => props.onStyle({ stroke })}
      />
      <select
        aria-label={state?.vector ? "Line width" : "Border width"}
        title={state?.vector ? "Line width" : "Border width"}
        disabled={!state}
        value={String(style.strokeWidth ?? 0)}
        onChange={(event) => props.onStyle({ strokeWidth: Number(event.target.value) })}
        className="h-6 rounded-md bg-transparent px-1 text-xs hover:bg-accent disabled:opacity-30"
      >
        {[...new Set([...BORDER_WIDTHS, style.strokeWidth ?? 0])]
          .sort((a, b) => a - b)
          .map((w) => (
            <option key={w} value={w}>
              {w === 0 ? "No border" : `${w}px`}
            </option>
          ))}
      </select>
      <Divider />
      {ORDER.map((o) => (
        <ToolButton key={o.to} label={o.label} disabled={!props.selection} onClick={() => props.onOrder(o.to)}>
          {o.icon}
        </ToolButton>
      ))}
      <ToolButton label="Delete (⌫)" disabled={!props.selection} onClick={props.onDelete}>
        <Trash2 />
      </ToolButton>
    </div>
  );
}

function Divider() {
  return <div className="mx-1 h-4 w-px bg-border" />;
}

function ToolButton(props: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.active}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        "rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-4",
        props.active && "bg-accent text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}

/** A color well: preset swatches, a custom color, and with `none`, no color at all. */
function ColorButton(props: {
  label: string;
  icon: ReactNode;
  value: string | null;
  disabled?: boolean;
  none?: boolean;
  onChange: (color: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const custom = useRef<HTMLInputElement>(null);
  const onChange = useRef(props.onChange);
  onChange.current = props.onChange;

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  // The system color picker reports every color the user passes over; only the one they settle on counts.
  useEffect(() => {
    const input = custom.current;
    if (!input) return;
    const pick = () => onChange.current(input.value);
    input.addEventListener("change", pick);
    return () => input.removeEventListener("change", pick);
  }, [open]);

  if (props.disabled && open) setOpen(false);
  const pick = (color: string | null) => {
    props.onChange(color);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={props.label}
        title={props.label}
        aria-expanded={open}
        disabled={props.disabled}
        onClick={() => setOpen(!open)}
        className="flex flex-col items-center rounded-md px-1 pt-0.5 pb-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-3.5"
      >
        {props.icon}
        <span
          data-testid={`${props.label} swatch`}
          className="mt-0.5 h-1 w-4 rounded-sm border border-black/15 dark:border-white/30"
          style={{ background: props.value ?? "transparent" }}
        />
      </button>
      {open && (
        <div role="dialog" aria-label={props.label} className="absolute top-full left-1/2 z-30 mt-1 -translate-x-1/2 rounded-md border bg-card p-2 shadow-md">
          <div className="grid w-max grid-cols-6 gap-1">
            {props.none && (
              <button
                type="button"
                aria-label="None"
                title="None"
                aria-pressed={props.value === null}
                onClick={() => pick(null)}
                className={cn("flex size-5 items-center justify-center rounded-full border text-muted-foreground [&_svg]:size-3.5", props.value === null && "ring-2 ring-foreground/60 ring-offset-1 ring-offset-card")}
              >
                <Ban />
              </button>
            )}
            {EDIT_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={color}
                title={color}
                aria-pressed={props.value === color}
                onClick={() => pick(color)}
                className={cn(
                  "size-5 rounded-full border border-black/15 dark:border-white/30",
                  props.value === color && "ring-2 ring-foreground/60 ring-offset-1 ring-offset-card",
                )}
                style={{ background: color }}
              />
            ))}
          </div>
          <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <input ref={custom} type="color" aria-label={`Custom ${props.label.toLowerCase()}`} defaultValue={props.value ?? "#000000"} className="h-5 w-8 cursor-pointer rounded border-0 bg-transparent p-0" />
            Custom
          </label>
        </div>
      )}
    </div>
  );
}
