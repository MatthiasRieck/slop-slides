import { memo } from "react";

import type { ArrangeMessage } from "../lib/arrange";
import type { AgentInsert, EditStyle, EditTool, ListKind, StackOrder, ToolFamily } from "../lib/editTools";
import { editRibbonOrder } from "../lib/ribbon";
import { useRibbonFit } from "./Ribbon";
import { ArrangeSection, CanvasSection } from "./ribbon/ArrangeSection";
import { InsertSection } from "./ribbon/InsertSection";
import { ParagraphSection } from "./ribbon/ParagraphSection";
import { SlideSection } from "./ribbon/SlideSection";
import { StyleSection } from "./ribbon/StyleSection";
import { TextSection } from "./ribbon/TextSection";
import { type SizeMode, useSlideReport } from "./stage/editorState";
import { TimelineTools } from "./TimelineTools";

/** The ribbon's sections, in the order they show. */
export const EDIT_SECTIONS = ["Insert", "Text", "Paragraph", "Style", "Slide", "Arrange", "Timeline", "Canvas"];

/** The order the sections collapse in, with something selected and with nothing (see `editRibbonOrder`). */
const ORDER_SELECTED = editRibbonOrder(EDIT_SECTIONS, true);
const ORDER_NOTHING = editRibbonOrder(EDIT_SECTIONS, false);

/**
 * Edit mode's tools, in a ribbon above the slide (one file per section, in ./ribbon/): add text,
 * shapes, lines, images, or start a request to the agent for a table, chart or icon; format the
 * text and its paragraphs; style the selection (fill, border, effects, the format painter, and
 * the tools of an image, a line or a shape); set the slide's background; arrange the selection;
 * show the timeline; and the canvas's own options. Sections collapse to an icon over their
 * caption as the ribbon narrows: with something selected the insert tools go first and what
 * formats it stays open; with nothing selected the insert tools stay. While typing, the text
 * styles go to the selected text. With nothing selected, the styles are those of what the
 * current tool adds. A control that waits for a selection says so in its tooltip.
 *
 * Its buttons keep focus in the slide, so the text being edited keeps its selection; after a
 * typed value or a pick from a list `onReturnFocus` gives focus back to the slide.
 *
 * What the slide editor reports (the selection, where it is, the layers, the deck's fonts and
 * colors) is not handed in: each control reads what it shows from `useEditorState`. The ribbon
 * itself reads only whether anything is selected, and its sections render only when what they
 * are given changes, so a report from the editor, which comes with every keystroke and every
 * frame of a drag, renders the controls showing it and no more. Its callbacks should so stay the
 * same from one render of its parent to the next.
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
  onArrange?: (message: ArrangeMessage) => void;
}) {
  const selected = useSlideReport((report) => report.selection !== null);
  const { ref, collapsed } = useRibbonFit(selected ? ORDER_SELECTED : ORDER_NOTHING);
  const shut = (name: string) => !!collapsed[EDIT_SECTIONS.indexOf(name)];
  const { tool, styles, onStyle, onReturnFocus, onArrange } = props;
  const restyling = { tool, styles, onStyle, onReturnFocus };

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="Edit tools"
      data-edit-toolbar=""
      className="flex min-w-0 flex-[1_1_200px]"
    >
      <InsertSection
        collapsed={shut("Insert")}
        tool={tool}
        onTool={props.onTool}
        onArrange={onArrange}
        onPickImage={props.onPickImage}
        onInsertAsk={props.onInsertAsk}
      />
      <TextSection collapsed={shut("Text")} {...restyling} onLink={props.onLink} onArrange={onArrange} />
      <ParagraphSection collapsed={shut("Paragraph")} {...restyling} onList={props.onList} onArrange={onArrange} />
      <StyleSection
        collapsed={shut("Style")}
        {...restyling}
        onTool={props.onTool}
        onArrange={onArrange}
        onPickImage={props.onPickImage}
      />
      <SlideSection
        collapsed={shut("Slide")}
        tool={tool}
        onBackground={props.onBackground}
        onReturnFocus={onReturnFocus}
      />
      <ArrangeSection
        collapsed={shut("Arrange")}
        tool={tool}
        onArrange={onArrange}
        onOrder={props.onOrder}
        onReturnFocus={onReturnFocus}
        onKeepRatio={props.onKeepRatio}
      />
      <TimelineTools collapsed={shut("Timeline")} />
      <CanvasSection onSizeMode={props.onSizeMode} />
    </div>
  );
});
