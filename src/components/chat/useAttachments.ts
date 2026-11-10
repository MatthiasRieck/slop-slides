import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import type React from "react";
import { useEffect, useState } from "react";

import { api } from "../../lib/api";
import { claimDrop, dropCovered, dropPoint, isImage } from "../../lib/drop";
import type { EditElement } from "../../lib/editTools";
import { basename, dirname } from "../../lib/utils";
import { relativePath, showError, useApp } from "../../store";
import { pastedName, readBase64 } from "./pastedFiles";

/**
 * What goes along with the composer's message besides its text: files picked, pasted, dropped
 * on the window or handed over by the app (saved as assets of the deck, or of the workspace
 * without one), a slide screenshot and the element on the slide a prepared message is about.
 */
export function useAttachments() {
  const deck = useApp((s) => s.deck);
  const workspace = useApp((s) => s.workspace);
  const assetTarget = deck?.id ?? workspace?.path;
  const assetPrefix = deck && workspace ? dirname(relativePath(workspace, deck.id) ?? basename(deck.id)) : "";
  const attachmentRef = (path: string) => (assetPrefix ? `${assetPrefix}/${path}` : path);
  const [attachments, setAttachments] = useState<string[]>([]);
  // A slide screenshot handed over with a prepared message (Tidy layout), shown with the images.
  const [screenshot, setScreenshot] = useState<string | null>(null);
  // The element on the slide a prepared message is about.
  const [element, setElement] = useState<EditElement | null>(null);
  const [dragging, setDragging] = useState(false);

  /** Attaches `paths`, leaving out those already attached. */
  const add = (paths: string[]) => setAttachments((prev) => [...prev, ...paths.filter((a) => !prev.includes(a))]);

  // Images show as previews in a fan behind the composer; other files stay chips.
  const images = [...(screenshot ? [screenshot] : []), ...attachments.filter(isImage)];
  const files = attachments.filter((a) => !isImage(a));
  const remove = (path: string) => {
    if (path === screenshot) setScreenshot(null);
    else setAttachments((prev) => prev.filter((p) => p !== path));
  };
  const clear = () => {
    setAttachments([]);
    setScreenshot(null);
    setElement(null);
  };

  // A prepared message brings its own screenshot and element, or none.
  const composerFill = useApp((s) => s.composerFill);
  useEffect(() => {
    if (composerFill) {
      setScreenshot(composerFill.screenshot ?? null);
      setElement(composerFill.element ?? null);
    }
  }, [composerFill]);

  // Screenshots of areas commented on, handed over while the composer was or wasn't shown.
  const composerImages = useApp((s) => s.composerImages);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when images are handed over
  useEffect(() => {
    if (composerImages.length === 0) return;
    add(useApp.getState().takeComposerImages());
  }, [composerImages]);

  const importPaths = async (paths: string[]) => {
    if (!assetTarget || paths.length === 0) return;
    try {
      add((await api.importAssets(assetTarget, paths)).map(attachmentRef));
    } catch (error) {
      showError(error);
    }
  };

  // Images pasted into the composer are saved as assets and attached.
  const pasteImages = async (files: File[]) => {
    if (!assetTarget) return;
    try {
      const saved: string[] = [];
      for (const file of files) {
        saved.push(attachmentRef(await api.saveAsset(assetTarget, pastedName(file), await readBase64(file))));
      }
      add(saved);
    } catch (error) {
      showError(error);
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    // Keep any text that came along (e.g. an image copied from a web page has none worth pasting).
    if (!e.clipboardData.getData("text/plain")) e.preventDefault();
    void pasteImages(images);
  };

  // Files dropped anywhere on the window become attachments, unless something there (like the
  // slide being edited) takes them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-register so drops import into the current asset target
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over" || event.payload.type === "enter")
          setDragging(!dropCovered(dropPoint(event.payload.position)));
        else if (event.payload.type === "leave") setDragging(false);
        else if (event.payload.type === "drop") {
          setDragging(false);
          void importPaths(claimDrop(event.payload.paths, dropPoint(event.payload.position)));
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [assetTarget]);

  const pickFiles = async () => {
    const picked = await open({
      multiple: true,
      filters: [
        {
          name: "Images & media",
          extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "mp4", "webm", "pdf", "csv", "md", "txt"],
        },
      ],
    });
    if (picked) await importPaths(Array.isArray(picked) ? picked : [picked]);
  };

  return {
    attachments,
    screenshot,
    setScreenshot,
    element,
    setElement,
    images,
    files,
    dragging,
    add,
    remove,
    clear,
    onPaste,
    pickFiles,
  };
}
