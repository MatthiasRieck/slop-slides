import { Film } from "lucide-react";

import { cn } from "../lib/utils";
import { useApp } from "../store";
import { keepFocus } from "./Button";
import { collapsedSectionClass, RibbonRow, RibbonSection, RibbonToggle } from "./Ribbon";

/**
 * The timeline's section of a ribbon, the same in View and in Edit: showing or folding away the
 * timeline under the slide (see NarrationTimeline), which has what plays the deck in its own bar.
 * Collapsed, it is the same toggle as an icon over its caption: one tool needs no flyout.
 */
export function TimelineTools({ collapsed }: { collapsed: boolean }) {
  const open = useApp((s) => s.timelineOpen);
  const playable = useApp((s) => s.deck?.slides.some((slide) => !slide.hidden) ?? false);
  const label = open ? "Hide the timeline under the slide" : "Show the timeline under the slide";
  const toggle = () => useApp.getState().setTimelineOpen(!open);
  return (
    <RibbonSection
      title="Timeline"
      icon={<Film />}
      collapsed={collapsed}
      closeOn={open}
      collapsedAs={
        <button
          type="button"
          aria-label={label}
          title={label}
          aria-pressed={open}
          disabled={!playable}
          onMouseDown={keepFocus}
          onClick={toggle}
          className={cn(collapsedSectionClass, open && "bg-primary/10 text-primary")}
        >
          <Film />
          <span className="text-[10px] leading-3">Timeline</span>
        </button>
      }
    >
      <RibbonRow>
        <RibbonToggle label={label} active={open} disabled={!playable} onClick={toggle}>
          <Film />
          {/* Its name; pressed in, the timeline shows. */}
          Timeline
        </RibbonToggle>
      </RibbonRow>
    </RibbonSection>
  );
}
