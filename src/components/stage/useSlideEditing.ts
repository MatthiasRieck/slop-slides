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
  parseTheme,
} from "../../lib/editTools";
import { FRAME_LOAD_LIMIT } from "../../lib/frameLoads";
import { keepsKey } from "../../lib/keys";
import { dismissTopLayer } from "../../lib/layers";
import { noteAssetsWritten } from "../../lib/ownAssets";
import {
  editingSlide,
  editsSaved,
  reportingErrors,
  SKETCH_TARGET_ATTR,
  showError,
  showInfo,
  stageSlides,
  undoNewestChange,
  useApp,
} from "../../store";
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

/** An element on its way from one of the slides shown side by side to another (see `useSlideEditing`). */
interface Transfer {
  /** The deck the two slides are in. */
  deck: string;
  from: string;
  to: string;
  /** The element as the editor copies it, and where on the other slide it goes; null where it was. */
  html: string;
  x: number | null;
  y: number | null;
  /** What the two saves of the move share, so that one undo takes back both. */
  group: string;
  /**
   * The save of its own slide without it, resolving to whether it was saved; null for a copy
   * dragged over, which leaves that slide as it was.
   */
  removal: Promise<boolean> | null;
  /**
   * How far it is. Its own slide is `saving` without it, then the other slide's editor is
   * `loading`, then that editor has it (`pasted`), then the other slide is saving with it
   * (`landing`). Then it is `over`, as it is once it was given up.
   */
  phase: "saving" | "loading" | "pasted" | "landing" | "over";
  /** Runs out when the other slide's editor is too long in loading, or in saying what it made of the element. */
  timer: ReturnType<typeof setTimeout> | null;
}

/** The group the deck's history keeps the saves of `transfer` under (see `slide_edit` in src-tauri/src/commands/deck.rs). */
const historyGroup = (transfer: Transfer) => `edit:${transfer.group}`;

/** How the deck's history labels a slide edit (see src-tauri/src/commands/deck.rs). */
const EDIT_SLIDE_LABEL = "Edit slide";

/** A whole number of slide pixels, or null. */
const pixelOrNull = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * Connects the stage to the slide editor running in its preview (src-tauri/assets/editor/):
 * saves the markup it posts, keeps the selection across a reload of the slide, and
 * handles undo and leaving edit mode. Images dropped on the stage go onto the slide. The
 * editor copies elements through the system clipboard, and ⌘V pastes from it: an element
 * copied there, images (saved as assets) or text from anywhere. The shortcuts on the selection
 * work with the focus in the app as they do in the slide (see `editShortcut`), and the look copied
 * from an element is kept here, so it can be pasted on another slide.
 *
 * With several slides side by side, an element dropped on another one moves there
 * (`slop:edit-transfer`): its own slide is saved without it first, then the other slide becomes
 * the one worked on, and its editor, once loaded, is handed the element (`slop:edit-paste`). The
 * other slide's editor is loaded only then, so it knows the element is gone from the first and
 * keeps its ids. The move is done once the other slide is saved with the element. Until then it
 * is given up as soon as it cannot get there (the editor does not load or save in time, the save
 * fails, the user goes elsewhere or undoes, the stage goes away), and the first slide gets the
 * element back: the save that took it off is undone, and no other change (see `undoNewest`).
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

  // The element being moved to another slide, until that slide saves with it; and the last save of a slide.
  const moving = useRef<Transfer | null>(null);
  const lastSave = useRef<{ group: string | null; saved: Promise<boolean> } | null>(null);
  const endTransfer = useCallback((transfer: Transfer) => {
    if (transfer.timer) clearTimeout(transfer.timer);
    transfer.timer = null;
    transfer.phase = "over";
    if (moving.current === transfer) moving.current = null;
  }, []);
  /** The element did not get to the other slide: its own slide gets it back. */
  const failTransfer = useCallback(
    async (transfer: Transfer) => {
      if (transfer.phase === "over") return;
      endTransfer(transfer);
      if (transfer.removal) {
        // Its slide was not saved without it, which is reported and loads the slide again as it was: nothing moved.
        if (!(await transfer.removal)) return;
        // That save is what is undone, and nothing else: not the change before it, should the user
        // have undone the save already, nor a change in another deck.
        const only = { deck: transfer.deck, group: historyGroup(transfer) };
        if (!(await undoNewestChange(EDIT_SLIDE_LABEL, "move", only))) {
          if (useApp.getState().deck?.id !== transfer.deck) {
            showError(
              "The element did not get to the other slide before its deck closed. Undo in that deck puts it back.",
            );
          }
          return;
        }
      }
      showError("The element could not be moved to the other slide; it is where it was.");
    },
    [endTransfer],
  );
  /** Gives up on the element if nothing more is heard of it for as long as a slide may take to load. */
  const awaitTransfer = useCallback(
    (transfer: Transfer) => {
      if (transfer.timer) clearTimeout(transfer.timer);
      transfer.timer = setTimeout(() => void failTransfer(transfer), FRAME_LOAD_LIMIT);
    },
    [failTransfer],
  );
  /** Moves what the editor took off its slide to the slide it was dropped on. */
  const startTransfer = useCallback(
    async (transfer: Transfer) => {
      // One at a time: while an element is on its way, the next one goes back to its slide. One
      // the other slide is saving with is as good as there, and ends with that save.
      const before = moving.current;
      if (before && before.phase !== "landing") return void failTransfer(transfer);
      moving.current = transfer;
      // The other slide's editor must load a deck in which the element is off this one.
      await editsSaved();
      const removed = transfer.removal === null || (await transfer.removal);
      if (transfer.phase !== "saving") return;
      // The save failed, which is reported and loads the slide again as it was: nothing moved.
      if (!removed) return endTransfer(transfer);
      const app = useApp.getState();
      const target = app.deck?.slides.find((slide) => slide.id === transfer.to);
      const shown = stageSlides(app).includes(transfer.to) && transfer.to !== transfer.from;
      if (!shown || !target || target.locked) return void failTransfer(transfer);
      transfer.phase = "loading";
      awaitTransfer(transfer);
      app.activateSlide(transfer.to);
    },
    [awaitTransfer, endTransfer, failTransfer],
  );
  // A move is given up as soon as it cannot be completed: the stage is on another slide than the
  // one the move is at (the user went there, or undid the save, which shows its slide), on another
  // deck, not editing any more, or gone. Once the other slide is saving with the element, that
  // save alone decides: undoing then would take back a move that was made.
  useEffect(() => {
    const giveUp = () => {
      const transfer = moving.current;
      if (transfer && transfer.phase !== "landing") void failTransfer(transfer);
    };
    const offStore = useApp.subscribe((app) => {
      const transfer = moving.current;
      if (!transfer) return;
      const at = transfer.phase === "saving" ? transfer.from : transfer.to;
      if (app.deck?.id !== transfer.deck || app.selected !== at || !editingSlide(app)) giveUp();
    });
    return () => {
      offStore();
      giveUp();
    };
  }, [failTransfer]);

  /** Pastes from the clipboard: where pastes go, or with `at` (a point in the preview), centered there. */
  const paste = useCallback(async (at?: MenuPoint) => {
    const { deck, selected } = useApp.getState();
    if (!deck || !editingSlide(useApp.getState()) || !selected) return;
    await reportingErrors(async () => {
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
  }, []);

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
      "slop:edit-commit": aboutSlide((data) => {
        if (typeof data.markup !== "string") return;
        restore.current = Array.isArray(data.select)
          ? { slide: data.slide, path: data.select, also: Array.isArray(data.also) ? data.also : [] }
          : null;
        const group = typeof data.group === "string" ? data.group : undefined;
        const transfer = moving.current;
        const landing = transfer?.phase === "pasted" && transfer.to === data.slide ? transfer : null;
        if (landing) {
          // The slide an element was moved to saves with it: the move is done once that is saved.
          landing.phase = "landing";
          if (landing.timer) clearTimeout(landing.timer);
          landing.timer = null;
        }
        // An undo on its way as the element landed took it back to its own slide: it is not saved on this one too.
        const undone = () => !!landing?.removal && useApp.getState().history?.redo?.group === historyGroup(landing);
        const save = useApp.getState().saveSlideEdit;
        const saved = landing
          ? save(data.slide, data.markup, group, () => !undone())
          : save(data.slide, data.markup, group);
        lastSave.current = { group: group ?? null, saved };
        if (!landing) return;
        void saved.then((landed) => {
          if (landed) endTransfer(landing);
          else void failTransfer(landing);
        });
      }),
      // An element was dropped on another of the slides shown, or sent there from the menu. The
      // save of its own slide without it, if there was one, came just before.
      "slop:edit-transfer": aboutSlide((data) => {
        const deck = useApp.getState().deck?.id;
        if (!deck || typeof data.to !== "string" || typeof data.html !== "string") return;
        const group = typeof data.group === "string" ? data.group : "";
        const last = lastSave.current;
        void startTransfer({
          deck,
          from: data.slide,
          to: data.to,
          html: data.html,
          x: pixelOrNull(data.x),
          y: pixelOrNull(data.y),
          group,
          removal: last && group !== "" && last.group === group ? last.saved : null,
          phase: "saving",
          timer: null,
        });
      }),
      "slop:edit-transfer-refused": aboutSlide((data) => {
        const slides = useApp.getState().deck?.slides ?? [];
        const number = slides.findIndex((slide) => slide.id === data.to) + 1;
        showInfo(`Slide ${number > 0 ? `${number} ` : ""}is locked: nothing can be moved onto it.`);
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
      "slop:edit-background": aboutSlide((data) => reportDeckLook({ background: parseHexColor(data.color) })),
      // The slide's primary colors: what the tools add starts out in them.
      "slop:edit-theme": aboutSlide((data) => {
        const theme = parseTheme(data.theme);
        if (theme) useApp.getState().setEditTheme(theme);
      }),
      "slop:edit-menu": aboutSlide((data) => {
        // The preview is scaled down to fit; the editor gives the point in its own pixels.
        const at = { x: Number(data.x), y: Number(data.y) };
        setEditorMenu({ ...toAppPoint(frame.current, at.x, at.y), at, ...parseMenuTarget(data) });
      }),
      "slop:edit-style-copied": aboutSlide((data) => useApp.getState().setCopiedStyle(data.style ?? null)),
      // What the editor's shortcuts need the app for: its Link popover, and the look it keeps.
      "slop:edit-request": aboutSlide((data) => {
        if (data.what === "link") useApp.getState().askForEditPanel("link");
        else if (data.what === "paste-style") pasteStyle();
      }),
      // ⌘⇧V while typing: the clipboard's text, without its formatting.
      "slop:edit-paste-request": aboutSlide(() => {
        api
          .readClipboardText()
          .then((text) => {
            if (editingSlide(useApp.getState()) && text) post({ type: "slop:edit-insert-text", text });
          })
          .catch((error) => showError(error));
      }),
      "slop:edit-open-svg": aboutSlide((data) => {
        const drawing = parseSvgOpen(data, useApp.getState().deck?.id);
        if (drawing) void useSvgEditor.getState().open(drawing);
      }),
      "slop:edit-copied": aboutSlide((data) => {
        if (typeof data.html !== "string") return;
        api
          .copyToClipboard(data.html, String(data.text ?? ""), useApp.getState().deck?.id ?? null)
          .catch((error) => showError(error));
      }),
      "slop:key": (data, event) => {
        if (!editingSlide(useApp.getState())) return;
        // Escape closes what is open in the app before it puts a tool away or leaves edit mode.
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
        if (shortcut) {
          event.preventDefault();
          runShortcut(shortcut);
        } else if (event.altKey) {
          // Nothing else here goes with Alt.
        } else if (
          runHistoryKey(event.key, event.shiftKey) ||
          runClipboardKey(event.key, event.shiftKey, true, keyForRail(target))
        )
          event.preventDefault();
      } else if (!event.altKey && runEditKey(event.key, true)) {
        event.preventDefault();
      }
    };
    // A press anywhere in the app but the edit toolbar ends typing in the slide, keeping the
    // text; the toolbar restyles the text being typed (see assets/editor/), and a press in the
    // slide is the editor's to see. The toolbar's popups render into the body, and are marked as
    // the toolbar's (`TOOLBAR_POPUP` in ../toolProps.ts).
    const onPress = (event: PointerEvent) => {
      if (!editingSlide(useApp.getState())) return;
      if ((event.target as Element | null)?.closest?.("[data-edit-toolbar], iframe")) return;
      post({ type: "slop:edit-finish" });
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPress, true);
    return () => {
      offMessages();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPress, true);
    };
  }, [messages, paste, post, endTransfer, failTransfer, startTransfer]);

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
      /** Moves the selection to `slide`, another of the slides shown side by side, where it was on its own. */
      moveToSlide: (slide: string) => {
        closeMenu();
        post({ type: "slop:edit-move-to", to: slide });
      },
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
        else if (action === "unlock-all") post({ type: "slop:edit-unlock-all" });
        else if (action === "copy-style") post({ type: "slop:edit-copy-style" });
        else if (action === "paste-style")
          post({ type: "slop:edit-paste-style", style: useApp.getState().copiedStyle });
        else if (action === "background") useApp.getState().askForEditPanel("background");
        else if (action === "screenshot") void useApp.getState().copySlideScreenshot();
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
      deleteSelection: () => post({ type: "slop:edit-delete" }),
      onFrameReady: (loaded: HTMLIFrameElement) => {
        frame.current = loaded;
        // A fresh editor starts with the select tool and nothing selected; it reports a restored
        // selection itself.
        editorRestarted();
        const { selected, editTool, editStyles, editSnap } = useApp.getState();
        const { sizeMode, keepRatio } = useEditorState.getState();
        const editing = editingSlide(useApp.getState());
        if (editing) {
          post({ type: "slop:edit-snap", on: editSnap });
          post({ type: "slop:edit-size-mode", mode: sizeMode });
          post({ type: "slop:edit-keep-ratio", on: keepRatio });
          post(toolMessage(editTool, editStyles));
        }
        const again = restore.current;
        if (editing && again && again.slide === selected) {
          const also = again.also.length > 0 ? { also: again.also } : {};
          post({ type: "slop:edit-select", path: again.path, ...also });
        }
        // The editor of the slide an element is moving to is up: it takes the element from here.
        const transfer = moving.current;
        const edits = /&edit=/.test(loaded.getAttribute("src") ?? "");
        if (editing && edits && transfer?.phase === "loading" && transfer.to === selected) {
          transfer.phase = "pasted";
          awaitTransfer(transfer);
          const { html, x, y, group } = transfer;
          post({ type: "slop:edit-paste", html, x, y, space: "slide", group });
        }
      },
      // Takes the selection, wires and any panning out of the preview, for a screenshot of just the slide.
      clearSelection: () => {
        restore.current = null;
        resetView();
        post({ type: "slop:edit-select", path: null, quiet: true });
      },
    };
  }, [paste, post, resetView, awaitTransfer]);
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
      // Of several slides side by side, only the one worked on takes them: its editor is the one there is.
      const several = stageSlides(useApp.getState()).length > 1;
      const box = several ? areaRef.current?.querySelector(`[${SKETCH_TARGET_ATTR}]`) : areaRef.current;
      const area = box?.getBoundingClientRect();
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
