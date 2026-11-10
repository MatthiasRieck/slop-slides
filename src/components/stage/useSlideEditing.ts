import { open } from "@tauri-apps/plugin-dialog";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

import { api } from "../../lib/api";
import { type EditGeometry, type EditLayer, parseGeometry, parseLayers } from "../../lib/arrange";
import { catchDrops, type DropPoint, isImage } from "../../lib/drop";
import {
  type DeckColor,
  type EditElement,
  type EditSelection,
  type FontChoice,
  IMAGE_FILE_TYPES,
  parseDeckColors,
  parseElement,
  parseFonts,
  parseHexColor,
  parseSelection,
} from "../../lib/editTools";
import { reportingErrors, showError, useApp } from "../../store";
import { parseSvgOpen, useSvgEditor } from "../../svgStore";
import type { EditMenuAction } from "../EditContextMenu";
import { isEditTool, runEditKey, runHistoryKey, toolMessage } from "./editKeys";
import { fromFrameIn, toAppPoint, toFramePoint } from "./frames";
import { importImages, measureImages } from "./images";
import { keyForRail } from "./useSlideKeyboard";

const NO_OVERFLOW: string[] = [];
const NO_LAYERS: EditLayer[] = [];
const NO_FONTS: FontChoice[] = [];
const NO_COLORS: DeckColor[] = [];

/**
 * Connects the stage to the slide editor running in its preview (src-tauri/assets/editor/):
 * saves the markup it posts, keeps the selection across the reload that follows, and
 * handles undo and leaving edit mode. Images dropped on the stage go onto the slide. The
 * editor copies elements through the system clipboard, and ⌘V pastes from it: an element
 * copied there, images (saved as assets) or text from anywhere.
 */
export function useSlideEditing(areaRef: RefObject<HTMLDivElement | null>, resetView: () => void) {
  const [sizeMode, setSizeMode] = useState<"resize" | "stretch">("resize");
  const [keepRatio, setKeepRatio] = useState(false);
  // What to select again once the edited slide reloads.
  const restore = useRef<{ slide: string; path: number[]; also: number[][] } | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [overflow, setOverflow] = useState<{ slide: string; items: string[] } | null>(null);
  // What the editor has selected, and on which slide.
  const [selection, setSelection] = useState<{ slide: string; selection: EditSelection | null } | null>(null);
  // The fonts the deck's styles use, for the toolbar's font list.
  const [fonts, setFonts] = useState<FontChoice[]>(NO_FONTS);
  // Where the selection is, and on which slide.
  const [geometry, setGeometry] = useState<{ slide: string; geometry: EditGeometry | null } | null>(null);
  const [layers, setLayers] = useState<{ slide: string; layers: EditLayer[] } | null>(null);
  const [colors, setColors] = useState<DeckColor[]>(NO_COLORS);
  const [background, setBackground] = useState<string | null>(null);
  // The menu a right-click in the editor opened, in the app's pixels.
  const [menu, setMenu] = useState<{ x: number; y: number; element: EditElement | null } | null>(null);

  const post = useCallback((data: unknown) => frame.current?.contentWindow?.postMessage(data, "*"), []);

  const paste = useCallback(async () => {
    const { deck, editing, selected } = useApp.getState();
    if (!deck || !editing || !selected) return;
    await reportingErrors(async () => {
      const pasted = await api.pasteFromClipboard(deck.id);
      const loaded = frame.current;
      const now = useApp.getState();
      if (!now.editing || now.selected !== selected || !loaded?.contentWindow) return;
      if (pasted.kind === "element") {
        loaded.contentWindow.postMessage({ type: "slop:edit-paste", html: pasted.html }, "*");
      } else if (pasted.kind === "text") {
        loaded.contentWindow.postMessage(
          { type: "slop:edit-paste-text", text: pasted.text, style: now.editStyles.text },
          "*",
        );
      } else if (pasted.kind === "slide") {
        await useApp.getState().pasteSlide();
      } else if (pasted.kind === "images") {
        const images = await measureImages(deck.id, pasted.images);
        // The editor puts them where the pointer is, or in the middle of the view.
        loaded.contentWindow.postMessage({ type: "slop:edit-paste-images", images }, "*");
      }
    });
  }, []);

  useEffect(() => {
    /** ⌘C / ⌘X / ⌘V while editing; `fromApp` when pressed outside the slide. True when handled. */
    const runClipboardKey = (key: string, shift: boolean, fromApp: boolean, rail = false) => {
      const lower = key.toLowerCase();
      if (shift) return false;
      // ⌘A and ⌘D pressed outside the slide still mean the slide's elements.
      if (fromApp && (lower === "a" || lower === "d") && !window.getSelection()?.toString()) {
        post({ type: lower === "a" ? "slop:edit-select-all" : "slop:edit-duplicate" });
        return true;
      }
      if (lower === "v") {
        void paste();
        return true;
      }
      // In the slide, the editor copies by itself; in the app, copying selected text comes
      // first, and ⌘C on the slide rail copies the slide (see useSlideKeyboard).
      if (lower === "c" && fromApp && rail) return false;
      if ((lower === "c" || lower === "x") && fromApp && !window.getSelection()?.toString()) {
        post({ type: "slop:edit-copy", cut: lower === "x" });
        return true;
      }
      return false;
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      const { editing, selected } = useApp.getState();
      if (!editing || !fromFrameIn(areaRef.current, event.source)) return;
      if (data?.type === "slop:edit-commit" && data.slide === selected && typeof data.markup === "string") {
        restore.current = Array.isArray(data.select)
          ? { slide: data.slide, path: data.select, also: Array.isArray(data.also) ? data.also : [] }
          : null;
        void useApp.getState().saveSlideEdit(data.slide, data.markup);
      } else if (data?.type === "slop:edit-overflow" && data.slide === selected && Array.isArray(data.items)) {
        setOverflow({ slide: data.slide, items: data.items.map(String) });
      } else if (data?.type === "slop:edit-press") {
        // A press in the preview never reaches this window, but for what is open here it is a press outside.
        frame.current?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      } else if (data?.type === "slop:edit-selection" && data.slide === selected) {
        setSelection({ slide: data.slide, selection: parseSelection(data.selection) });
      } else if (data?.type === "slop:edit-geometry" && data.slide === selected) {
        setGeometry({ slide: data.slide, geometry: parseGeometry(data.geometry) });
      } else if (data?.type === "slop:edit-layers" && data.slide === selected) {
        setLayers({ slide: data.slide, layers: parseLayers(data.layers) });
      } else if (data?.type === "slop:edit-tool" && data.slide === selected && typeof data.tool === "string") {
        // The editor put its tool away by itself (after adding a shape, or on Escape).
        if (isEditTool(data.tool)) useApp.getState().setEditTool(data.tool);
      } else if (data?.type === "slop:edit-fonts" && data.slide === selected) {
        setFonts(parseFonts(data.fonts));
      } else if (data?.type === "slop:edit-colors" && data.slide === selected) {
        setColors(parseDeckColors(data.colors));
      } else if (data?.type === "slop:edit-background" && data.slide === selected) {
        setBackground(parseHexColor(data.color));
      } else if (data?.type === "slop:edit-menu" && data.slide === selected) {
        // The preview is scaled down to fit; the editor gives the point in its own pixels.
        const at = toAppPoint(frame.current, Number(data.x), Number(data.y));
        setMenu({ ...at, element: parseElement(data.element) });
      } else if (data?.type === "slop:edit-paste-request" && data.slide === selected) {
        // ⌘⇧V while typing: the clipboard's text, without its formatting.
        api
          .readClipboardText()
          .then((text) => {
            if (useApp.getState().editing && text) post({ type: "slop:edit-insert-text", text });
          })
          .catch((error) => showError(error));
      } else if (data?.type === "slop:edit-open-svg" && data.slide === selected) {
        const drawing = parseSvgOpen(data, useApp.getState().deck?.id);
        if (drawing) void useSvgEditor.getState().open(drawing);
      } else if (data?.type === "slop:edit-copied" && data.slide === selected && typeof data.html === "string") {
        api
          .copyToClipboard(data.html, String(data.text ?? ""), useApp.getState().deck?.id ?? null)
          .catch((error) => showError(error));
      } else if (data?.type === "slop:key") {
        if (data.mod)
          runHistoryKey(String(data.key), Boolean(data.shift)) ||
            runClipboardKey(String(data.key), Boolean(data.shift), false);
        else runEditKey(String(data.key));
      }
    };
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!useApp.getState().editing || target?.closest("input, textarea, select, [contenteditable]")) return;
      if (event.metaKey || event.ctrlKey) {
        if (
          runHistoryKey(event.key, event.shiftKey) ||
          runClipboardKey(event.key, event.shiftKey, true, keyForRail(target))
        )
          event.preventDefault();
      } else if (!event.altKey && runEditKey(event.key, true)) {
        event.preventDefault();
      }
    };
    // A press anywhere in the app but the edit toolbar ends typing in the slide, keeping the
    // text; the toolbar restyles the text being typed (see assets/editor/), and a press on the frame
    // is one passed on from the slide, where the editor sees it itself.
    const onPress = (event: PointerEvent) => {
      if (!useApp.getState().editing) return;
      if ((event.target as Element | null)?.closest?.("[data-edit-toolbar], iframe")) return;
      post({ type: "slop:edit-finish" });
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPress, true);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPress, true);
    };
  }, [areaRef, paste, post]);

  useImageDrops(areaRef, frame);

  const current = useApp((s) => s.selected);
  const editing = useApp((s) => s.editing);

  const closeMenu = () => {
    setMenu(null);
    frame.current?.focus();
  };
  const runMenuAction = (action: EditMenuAction) => {
    const element = menu?.element;
    closeMenu();
    if (action === "cut" || action === "copy") post({ type: "slop:edit-copy", cut: action === "cut" });
    else if (action === "paste") void paste();
    else if (action === "duplicate") post({ type: "slop:edit-duplicate" });
    else if (action === "delete") post({ type: "slop:edit-delete" });
    else if (action === "svg") post({ type: "slop:edit-open-svg" });
    else if (action === "group" || action === "ungroup") post({ type: `slop:edit-${action}` });
    else if (action === "lock" || action === "unlock") post({ type: "slop:edit-lock", locked: action === "lock" });
    else if (action === "flip-x" || action === "flip-y") {
      const look = selection?.slide === current ? selection.selection : null;
      if (!look?.flippable) return;
      post({ type: "slop:edit-style", style: action === "flip-x" ? { flipX: !look.flipX } : { flipY: !look.flipY } });
    } else if (action === "ask" || action === "tidy") {
      if (!element) return;
      // The screenshot shows the whole slide, with the element selected and the menu gone.
      resetView();
      const { askAboutElement, tidyElement } = useApp.getState();
      const handOver = action === "ask" ? askAboutElement : tidyElement;
      requestAnimationFrame(() => requestAnimationFrame(() => void handOver(element)));
    } else post({ type: "slop:edit-order", to: action });
  };

  return {
    sizeMode,
    setSizeMode: (mode: "resize" | "stretch") => {
      setSizeMode(mode);
      post({ type: "slop:edit-size-mode", mode });
    },
    /** Resizes keep the aspect ratio. */
    keepRatio,
    setKeepRatio: (on: boolean) => {
      setKeepRatio(on);
      post({ type: "slop:edit-keep-ratio", on });
    },
    overflow: editing && overflow?.slide === current ? overflow.items : NO_OVERFLOW,
    /** What the editor has selected, as its toolbar shows it. */
    selection: editing && selection?.slide === current ? selection.selection : null,
    /** Where the selection is, for the arrange controls. */
    geometry: editing && geometry?.slide === current ? geometry.geometry : null,
    /** What is on the slide, the top-most first, for the Layers panel. */
    layers: editing && layers?.slide === current ? layers.layers : NO_LAYERS,
    /** The open context menu, and what it does. */
    menu: editing ? menu : null,
    closeMenu,
    runMenuAction,
    /** Sends a message to the slide editor in the preview. */
    post,
    /** The fonts the deck uses. */
    fonts,
    /** The colors in the deck's CSS variables. */
    colors,
    /** The current slide's background color. */
    background,
    /** Picks image files: to add to the slide, or with `replace`, to put in the selected image. */
    pickImage: async (replace: boolean) => {
      const { deck, selected } = useApp.getState();
      if (!deck || !selected) return;
      await reportingErrors(async () => {
        const picked = await open({
          multiple: !replace,
          filters: [{ name: "Images", extensions: IMAGE_FILE_TYPES }],
        });
        const paths = [picked ?? []].flat();
        if (paths.length === 0) return;
        const images = await importImages(deck.id, paths);
        const now = useApp.getState();
        if (!now.editing || now.selected !== selected) return;
        if (replace && images[0]) post({ type: "slop:edit-replace-image", src: images[0].src });
        else post({ type: "slop:edit-paste-images", images });
      });
    },
    /** Gives focus back to the slide, as after typing a value into the toolbar. */
    focus: () => frame.current?.focus(),
    deleteSelection: () => post({ type: "slop:edit-delete" }),
    onFrameReady: (loaded: HTMLIFrameElement) => {
      frame.current = loaded;
      // A fresh editor starts with the select tool and nothing selected; it reports a restored
      // selection itself.
      setSelection(null);
      setGeometry(null);
      setMenu(null);
      const { editing, selected, editTool, editStyles } = useApp.getState();
      if (editing) {
        post({ type: "slop:edit-size-mode", mode: sizeMode });
        post({ type: "slop:edit-keep-ratio", on: keepRatio });
        post(toolMessage(editTool, editStyles));
      }
      const again = restore.current;
      if (editing && again && again.slide === selected) {
        const also = again.also.length > 0 ? { also: again.also } : {};
        post({ type: "slop:edit-select", path: again.path, ...also });
      }
    },
    // Takes the selection, wires and any panning out of the preview, for a screenshot of just the slide.
    clearSelection: () => {
      restore.current = null;
      resetView();
      post({ type: "slop:edit-select", path: null, quiet: true });
    },
  };
}

/**
 * Images dropped on the stage while editing are saved as assets and put on the slide where they
 * landed; anything else dropped there goes on to the chat.
 */
function useImageDrops(areaRef: RefObject<HTMLDivElement | null>, frame: RefObject<HTMLIFrameElement | null>) {
  useEffect(() => {
    const insert = (deckId: string, slide: string, paths: string[], point: DropPoint) =>
      reportingErrors(async () => {
        const images = await importImages(deckId, paths);
        const { editing, selected } = useApp.getState();
        const loaded = frame.current;
        if (!editing || selected !== slide || !loaded?.contentWindow || images.length === 0) return;
        // The preview is scaled down to fit; the editor wants the point in its own pixels.
        const at = toFramePoint(loaded, point.x, point.y);
        loaded.contentWindow.postMessage({ type: "slop:edit-insert-images", images, ...at }, "*");
      });
    const covers = (point: DropPoint) => {
      const { deck, editing, selected } = useApp.getState();
      const area = areaRef.current?.getBoundingClientRect();
      const inside =
        !!area && point.x >= area.left && point.x <= area.right && point.y >= area.top && point.y <= area.bottom;
      return !!deck && editing && !!selected && !!frame.current && inside;
    };
    return catchDrops((paths, point) => {
      const { deck, selected } = useApp.getState();
      const images = paths.filter(isImage);
      if (!deck || !selected || images.length === 0 || !covers(point)) return paths;
      void insert(deck.id, selected, images, point);
      return paths.filter((p) => !isImage(p));
    }, covers);
  }, [areaRef, frame]);
}
