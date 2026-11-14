import { Copy, Presentation, Wallpaper } from "lucide-react";
import { memo } from "react";

import { showSuccess, useApp } from "../../store";
import { Button, keepFocus } from "../Button";
import { ColorButton } from "../ColorButton";
import { RibbonRow, RibbonSection } from "../Ribbon";
import { useEditorState } from "../stage/editorState";
import { ChangeLayoutTool, TidyLayoutTool } from "../stage/SlideLayoutTools";
import type { SectionProps } from "./parts";

/** What the background well says of a slide whose background is a gradient or an image. */
const CUSTOM_BACKGROUND = "This slide has a gradient or image background. Picking a color replaces it.";

/** Gives every slide `color` as its background, and says how many changed, with a way back. */
async function applyToAll(color: string | null) {
  const changed = await useApp.getState().applyBackgroundToAll(color);
  if (changed === 0) return;
  showSuccess(`Gave ${changed === 1 ? "1 more slide" : `${changed} more slides`} this background.`, {
    label: "Undo",
    run: () => void useApp.getState().undo(),
  });
}

/**
 * What is the slide's own, whatever is selected: its background, which can go to every slide, and
 * its layout, which the agent changes or tidies.
 */
export const SlideSection = memo(function SlideSection(
  props: SectionProps & { onBackground?: (color: string | null) => void; onReturnFocus?: () => void },
) {
  const background = useEditorState((s) => s.background);
  const custom = useEditorState((s) => s.backgroundOther);
  const colors = useEditorState((s) => s.colors);
  const own = useEditorState((s) => s.backgroundOwn);
  return (
    <RibbonSection title="Slide" icon={<Presentation />} collapsed={props.collapsed} closeOn={props.tool}>
      {/* Two rows like every section: the layout requests one under the other, the background beside the first. */}
      <RibbonRow>
        <ChangeLayoutTool />
        <ColorButton
          label="Slide background"
          icon={<Wallpaper />}
          value={custom ? null : background}
          other={custom}
          otherNote={CUSTOM_BACKGROUND}
          defaultLabel="Deck default"
          deck={colors}
          panel="background"
          footer={
            <Button
              variant="outline"
              size="sm"
              disabled={custom}
              title={
                custom
                  ? "Pick a color first: a gradient or image stays this slide's own"
                  : "Give every slide that is not locked this slide's background"
              }
              onMouseDown={keepFocus}
              // A slide showing the deck's own background gives the others theirs back.
              onClick={() => void applyToAll(own ? background : null)}
              className="justify-center"
            >
              <Copy />
              Apply to all slides
            </Button>
          }
          onChange={(color) => props.onBackground?.(color)}
          onDone={() => props.onReturnFocus?.()}
        />
      </RibbonRow>
      <RibbonRow>
        <TidyLayoutTool />
      </RibbonRow>
    </RibbonSection>
  );
});
