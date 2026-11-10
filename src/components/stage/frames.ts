/** Whether a message came from one of the slide previews in `area`. */
export function fromFrameIn(area: HTMLElement | null | undefined, source: MessageEventSource | null): boolean {
  return Array.from(area?.querySelectorAll("iframe") ?? []).some((frame) => frame.contentWindow === source);
}

/** How many app pixels one of the preview's own pixels takes: the preview is scaled down to fit. */
function scaleOf(frame: HTMLIFrameElement, rect: DOMRect) {
  return frame.clientWidth ? rect.width / frame.clientWidth : 1;
}

/** Where a point in the preview's own pixels (as the editor gives it) is in the app's. */
export function toAppPoint(frame: HTMLIFrameElement | null, x: number, y: number) {
  if (!frame) return { x, y };
  const rect = frame.getBoundingClientRect();
  const k = scaleOf(frame, rect);
  return { x: rect.left + x * k, y: rect.top + y * k };
}

/** Where a point in the app's pixels is in the preview's own (as the editor wants it). */
export function toFramePoint(frame: HTMLIFrameElement, x: number, y: number) {
  const rect = frame.getBoundingClientRect();
  const k = scaleOf(frame, rect);
  return { x: (x - rect.left) / k, y: (y - rect.top) / k };
}
