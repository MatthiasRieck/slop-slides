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
import { memo, type ReactNode, useId, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@/components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ArrangeMessage } from "../lib/arrange";
import {
  type AgentInsert,
  AUTOFIT_LABELS,
  type Autofit,
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
import { useApp } from "../store";
import { AlignControls, GroupControls, LayersPanel, PositionControls, SnapToggle } from "./ArrangeControls";
import { ColorButton } from "./ColorButton";
import { DraftInput } from "./DraftInput";
import { useEditPanelAsk } from "./editPanelAsk";
import { DashSelect, LineButton, Parallelogram, Trapezoid } from "./LineTools";
import { LookTools } from "./LookTools";
import { RibbonRow, RibbonSection, RibbonSelect, useRibbonFit } from "./Ribbon";
import { type SizeMode, useEditorState, useSlideReport } from "./stage/editorState";
import { TimelineTools } from "./TimelineTools";
import { SLIDE_TOOL, unlessOff } from "./toolProps";

/** A control's name beside it in a ribbon popover. */
const LABEL = "text-xs font-normal text-muted-foreground";

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

/** What every section of the ribbon is told: whether it is collapsed to its icon, and the tool in hand. */
interface SectionProps {
  collapsed: boolean;
  tool: EditTool;
}

/** What the sections that restyle are told on top: the looks of what the tools add, and how to restyle. */
interface StyleSectionProps extends SectionProps {
  styles: Record<ToolFamily, EditStyle>;
  onStyle: (changes: EditStyle) => void;
  onReturnFocus?: () => void;
}

/**
 * What a section's controls show and which of them are enabled: the selection the editor reports
 * (see `toolbarState`), read here so that only the sections showing it render when it changes.
 */
function useToolbarState(tool: EditTool, styles: Record<ToolFamily, EditStyle>) {
  const selection = useSlideReport((report) => report.selection);
  const state = toolbarState(selection, tool, styles);
  return { selection, state, style: state?.style ?? {}, textOff: !state?.text };
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
 *
 * What the slide editor reports (the selection, where it is, the layers, the deck's fonts and
 * colors) is not handed in: each control reads what it shows from `useEditorState`. The ribbon
 * and its sections render only when what they are given changes, so a report from the editor,
 * which comes with every keystroke and every frame of a drag, renders the controls showing it
 * and no more. Its callbacks should so stay the same from one render of its parent to the next.
 */
export const EditToolbar = memo(function EditToolbar(props: {
  onSizeMode: (mode: SizeMode) => void;
  onKeepRatio?: (on: boolean) => void;
  tool: EditTool;
  styles: Record<ToolFamily, EditStyle>;
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
  onArrange?: (message: ArrangeMessage) => void;
}) {
  const ribbon = useRibbonFit();
  const { collapsedFrom } = ribbon;
  const { tool, styles, onStyle, onReturnFocus } = props;
  const restyling = { tool, styles, onStyle, onReturnFocus };

  return (
    <div
      ref={ribbon.ref}
      role="toolbar"
      aria-label="Edit tools"
      data-edit-toolbar=""
      className="flex min-w-0 flex-[1_1_200px]"
    >
      <InsertSection
        collapsed={collapsedFrom <= 0}
        tool={tool}
        onTool={props.onTool}
        onPickImage={props.onPickImage}
        onInsertAsk={props.onInsertAsk}
      />
      <TextSection collapsed={collapsedFrom <= 1} {...restyling} onLink={props.onLink} onArrange={props.onArrange} />
      <ParagraphSection collapsed={collapsedFrom <= 2} {...restyling} onList={props.onList} />
      <StyleSection
        collapsed={collapsedFrom <= 3}
        {...restyling}
        onTool={props.onTool}
        onArrange={props.onArrange}
        onPickImage={props.onPickImage}
      />
      <SlideSection
        collapsed={collapsedFrom <= 4}
        tool={tool}
        onBackground={props.onBackground}
        onReturnFocus={onReturnFocus}
      />
      <ArrangeSection
        collapsed={collapsedFrom <= 5}
        tool={tool}
        onArrange={props.onArrange}
        onOrder={props.onOrder}
        onDelete={props.onDelete}
        onReturnFocus={onReturnFocus}
        onSizeMode={props.onSizeMode}
        onKeepRatio={props.onKeepRatio}
      />
      <TimelineTools collapsed={collapsedFrom <= 6} />
    </div>
  );
});

/** The tools that add to the slide, and the requests to the agent for what they do not draw. */
const InsertSection = memo(function InsertSection(
  props: SectionProps & {
    onTool: (tool: EditTool) => void;
    onPickImage?: (replace: boolean) => void;
    onInsertAsk?: (kind: AgentInsert) => void;
  },
) {
  const toolButton = (t: ToolChoice) => (
    <Button
      key={t.tool}
      {...SLIDE_TOOL}
      aria-label={t.label}
      tooltip={t.title ?? t.label}
      shortcut={t.shortcut}
      aria-pressed={props.tool === t.tool}
      onClick={() => props.onTool(t.tool)}
    >
      {t.icon}
    </Button>
  );
  return (
    <RibbonSection title="Insert" icon={<Shapes />} collapsed={props.collapsed} closeOn={props.tool}>
      <RibbonRow>
        {TOOLS.slice(0, FIRST_ROW_TOOLS).map(toolButton)}
        <MoreShapes tool={props.tool} onTool={props.onTool} />
      </RibbonRow>
      <RibbonRow>
        {TOOLS.slice(FIRST_ROW_TOOLS).map(toolButton)}
        <Button {...SLIDE_TOOL} tooltip="Add an image from a file" onClick={() => props.onPickImage?.(false)}>
          <ImagePlus />
        </Button>
        {AGENT_INSERTS.map((insert) => (
          <Button
            key={insert.kind}
            {...SLIDE_TOOL}
            aria-label={insert.label}
            tooltip={insert.title}
            onClick={() => props.onInsertAsk?.(insert.kind)}
          >
            {insert.icon}
          </Button>
        ))}
      </RibbonRow>
    </RibbonSection>
  );
});

/** The text's font, size, marks, color and link. */
const TextSection = memo(function TextSection(
  props: StyleSectionProps & {
    onLink?: (href: string | null) => void;
    onArrange?: (message: ArrangeMessage) => void;
  },
) {
  const { selection, state, style, textOff } = useToolbarState(props.tool, props.styles);
  const fonts = useEditorState((s) => s.fonts);
  const colors = useEditorState((s) => s.colors);
  const fontSize = style.fontSize ?? 48;
  const returnFocus = () => props.onReturnFocus?.();
  return (
    <RibbonSection title="Text" icon={<Type />} collapsed={props.collapsed} closeOn={props.tool}>
      <RibbonRow>
        <FontPicker
          value={style.fontFamily ?? null}
          fonts={fonts}
          disabled={textOff}
          onChange={(fontFamily) => props.onStyle({ fontFamily })}
          onDone={returnFocus}
        />
        <Button
          {...SLIDE_TOOL}
          aria-label="Smaller text"
          {...unlessOff(textOff, NEEDS_TEXT, "Smaller text", "mod+shift+,")}
          onClick={() => props.onStyle({ fontSize: stepFontSize(fontSize, -1) })}
        >
          <Minus />
        </Button>
        <FontSizeInput
          value={state?.text ? fontSize : null}
          onChange={(size) => props.onStyle({ fontSize: size })}
          onDone={returnFocus}
        />
        <Button
          {...SLIDE_TOOL}
          aria-label="Larger text"
          {...unlessOff(textOff, NEEDS_TEXT, "Larger text", "mod+shift+.")}
          onClick={() => props.onStyle({ fontSize: stepFontSize(fontSize, 1) })}
        >
          <Plus />
        </Button>
      </RibbonRow>
      <RibbonRow>
        {TEXT_MARKS.map((m) => (
          <Button
            key={m.mark}
            {...SLIDE_TOOL}
            aria-label={m.label}
            aria-pressed={!textOff && !!style[m.mark]}
            {...unlessOff(textOff, NEEDS_TEXT, m.label, m.shortcut)}
            onClick={() => props.onStyle({ [m.mark]: !style[m.mark] })}
          >
            {m.icon}
          </Button>
        ))}
        {SCRIPTS.map((s) => (
          <Button
            key={s.value}
            {...SLIDE_TOOL}
            aria-label={s.label}
            aria-pressed={!textOff && !!selection && selection.script === s.value}
            {...unlessOff(textOff || !selection, NEEDS_TEXT, s.label)}
            onClick={() => props.onStyle({ script: selection?.script === s.value ? null : s.value })}
          >
            {s.icon}
          </Button>
        ))}
        <ColorButton
          label="Text color"
          icon={<Baseline />}
          value={style.color ?? null}
          other={!!selection?.colorOther}
          disabled={textOff}
          disabledReason={NEEDS_TEXT}
          deck={colors}
          onChange={(color) => props.onStyle({ color })}
          onDone={returnFocus}
        />
        <LinkButton
          value={selection?.link ?? null}
          disabled={!selection}
          onChange={(href) => props.onLink?.(href)}
          onDone={returnFocus}
        />
        <Button
          {...SLIDE_TOOL}
          aria-label="Clear formatting"
          {...unlessOff(
            textOff || !selection,
            NEEDS_TEXT,
            "Clear formatting: take bold, colors, sizes and other formatting off the text, keeping its links",
          )}
          onClick={() => props.onArrange?.({ type: "slop:edit-clear-formatting" })}
        >
          <RemoveFormatting />
        </Button>
      </RibbonRow>
    </RibbonSection>
  );
});

/** How the text is aligned, listed and spaced, and what it does when it does not fit. */
const ParagraphSection = memo(function ParagraphSection(
  props: StyleSectionProps & { onList?: (list: ListKind) => void },
) {
  const { selection, state, style, textOff } = useToolbarState(props.tool, props.styles);
  const returnFocus = () => props.onReturnFocus?.();
  return (
    <RibbonSection title="Paragraph" icon={<AlignLeft />} collapsed={props.collapsed} closeOn={props.tool}>
      <RibbonRow>
        {ALIGN.map((a) => (
          <Button
            key={a.value}
            {...SLIDE_TOOL}
            aria-label={a.label}
            aria-pressed={!textOff && style.align === a.value}
            {...unlessOff(textOff, NEEDS_TEXT, a.label, a.shortcut)}
            onClick={() => props.onStyle({ align: a.value })}
          >
            {a.icon}
          </Button>
        ))}
        {LISTS.map((l) => (
          <Button
            key={l.value}
            {...SLIDE_TOOL}
            aria-label={l.label}
            aria-pressed={!textOff && !!selection && selection.list === l.value}
            {...unlessOff(textOff || !selection, NEEDS_TEXT, l.title)}
            onClick={() => props.onList?.(l.value)}
          >
            {l.icon}
          </Button>
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
          <Button
            key={a.value}
            {...SLIDE_TOOL}
            aria-label={a.label}
            aria-pressed={!textOff && !!state?.valign && style.valign === a.value}
            {...unlessOff(
              textOff || !state?.valign,
              textOff ? NEEDS_TEXT : "This element's text cannot align vertically",
              a.label,
            )}
            onClick={() => props.onStyle({ valign: a.value })}
          >
            {a.icon}
          </Button>
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
            <NativeSelectOption key={choice.value} value={choice.value}>
              {choice.label}
            </NativeSelectOption>
          ))}
        </RibbonSelect>
      </RibbonRow>
    </RibbonSection>
  );
});

/** The selection's fill, border or line, and the rest of its look. */
const StyleSection = memo(function StyleSection(
  props: StyleSectionProps & {
    onTool: (tool: EditTool) => void;
    onArrange?: (message: ArrangeMessage) => void;
    onPickImage?: (replace: boolean) => void;
  },
) {
  const { selection, state, style } = useToolbarState(props.tool, props.styles);
  const colors = useEditorState((s) => s.colors);
  const returnFocus = () => props.onReturnFocus?.();
  const vector = !!state?.vector;
  const strokeOff = !state || !!selection?.clipped;
  const strokeReason = selection?.clipped ? "A cut-out shape takes no border" : NEEDS_ELEMENT;
  const strokeWidth = style.strokeWidth ?? 0;
  return (
    <RibbonSection title="Style" icon={<PaintBucket />} collapsed={props.collapsed} closeOn={props.tool}>
      <RibbonRow>
        <ColorButton
          label="Fill"
          icon={<PaintBucket />}
          value={style.fill ?? null}
          other={!!selection?.fillOther}
          disabled={!state}
          disabledReason={NEEDS_ELEMENT}
          none
          deck={colors}
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
          deck={colors}
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
            <NativeSelectOption key={w} value={w}>
              {w === 0 ? "No border" : `${w}px`}
            </NativeSelectOption>
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
  );
});

/** What is the slide's own, whatever is selected: its background. */
const SlideSection = memo(function SlideSection(
  props: SectionProps & { onBackground?: (color: string | null) => void; onReturnFocus?: () => void },
) {
  const background = useEditorState((s) => s.background);
  const colors = useEditorState((s) => s.colors);
  return (
    <RibbonSection title="Slide" icon={<Presentation />} collapsed={props.collapsed} closeOn={props.tool}>
      <RibbonRow>
        <ColorButton
          label="Slide background"
          icon={<Wallpaper />}
          value={background}
          none
          deck={colors}
          panel="background"
          onChange={(color) => props.onBackground?.(color)}
          onDone={() => props.onReturnFocus?.()}
        />
      </RibbonRow>
    </RibbonSection>
  );
});

/**
 * Where the selection is and how it lies among the rest. The section itself only knows whether
 * anything is selected; the controls that show where (see ArrangeControls.tsx) follow the
 * selection as it is dragged by themselves.
 */
const ArrangeSection = memo(function ArrangeSection(
  props: SectionProps & {
    onArrange?: (message: ArrangeMessage) => void;
    onOrder: (to: StackOrder) => void;
    onDelete: () => void;
    onReturnFocus?: () => void;
    onSizeMode: (mode: SizeMode) => void;
    onKeepRatio?: (on: boolean) => void;
  },
) {
  const nothing = useSlideReport((report) => report.selection === null);
  const { onArrange, onReturnFocus } = props;
  return (
    <RibbonSection title="Arrange" icon={<Move />} collapsed={props.collapsed} closeOn={props.tool}>
      <RibbonRow>
        <AlignControls onArrange={onArrange} />
        <PositionControls
          onArrange={onArrange}
          onDone={onReturnFocus}
          onSizeMode={props.onSizeMode}
          onKeepRatio={props.onKeepRatio}
        />
      </RibbonRow>
      <RibbonRow>
        {ORDER.map((o) => (
          <Button
            key={o.to}
            {...SLIDE_TOOL}
            aria-label={o.label}
            {...unlessOff(nothing, NEEDS_ELEMENT, o.label, o.shortcut)}
            onClick={() => props.onOrder(o.to)}
          >
            {o.icon}
          </Button>
        ))}
        <GroupControls onArrange={onArrange} />
        <LayersPanel onArrange={onArrange} />
        <SnapToggle />
        <Button
          {...SLIDE_TOOL}
          aria-label="Duplicate"
          {...unlessOff(nothing, NEEDS_ELEMENT, "Duplicate", "mod+d")}
          onClick={() => onArrange?.({ type: "slop:edit-duplicate" })}
        >
          <CopyPlus />
        </Button>
        <Button
          {...SLIDE_TOOL}
          aria-label="Delete"
          {...unlessOff(nothing, NEEDS_ELEMENT, "Delete", "backspace")}
          onClick={props.onDelete}
          className="hover:text-destructive aria-disabled:hover:text-muted-foreground"
        >
          <Trash2 />
        </Button>
      </RibbonRow>
    </RibbonSection>
  );
});

/** The "More shapes" picker: diagram shapes under their headings, which go back to Select once one is added. */
function MoreShapes(props: { tool: EditTool; onTool: (tool: EditTool) => void }) {
  const [open, setOpen] = useState(false);
  const current = MORE_SHAPES.flatMap((group) => group.shapes).find((s) => s.tool === props.tool);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            {...SLIDE_TOOL}
            aria-label="More shapes"
            tooltip={current ? `More shapes: ${current.label.replace(/^Add an? /, "")}` : "More shapes"}
            aria-pressed={!!current}
          />
        }
      >
        {current?.icon ?? <Shapes />}
      </PopoverTrigger>
      <PopoverContent aria-label="More shapes" initialFocus={false} finalFocus={false} className="w-max gap-1 p-1.5">
        {MORE_SHAPES.map((group) => (
          <FieldSet key={group.heading} className="gap-0.5">
            <FieldLegend
              variant="label"
              className="mb-0 leading-3 font-normal text-muted-foreground data-[variant=label]:text-[10px]"
            >
              {group.heading}
            </FieldLegend>
            <div className="flex gap-0.5">
              {group.shapes.map((s) => (
                <Button
                  key={s.tool}
                  {...SLIDE_TOOL}
                  tooltip={s.label}
                  aria-pressed={props.tool === s.tool}
                  onClick={() => {
                    props.onTool(s.tool);
                    setOpen(false);
                  }}
                >
                  {s.icon}
                </Button>
              ))}
            </div>
          </FieldSet>
        ))}
      </PopoverContent>
    </Popover>
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
      <NativeSelectOption value="">Default font</NativeSelectOption>
      {current && <NativeSelectOption value="__current">{current}</NativeSelectOption>}
      {choices.deck.length > 0 && (
        <NativeSelectOptGroup label="Deck fonts">
          {choices.deck.map((f) => (
            <NativeSelectOption key={f.name} value={f.stack}>
              {f.name}
            </NativeSelectOption>
          ))}
        </NativeSelectOptGroup>
      )}
      <NativeSelectOptGroup label="System fonts">
        {choices.system.map((f) => (
          <NativeSelectOption key={f.name} value={f.stack}>
            {f.name}
          </NativeSelectOption>
        ))}
      </NativeSelectOptGroup>
    </RibbonSelect>
  );
}

/** The font size as a number to type; it applies on Enter or when the field loses focus, and ↑ / ↓ step it. */
function FontSizeInput(props: { value: number | null; onChange: (size: number) => void; onDone: () => void }) {
  return (
    <DraftInput
      aria-label="Font size"
      tooltip={props.value === null ? NEEDS_TEXT : "Font size (type a size and press Enter, or step it with ↑ and ↓)"}
      disabled={props.value === null}
      value={props.value}
      parse={parseFontSize}
      sanitize={(text) => text.replace(/[^\d.]/g, "")}
      onChange={props.onChange}
      onDone={props.onDone}
      className="w-9 text-center"
    />
  );
}

/** Adds, changes or removes the selection's link: to a web or mail address, or another slide. */
function LinkButton(props: {
  value: string | null;
  disabled: boolean;
  onChange: (href: string | null) => void;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Nothing to link: it closes, and stays closed when a selection comes back.
  if (props.disabled && open) setOpen(false);
  const field = useRef<HTMLInputElement>(null);
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
    <Popover open={open} onOpenChange={(next) => (next ? show() : setOpen(false))}>
      <PopoverTrigger
        render={
          <Button
            {...SLIDE_TOOL}
            aria-label="Link"
            aria-pressed={!!props.value}
            {...unlessOff(props.disabled, NEEDS_ELEMENT, props.value ? `Link: ${props.value}` : "Add a link", "mod+k")}
          />
        }
      >
        <Link />
      </PopoverTrigger>
      {/* The address is typed, so the focus goes to its field; done, it goes back to the slide (`onDone`). */}
      <PopoverContent aria-label="Link" initialFocus={field} finalFocus={false} className="w-64 p-2 text-xs">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
          className="flex flex-col gap-2"
        >
          <Input
            ref={field}
            size="sm"
            aria-label="Link address"
            placeholder="https://… or someone@example.com"
            value={address}
            aria-invalid={invalid || undefined}
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
          />
          <LinkTargets
            value={slide}
            onChange={(id) => {
              setSlide(id);
              setInvalid(false);
            }}
          />
          {invalid && <p className="text-destructive">Enter a web address, an email address, or pick a slide.</p>}
          <div className="flex justify-end gap-1">
            {props.value && (
              <Button variant="ghost" size="xs" onClick={() => finish(null)}>
                Remove link
              </Button>
            )}
            <Button type="submit" size="xs">
              {props.value ? "Update" : "Add link"}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The deck's slides, to pick the one a link goes to. It is part of the open Link popover: only
 * then is the list made, and kept up with the deck.
 */
function LinkTargets(props: { value: string; onChange: (slide: string) => void }) {
  const slides = useApp((s) => s.deck?.slides);
  const targets = useMemo(() => (slides ?? []).map((s, i) => ({ id: s.id, label: `${i + 1}. ${s.id}` })), [slides]);
  if (targets.length === 0) return null;
  return (
    <NativeSelect
      size="sm"
      aria-label="Link to slide"
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      className="w-full"
    >
      <NativeSelectOption value="">Or link to a slide…</NativeSelectOption>
      {targets.map((target) => (
        <NativeSelectOption key={target.id} value={target.id}>
          {target.label}
        </NativeSelectOption>
      ))}
    </NativeSelect>
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
  const id = useId();
  const [open, setOpen] = useState(false);
  // No text to space: it closes, and stays closed when text is selected again.
  if (props.disabled && open) setOpen(false);
  const heights = [...new Set<number>([...LINE_HEIGHTS, ...(props.lineHeight ? [props.lineHeight] : [])])].sort(
    (a, b) => a - b,
  );
  const spacings = [...new Set<number>([...LETTER_SPACINGS, props.letterSpacing])].sort((a, b) => a - b);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            {...SLIDE_TOOL}
            aria-label="Spacing"
            {...unlessOff(props.disabled, NEEDS_TEXT, "Line height and letter spacing")}
          />
        }
      >
        <Space />
      </PopoverTrigger>
      <PopoverContent
        aria-label="Spacing"
        initialFocus={false}
        finalFocus={false}
        className="grid w-max grid-cols-[auto_auto] items-center gap-x-2 gap-y-1.5 p-2 text-xs"
      >
        <Label htmlFor={`${id}-line-height`} className={LABEL}>
          Line height
        </Label>
        <RibbonSelect
          id={`${id}-line-height`}
          value={props.lineHeight === null ? "" : String(props.lineHeight)}
          onPick={(height) => props.onChange({ lineHeight: height ? Number(height) : null })}
          onDone={props.onDone}
          className="border"
        >
          <NativeSelectOption value="">Default</NativeSelectOption>
          {heights.map((h) => (
            <NativeSelectOption key={h} value={h}>
              {h}
            </NativeSelectOption>
          ))}
        </RibbonSelect>
        <Label htmlFor={`${id}-letter-spacing`} className={LABEL}>
          Letter spacing
        </Label>
        <RibbonSelect
          id={`${id}-letter-spacing`}
          value={String(props.letterSpacing)}
          onPick={(spacing) => props.onChange({ letterSpacing: Number(spacing) })}
          onDone={props.onDone}
          className="border"
        >
          {spacings.map((v) => (
            <NativeSelectOption key={v} value={v}>
              {v === 0 ? "Normal" : `${v}px`}
            </NativeSelectOption>
          ))}
        </RibbonSelect>
      </PopoverContent>
    </Popover>
  );
}
