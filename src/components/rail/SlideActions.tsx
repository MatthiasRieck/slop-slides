import { Copy, Eye, EyeOff, Lock, LockOpen, MoreHorizontal, Trash2 } from "lucide-react";
import { memo, type ReactNode } from "react";

import type { Slide } from "../../lib/api";
import { cn, plural } from "../../lib/utils";
import { railSelection, useApp } from "../../store";

/** No slides picked besides the one on the stage: the same list every time. */
const ONLY_ITSELF: string[] = [];

/** What a thumbnail's quick actions are about, and what they are called. */
export interface ActionTargets {
  /** The slides they are about. */
  slides: string[];
  /** Those of them that are not locked: what deleting and, of several, hiding is about. */
  free: string[];
  lock: { title: string; on: boolean };
  hide: { title: string; on: boolean; slides: string[] };
  duplicate: string;
  remove: { title: string; reason?: string };
}

/**
 * What the quick actions on `slide`'s thumbnail are about: the slide, or every picked slide when
 * it is one of several (`picked`, in deck order), as its menu and a drag of it are. Locked slides
 * are not deleted and, of several, not hidden; the names say how many slides, and why not.
 */
export function actionTargets(slide: Slide, picked: Slide[]): ActionTargets {
  const several = picked.length > 1 && picked.some((s) => s.id === slide.id);
  if (!several) {
    return {
      slides: [slide.id],
      free: slide.locked ? [] : [slide.id],
      lock: { title: slide.locked ? "Unlock slide" : "Lock slide", on: !slide.locked },
      hide: { title: slide.hidden ? "Show slide" : "Hide slide", on: !slide.hidden, slides: [slide.id] },
      duplicate: "Duplicate",
      remove: { title: "Delete", reason: slide.locked ? "Locked: unlock to delete" : undefined },
    };
  }
  const free = picked.filter((s) => !s.locked);
  const count = plural(picked.length, "slide");
  const locked = picked.length - free.length;
  const skips = locked > 0 && free.length > 0 ? ` (not the ${locked} locked)` : "";
  const lock = !picked.every((s) => s.locked);
  const hide = !(free.length > 0 && free.every((s) => s.hidden));
  return {
    slides: picked.map((s) => s.id),
    free: free.map((s) => s.id),
    lock: { title: `${lock ? "Lock" : "Unlock"} ${count}`, on: lock },
    hide: {
      title: `${hide ? "Hide" : "Show"} ${plural(free.length || picked.length, "slide")}${skips}`,
      on: hide,
      slides: free.map((s) => s.id),
    },
    duplicate: `Duplicate ${count}`,
    remove: {
      title: `Delete ${plural(free.length || picked.length, "slide")}${skips}`,
      reason: free.length === 0 ? "Locked: unlock them to delete" : undefined,
    },
  };
}

/**
 * A thumbnail's quick actions, over its top right corner while the pointer is on the row or the
 * keyboard's focus is in it (the list they are in keeps them to one row at a time). On a
 * thumbnail too small to carry four buttons without hiding the slide's title they fold into one
 * that opens the slide's menu. Done on one of several picked slides, an action is about all of
 * them. It reads the picks for itself, so its thumbnail does not render as they change, and it
 * renders only for its slide, the picks or the menu: not with every render of its row.
 */
export const SlideActions = memo(function SlideActions(props: {
  slide: Slide;
  onMenu: (event: React.MouseEvent, slide: string) => void;
}) {
  const { slide } = props;
  const picks = useApp((s) => (s.railSelected.includes(slide.id) ? s.railSelected : ONLY_ITSELF));
  const app = useApp.getState;
  const targets = () => {
    const state = app();
    const picked = picks === ONLY_ITSELF ? [] : railSelection(state);
    return actionTargets(
      slide,
      (state.deck?.slides ?? []).filter((s) => picked.includes(s.id)),
    );
  };
  const shown = targets();
  return (
    <div
      data-slide-actions
      className="absolute right-1 top-1 hidden gap-0.5 group-hover/slide:flex group-has-[:focus-visible]/slide:flex"
    >
      <div className="hidden gap-0.5 @[150px]:flex">
        <RailAction
          title={shown.lock.title}
          onClick={() => {
            const now = targets();
            void app().setSlidesLocked(now.slides, now.lock.on);
          }}
        >
          {shown.lock.on ? <Lock /> : <LockOpen />}
        </RailAction>
        <RailAction
          title={shown.hide.title}
          onClick={() => {
            const now = targets();
            void app().setSlidesHidden(now.hide.slides, now.hide.on);
          }}
        >
          {shown.hide.on ? <EyeOff /> : <Eye />}
        </RailAction>
        <RailAction title={shown.duplicate} onClick={() => void app().duplicateSlides(targets().slides)}>
          <Copy />
        </RailAction>
        <RailAction
          title={shown.remove.title}
          disabledReason={shown.remove.reason}
          onClick={() => void app().deleteSlides(targets().free)}
        >
          <Trash2 />
        </RailAction>
      </div>
      <div className="flex @[150px]:hidden">
        <RailAction title="More actions" menu onClick={(event) => props.onMenu(event, slide.id)}>
          <MoreHorizontal />
        </RailAction>
      </div>
    </div>
  );
});

/** One of the quick actions: a small dark button that reads on any slide. Off, it stays, saying why. */
function RailAction(props: {
  title: string;
  disabledReason?: string;
  /** It opens a menu. */
  menu?: boolean;
  onClick: (event: React.MouseEvent) => void;
  children: ReactNode;
}) {
  const off = props.disabledReason !== undefined;
  return (
    <button
      type="button"
      aria-label={props.title}
      aria-disabled={off || undefined}
      aria-haspopup={props.menu ? "menu" : undefined}
      title={props.disabledReason ?? props.title}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (!off) props.onClick(e);
      }}
      className={cn(
        "rounded bg-overlay p-1 text-overlay-foreground focus-visible:outline-2 focus-visible:outline-ring [&_svg]:size-3",
        off ? "cursor-default [&_svg]:opacity-40" : "hover:opacity-90",
      )}
    >
      {props.children}
    </button>
  );
}
