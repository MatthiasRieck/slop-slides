import { open } from "@tauri-apps/plugin-dialog";
import { type RefObject, useCallback, useEffect, useMemo, useRef } from "react";

import { api } from "../../lib/api";
import { parseGeometry, parseLayers } from "../../lib/arrange";
import { catchDrops, type DropPoint, isImage } from "../../lib/drop";
import {
  type AgentInsert,
  IMAGE_FILE_TYPES,
  parseDeckColors,
  parseFonts,
  parseHexColor,
  parseMenuTarget,
  parseSelection,
} from "../../lib/editTools";
import { keepsKey } from "../../lib/keys";
import { dismissTopLayer } from "../../lib/layers";
import { noteAssetsWritten } from "../../lib/ownAssets";
import { editingSlide, reportingErrors, showError, useApp } from "../../store";
import { parseSvgOpen, useSvgEditor } from "../../svgStore";
import type { EditMenuAction } from "../EditContextMenu";
import { type EditShortcut, editShortcut, isEditTool, runEditKey, runHistoryKey, toolMessage } from "./editKeys";
import {
  editorRestarted,
  reportDeckLook,
  reportFromEditor,
  resetEditorState,
  type SizeMode,
  setEditorMenu,
  slideReport,
  useEditorState,
} from "./editorState";
import { toAppPoint, toFramePoint } from "./frames";
import { importImages, measureImages } from "./images";
import type { FrameHandler, FrameMessages } from "./messages";
import { keyForRail } from "./useSlideKeyboard";

/** A point in the slide preview's own pixels. */
interface MenuPoint {
  x: number;
  y: number;
}

/**
 * Connects the stage to the slide editor running in its preview (src-tauri/assets/editor/):
 * saves the markup it posts, keeps the selection across a reload of the slide, and
 * handles undo and leaving edit mode. Images dropped on the stage go onto the slide. The
 * editor copies elements through the system clipboard, and ⌘V pastes from it: an element
 * copied there, images (saved as assets) or text from anywhere, and ⇧⌘V the clipboard's text alone,
 * as a text box. The shortcuts on the selection work with the focus in the app as they do in the
 * slide (see `editShortcut`), and so do the arrows (nudging it) and Delete, while something is
 * selected and the focus is not in the slide list or a field. ⌘Z while typing undoes the typing
 * first. The look copied from an element is kept here, so it can be pasted on another slide.
 *
 * What the editor reports about itself (its selection, where that is, the layers, …) goes to
 * `useEditorState`, for the controls that show it to read: nothing of it is state of the stage,
 * which so does not render as the editor reports. What this gives back never changes.
 */
export function useSlideEditing(
  areaRef: RefObject<HTMLDivElement | null>,
  messages: FrameMessages,
  resetView: () => void,
) {
  // What to select again once the edited slide reloads.
  const restore = useRef<{ slide: string; path: number[]; also: number[][] } | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);

  const post = useCallback((data: unknown) => frame.current?.contentWindow?.postMessage(data, "*"), []);

  /**
   * Sets a fresh editor up as the app has it: snapping, how handles size, the tool; and selects
   * again what the last save had selected, on its slide. A fresh editor starts with nothing
   * selected, and reports a selection it restores itself.
   */
  const setUpEditor = useCallback(() => {
    editorRestarted();
    const app = useApp.getState();
    if (!editingSlide(app)) return;
    const { sizeMode, keepRatio } = useEditorState.getState();
    post({ type: "slop:edit-snap", on: app.editSnap });
    post({ type: "slop:edit-size-mode", mode: sizeMode });
    post({ type: "slop:edit-keep-ratio", on: keepRatio });
    post(toolMessage(app.editTool, app.editStyles));
    const again = restore.current;
    if (again && again.slide === app.selected) {
      const also = again.also.length > 0 ? { also: again.also } : {};
      post({ type: "slop:edit-select", path: again.path, ...also });
    }
  }, [post]);

  /**
   * Pastes from the clipboard: where pastes go, or with `at` (a point in the preview), centered
   * there. With `plain`, only its text, as a text box; without any text there, what it holds.
   */
  const paste = useCallback(
    async (at?: MenuPoint, plain = false) => {
      const { deck, selected } = useApp.getState();
      if (!deck || !editingSlide(useApp.getState()) || !selected) return;
      await reportingErrors(async () => {
        if (plain) {
          const text = await api.readClipboardText();
          const now = useApp.getState();
          if (!editingSlide(now) || now.selected !== selected) return;
          if (text.trim()) {
            post({ type: "slop:edit-paste-text", text, style: now.editStyles.text, ...at });
            return;
          }
        }
        const pasted = await api.pasteFromClipboard(deck.id);
        const loaded = frame.current;
        const now = useApp.getState();
        if (!editingSlide(now) || now.selected !== selected || !loaded?.contentWindow) return;
        if (pasted.kind === "element") {
          // The editor puts it where it was copied from, unless the menu says where.
          loaded.contentWindow.postMessage({ type: "slop:edit-paste", html: pasted.html, ...at }, "*");
        } else if (pasted.kind === "text") {
          loaded.contentWindow.postMessage(
            { type: "slop:edit-paste-text", text: pasted.text, style: now.editStyles.text, ...at },
            "*",
          );
        } else if (pasted.kind === "slide") {
          await useApp.getState().pasteSlides();
        } else if (pasted.kind === "images") {
          // The backend saved them as assets: files the app wrote, which no preview need load again for.
          const images = await measureImages(deck.id, noteAssetsWritten(deck.id, pasted.images));
          // The editor puts them where the pointer is, or in the middle of the view.
          loaded.contentWindow.postMessage({ type: "slop:edit-paste-images", images, ...at }, "*");
        }
      });
    },
    [post],
  );

  useEffect(() => {
    /** Gives the selection the look copied last, if any. */
    const pasteStyle = () => {
      const { copiedStyle } = useApp.getState();
      if (copiedStyle) post({ type: "slop:edit-paste-style", style: copiedStyle });
    };
    /** Does what a shortcut on the selection asks for (see `editShortcut`). */
    const runShortcut = (shortcut: EditShortcut) => {
      const { selection } = slideReport();
      if ("post" in shortcut) post(shortcut.post);
      else if ("pasteStyle" in shortcut) pasteStyle();
      else if ("panel" in shortcut) useApp.getState().askForEditPanel(shortcut.panel);
      else if (selection) post({ type: "slop:edit-lock", locked: !selection.locked });
    };
    /** ⌘C / ⌘X / ⌘V while editing; `fromApp` when pressed outside the slide. True when handled. */
    const runClipboardKey = (key: string, shift: boolean, fromApp: boolean, rail = false) => {
      const lower = key.toLowerCase();
      // ⇧⌘V pastes the clipboard's text alone, as it does into text being typed.
      if (shift && lower === "v") {
        void paste(undefined, true);
        return true;
      }
      if (shift) return false;
      // Pressed on the slide rail, these mean the slides picked there (see useSlideKeyboard).
      if (fromApp && rail && ["a", "c", "d", "x"].includes(lower)) return false;
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
      // first.
      if ((lower === "c" || lower === "x") && fromApp && !window.getSelection()?.toString()) {
        post({ type: "slop:edit-copy", cut: lower === "x" });
        return true;
      }
      return false;
    };
    /** A handler of what the editor says about the slide it is at work on; anything else it is not handed. */
    const aboutSlide =
      (handle: FrameHandler): FrameHandler =>
      (data, event) => {
        const app = useApp.getState();
        if (editingSlide(app) && data.slide === app.selected) handle(data, event);
      };
    const offMessages = messages.on({
      // The editor came to a page that had loaded without it (see ./stageDocument.ts).
      "slop:edit-attached": aboutSlide(() => setUpEditor()),
      "slop:edit-commit": aboutSlide((data) => {
        if (typeof data.markup !== "string") return;
        restore.current = Array.isArray(data.select)
          ? { slide: data.slide, path: data.select, also: Array.isArray(data.also) ? data.also : [] }
          : null;
        const group = typeof data.group === "string" ? data.group : undefined;
        void useApp.getState().saveSlideEdit(data.slide, data.markup, group);
      }),
      "slop:edit-overflow": aboutSlide((data) => {
        if (Array.isArray(data.items)) reportFromEditor(data.slide, "overflow", data.items.map(String));
      }),
      // The editor reports these on every keystroke and move of the caret, and with every frame
      // of a drag: mostly the same thing, which the store then keeps as it is.
      "slop:edit-selection": aboutSlide((data) =>
        reportFromEditor(data.slide, "selection", parseSelection(data.selection)),
      ),
      "slop:edit-geometry": aboutSlide((data) =>
        reportFromEditor(data.slide, "geometry", parseGeometry(data.geometry)),
      ),
      "slop:edit-layers": aboutSlide((data) => reportFromEditor(data.slide, "layers", parseLayers(data.layers))),
      // The editor put its tool away by itself (after adding a shape, or on Escape).
      "slop:edit-tool": aboutSlide((data) => {
        if (typeof data.tool === "string" && isEditTool(data.tool)) useApp.getState().setEditTool(data.tool);
      }),
      "slop:edit-fonts": aboutSlide((data) => reportDeckLook({ fonts: parseFonts(data.fonts) })),
      "slop:edit-colors": aboutSlide((data) => reportDeckLook({ colors: parseDeckColors(data.colors) })),
      "slop:edit-background": aboutSlide((data) =>
        reportDeckLook({
          background: parseHexColor(data.color),
          backgroundOther: data.other === true,
          backgroundOwn: data.own === true,
        }),
      ),
      "slop:edit-menu": aboutSlide((data) => {
        // The preview is scaled down to fit; the editor gives the point in its own pixels.
        const at = { x: Number(data.x), y: Number(data.y) };
        setEditorMenu({ ...toAppPoint(frame.current, at.x, at.y), at, ...parseMenuTarget(data) });
      }),
      "slop:edit-style-copied": aboutSlide((data) => useApp.getState().setCopiedStyle(data.style ?? null)),
      // What the editor's shortcuts need the app for: its Link popover, and the look it keeps.
      "slop:edit-request": aboutSlide((data) => {
        if (data.what === "link") useApp.getState().askForEditPanel("link");
        // A double-click on an image: "Replace image…", as the toolbar and the menu have it.
        else if (data.what === "replace-image") useApp.getState().askForEditPanel("replace-image");
        else if (data.what === "paste-style") pasteStyle();
      }),
      // ⌘⇧V while typing: the clipboard's text, without its formatting.
      "slop:edit-paste-request": aboutSlide(() => {
        api
          .readClipboardText()
          .then((text) => {
            if (editingSlide(useApp.getState()) && text) post({ type: "slop:edit-insert-text", text });
          })
          .catch((error) => showError(error, { doing: "Could not paste the text" }));
      }),
      "slop:edit-open-svg": aboutSlide((data) => {
        const drawing = parseSvgOpen(data, useApp.getState().deck?.id);
        if (drawing) void useSvgEditor.getState().open(drawing);
      }),
      "slop:edit-copied": aboutSlide((data) => {
        if (typeof data.html !== "string") return;
        api
          .copyToClipboard(data.html, String(data.text ?? ""), useApp.getState().deck?.id ?? null)
          .catch((error) => showError(error, { doing: "Could not copy" }));
      }),
      "slop:key": (data, event) => {
        if (!editingSlide(useApp.getState())) return;
        // Escape closes what is open in the app before it puts a tool away.
        if (data.key === "Escape" && dismissTopLayer(event)) return;
        if (data.mod)
          runHistoryKey(String(data.key), Boolean(data.shift)) ||
            runClipboardKey(String(data.key), Boolean(data.shift), false);
        else runEditKey(String(data.key));
      },
    });
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!editingSlide(useApp.getState()) || keepsKey(event)) return;
      if (event.metaKey || event.ctrlKey) {
        const shortcut = editShortcut(event);
        const history = !event.altKey && /^[zy]$/i.test(event.key);
        if (shortcut) {
          event.preventDefault();
          runShortcut(shortcut);
        } else if (event.altKey) {
          // Nothing else here goes with Alt.
        } else if (history && slideReport().selection?.editing) {
          // While typing (the toolbar may have the focus), the typing's own steps come first.
          event.preventDefault();
          post({ type: "slop:edit-undo", redo: event.shiftKey || event.key.toLowerCase() === "y" });
        } else if (
          runHistoryKey(event.key, event.shiftKey) ||
          runClipboardKey(event.key, event.shiftKey, true, keyForRail(target))
        )
          event.preventDefault();
      } else if (!event.altKey && runEditKey(event.key)) {
        event.preventDefault();
      }
    };
    // With the focus in the app (after a button, a popover, the Layers panel), the arrows and
    // Delete still go to what is selected on the slide, as in the slide itself; before the slides'
    // keys (see useSlideKeyboard), which have them otherwise. Not in the slide list, a field or a
    // widget that moves through its parts with them, and Delete not while slides are picked there.
    const onSelectionKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const app = useApp.getState();
      if (!editingSlide(app) || app.presenting || keepsKey(event) || keyForRail(event.target)) return;
      const { selection } = slideReport();
      if (!selection || selection.editing) return;
      const deletes = event.key === "Delete" || event.key === "Backspace";
      if (!event.key.startsWith("Arrow") && !(deletes && app.railSelected.length === 0)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      post({ type: "slop:edit-key", key: event.key, shift: event.shiftKey });
    };
    // A press anywhere in the app but the edit toolbar ends typing in the slide, keeping the
    // text; the toolbar restyles the text being typed (see assets/editor/), and a press in the
    // slide is the editor's to see.
    const onPress = (event: PointerEvent) => {
      if (!editingSlide(useApp.getState())) return;
      if ((event.target as Element | null)?.closest?.("[data-edit-toolbar], iframe")) return;
      post({ type: "slop:edit-finish" });
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keydown", onSelectionKey, true);
    window.addEventListener("pointerdown", onPress, true);
    return () => {
      offMessages();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", onSelectionKey, true);
      window.removeEventListener("pointerdown", onPress, true);
    };
  }, [messages, paste, post, setUpEditor]);

  // What the editor said is the stage's while it is there.
  useEffect(() => resetEditorState, []);

  useImageDrops(areaRef, frame);

  // The editor snaps as the toolbar's toggle says, on every slide.
  const editing = useApp(editingSlide);
  const snap = useApp((s) => s.editSnap);
  useEffect(() => {
    if (editing) post({ type: "slop:edit-snap", on: snap });
  }, [editing, snap, post]);

  return useMemo(() => {
    /** Runs `then` once the view is back on the whole slide and has painted, for a screenshot of it. */
    const afterResetView = (then: () => void) => {
      resetView();
      requestAnimationFrame(() => requestAnimationFrame(then));
    };
    const closeMenu = () => {
      setEditorMenu(null);
      frame.current?.focus();
    };
    return {
      setSizeMode: (sizeMode: SizeMode) => {
        useEditorState.setState({ sizeMode });
        post({ type: "slop:edit-size-mode", mode: sizeMode });
      },
      setKeepRatio: (keepRatio: boolean) => {
        useEditorState.setState({ keepRatio });
        post({ type: "slop:edit-keep-ratio", on: keepRatio });
      },
      closeMenu,
      /** Does what a choice of the open context menu asks for, and closes it. */
      runMenuAction: (action: EditMenuAction) => {
        const opened = useEditorState.getState().menu;
        const element = opened?.element;
        closeMenu();
        if (action === "cut" || action === "copy") post({ type: "slop:edit-copy", cut: action === "cut" });
        // Where the menu was opened, not where the pointer went to pick "Paste".
        else if (action === "paste") void paste(opened?.at);
        else if (action === "edit-text") post({ type: "slop:edit-edit-text" });
        else if (action === "select-all") post({ type: "slop:edit-select-all" });
        else if (action === "select-parent") {
          if (opened?.parent) post({ type: "slop:edit-select", path: opened.parent.path });
        } else if (action.startsWith("select-under-")) {
          const pick = opened?.under[Number(action.slice("select-under-".length))];
          if (pick) post({ type: "slop:edit-select", path: pick.path });
        } else if (action === "unlock-all") post({ type: "slop:edit-unlock-all" });
        else if (action === "copy-style") post({ type: "slop:edit-copy-style" });
        else if (action === "paste-style")
          post({ type: "slop:edit-paste-style", style: useApp.getState().copiedStyle });
        else if (action === "background") useApp.getState().askForEditPanel("background");
        else if (action === "link" || action === "position" || action === "replace-image")
          useApp.getState().askForEditPanel(action);
        else if (action === "rotate-right" || action === "rotate-left")
          post({ type: "slop:edit-rotate", step: action === "rotate-right" ? 1 : -1 });
        else if (action.startsWith("align-")) post({ type: "slop:edit-align", to: action.slice("align-".length) });
        else if (action === "distribute-h" || action === "distribute-v")
          post({ type: "slop:edit-distribute", axis: action === "distribute-h" ? "h" : "v" });
        else if (action === "duplicate") post({ type: "slop:edit-duplicate" });
        else if (action === "delete") post({ type: "slop:edit-delete" });
        else if (action === "svg") post({ type: "slop:edit-open-svg" });
        else if (action === "group" || action === "ungroup") post({ type: `slop:edit-${action}` });
        else if (action === "lock" || action === "unlock") post({ type: "slop:edit-lock", locked: action === "lock" });
        else if (action === "flip-x" || action === "flip-y") {
          post({ type: "slop:edit-flip", axis: action === "flip-x" ? "x" : "y" });
        } else if (action === "ask" || action === "tidy") {
          if (!opened || !element) return;
          // The screenshot shows the whole slide, with the selection and the menu gone.
          const { askAboutElements, tidyElement } = useApp.getState();
          const handOver = action === "ask" ? () => askAboutElements(opened.elements) : () => tidyElement(element);
          afterResetView(() => void handOver());
        } else post({ type: "slop:edit-order", to: action });
      },
      /** Sends a message to the slide editor in the preview. */
      post,
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
          if (!editingSlide(now) || now.selected !== selected) return;
          if (replace && images[0]) post({ type: "slop:edit-replace-image", src: images[0].src });
          else post({ type: "slop:edit-paste-images", images });
        });
      },
      /** Starts a request to the agent for a table, chart or icon, with a screenshot of the whole slide. */
      askForInsert: (kind: AgentInsert) => afterResetView(() => void useApp.getState().askForInsert(kind)),
      /** Gives focus back to the slide, as after typing a value into the toolbar. */
      focus: () => frame.current?.focus(),
      onFrameReady: (loaded: HTMLIFrameElement, warmed = false) => {
        frame.current = loaded;
        // One that loaded ahead out of sight (or was kept since it was last shown) starts over
        // as a fresh editor does, and says again what it reported, unheard, meanwhile.
        if (warmed) post({ type: "slop:edit-show" });
        setUpEditor();
      },
      // Takes the selection, wires and any panning out of the preview, for a screenshot of just the slide.
      clearSelection: () => {
        restore.current = null;
        resetView();
        post({ type: "slop:edit-select", path: null, quiet: true });
      },
    };
  }, [paste, post, resetView, setUpEditor]);
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
        const { selected } = useApp.getState();
        const editing = editingSlide(useApp.getState());
        const loaded = frame.current;
        if (!editing || selected !== slide || !loaded?.contentWindow || images.length === 0) return;
        // The preview is scaled down to fit; the editor wants the point in its own pixels.
        const at = toFramePoint(loaded, point.x, point.y);
        loaded.contentWindow.postMessage({ type: "slop:edit-insert-images", images, ...at }, "*");
      });
    const covers = (point: DropPoint) => {
      const { deck, selected } = useApp.getState();
      const editing = editingSlide(useApp.getState());
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
