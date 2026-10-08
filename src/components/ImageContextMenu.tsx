import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { errorMessage } from "../lib/api";
import { deckFileUrl } from "../lib/utils";
import { useApp } from "../store";

/** The sandbox only requests a menu; native file actions stay in the app. */
export function ImageContextMenu() {
  const deckId = useApp((s) => s.deck?.id);
  const [menu, setMenu] = useState<{
    x: number; y: number;
    save: () => Promise<void>;
    open: () => Promise<void>;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setMenu(null);
    if (!deckId) return;
    const report = (error: unknown) => useApp.getState().setError(`Could not access image: ${errorMessage(error)}`);
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "slop:image-menu" || typeof event.data.src !== "string") return;
      // An opaque sandbox has no usable origin. Check its window and the deck URL instead.
      const base = new URL(deckFileUrl(deckId, "deck.html"), location.href);
      const frame = [...document.querySelectorAll("iframe")].find((frame) =>
        frame.contentWindow === event.source && frame.src.split("?")[0] === base.href,
      );
      if (!frame) return;
      try {
        const url = new URL(event.data.src);
        const prefix = base.href.slice(0, base.href.lastIndexOf("/") + 1);
        const local = url.href.startsWith(prefix);
        if (!local && !["https:", "http:", "data:"].includes(url.protocol)) throw new Error("Unsupported image URL");
        const source = local ? decodeURIComponent(url.pathname.slice(base.pathname.lastIndexOf("/") + 1)) : url.href;
        const dataExtension = /^data:image\/(png|jpeg|gif|webp|avif|svg\+xml)[;,]/.exec(url.href)?.[1]?.replace("jpeg", "jpg").replace("svg+xml", "svg") ?? "png";
        const name = url.protocol === "data:" ? `image.${dataExtension}` : decodeURIComponent(url.pathname.split("/").pop() || "image.png");
        const action = (kind: "save" | "open") => async () => {
          try {
            if (kind === "open") {
              if (!local && url.protocol !== "data:") await openUrl(url.href);
              else await invoke("open_deck_image", { id: deckId, source });
              return;
            }
            const dest = await save({ title: "Save image", defaultPath: name });
            if (!dest) return;
            let savedSource = source;
            if (!local && url.protocol !== "data:") {
              const response = await fetch(url.href);
              if (!response.ok) throw new Error(`Image download failed (${response.status})`);
              const blob = await response.blob();
              savedSource = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.onerror = () => reject(reader.error);
                reader.readAsDataURL(blob);
              });
            }
            await invoke("save_deck_image", { id: deckId, source: savedSource, dest });
          } catch (error) { report(error); }
        };
        const rect = frame.getBoundingClientRect();
        const x = Number.isFinite(event.data.x) ? event.data.x : 24;
        const y = Number.isFinite(event.data.y) ? event.data.y : 24;
        setMenu({
          x: Math.max(8, Math.min(innerWidth - 288, rect.left + x * (rect.width / (frame.clientWidth || rect.width || 1)))),
          y: Math.max(8, Math.min(innerHeight - 92, rect.top + y * (rect.height / (frame.clientHeight || rect.height || 1)))),
          save: action("save"),
          open: action("open"),
        });
      } catch (error) { report(error); }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [deckId]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector("button")?.focus();
    const dismiss = () => setMenu(null);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [menu]);

  if (!menu) return null;
  const choose = (action: () => Promise<void>) => {
    setMenu(null);
    void action();
  };
  return createPortal(
    <div
      className="fixed inset-0 z-[100]"
      data-testid="image-menu-backdrop"
      onPointerDown={() => setMenu(null)}
      onContextMenu={(event) => { event.preventDefault(); setMenu(null); }}
    >
      <div
        ref={menuRef}
        role="menu"
        aria-label="Image actions"
        className="fixed w-[280px] rounded-lg border border-border bg-card p-1 text-sm text-foreground shadow-xl"
        style={{ left: menu.x, top: menu.y }}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (["Escape", "Tab"].includes(event.key)) {
            event.preventDefault();
            setMenu(null);
          } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const buttons = [...event.currentTarget.querySelectorAll("button")];
            const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 :
              (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
          }
        }}
      >
        <button type="button" role="menuitem" className="block w-full rounded px-3 py-2 text-left hover:bg-accent focus:bg-accent focus:outline-none" onClick={() => choose(menu.save)}>
          Download image…
        </button>
        <button type="button" role="menuitem" className="block w-full rounded px-3 py-2 text-left hover:bg-accent focus:bg-accent focus:outline-none" onClick={() => choose(menu.open)}>
          Open image in another window
        </button>
      </div>
    </div>,
    document.body,
  );
}
