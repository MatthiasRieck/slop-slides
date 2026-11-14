import { Move, Settings2 } from "lucide-react";
import { memo } from "react";

import { useDropdown } from "../../hooks/useDropdown";
import type { ArrangeMessage } from "../../lib/arrange";
import type { StackOrder } from "../../lib/editTools";
import { formatKeys } from "../../lib/keys";
import { useApp } from "../../store";
import { AlignMenu, GroupControls, LayersPanel, OrderMenu, PositionControls, RotateMenu } from "../ArrangeControls";
import { RibbonRow, RibbonSection } from "../Ribbon";
import { type SizeMode, useEditorState } from "../stage/editorState";
import { MenuDivider, MenuPanel, MenuRow, PanelButton, type SectionProps } from "./parts";

/**
 * Where the selection is and how it lies among the rest: aligning it (one element with the
 * slide, several with each other), its order, turns and flips, exact place and size; grouping,
 * locking, duplicating it, and the slide's layers. The section itself renders only with the tool;
 * the controls that show where the selection is follow it as it is dragged by themselves.
 */
export const ArrangeSection = memo(function ArrangeSection(
  props: SectionProps & {
    onArrange?: (message: ArrangeMessage) => void;
    onOrder: (to: StackOrder) => void;
    onReturnFocus?: () => void;
    onKeepRatio?: (on: boolean) => void;
  },
) {
  const { onArrange, onReturnFocus } = props;
  return (
    <RibbonSection title="Arrange" icon={<Move />} collapsed={props.collapsed} closeOn={props.tool}>
      <RibbonRow>
        <AlignMenu onArrange={onArrange} />
        <OrderMenu onOrder={props.onOrder} />
        <RotateMenu onArrange={onArrange} />
        <PositionControls onArrange={onArrange} onDone={onReturnFocus} onKeepRatio={props.onKeepRatio} />
      </RibbonRow>
      <RibbonRow>
        <GroupControls onArrange={onArrange} />
        <LayersPanel onArrange={onArrange} />
      </RibbonRow>
    </RibbonSection>
  );
});

/**
 * The settings of the canvas, not of the selection, at the ribbon's end: whether drags snap to
 * the guides, and whether a handle stretches an element's contents with its box.
 */
export const CanvasSection = memo(function CanvasSection(props: { onSizeMode: (mode: SizeMode) => void }) {
  const { open, setOpen, ref, toggle } = useDropdown();
  const snap = useApp((s) => s.editSnap);
  const stretch = useEditorState((s) => s.sizeMode === "stretch");
  const held = formatKeys("mod");
  return (
    <RibbonSection title="Canvas" icon={<Settings2 />} collapsed={false} fixed>
      <RibbonRow>
        <div ref={ref} className="relative">
          <PanelButton
            open={open}
            label="Canvas options"
            title={`Canvas options: snapping ${snap ? "on" : "off"}${stretch ? ", handles stretch the contents" : ""}`}
            active={open || stretch}
            onClick={toggle}
          >
            <Settings2 />
          </PanelButton>
          {open && (
            <MenuPanel label="Canvas options">
              <MenuRow
                label="Snap to guides"
                title={`Moves and resizes snap to the slide and other elements; hold ${held} while dragging to do the opposite`}
                checked={snap}
                onClick={() => useApp.getState().setEditSnap(!snap)}
              />
              <MenuDivider />
              <MenuRow
                label="Stretch contents when resizing"
                title="Dragging a handle scales an element's text and borders with its box, instead of resizing just the box"
                checked={stretch}
                onClick={() => {
                  props.onSizeMode(stretch ? "resize" : "stretch");
                  setOpen(false);
                }}
              />
            </MenuPanel>
          )}
        </div>
      </RibbonRow>
    </RibbonSection>
  );
});
