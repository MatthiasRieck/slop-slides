import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/** Keep composer menus outside container-query and scroll compositing layers. */
export function ComposerPopover({ anchor, onClose, width, className, children }: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  width: number;
  className: string;
  children: ReactNode;
}) {
  const popup = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });

  useLayoutEffect(() => {
    const place = () => {
      if (!anchor.current) return;
      const rect = anchor.current.getBoundingClientRect();
      const margin = 8;
      const popupWidth = Math.min(width, window.innerWidth - margin * 2);
      const above = rect.top - margin * 2;
      const below = window.innerHeight - rect.bottom - margin * 2;
      const opensAbove = above >= below;
      setPosition({
        width: popupWidth,
        left: Math.max(margin, Math.min(rect.left, window.innerWidth - popupWidth - margin)),
        ...(opensAbove
          ? { bottom: window.innerHeight - rect.top + margin }
          : { top: rect.bottom + margin }),
        maxHeight: Math.max(0, opensAbove ? above : below),
      });
    };
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!anchor.current?.contains(target) && !popup.current?.contains(target)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    place();
    const observer = new ResizeObserver(place);
    // Panel resizing and textarea resizing can move the button without changing its size.
    for (let element = anchor.current; element; element = element.parentElement) observer.observe(element);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [anchor, onClose, width]);

  return createPortal(
    <div ref={popup} style={position} className={`fixed z-50 overflow-y-auto rounded-xl border bg-card text-foreground shadow-xl shadow-black/20 ${className}`}>
      {children}
    </div>,
    document.body,
  );
}
