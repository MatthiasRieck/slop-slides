import type { Deck, Slide } from "../../lib/api";
import { pixelsOf } from "../../lib/slideSize";
import { cn, headSlideUrl } from "../../lib/utils";
import { SlideFrame, useSlideVersion } from "../SlideFrame";
import { SlideImage } from "../SlideImage";

/** A slide as it is now, small, in the list. It loads once the list shows it, like the slide list's. */
export function LiveThumbnail({ deck, slide, faded }: { deck: Deck; slide: Slide; faded: boolean }) {
  const version = useSlideVersion(slide);
  return (
    <SlideImage
      deckId={deck.id}
      slideId={slide.id}
      version={version}
      size={pixelsOf({ size: deck.size })}
      lazy
      className={cn(faded && "opacity-50")}
    />
  );
}

/** A slide as it is now, as large as the stage has room. */
export function LiveSlide({ deck, slide }: { deck: Deck; slide: Slide }) {
  const version = useSlideVersion(slide);
  return (
    <SlideFrame
      deckId={deck.id}
      slideId={slide.id}
      version={version}
      size={pixelsOf({ size: deck.size })}
      thumbnail
      className="w-full"
    />
  );
}

/**
 * A slide as the last version (the commit `commit`) has it. `lazy` in the list, where it loads
 * once it shows; on the stage it fills the width.
 */
export function SavedSlide(props: {
  deck: Deck;
  slideId: string;
  commit: string;
  size: { width: number; height: number };
  lazy?: boolean;
  className?: string;
}) {
  const { deck, slideId, commit } = props;
  // In the list, a picture; on the stage, as large as there is room, the slide itself.
  if (props.lazy) {
    return (
      <SlideImage
        deckId={deck.id}
        slideId={slideId}
        version={commit}
        url={headSlideUrl(deck.id, slideId, commit)}
        size={props.size}
        lazy
        className={props.className}
      />
    );
  }
  return (
    <SlideFrame
      deckId={deck.id}
      slideId={slideId}
      version={commit}
      url={headSlideUrl(deck.id, slideId, commit)}
      size={props.size}
      thumbnail
      lazy={props.lazy}
      className={props.className}
    />
  );
}
