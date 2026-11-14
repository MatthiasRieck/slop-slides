import {
  ArrowBigRight,
  ChartColumn,
  ChevronRight,
  Circle,
  CornerDownRight,
  Cross,
  Cylinder,
  Diamond,
  FileText,
  Heart,
  Hexagon,
  ImagePlus,
  MessageSquare,
  MousePointer2,
  MoveUpRight,
  Octagon,
  PenLine,
  Pentagon,
  Shapes,
  Slash,
  Smile,
  Spline,
  Square,
  SquareRoundCorner,
  Star,
  Table,
  Triangle,
  Type,
} from "lucide-react";
import { memo, type ReactNode } from "react";

import { useDropdown } from "../../hooks/useDropdown";
import type { ArrangeMessage } from "../../lib/arrange";
import type { AgentInsert, EditTool } from "../../lib/editTools";
import { useApp } from "../../store";
import { ToolButton } from "../Button";
import { Brace, Bracket, DoubleArrow, Parallelogram, Trapezoid } from "../LineTools";
import { KeptMark } from "../LookTools";
import { DropdownPanel } from "../Popover";
import { RibbonRow, RibbonSection } from "../Ribbon";
import { AGENT_BUSY, AgentMark, PanelButton, type SectionProps } from "./parts";

/** A tool of the Insert section: `title` adds how it is used to its name, `shortcut` is its key. */
interface ToolChoice {
  tool: EditTool;
  label: string;
  title?: string;
  shortcut?: string;
  icon: ReactNode;
}

const SNAPS_45 = "Shift snaps to 45°";
/** What a tool's tooltip ends with: how to keep it for several. */
const KEEP_HINT = "double-click to keep it for several";

const SELECT: ToolChoice = { tool: "select", label: "Select and move", shortcut: "v", icon: <MousePointer2 /> };
const TEXT: ToolChoice = { tool: "text", label: "Add text", shortcut: "t", icon: <Type /> };

/** The shapes, under the heading each belongs to: the gallery behind the Shapes button. */
export const SHAPES: { heading: string; shapes: ToolChoice[] }[] = [
  {
    heading: "Basic shapes",
    shapes: [
      { tool: "rect", label: "Add a rectangle", shortcut: "r", icon: <Square /> },
      { tool: "rounded", label: "Add a rounded rectangle", icon: <SquareRoundCorner /> },
      { tool: "ellipse", label: "Add an ellipse", shortcut: "o", icon: <Circle /> },
      { tool: "triangle", label: "Add a triangle", icon: <Triangle /> },
      { tool: "star", label: "Add a star", icon: <Star /> },
      { tool: "bubble", label: "Add a speech bubble", icon: <MessageSquare /> },
    ],
  },
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
      { tool: "double-arrow", label: "Add a double-headed arrow", icon: <DoubleArrow /> },
    ],
  },
  {
    heading: "More shapes",
    shapes: [
      { tool: "pentagon", label: "Add a pentagon", icon: <Pentagon /> },
      { tool: "octagon", label: "Add an octagon", icon: <Octagon /> },
      { tool: "plus", label: "Add a plus", icon: <Cross /> },
      { tool: "heart", label: "Add a heart", icon: <Heart /> },
      { tool: "bracket", label: "Add a bracket", icon: <Bracket /> },
      { tool: "brace", label: "Add a brace", icon: <Brace /> },
    ],
  },
];

/** The lines and connectors, and drawing freehand: the gallery behind the Lines button. */
export const LINES: { heading: string; shapes: ToolChoice[] }[] = [
  {
    heading: "Lines",
    shapes: [
      { tool: "line", label: "Add a line", title: `Add a line, ${SNAPS_45}`, shortcut: "l", icon: <Slash /> },
      {
        tool: "arrow",
        label: "Add an arrow",
        title: `Add an arrow, ${SNAPS_45}`,
        shortcut: "a",
        icon: <MoveUpRight />,
      },
      { tool: "draw", label: "Draw freehand", shortcut: "d", icon: <PenLine /> },
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
const AGENT_INSERTS: { kind: AgentInsert; label: string; icon: ReactNode }[] = [
  { kind: "table", label: "Table…", icon: <Table /> },
  { kind: "chart", label: "Chart…", icon: <ChartColumn /> },
  { kind: "icon", label: "Icon…", icon: <Smile /> },
];

/** What picking a tool does: `onTool` picks it, `onKeep` keeps it in hand for several (a double-click). */
interface Picking {
  tool: EditTool;
  kept: boolean;
  onTool: (tool: EditTool) => void;
  onKeep: (tool: EditTool) => void;
}

/** A tool's button: a click picks it for one element, a double-click keeps it for several. */
function ToolChoiceButton(props: Picking & { choice: ToolChoice; onPicked?: () => void }) {
  const { choice } = props;
  const active = props.tool === choice.tool;
  const keeps = choice.tool !== "select";
  const name = choice.title ?? choice.label;
  return (
    <ToolButton
      keepFocus
      label={choice.label}
      title={
        !keeps
          ? name
          : active && props.kept
            ? `${name}: kept for several; Escape or V puts it away`
            : `${name}; ${KEEP_HINT}`
      }
      shortcut={choice.shortcut}
      active={active}
      onClick={() => {
        props.onTool(choice.tool);
        props.onPicked?.();
      }}
      onDoubleClick={() => {
        if (!keeps) return;
        props.onKeep(choice.tool);
        props.onPicked?.();
      }}
      className="relative"
    >
      {choice.icon}
      {active && props.kept && <KeptMark />}
    </ToolButton>
  );
}

/**
 * A button that opens a gallery of tools under their headings, showing the one in hand when it
 * is one of them. A pick closes the gallery; a double-click keeps the tool for several.
 */
function Gallery(
  props: Picking & {
    label: string;
    title: string;
    icon: ReactNode;
    groups: { heading: string; shapes: ToolChoice[] }[];
  },
) {
  const { open, setOpen, ref, toggle } = useDropdown();
  const current = props.groups.flatMap((group) => group.shapes).find((s) => s.tool === props.tool);
  return (
    <div ref={ref} className="relative">
      <PanelButton
        open={open || !!current}
        aria-expanded={open}
        label={props.label}
        title={current ? `${props.title}: ${current.label.replace(/^Add an? /, "")}` : props.title}
        onClick={toggle}
      >
        {current?.icon ?? props.icon}
        {current && props.kept && <KeptMark />}
      </PanelButton>
      {open && (
        <DropdownPanel role="dialog" aria-label={props.label} className="flex w-max flex-col gap-1.5 p-1.5">
          {props.groups.map((group) => (
            <fieldset key={group.heading} aria-label={group.heading} className="flex flex-col gap-0.5">
              <span className="text-[10px] leading-3 text-muted-foreground">{group.heading}</span>
              <div className="grid w-max grid-cols-6 gap-0.5">
                {group.shapes.map((choice) => (
                  <ToolChoiceButton key={choice.tool} {...props} choice={choice} onPicked={() => setOpen(false)} />
                ))}
              </div>
            </fieldset>
          ))}
          <p className="text-[10px] leading-3 text-muted-foreground">Double-click a shape to add several.</p>
        </DropdownPanel>
      )}
    </div>
  );
}

/**
 * The tools that add to the slide, compact: selecting, text, a gallery of shapes and one of lines
 * and connectors, an image from a file; and the requests to the agent for what they do not draw.
 */
export const InsertSection = memo(function InsertSection(
  props: SectionProps & {
    onTool: (tool: EditTool) => void;
    onArrange?: (message: ArrangeMessage) => void;
    onPickImage?: (replace: boolean) => void;
    onInsertAsk?: (kind: AgentInsert) => void;
  },
) {
  const kept = useApp((s) => s.editToolKept);
  const running = useApp((s) => s.running);
  const { onTool, onArrange } = props;
  const picking: Picking = {
    tool: props.tool,
    kept,
    // A click picks a tool for one element.
    onTool: (tool) => {
      if (kept) onArrange?.({ type: "slop:edit-tool-keep", tool, on: false });
      onTool(tool);
    },
    onKeep: (tool) => {
      useApp.getState().setEditTool(tool, true);
      onArrange?.({ type: "slop:edit-tool-keep", tool, on: true });
    },
  };
  return (
    <RibbonSection title="Insert" icon={<Shapes />} collapsed={props.collapsed} closeOn={props.tool}>
      <RibbonRow>
        <ToolChoiceButton {...picking} choice={SELECT} />
        <ToolChoiceButton {...picking} choice={TEXT} />
        <Gallery {...picking} label="Shapes" title="Add a shape" icon={<Shapes />} groups={SHAPES} />
        <Gallery
          {...picking}
          label="Lines"
          title="Add a line, an arrow or a connector"
          icon={<Slash />}
          groups={LINES}
        />
      </RibbonRow>
      <RibbonRow>
        <ToolButton keepFocus label="Add an image from a file…" onClick={() => props.onPickImage?.(false)}>
          <ImagePlus />
        </ToolButton>
        {AGENT_INSERTS.map((insert) => (
          <ToolButton
            keepFocus
            key={insert.kind}
            label={`Ask the agent for ${insert.kind === "icon" ? "an icon" : `a ${insert.kind}`}`}
            title={`${insert.label.replace("…", "")}: starts the request in the chat · asks the agent`}
            disabled={running}
            disabledReason={AGENT_BUSY}
            onClick={() => props.onInsertAsk?.(insert.kind)}
            className="relative"
          >
            {insert.icon}
            <AgentMark />
          </ToolButton>
        ))}
      </RibbonRow>
    </RibbonSection>
  );
});
