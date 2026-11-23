// What the browser tells a conversation of its sizes, by hand: jsdom lays nothing out, so a
// `MessageScroller` there is always at its end, with nothing to scroll.
import { act, fireEvent } from "@testing-library/react";
import { vi } from "vitest";

const VIEWPORT = "[data-slot=message-scroller-viewport]";
const ITEM = "[data-slot=message-scroller-item]";

const slotOf = (element: unknown) => (element as HTMLElement).dataset?.slot;

/**
 * Lays conversations out for the test that calls it, before it renders one: every message is
 * `each` pixels tall, one under the other, in a box that shows `shown` pixels of them. Both can
 * be changed later (`size`). Scrolling by the scroller's own doing goes where it is told at
 * once, and tells of it as a browser does. `restore` puts jsdom back as it was.
 */
export function layOutConversation(options: { shown?: number; each?: number } = {}) {
  const size = { shown: options.shown ?? 400, each: options.each ?? 500 };
  const viewport = () => document.querySelector<HTMLElement>(VIEWPORT)!;
  const items = (within: Element) => [...within.querySelectorAll<HTMLElement>(ITEM)];
  /** What the scroller puts under the last message so that a new turn can start at the top. */
  const spacer = (within: Element) => {
    const el = within.querySelector<HTMLElement>("[data-message-scroller-spacer]");
    return el && !el.hidden ? Number.parseFloat(el.style.height) || 0 : 0;
  };
  const spies = [
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return slotOf(this) === "message-scroller-viewport" ? size.shown : 0;
    }),
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return slotOf(this) === "message-scroller-viewport" ? items(this).length * size.each + spacer(this) : 0;
    }),
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (slotOf(this) === "message-scroller-viewport") return new DOMRect(0, 0, 300, size.shown);
      if (slotOf(this) !== "message-scroller-item") return new DOMRect(0, 0, 0, 0);
      const box = this.closest<HTMLElement>(VIEWPORT);
      const index = box ? items(box).indexOf(this) : 0;
      return new DOMRect(0, index * size.each - (box?.scrollTop ?? 0), 300, size.each);
    }),
    vi.spyOn(Element.prototype, "scrollTo").mockImplementation(function (this: Element, to?: unknown) {
      const el = this as HTMLElement;
      const top = typeof to === "object" && to !== null ? ((to as ScrollToOptions).top ?? 0) : 0;
      el.scrollTop = Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight));
      fireEvent.scroll(el);
    }),
  ];
  return {
    size,
    viewport,
    /** The reader scrolling to `top` themselves: with the wheel, as the scroller tells it from its own scrolling. */
    scroll(top: number) {
      const el = viewport();
      fireEvent.wheel(el);
      el.scrollTop = top;
      fireEvent.scroll(el);
      return el;
    },
    /** Whether the message `id` is in what shows, in part at least. */
    inView(id: string) {
      const box = viewport().getBoundingClientRect();
      const rect = document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!.getBoundingClientRect();
      return rect.bottom > box.top && rect.top < box.bottom;
    },
    restore() {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

/** Lets what the scroller does a frame after it was told of a change happen. */
export async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}
