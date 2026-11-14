import { PaintBucket, PenLine, SquareDashed } from "lucide-react";
import { memo } from "react";

import type { ArrangeMessage } from "../../lib/arrange";
import { BORDER_WIDTHS, type EditTool, isMixed } from "../../lib/editTools";
import { ColorButton } from "../ColorButton";
import { NumberBox } from "../Field";
import { DashPicker, LineButton } from "../LineTools";
import { EffectsButton, hasShapeTools, ImageButton, PainterButton, ShapeButton } from "../LookTools";
import { RibbonRow, RibbonSection } from "../Ribbon";
import { useEditorState } from "../stage/editorState";
import { NEEDS_ELEMENT, type StyleSectionProps, useToolbarState } from "./parts";

/** Whether `tool` draws a line, which has no area to fill. */
const isLineTool = (tool: EditTool) => tool === "line" || tool === "arrow" || tool === "elbow" || tool === "curve";

/**
 * The selection's fill, border or line, its effects and the format painter; and one slot for the
 * tools of what it is, shown only for that: an image's, a line's, or a shape's.
 */
export const StyleSection = memo(function StyleSection(
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
  // A line, or a line about to be drawn, has no area to fill.
  const line = selection ? !!selection.line : isLineTool(props.tool);
  const fillOff = !state || line;
  const look = { onStyle: props.onStyle, onArrange: props.onArrange, onDone: returnFocus };
  /** Shows a color on the selection while the pointer is on it (see ColorButton); undefined takes it back. */
  const previewColor = (key: "fill" | "stroke") =>
    selection
      ? (color: string | null | undefined) =>
          props.onArrange?.(
            color === undefined
              ? { type: "slop:edit-style-cancel" }
              : { type: "slop:edit-style", style: { [key]: color }, preview: true },
          )
      : undefined;
  return (
    <RibbonSection title="Style" icon={<PaintBucket />} collapsed={props.collapsed} closeOn={props.tool}>
      <RibbonRow>
        <ColorButton
          label="Fill"
          icon={<PaintBucket />}
          value={line ? null : (style.fill ?? null)}
          other={!line && !!selection?.fillOther}
          disabled={fillOff}
          disabledReason={line ? "A line has no fill" : NEEDS_ELEMENT}
          none
          deck={colors}
          onChange={(fill) => props.onStyle({ fill })}
          onPreview={previewColor("fill")}
          onDone={returnFocus}
        />
        <ColorButton
          label={vector ? "Line color" : "Border color"}
          icon={vector ? <PenLine /> : <SquareDashed />}
          value={style.stroke ?? null}
          other={!!selection?.strokeOther}
          disabled={strokeOff}
          disabledReason={strokeReason}
          none={!vector}
          deck={colors}
          onChange={(stroke) => props.onStyle({ stroke })}
          onPreview={previewColor("stroke")}
          onDone={returnFocus}
        />
        <NumberBox
          label={vector ? "Line width" : "Border width"}
          value={state && !isMixed(selection, "strokeWidth") ? (style.strokeWidth ?? 0) : null}
          unit="px"
          min={vector ? 1 : 0}
          max={200}
          width="w-6"
          presets={BORDER_WIDTHS.filter((w) => !vector || w > 0).map((w) => ({
            value: w,
            label: w === 0 ? "No border" : `${w} px`,
          }))}
          disabled={strokeOff}
          disabledReason={strokeReason}
          onChange={(strokeWidth) => props.onStyle({ strokeWidth: strokeWidth ?? 0 })}
          onDone={returnFocus}
        />
        <DashPicker
          value={style.dash ?? "solid"}
          mixed={isMixed(selection, "dash")}
          vector={vector}
          disabled={strokeOff}
          disabledReason={strokeReason}
          onChange={props.onStyle}
          onDone={returnFocus}
        />
      </RibbonRow>
      <RibbonRow>
        <EffectsButton selection={selection} {...look} />
        <PainterButton tool={props.tool} selection={selection} onTool={props.onTool} onArrange={props.onArrange} />
        {/* One slot, the same width whatever it holds, so the ribbon does not move as the selection changes. */}
        <span className="flex w-[4.75rem] justify-start">
          {selection?.image ? (
            <ImageButton
              selection={selection}
              onStyle={props.onStyle}
              onReplace={() => props.onPickImage?.(true)}
              onDone={returnFocus}
            />
          ) : selection?.line ? (
            <LineButton selection={selection} onChange={props.onStyle} onDone={returnFocus} />
          ) : selection && hasShapeTools(selection) ? (
            <ShapeButton selection={selection} {...look} />
          ) : null}
        </span>
      </RibbonRow>
    </RibbonSection>
  );
});
