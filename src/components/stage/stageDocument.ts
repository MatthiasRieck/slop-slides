import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

import { api } from "../../lib/api";
import { slideUrl } from "../../lib/utils";

/**
 * The page the stage's preview holds for its slide, and what it shows now. A page costs a load
 * (the deck's styles, fonts and images, the player, the editor): it is kept for as long as it can
 * show what is wanted. Edit mode comes and goes on it (the pasteboard attaches the slide editor
 * and detaches it again, see assets/pasteboard.js), and while the editor is on it a new version of
 * its slide is patched in (see assets/editor/75-life.js), so an undo, or the agent's change, shows
 * without a load.
 */
export interface StageDocument {
  slide: string;
  /** What else the page shows that only a load brings in: the deck's styles, its assets, a reload asked for, narration playing over it. */
  around: string;
  /** The `replayRev` it was loaded for: View plays the slide's animations again by loading it again. */
  replay: number;
  /** The slide's version (see `useSlideVersion`) it loaded, which its address names. */
  loaded: string;
  /** The slide's version it shows now: the one it loaded, one patched in since, or one its editor saved. */
  shows: string;
  /** Loaded with the slide editor (`edit` in its address) and as a still (`static`). */
  loadedEdit: boolean;
  loadedStill: boolean;
  /** Whether the editor is on it now, and whether it shows the slide's final animation frame. */
  edit: boolean;
  still: boolean;
}

/** What the stage wants its preview to show. */
export interface StageWants {
  slide: string;
  around: string;
  replay: number;
  /** The slide's version now. */
  version: string;
  /** The slide editor on the page. */
  edit: boolean;
  /** The slide on its final animation frame (always, while editing). */
  still: boolean;
  /** `version` is one the editor saved: what it shows already. */
  own: boolean;
}

function freshDocument(want: StageWants): StageDocument {
  return {
    slide: want.slide,
    around: want.around,
    replay: want.replay,
    loaded: want.version,
    shows: want.version,
    loadedEdit: want.edit,
    loadedStill: want.still,
    edit: want.edit,
    still: want.still,
  };
}

/**
 * What the preview holds once it shows what is wanted: `doc` itself when it does, `doc` with the
 * editor on or off when only the mode changed, or a fresh page to load. A version the editor did
 * not save is left for the editor to patch in, while it is on the page (see `useStageDocument`);
 * without it the page loads again, as View has always shown a new version.
 */
export function nextDocument(doc: StageDocument | null, want: StageWants): StageDocument {
  if (!doc || doc.slide !== want.slide || doc.around !== want.around) return freshDocument(want);
  // In View, playing the slide again, or showing it still or not, is a load of its own.
  if (!want.edit && (doc.replay !== want.replay || (!doc.edit && doc.still !== want.still))) return freshDocument(want);
  let next = doc;
  if (doc.edit !== want.edit) next = { ...next, edit: want.edit, still: want.still };
  if (want.version !== next.shows) {
    if (want.own) next = { ...next, shows: want.version };
    else if (!want.edit) return freshDocument(want);
  }
  return next;
}

/** The page loaded again at `version`, with the editor and still as it is now. */
function reloaded(doc: StageDocument, version: string): StageDocument {
  return { ...doc, loaded: version, shows: version, loadedEdit: doc.edit, loadedStill: doc.still };
}

/** How long the editor has to answer a patch before the slide is loaded again instead. */
export const PATCH_WAIT = 2000;

/**
 * The page the stage's preview holds (see `StageDocument`), and what makes it follow what is
 * wanted: the address it loads, the props for its `SlideFrame` (`version`, `still`, `editKey`),
 * and `onReady` for the frame that has loaded. As the mode changes, the page is told to attach the
 * editor or to detach it, once it has loaded; a new version of the slide that the editor did not
 * save is fetched and patched into it while the editor is there, the page loading again only
 * when the patch cannot be made.
 */
export function useStageDocument(
  props: { deckId: string; slideHash: string; editReload: number; pan: boolean },
  want: StageWants,
  frame: RefObject<HTMLIFrameElement | null>,
) {
  const [kept, setKept] = useState<StageDocument | null>(null);
  const doc = nextDocument(kept, want);
  if (doc !== kept) setKept(doc);

  const version = doc.replay > 0 && !doc.loadedEdit ? `${doc.loaded}.r${doc.replay}` : doc.loaded;
  const editKey = doc.loadedEdit ? String(props.editReload) : undefined;
  const url = slideUrl(props.deckId, doc.slide, version, doc.loadedStill, editKey, props.pan);

  // The page in the frame that last loaded (its address), and the mode it was put in.
  const [page, setPage] = useState<{ url: string | null; edit: boolean; still: boolean } | null>(null);
  const ready = page?.url === url;
  const loadedMode = useRef({ edit: doc.loadedEdit, still: doc.loadedStill });
  loadedMode.current = { edit: doc.loadedEdit, still: doc.loadedStill };
  const onReady = useCallback(
    (loaded: HTMLIFrameElement) => setPage({ url: loaded.getAttribute("src"), ...loadedMode.current }),
    [],
  );

  // The editor goes on the page, or comes off it, as the mode changes.
  useEffect(() => {
    if (!ready || !page || (page.edit === doc.edit && page.still === doc.still)) return;
    const shown = frame.current?.contentWindow;
    if (!shown) return;
    shown.postMessage(doc.edit ? { type: "slop:edit-attach" } : { type: "slop:edit-detach", still: doc.still }, "*");
    setPage({ url, edit: doc.edit, still: doc.still });
  }, [ready, page, url, doc.edit, doc.still, frame]);

  // A version the editor did not save is patched in while the editor is there.
  const target = want.version;
  const patching = ready && doc.edit && page?.edit === true && target !== doc.shows && !want.own;
  const { deckId, slideHash } = props;
  const slide = doc.slide;
  useEffect(() => {
    const shown = frame.current?.contentWindow;
    if (!patching || !shown) return;
    let over = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (
        event.source !== shown ||
        data?.type !== "slop:edit-patched" ||
        data.slide !== slide ||
        data.hash !== slideHash
      )
        return;
      settle(data.ok === true);
    };
    const stop = () => {
      over = true;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };
    /** Shows the patched page, or (not `patched`) loads the slide again. */
    function settle(patched: boolean) {
      if (over) return;
      stop();
      setKept((now) => {
        if (!now || now.slide !== slide || now.shows === target) return now;
        return patched ? { ...now, shows: target } : reloaded(now, target);
      });
    }
    window.addEventListener("message", onMessage);
    timer = setTimeout(() => settle(false), PATCH_WAIT);
    api
      .slideSource(deckId, slide)
      .then((source) => {
        if (over) return;
        // The deck has moved on from the version asked for: the slide loads as it is.
        if (source.hash !== slideHash) settle(false);
        else shown.postMessage({ type: "slop:edit-patch", slide, hash: slideHash, markup: source.markup }, "*");
      })
      .catch(() => settle(false));
    return stop;
  }, [patching, target, slide, slideHash, deckId, frame]);

  return { doc, version, editKey, still: doc.loadedStill, url, onReady };
}
