import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  ArrowBigRight,
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Baseline,
  Bold,
  Braces,
  Brackets,
  BringToFront,
  ChartColumn,
  ChevronRight,
  Circle,
  CopyPlus,
  CornerDownRight,
  Cross,
  Cylinder,
  Diamond,
  FileText,
  Heart,
  Hexagon,
  ImagePlus,
  Italic,
  Link,
  List,
  ListOrdered,
  MessageSquare,
  Minus,
  MousePointer2,
  Move,
  MoveUpRight,
  Octagon,
  PaintBucket,
  PenLine,
  Pentagon,
  Plus,
  Presentation,
  RemoveFormatting,
  SendToBack,
  Shapes,
  Slash,
  Smile,
  Space,
  Spline,
  Square,
  SquareDashed,
  SquareRoundCorner,
  Star,
  Strikethrough,
  Subscript,
  Superscript,
  Table,
  Trash2,
  Triangle,
  Type,
  Underline,
  Wallpaper,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useDropdown } from "../hooks/useDropdown";
import type { ArrangeMessage, EditGeometry, EditLayer } from "../lib/arrange";
import {
  type AgentInsert,
  AUTOFIT_LABELS,
  type Autofit,
  type DeckColor,
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
  strokeWidths,
  type TextAlign,
  type ToolFamily,
  toolbarState,
  type VerticalAlign,
} from "../lib/editTools";
import { cn } from "../lib/utils";
import { AlignControls, GroupControls, LayersPanel, PositionControls, SnapToggle } from "./ArrangeControls";
import { ToolButton } from "./Button";
import { ColorButton } from "./ColorButton";
import { useEditPanelAsk } from "./editPanelAsk";
import { DraftInput } from "./Field";
import { DashSelect, LineButton, Parallelogram, Trapezoid } from "./LineTools";
import { LookTools } from "./LookTools";
import { DropdownPanel, dropdownPanel } from "./Popover";
import { RibbonRow, RibbonSection, RibbonSelect, useRibbonFit } from "./Ribbon";
import { TimelineTools } from "./TimelineTools";

/** A tool of the Insert section: `title` adds how it is used to its name, `shortcut` is its key. */
interface ToolChoice {
  tool: EditTool;
  label: string;
  title?: string;
  shortcut?: string;
  icon: ReactNode;
}

const SNAPS_45 = "Shift snaps to 45°";

const TOOLS: ToolChoice[] = [
  { tool: "select", label: "Select and move", shortcut: "v", icon: <MousePointer2 /> },
  { tool: "text", label: "Add text", shortcut: "t", icon: <Type /> },
  { tool: "rect", label: "Add a rectangle", shortcut: "r", icon: <Square /> },
  { tool: "rounded", label: "Add a rounded rectangle", icon: <SquareRoundCorner /> },
  { tool: "ellipse", label: "Add an ellipse", shortcut: "o", icon: <Circle /> },
  { tool: "triangle", label: "Add a triangle", icon: <Triangle /> },
  { tool: "star", label: "Add a star", icon: <Star /> },
  { tool: "bubble", label: "Add a speech bubble", icon: <MessageSquare /> },
  { tool: "draw", label: "Draw freehand", shortcut: "d", icon: <PenLine /> },
  { tool: "line", label: "Add a line", title: `Add a line, ${SNAPS_45}`, shortcut: "l", icon: <Slash /> },
  { tool: "arrow", label: "Add an arrow", title: `Add an arrow, ${SNAPS_45}`, shortcut: "a", icon: <MoveUpRight /> },
];
/** How many of `TOOLS` go in the Insert section's first row. */
const FIRST_ROW_TOOLS = 7;

/** Shapes for diagrams, in the Insert section's "More shapes" picker, under the heading each belongs to. */
const MORE_SHAPES: { heading: string; shapes: ToolChoice[] }[] = [
  {
    heading: "Flowchart",
    shapes: [
      { tool: "diamond", label: "Add a diamond (a decision in a flowchart)", icon: <Diamond /> },
      { tool: "parallelogram", label: "Add a parallelogram (input or output)", icon: <Parallelogram /> },
      { tool: "hexagon", label: "Add a hexagon (a preparation step)", icon: <Hexagon /> },
      { tool: "cylinder", label: "Add a cylinder (a database)", icon: <Cylinder /> },
      { tool: "document", label: "Add a document", icon: <FileText /> },
      { tool: "trapezoid", label: "Add a trapezoid", icon: <Trapezoid /> },
    ],
  },
  {
    heading: "Arrows",
    shapes: [
      { tool: "chevron", label: "Add a chevron (a step in a process)", icon: <ChevronRight /> },
      { tool: "block-arrow", label: "Add a block arrow", icon: <ArrowBigRight /> },
      { tool: "double-arrow", label: "Add a double-headed arrow", icon: <ArrowLeftRight /> },
    ],
  },
  {
    heading: "Shapes",
    shapes: [
      { tool: "pentagon", label: "Add a pentagon", icon: <Pentagon /> },
      { tool: "octagon", label: "Add an octagon", icon: <Octagon /> },
      { tool: "plus", label: "Add a plus", icon: <Cross /> },
      { tool: "heart", label: "Add a heart", icon: <Heart /> },
    ],
  },
  {
    heading: "Brackets",
    shapes: [
      { tool: "bracket", label: "Add a bracket", icon: <Brackets /> },
      { tool: "brace", label: "Add a brace", icon: <Braces /> },
    ],
  },
  {
    heading: "Connectors",
    shapes: [
      {
        tool: "elbow",
        label: "Add an elbow connector (turns at right angles between the elements its ends stick to)",
        icon: <CornerDownRight />,
      },
      {
        tool: "curve",
        label: "Add a curved connector (curves between the elements its ends stick to)",
        icon: <Spline />,
      },
    ],
  },
];

/** What the agent adds, as the Insert section offers it: the request starts in the chat. */
const AGENT_INSERTS: { kind: AgentInsert; label: string; title: string; icon: ReactNode }[] = [
  {
    kind: "table",
    label: "Table…",
    title: "Ask the agent for a table: starts the request in the chat",
    icon: <Table />,
  },
  {
    kind: "chart",
    label: "Chart…",
    title: "Ask the agent for a chart: starts the request in the chat",
    icon: <ChartColumn />,
  },
  { kind: "icon", label: "Icon…", title: "Ask the agent for an icon: starts the request in the chat", icon: <Smile /> },
];

const ALIGN: { value: TextAlign; label: string; shortcut: string; icon: ReactNode }[] = [
  { value: "left", label: "Align text left", shortcut: "mod+shift+l", icon: <AlignLeft /> },
  { value: "center", label: "Center text", shortcut: "mod+shift+e", icon: <AlignCenter /> },
  { value: "right", label: "Align text right", shortcut: "mod+shift+r", icon: <AlignRight /> },
  { value: "justify", label: "Justify text", shortcut: "mod+shift+j", icon: <AlignJustify /> },
];

const VALIGN: { value: VerticalAlign; label: string; icon: ReactNode }[] = [
  { value: "top", label: "Align text to the top", icon: <AlignVerticalJustifyStart /> },
  { value: "middle", label: "Center text vertically", icon: <AlignVerticalJustifyCenter /> },
  { value: "bottom", label: "Align text to the bottom", icon: <AlignVerticalJustifyEnd /> },
];

const ORDER: { to: StackOrder; label: string; shortcut: string; icon: ReactNode }[] = [
  { to: "front", label: "Bring to front", shortcut: "mod+shift+]", icon: <BringToFront /> },
  { to: "forward", label: "Bring forward", shortcut: "mod+]", icon: <ArrowUp /> },
  { to: "backward", label: "Send backward", shortcut: "mod+[", icon: <ArrowDown /> },
  { to: "back", label: "Send to back", shortcut: "mod+shift+[", icon: <SendToBack /> },
];

/** The text's on-or-off looks, each a button of its own. */
const TEXT_MARKS: {
  mark: "bold" | "italic" | "underline" | "strike";
  label: string;
  shortcut?: string;
  icon: ReactNode;
}[] = [
  { mark: "bold", label: "Bold", shortcut: "mod+b", icon: <Bold /> },
  { mark: "italic", label: "Italic", shortcut: "mod+i", icon: <Italic /> },
  { mark: "underline", label: "Underline", shortcut: "mod+u", icon: <Underline /> },
  { mark: "strike", label: "Strikethrough", icon: <Strikethrough /> },
];

const SCRIPTS: { value: "sup" | "sub"; label: string; icon: ReactNode }[] = [
  { value: "sup", label: "Superscript", icon: <Superscript /> },
  { value: "sub", label: "Subscript", icon: <Subscript /> },
];

const LISTS: { value: ListKind; label: string; title: string; icon: ReactNode }[] = [
  { value: "ul", label: "Bulleted list", title: "Bulleted list (Tab indents, Shift+Tab outdents)", icon: <List /> },
  {
    value: "ol",
    label: "Numbered list",
    title: "Numbered list (Tab indents, Shift+Tab outdents)",
    icon: <ListOrdered />,
  },
];

/** Why a control is disabled, by what it works on. */
const NEEDS_TEXT = "Select text or a text box";
const NEEDS_ELEMENT = "Select an element";

/** A slide a link can go to. */
export interface LinkTarget {
  id: string;
  label: string;
}

/**
 * Edit mode's tools, in a ribbon above the slide, whose sections collapse to an icon as it
 * narrows: add text, images, shapes, lines and freehand drawings, or start a request to the agent
 * for a table, chart or icon; restyle the selection (font, size, color, bold, italic, underline,
 * strikethrough, superscript / subscript, lists, links, spacing, alignment, how text fits, fill,
 * border, opacity, shadow, corner radius, image fit), clear its formatting, paint one element's
 * look onto another; set the slide's background; line the selection up, space it out, move it up
 * or down the stack, group, lock, duplicate or delete it, and set its exact place and size.
 * While typing, the text styles go to the selected text. With nothing selected, the styles are
 * those of what the current tool adds. A control that waits for a selection says so in its tooltip.
 *
 * Its buttons keep focus in the slide, so the text being edited keeps its selection; after a
 * typed value or a pick from a list `onReturnFocus` gives focus back to the slide.
 */
export function EditToolbar(props: {
  sizeMode: "resize" | "stretch";
  onSizeMode: (mode: "resize" | "stretch") => void;
  /** Resizes keep the aspect ratio. */
  keepRatio?: boolean;
  onKeepRatio?: (on: boolean) => void;
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
  /** Starts a request to the agent for something the tools do not draw. */
  onInsertAsk?: (kind: AgentInsert) => void;
  onReturnFocus?: () => void;
  onOrder: (to: StackOrder) => void;
  onDelete: () => void;
  /** Where the selection is, for the arrange controls. */
  geometry?: EditGeometry | null;
  /** What is on the slide, the top-most first, for the Layers panel. */
  layers?: EditLayer[];
  onArrange?: (message: ArrangeMessage) => void;
}) {
  const state = toolbarState(props.selection, props.tool, props.styles);
  const style = state?.style ?? {};
  const textOff = !state?.text;
  const fontSize = style.fontSize ?? 48;
  const selection = props.selection;
  const returnFocus = () => props.onReturnFocus?.();
  const ribbon = useRibbonFit();
  const { collapsedFrom } = ribbon;
  const vector = !!state?.vector;
  const strokeOff = !state || !!selection?.clipped;
  const strokeReason = selection?.clipped ? "A cut-out shape takes no border" : NEEDS_ELEMENT;
  const strokeWidth = style.strokeWidth ?? 0;
  const toolButton = (t: ToolChoice) => (
    <ToolButton
      keepFocus
      key={t.tool}
      label={t.label}
      title={t.title}
      shortcut={t.shortcut}
      active={props.tool === t.tool}
      onClick={() => props.onTool(t.tool)}
    >
      {t.icon}
    </ToolButton>
  );

  return (
    <div
      ref={ribbon.ref}
      role="toolbar"
      aria-label="Edit tools"
      data-edit-toolbar=""
      className="flex min-w-0 flex-[1_1_200px]"
    >
      <RibbonSection title="Insert" icon={<Shapes />} collapsed={collapsedFrom <= 0} closeOn={props.tool}>
        <RibbonRow>
          {TOOLS.slice(0, FIRST_ROW_TOOLS).map(toolButton)}
          <MoreShapes tool={props.tool} onTool={props.onTool} />
        </RibbonRow>
        <RibbonRow>
          {TOOLS.slice(FIRST_ROW_TOOLS).map(toolButton)}
          <ToolButton keepFocus label="Add an image from a file" onClick={() => props.onPickImage?.(false)}>
            <ImagePlus />
          </ToolButton>
          {AGENT_INSERTS.map((insert) => (
            <ToolButton
              keepFocus
              key={insert.kind}
              label={insert.label}
              title={insert.title}
              onClick={() => props.onInsertAsk?.(insert.kind)}
            >
              {insert.icon}
            </ToolButton>
          ))}
        </RibbonRow>
      </RibbonSection>
      <RibbonSection title="Text" icon={<Type />} collapsed={collapsedFrom <= 1} closeOn={props.tool}>
        <RibbonRow>
          <FontPicker
            value={style.fontFamily ?? null}
            fonts={props.fonts ?? []}
            disabled={textOff}
            onChange={(fontFamily) => props.onStyle({ fontFamily })}
            onDone={returnFocus}
          />
          <ToolButton
            keepFocus
            label="Smaller text"
            shortcut="mod+shift+,"
            disabled={textOff}
            disabledReason={NEEDS_TEXT}
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
            keepFocus
            label="Larger text"
            shortcut="mod+shift+."
            disabled={textOff}
            disabledReason={NEEDS_TEXT}
            onClick={() => props.onStyle({ fontSize: stepFontSize(fontSize, 1) })}
          >
            <Plus />
          </ToolButton>
        </RibbonRow>
        <RibbonRow>
          {TEXT_MARKS.map((m) => (
            <ToolButton
              keepFocus
              key={m.mark}
              label={m.label}
              shortcut={m.shortcut}
              active={!textOff && !!style[m.mark]}
              disabled={textOff}
              disabledReason={NEEDS_TEXT}
              onClick={() => props.onStyle({ [m.mark]: !style[m.mark] })}
            >
              {m.icon}
            </ToolButton>
          ))}
          {SCRIPTS.map((s) => (
            <ToolButton
              keepFocus
              key={s.value}
              label={s.label}
              active={!textOff && !!selection && selection.script === s.value}
              disabled={textOff || !selection}
              disabledReason={NEEDS_TEXT}
              onClick={() => props.onStyle({ script: selection?.script === s.value ? null : s.value })}
            >
              {s.icon}
            </ToolButton>
          ))}
          <ColorButton
            label="Text color"
            icon={<Baseline />}
            value={style.color ?? null}
            other={!!selection?.colorOther}
            disabled={textOff}
            disabledReason={NEEDS_TEXT}
            deck={props.colors}
            onChange={(color) => props.onStyle({ color })}
            onDone={returnFocus}
          />
          <LinkButton
            value={selection?.link ?? null}
            disabled={!selection}
            slides={props.slides ?? []}
            onChange={(href) => props.onLink?.(href)}
            onDone={returnFocus}
          />
          <ToolButton
            keepFocus
            label="Clear formatting"
            title="Clear formatting: take bold, colors, sizes and other formatting off the text, keeping its links"
            disabled={textOff || !selection}
            disabledReason={NEEDS_TEXT}
            onClick={() => props.onArrange?.({ type: "slop:edit-clear-formatting" })}
          >
            <RemoveFormatting />
          </ToolButton>
        </RibbonRow>
      </RibbonSection>
      <RibbonSection title="Paragraph" icon={<AlignLeft />} collapsed={collapsedFrom <= 2} closeOn={props.tool}>
        <RibbonRow>
          {ALIGN.map((a) => (
            <ToolButton
              keepFocus
              key={a.value}
              label={a.label}
              shortcut={a.shortcut}
              active={!textOff && style.align === a.value}
              disabled={textOff}
              disabledReason={NEEDS_TEXT}
              onClick={() => props.onStyle({ align: a.value })}
            >
              {a.icon}
            </ToolButton>
          ))}
          {LISTS.map((l) => (
            <ToolButton
              keepFocus
              key={l.value}
              label={l.label}
              title={l.title}
              active={!textOff && !!selection && selection.list === l.value}
              disabled={textOff || !selection}
              disabledReason={NEEDS_TEXT}
              onClick={() => props.onList?.(l.value)}
            >
              {l.icon}
            </ToolButton>
          ))}
          <SpacingButton
            lineHeight={style.lineHeight ?? null}
            letterSpacing={style.letterSpacing ?? 0}
            disabled={textOff}
            onChange={props.onStyle}
            onDone={returnFocus}
          />
        </RibbonRow>
        <RibbonRow>
          {VALIGN.map((a) => (
            <ToolButton
              keepFocus
              key={a.value}
              label={a.label}
              active={!textOff && !!state?.valign && style.valign === a.value}
              disabled={textOff || !state?.valign}
              disabledReason={textOff ? NEEDS_TEXT : "This element's text cannot align vertically"}
              onClick={() => props.onStyle({ valign: a.value })}
            >
              {a.icon}
            </ToolButton>
          ))}
          <RibbonSelect
            label="When text does not fit"
            title="When text does not fit its box: leave it (the overflow is marked), shrink the text, or grow the box"
            disabled={textOff || !selection}
            disabledReason={NEEDS_TEXT}
            value={selection?.autofit ?? ""}
            onPick={(autofit) => props.onStyle({ autofit: (autofit || null) as Autofit | null })}
            onDone={returnFocus}
            className="w-full min-w-0 flex-1 enabled:hover:bg-accent"
          >
            {AUTOFIT_LABELS.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </RibbonSelect>
        </RibbonRow>
      </RibbonSection>
      <RibbonSection title="Style" icon={<PaintBucket />} collapsed={collapsedFrom <= 3} closeOn={props.tool}>
        <RibbonRow>
          <ColorButton
            label="Fill"
            icon={<PaintBucket />}
            value={style.fill ?? null}
            other={!!selection?.fillOther}
            disabled={!state}
            disabledReason={NEEDS_ELEMENT}
            none
            deck={props.colors}
            onChange={(fill) => props.onStyle({ fill })}
            onDone={returnFocus}
          />
          <ColorButton
            label={vector ? "Line color" : "Border color"}
            icon={<SquareDashed />}
            value={style.stroke ?? null}
            other={!!selection?.strokeOther}
            disabled={strokeOff}
            disabledReason={strokeReason}
            none
            deck={props.colors}
            onChange={(stroke) => props.onStyle({ stroke })}
            onDone={returnFocus}
          />
          <RibbonSelect
            label={vector ? "Line width" : "Border width"}
            disabled={strokeOff}
            disabledReason={strokeReason}
            value={String(strokeWidth)}
            onPick={(width) => props.onStyle({ strokeWidth: Number(width) })}
            onDone={returnFocus}
            className="w-24 enabled:hover:bg-accent"
          >
            {strokeWidths(strokeWidth, vector).map((w) => (
              <option key={w} value={w}>
                {w === 0 ? "No border" : `${w}px`}
              </option>
            ))}
          </RibbonSelect>
          <DashSelect
            value={style.dash ?? "solid"}
            vector={vector}
            disabled={strokeOff}
            disabledReason={strokeReason}
            onChange={props.onStyle}
            onDone={returnFocus}
          />
        </RibbonRow>
        <RibbonRow>
          <LookTools
            tool={props.tool}
            selection={selection}
            onTool={props.onTool}
            onStyle={props.onStyle}
            onArrange={props.onArrange}
            onPickImage={props.onPickImage}
            onReturnFocus={returnFocus}
          />
          <LineButton selection={selection} onChange={props.onStyle} onDone={returnFocus} />
        </RibbonRow>
      </RibbonSection>
      <RibbonSection title="Slide" icon={<Presentation />} collapsed={collapsedFrom <= 4} closeOn={props.tool}>
        <RibbonRow>
          <ColorButton
            label="Slide background"
            icon={<Wallpaper />}
            value={props.background ?? null}
            none
            deck={props.colors}
            panel="background"
            onChange={(color) => props.onBackground?.(color)}
            onDone={returnFocus}
          />
        </RibbonRow>
      </RibbonSection>
      <RibbonSection title="Arrange" icon={<Move />} collapsed={collapsedFrom <= 5} closeOn={props.tool}>
        <RibbonRow>
          <AlignControls geometry={props.geometry ?? null} onArrange={props.onArrange} />
          <PositionControls
            geometry={props.geometry ?? null}
            selection={selection}
            onArrange={props.onArrange}
            onDone={returnFocus}
            sizeMode={props.sizeMode}
            onSizeMode={props.onSizeMode}
            keepRatio={props.keepRatio}
            onKeepRatio={props.onKeepRatio}
          />
        </RibbonRow>
        <RibbonRow>
          {ORDER.map((o) => (
            <ToolButton
              keepFocus
              key={o.to}
              label={o.label}
              shortcut={o.shortcut}
              disabled={!props.selection}
              disabledReason={NEEDS_ELEMENT}
              onClick={() => props.onOrder(o.to)}
            >
              {o.icon}
            </ToolButton>
          ))}
          <GroupControls geometry={props.geometry ?? null} selection={selection} onArrange={props.onArrange} />
          <LayersPanel layers={props.layers ?? []} onArrange={props.onArrange} />
          <SnapToggle />
          <ToolButton
            keepFocus
            label="Duplicate"
            shortcut="mod+d"
            disabled={!props.selection}
            disabledReason={NEEDS_ELEMENT}
            onClick={() => props.onArrange?.({ type: "slop:edit-duplicate" })}
          >
            <CopyPlus />
          </ToolButton>
          <ToolButton
            keepFocus
            destructive
            label="Delete"
            shortcut="backspace"
            disabled={!props.selection}
            disabledReason={NEEDS_ELEMENT}
            onClick={props.onDelete}
          >
            <Trash2 />
          </ToolButton>
        </RibbonRow>
      </RibbonSection>
      <TimelineTools collapsed={collapsedFrom <= 6} />
    </div>
  );
}

/** The "More shapes" picker: diagram shapes under their headings, which go back to Select once one is added. */
function MoreShapes(props: { tool: EditTool; onTool: (tool: EditTool) => void }) {
  const { open, setOpen, ref, toggle } = useDropdown();
  const current = MORE_SHAPES.flatMap((group) => group.shapes).find((s) => s.tool === props.tool);
  return (
    <div ref={ref} className="relative">
      <ToolButton
        keepFocus
        label="More shapes"
        title={current ? `More shapes: ${current.label.replace(/^Add an? /, "")}` : "More shapes"}
        aria-expanded={open}
        active={!!current || open}
        onClick={toggle}
      >
        {current?.icon ?? <Shapes />}
      </ToolButton>
      {open && (
        <DropdownPanel role="dialog" aria-label="More shapes" className="flex w-max flex-col gap-1 p-1.5">
          {MORE_SHAPES.map((group) => (
            <fieldset key={group.heading} aria-label={group.heading} className="flex flex-col gap-0.5">
              <span className="text-[10px] leading-3 text-muted-foreground">{group.heading}</span>
              <div className="flex gap-0.5">
                {group.shapes.map((s) => (
                  <ToolButton
                    keepFocus
                    key={s.tool}
                    label={s.label}
                    active={props.tool === s.tool}
                    onClick={() => {
                      props.onTool(s.tool);
                      setOpen(false);
                    }}
                  >
                    {s.icon}
                  </ToolButton>
                ))}
              </div>
            </fieldset>
          ))}
        </DropdownPanel>
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
  onDone: () => void;
}) {
  const choices = fontChoices(props.fonts);
  const name = firstFamily(props.value).toLowerCase();
  const all = [...choices.deck, ...choices.system];
  const match = name ? all.find((f) => f.name.toLowerCase() === name) : undefined;
  // A font the list does not have (set in the deck's styles) still shows as the current one.
  const current = name && !match ? firstFamily(props.value) : null;
  return (
    <RibbonSelect
      label="Font"
      disabled={props.disabled}
      disabledReason={NEEDS_TEXT}
      value={match ? match.stack : current ? "__current" : ""}
      onPick={(value) => {
        if (value !== "__current") props.onChange(value || null);
      }}
      onDone={props.onDone}
      className="w-28 truncate enabled:hover:bg-accent"
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
    </RibbonSelect>
  );
}

/** The font size as a number to type; it applies on Enter or when the field loses focus, and ↑ / ↓ step it. */
function FontSizeInput(props: { value: number | null; onChange: (size: number) => void; onDone: () => void }) {
  return (
    <DraftInput
      aria-label="Font size"
      title={props.value === null ? NEEDS_TEXT : "Font size (type a size and press Enter, or step it with ↑ and ↓)"}
      disabled={props.value === null}
      value={props.value}
      parse={parseFontSize}
      sanitize={(text) => text.replace(/[^\d.]/g, "")}
      onChange={props.onChange}
      onDone={props.onDone}
      className="h-6 w-9 rounded-md border bg-transparent px-1 text-center text-xs tabular-nums disabled:opacity-40"
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
  const { open, setOpen, ref } = useDropdown({ disabled: props.disabled });
  const slideNow = linkedSlide(props.value);
  const [address, setAddress] = useState("");
  const [slide, setSlide] = useState("");
  const [invalid, setInvalid] = useState(false);

  /** Opens the popover on the link as it is now. */
  const show = () => {
    setAddress(props.value && !slideNow ? props.value : "");
    setSlide(slideNow ?? "");
    setInvalid(false);
    setOpen(true);
  };
  const toggle = () => {
    if (open) setOpen(false);
    else show();
  };
  // ⌘K opens it, from the slide or the app.
  useEditPanelAsk("link", () => {
    if (!props.disabled) show();
  });
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
      <ToolButton
        keepFocus
        label="Link"
        shortcut="mod+k"
        title={props.value ? `Link: ${props.value}` : "Add a link"}
        active={!!props.value}
        aria-expanded={open}
        disabled={props.disabled}
        disabledReason={NEEDS_ELEMENT}
        onClick={toggle}
      >
        <Link />
      </ToolButton>
      {open && (
        <form
          role="dialog"
          aria-label="Link"
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
          className={cn(dropdownPanel, "flex w-64 flex-col gap-2 text-xs")}
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
  onDone: () => void;
}) {
  const { open, ref, toggle } = useDropdown({ disabled: props.disabled });
  const heights = [...new Set<number>([...LINE_HEIGHTS, ...(props.lineHeight ? [props.lineHeight] : [])])].sort(
    (a, b) => a - b,
  );
  const spacings = [...new Set<number>([...LETTER_SPACINGS, props.letterSpacing])].sort((a, b) => a - b);
  return (
    <div ref={ref} className="relative">
      <ToolButton
        keepFocus
        label="Spacing"
        title="Line height and letter spacing"
        aria-expanded={open}
        disabled={props.disabled}
        disabledReason={NEEDS_TEXT}
        onClick={toggle}
      >
        <Space />
      </ToolButton>
      {open && (
        <DropdownPanel
          role="dialog"
          aria-label="Spacing"
          className="grid w-max grid-cols-[auto_auto] items-center gap-x-2 gap-y-1.5 text-xs"
        >
          <label htmlFor="edit-line-height" className="text-muted-foreground">
            Line height
          </label>
          <RibbonSelect
            id="edit-line-height"
            value={props.lineHeight === null ? "" : String(props.lineHeight)}
            onPick={(height) => props.onChange({ lineHeight: height ? Number(height) : null })}
            onDone={props.onDone}
            className="border"
          >
            <option value="">Default</option>
            {heights.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </RibbonSelect>
          <label htmlFor="edit-letter-spacing" className="text-muted-foreground">
            Letter spacing
          </label>
          <RibbonSelect
            id="edit-letter-spacing"
            value={String(props.letterSpacing)}
            onPick={(spacing) => props.onChange({ letterSpacing: Number(spacing) })}
            onDone={props.onDone}
            className="border"
          >
            {spacings.map((v) => (
              <option key={v} value={v}>
                {v === 0 ? "Normal" : `${v}px`}
              </option>
            ))}
          </RibbonSelect>
        </DropdownPanel>
      )}
    </div>
  );
}
