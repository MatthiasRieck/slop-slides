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
  Link,
  List,
  ListOrdered,
  MessageSquare,
  Minus,
  MousePointer2,
  MoveUpRight,
  PaintBucket,
  PenLine,
  Plus,
  SendToBack,
  Slash,
  Space,
  Square,
  SquareDashed,
  SquareRoundCorner,
  Star,
  Strikethrough,
  Subscript,
  Superscript,
  Trash2,
  Triangle,
  Type,
  Underline,
  Wallpaper,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { ArrangeMessage, EditGeometry } from "../lib/arrange";
import {
  type Autofit,
  BORDER_WIDTHS,
  type DeckColor,
  EDIT_COLORS,
  type EditSelection,
  type EditStyle,
  type EditTool,
  type FontChoice,
  firstFamily,
  fontChoices,
  LETTER_SPACINGS,
  LINE_HEIGHTS,
  type ListKind,
  linkedSlide,
  normalizeHref,
  parseFontSize,
  type StackOrder,
  stepFontSize,
  type TextAlign,
  type ToolFamily,
  toolbarState,
  type VerticalAlign,
} from "../lib/editTools";
import { cn } from "../lib/utils";
import { ArrangeControls } from "./ArrangeControls";
import { keepFocus, ToolButton, useOutsideClose } from "./EditControls";
import { LookTools } from "./LookTools";

const TOOLS: { tool: EditTool; label: string; icon: ReactNode }[] = [
  { tool: "select", label: "Select and move (V)", icon: <MousePointer2 /> },
  { tool: "text", label: "Add text (T)", icon: <Type /> },
  { tool: "rect", label: "Add a rectangle (R)", icon: <Square /> },
  { tool: "rounded", label: "Add a rounded rectangle", icon: <SquareRoundCorner /> },
  { tool: "ellipse", label: "Add an ellipse (O)", icon: <Circle /> },
  { tool: "triangle", label: "Add a triangle", icon: <Triangle /> },
  { tool: "star", label: "Add a star", icon: <Star /> },
  { tool: "bubble", label: "Add a speech bubble", icon: <MessageSquare /> },
  { tool: "draw", label: "Draw freehand (D)", icon: <PenLine /> },
  { tool: "line", label: "Add a line (L, Shift snaps to 45°)", icon: <Slash /> },
  { tool: "arrow", label: "Add an arrow (A, Shift snaps to 45°)", icon: <MoveUpRight /> },
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

const SCRIPTS: { value: "sup" | "sub"; label: string; icon: ReactNode }[] = [
  { value: "sup", label: "Superscript", icon: <Superscript /> },
  { value: "sub", label: "Subscript", icon: <Subscript /> },
];

const LISTS: { value: ListKind; label: string; icon: ReactNode }[] = [
  { value: "ul", label: "Bulleted list (Tab indents, Shift+Tab outdents)", icon: <List /> },
  { value: "ol", label: "Numbered list (Tab indents, Shift+Tab outdents)", icon: <ListOrdered /> },
];

/** A slide a link can go to. */
export interface LinkTarget {
  id: string;
  label: string;
}

/**
 * Edit mode's tools, in the row above the slide: add text, images, shapes, lines and freehand drawings, restyle the
 * selection (font, size, color, bold, italic, underline, strikethrough, superscript /
 * subscript, lists, links, spacing, alignment, how text fits, fill, border, opacity, shadow,
 * corner radius, image fit and flips), paint one element's look onto another, set the slide's
 * background, move the selection up or down the stack, or delete it. While typing, the text styles go to the selected text. With
 * nothing selected, the styles are those of what the current tool adds.
 *
 * Its buttons keep focus in the slide, so the text being edited keeps its selection; after a
 * typed value (a font size, a link) `onReturnFocus` gives focus back to the slide.
 */
export function EditToolbar(props: {
  sizeMode: "resize" | "stretch";
  onSizeMode: (mode: "resize" | "stretch") => void;
  tool: EditTool;
  selection: EditSelection | null;
  styles: Record<ToolFamily, EditStyle>;
  /** The fonts the deck's styles use. */
  fonts?: FontChoice[];
  /** The colors in the deck's CSS variables. */
  colors?: DeckColor[];
  /** The current slide's background color. */
  background?: string | null;
  /** The deck's slides, for links between them. */
  slides?: LinkTarget[];
  onTool: (tool: EditTool) => void;
  onStyle: (changes: EditStyle) => void;
  onList?: (list: ListKind) => void;
  onLink?: (href: string | null) => void;
  onBackground?: (color: string | null) => void;
  /** Picks image files: to add to the slide, or to put in the selected image. */
  onPickImage?: (replace: boolean) => void;
  onReturnFocus?: () => void;
  onOrder: (to: StackOrder) => void;
  onDelete: () => void;
  /** Where the selection is, for the arrange controls. */
  geometry?: EditGeometry | null;
  onArrange?: (message: ArrangeMessage) => void;
}) {
  const state = toolbarState(props.selection, props.tool, props.styles);
  const style = state?.style ?? {};
  const textOff = !state?.text;
  const fontSize = style.fontSize ?? 48;
  const selection = props.selection;
  const returnFocus = () => props.onReturnFocus?.();

  return (
    <div
      role="toolbar"
      aria-label="Edit tools"
      data-edit-toolbar=""
      className="flex min-w-0 flex-[1_1_600px] flex-wrap items-center gap-0.5"
    >
      {TOOLS.map((t) => (
        <ToolButton key={t.tool} label={t.label} active={props.tool === t.tool} onClick={() => props.onTool(t.tool)}>
          {t.icon}
        </ToolButton>
      ))}
      <Divider />
      <select
        aria-label="Size mode"
        title="Resize changes the box; Stretch scales its contents"
        value={props.sizeMode}
        onChange={(event) => props.onSizeMode(event.target.value as "resize" | "stretch")}
        className="rounded border bg-card px-1 py-1 text-xs"
      >
        <option value="resize">Resize</option>
        <option value="stretch">Stretch</option>
      </select>
      <Divider />
      <FontPicker
        value={style.fontFamily ?? null}
        fonts={props.fonts ?? []}
        disabled={textOff}
        onChange={(fontFamily) => props.onStyle({ fontFamily })}
      />
      <ColorButton
        label="Text color"
        icon={<Baseline />}
        value={style.color ?? null}
        disabled={textOff}
        deck={props.colors}
        onChange={(color) => props.onStyle({ color })}
      />
      <ToolButton
        label="Smaller text"
        disabled={textOff}
        onClick={() => props.onStyle({ fontSize: stepFontSize(fontSize, -1) })}
      >
        <Minus />
      </ToolButton>
      <FontSizeInput
        value={state?.text ? fontSize : null}
        onChange={(size) => props.onStyle({ fontSize: size })}
        onDone={returnFocus}
      />
      <ToolButton
        label="Larger text"
        disabled={textOff}
        onClick={() => props.onStyle({ fontSize: stepFontSize(fontSize, 1) })}
      >
        <Plus />
      </ToolButton>
      <ToolButton
        label="Bold (⌘B)"
        active={!textOff && !!style.bold}
        disabled={textOff}
        onClick={() => props.onStyle({ bold: !style.bold })}
      >
        <Bold />
      </ToolButton>
      <ToolButton
        label="Italic (⌘I)"
        active={!textOff && !!style.italic}
        disabled={textOff}
        onClick={() => props.onStyle({ italic: !style.italic })}
      >
        <Italic />
      </ToolButton>
      <ToolButton
        label="Underline (⌘U)"
        active={!textOff && !!style.underline}
        disabled={textOff}
        onClick={() => props.onStyle({ underline: !style.underline })}
      >
        <Underline />
      </ToolButton>
      <ToolButton
        label="Strikethrough"
        active={!textOff && !!style.strike}
        disabled={textOff}
        onClick={() => props.onStyle({ strike: !style.strike })}
      >
        <Strikethrough />
      </ToolButton>
      {SCRIPTS.map((s) => (
        <ToolButton
          key={s.value}
          label={s.label}
          active={!textOff && !!selection && selection.script === s.value}
          disabled={textOff || !selection}
          onClick={() => props.onStyle({ script: selection?.script === s.value ? null : s.value })}
        >
          {s.icon}
        </ToolButton>
      ))}
      <Divider />
      {LISTS.map((l) => (
        <ToolButton
          key={l.value}
          label={l.label}
          active={!textOff && !!selection && selection.list === l.value}
          disabled={textOff || !selection}
          onClick={() => props.onList?.(l.value)}
        >
          {l.icon}
        </ToolButton>
      ))}
      <LinkButton
        value={selection?.link ?? null}
        disabled={!selection}
        slides={props.slides ?? []}
        onChange={(href) => props.onLink?.(href)}
        onDone={returnFocus}
      />
      <SpacingButton
        lineHeight={style.lineHeight ?? null}
        letterSpacing={style.letterSpacing ?? 0}
        disabled={textOff}
        onChange={props.onStyle}
      />
      <select
        aria-label="When text does not fit"
        title="When text does not fit its box: only show the overflow, shrink the text, or grow the box"
        disabled={textOff || !selection}
        value={selection?.autofit ?? ""}
        onChange={(event) => props.onStyle({ autofit: (event.target.value || null) as Autofit | null })}
        className="h-6 rounded-md bg-transparent px-1 text-xs hover:bg-accent disabled:opacity-30"
      >
        <option value="">Report overflow</option>
        <option value="shrink">Shrink text</option>
        <option value="grow">Grow box</option>
      </select>
      <Divider />
      {ALIGN.map((a) => (
        <ToolButton
          key={a.value}
          label={a.label}
          active={!textOff && style.align === a.value}
          disabled={textOff}
          onClick={() => props.onStyle({ align: a.value })}
        >
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
      <ColorButton
        label="Fill"
        icon={<PaintBucket />}
        value={style.fill ?? null}
        disabled={!state}
        none
        deck={props.colors}
        onChange={(fill) => props.onStyle({ fill })}
      />
      <ColorButton
        label={state?.vector ? "Line color" : "Border color"}
        icon={<SquareDashed />}
        value={style.stroke ?? null}
        disabled={!state || !!selection?.clipped}
        none
        deck={props.colors}
        onChange={(stroke) => props.onStyle({ stroke })}
      />
      <select
        aria-label={state?.vector ? "Line width" : "Border width"}
        title={state?.vector ? "Line width" : "Border width"}
        disabled={!state || !!selection?.clipped}
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
      <ArrangeControls geometry={props.geometry ?? null} onArrange={props.onArrange} onDone={returnFocus} />
      <Divider />
      <LookTools
        tool={props.tool}
        selection={selection}
        onTool={props.onTool}
        onStyle={props.onStyle}
        onPickImage={props.onPickImage}
        onReturnFocus={returnFocus}
      />
      <ColorButton
        label="Slide background"
        icon={<Wallpaper />}
        value={props.background ?? null}
        none
        deck={props.colors}
        onChange={(color) => props.onBackground?.(color)}
      />
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

/** A color well: the deck's colors, preset swatches, a custom color, and with `none`, no color at all. */
function ColorButton(props: {
  label: string;
  icon: ReactNode;
  value: string | null;
  disabled?: boolean;
  none?: boolean;
  deck?: DeckColor[];
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: the input mounts and unmounts with the popover
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
        onMouseDown={keepFocus}
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
        <div
          role="dialog"
          aria-label={props.label}
          className="absolute top-full left-1/2 z-30 mt-1 -translate-x-1/2 rounded-md border bg-card p-2 shadow-md"
        >
          {!!props.deck?.length && (
            <fieldset aria-label="Deck colors" className="mb-2 grid w-max grid-cols-6 gap-1 border-b pb-2">
              {props.deck.map((color) => (
                <button
                  key={color.name}
                  type="button"
                  aria-label={`Deck color ${color.name}`}
                  title={color.name}
                  aria-pressed={props.value === color.value}
                  onMouseDown={keepFocus}
                  onClick={() => pick(color.value)}
                  className={cn(
                    "size-5 rounded-full border border-black/15 dark:border-white/30",
                    props.value === color.value && "ring-2 ring-foreground/60 ring-offset-1 ring-offset-card",
                  )}
                  style={{ background: color.value }}
                />
              ))}
            </fieldset>
          )}
          <div className="grid w-max grid-cols-6 gap-1">
            {props.none && (
              <button
                type="button"
                aria-label="None"
                title="None"
                aria-pressed={props.value === null}
                onMouseDown={keepFocus}
                onClick={() => pick(null)}
                className={cn(
                  "flex size-5 items-center justify-center rounded-full border text-muted-foreground [&_svg]:size-3.5",
                  props.value === null && "ring-2 ring-foreground/60 ring-offset-1 ring-offset-card",
                )}
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
                onMouseDown={keepFocus}
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
            <input
              ref={custom}
              type="color"
              aria-label={`Custom ${props.label.toLowerCase()}`}
              defaultValue={props.value ?? "#000000"}
              className="h-5 w-8 cursor-pointer rounded border-0 bg-transparent p-0"
            />
            Custom
          </label>
        </div>
      )}
    </div>
  );
}

/** The font list: the deck's own fonts, then system fonts; "Default" leaves it to the deck. */
function FontPicker(props: {
  value: string | null;
  fonts: FontChoice[];
  disabled: boolean;
  onChange: (stack: string | null) => void;
}) {
  const choices = fontChoices(props.fonts);
  const name = firstFamily(props.value).toLowerCase();
  const all = [...choices.deck, ...choices.system];
  const match = name ? all.find((f) => f.name.toLowerCase() === name) : undefined;
  // A font the list does not have (set in the deck's styles) still shows as the current one.
  const current = name && !match ? firstFamily(props.value) : null;
  return (
    <select
      aria-label="Font"
      title="Font"
      disabled={props.disabled}
      value={match ? match.stack : current ? "__current" : ""}
      onChange={(event) => {
        const value = event.target.value;
        if (value !== "__current") props.onChange(value || null);
      }}
      className="h-6 w-28 truncate rounded-md bg-transparent px-1 text-xs hover:bg-accent disabled:opacity-30"
    >
      <option value="">Default font</option>
      {current && <option value="__current">{current}</option>}
      {choices.deck.length > 0 && (
        <optgroup label="Deck fonts">
          {choices.deck.map((f) => (
            <option key={f.name} value={f.stack}>
              {f.name}
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label="System fonts">
        {choices.system.map((f) => (
          <option key={f.name} value={f.stack}>
            {f.name}
          </option>
        ))}
      </optgroup>
    </select>
  );
}

/** The font size as a number to type; it applies on Enter or when the field loses focus. */
function FontSizeInput(props: { value: number | null; onChange: (size: number) => void; onDone: () => void }) {
  const [draft, setDraft] = useState(props.value === null ? "" : String(props.value));
  useEffect(() => setDraft(props.value === null ? "" : String(props.value)), [props.value]);
  const apply = () => {
    const size = parseFontSize(draft);
    if (size === null || size === props.value) {
      setDraft(props.value === null ? "" : String(props.value));
      return false;
    }
    props.onChange(size);
    return true;
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label="Font size"
      title="Font size (type a size and press Enter)"
      disabled={props.value === null}
      placeholder="–"
      value={draft}
      onChange={(event) => setDraft(event.target.value.replace(/[^\d.]/g, ""))}
      onBlur={apply}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          apply();
          props.onDone();
        } else if (event.key === "Escape") {
          event.preventDefault();
          setDraft(props.value === null ? "" : String(props.value));
          props.onDone();
        }
      }}
      className="h-6 w-9 rounded-md border bg-transparent px-1 text-center text-xs tabular-nums disabled:opacity-30"
    />
  );
}

/** Adds, changes or removes the selection's link: to a web or mail address, or another slide. */
function LinkButton(props: {
  value: string | null;
  disabled: boolean;
  slides: LinkTarget[];
  onChange: (href: string | null) => void;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const slideNow = linkedSlide(props.value);
  const [address, setAddress] = useState("");
  const [slide, setSlide] = useState("");
  const [invalid, setInvalid] = useState(false);
  useOutsideClose(open, ref, () => setOpen(false));
  if (props.disabled && open) setOpen(false);

  const toggle = () => {
    if (!open) {
      setAddress(props.value && !slideNow ? props.value : "");
      setSlide(slideNow ?? "");
      setInvalid(false);
    }
    setOpen(!open);
  };
  const finish = (href: string | null) => {
    props.onChange(href);
    setOpen(false);
    props.onDone();
  };
  const apply = () => {
    const href = slide ? `#${slide}` : normalizeHref(address);
    if (!href) {
      setInvalid(true);
      return;
    }
    finish(href);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Link"
        title={props.value ? `Link: ${props.value}` : "Add a link"}
        aria-pressed={!!props.value}
        aria-expanded={open}
        disabled={props.disabled}
        onMouseDown={keepFocus}
        onClick={toggle}
        className={cn(
          "rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-4",
          props.value && "bg-accent text-foreground",
        )}
      >
        <Link />
      </button>
      {open && (
        <form
          role="dialog"
          aria-label="Link"
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
          className="absolute top-full left-1/2 z-30 mt-1 flex w-64 -translate-x-1/2 flex-col gap-2 rounded-md border bg-card p-2 text-xs shadow-md"
        >
          <input
            autoFocus
            aria-label="Link address"
            placeholder="https://… or someone@example.com"
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              setSlide("");
              setInvalid(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setOpen(false);
                props.onDone();
              }
            }}
            className={cn("h-7 rounded border bg-transparent px-2", invalid && "border-destructive")}
          />
          {props.slides.length > 0 && (
            <select
              aria-label="Link to slide"
              value={slide}
              onChange={(event) => {
                setSlide(event.target.value);
                setInvalid(false);
              }}
              className="h-7 rounded border bg-transparent px-1"
            >
              <option value="">Or link to a slide…</option>
              {props.slides.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          )}
          {invalid && <p className="text-destructive">Enter a web address, an email address, or pick a slide.</p>}
          <div className="flex justify-end gap-1">
            {props.value && (
              <button type="button" onClick={() => finish(null)} className="rounded-md px-2 py-1 hover:bg-accent">
                Remove link
              </button>
            )}
            <button type="submit" className="rounded-md bg-primary px-2 py-1 font-medium text-primary-foreground">
              {props.value ? "Update" : "Add link"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Line height and letter spacing. */
function SpacingButton(props: {
  lineHeight: number | null;
  letterSpacing: number;
  disabled: boolean;
  onChange: (changes: EditStyle) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose(open, ref, () => setOpen(false));
  if (props.disabled && open) setOpen(false);
  const heights = [...new Set<number>([...LINE_HEIGHTS, ...(props.lineHeight ? [props.lineHeight] : [])])].sort(
    (a, b) => a - b,
  );
  const spacings = [...new Set<number>([...LETTER_SPACINGS, props.letterSpacing])].sort((a, b) => a - b);
  const select = "h-6 rounded border bg-transparent px-1";
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Spacing"
        title="Line height and letter spacing"
        aria-expanded={open}
        disabled={props.disabled}
        onMouseDown={keepFocus}
        onClick={() => setOpen(!open)}
        className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-4"
      >
        <Space />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Spacing"
          className="absolute top-full left-1/2 z-30 mt-1 grid w-max -translate-x-1/2 grid-cols-[auto_auto] items-center gap-x-2 gap-y-1.5 rounded-md border bg-card p-2 text-xs shadow-md"
        >
          <label htmlFor="edit-line-height" className="text-muted-foreground">
            Line height
          </label>
          <select
            id="edit-line-height"
            value={props.lineHeight === null ? "" : String(props.lineHeight)}
            onChange={(event) => props.onChange({ lineHeight: event.target.value ? Number(event.target.value) : null })}
            className={select}
          >
            <option value="">Default</option>
            {heights.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
          <label htmlFor="edit-letter-spacing" className="text-muted-foreground">
            Letter spacing
          </label>
          <select
            id="edit-letter-spacing"
            value={String(props.letterSpacing)}
            onChange={(event) => props.onChange({ letterSpacing: Number(event.target.value) })}
            className={select}
          >
            {spacings.map((v) => (
              <option key={v} value={v}>
                {v === 0 ? "Normal" : `${v}px`}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
