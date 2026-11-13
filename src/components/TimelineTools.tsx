import { Film } from "lucide-react";

import { useApp } from "../store";
import { RibbonRow, RibbonSection, RibbonToggle } from "./Ribbon";

/**
 * The timeline's section of a ribbon, the same in View and in Edit: showing or folding away the
 * timeline under the slide (see NarrationTimeline), which has what plays the deck in its own bar.
 */
export function TimelineTools({ collapsed }: { collapsed: boolean }) {
  const open = useApp((s) => s.timelineOpen);
  const playable = useApp((s) => s.deck?.slides.some((slide) => !slide.hidden) ?? false);
  return (
    <RibbonSection title="Timeline" icon={<Film />} collapsed={collapsed} closeOn={open}>
      <RibbonRow>
        <RibbonToggle
          label={open ? "Hide the timeline under the slide" : "Show the timeline under the slide"}
          active={open}
          disabled={!playable}
          onClick={() => useApp.getState().setTimelineOpen(!open)}
        >
          <Film />
          {/* Its name; pressed in, the timeline shows. */}
          Timeline
        </RibbonToggle>
      </RibbonRow>
    </RibbonSection>
  );
}
