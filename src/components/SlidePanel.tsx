import { Lock } from "lucide-react";
import type { ReactNode } from "react";

import type { Deck, Slide } from "../lib/api";
import { ScriptPreviewToggle } from "./ScriptMarkdown";

/**
 * A sidebar tab with tools for the selected slide (its notes, its narration), filling the tab
 * from top to bottom, or a line saying what is missing when there is no deck or no slide.
 * `noun` names what the panel writes, for that line.
 */
export function SlidePanel(props: {
  label: string;
  noun: string;
  deck: Deck | null | undefined;
  slide: Slide | undefined;
  children: (deck: Deck, slide: Slide) => ReactNode;
}) {
  const { deck, slide, noun } = props;
  if (!deck || !slide) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {deck ? `Add a slide to write its ${noun}.` : `Open a deck to write ${noun} for its slides.`}
      </p>
    );
  }
  return (
    <section aria-label={props.label} className="flex h-full min-h-0 flex-col overflow-y-auto">
      {props.children(deck, slide)}
    </section>
  );
}

/**
 * The header row of a slide panel's editor: which slide it is, anything the panel adds about it
 * (`children`), the Markdown preview toggle, and whether the slide is locked. It wraps when the
 * sidebar is narrow.
 */
export function SlidePanelHeader(props: {
  slide: Slide;
  index: number;
  total: number;
  preview: boolean;
  onPreview: (preview: boolean) => void;
  children?: ReactNode;
}) {
  const { slide } = props;
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span className="min-w-0 truncate">
        Slide {props.index + 1} of {props.total} · <span className="font-mono">{slide.id}</span>
      </span>
      {props.children}
      <ScriptPreviewToggle preview={props.preview} onChange={props.onPreview} />
      {slide.locked && (
        <span className="flex shrink-0 items-center gap-1">
          <Lock className="size-3" />
          Locked
        </span>
      )}
    </div>
  );
}
