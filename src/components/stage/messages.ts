import { type RefObject, useEffect, useMemo } from "react";

/** Takes a message of one type from the stage's preview: what it posted, and the event it came in. */
export type FrameHandler = (data: MessageEvent["data"], event: MessageEvent) => void;

/** The messages the stage's preview posts, handed to whoever asked for their type. */
export interface FrameMessages {
  /** Has each of `handlers` take the messages of the type it is listed under; gives back what ends that. */
  on: (handlers: Record<string, FrameHandler>) => () => void;
}

/**
 * Routes the messages posted to the window by a slide preview in `area` (the editor's reports, the
 * pasteboard's view, the comment tools' picks) to the handlers of their `type`, in the order
 * those asked. A message is looked at once, whoever takes it: a type nobody asked for is dropped
 * unseen, and whether it is one of the area's previews that posted is settled once, by the preview
 * that posted last, without looking through the page again. A drag posts sixty a second.
 */
export function frameMessages(area: () => HTMLElement | null) {
  const byType = new Map<string, Set<FrameHandler>>();
  let known: HTMLIFrameElement | null = null;

  const fromPreview = (source: MessageEventSource | null) => {
    const within = area();
    if (!source || !within) return false;
    if (known?.contentWindow === source && within.contains(known)) return true;
    known = Array.from(within.querySelectorAll("iframe")).find((frame) => frame.contentWindow === source) ?? null;
    return known !== null;
  };

  const onMessage = (event: MessageEvent) => {
    const type = event.data?.type;
    const handlers = typeof type === "string" ? byType.get(type) : undefined;
    if (!handlers?.size || !fromPreview(event.source)) return;
    for (const handle of [...handlers]) handle(event.data, event);
  };

  return {
    on: (handlers: Record<string, FrameHandler>) => {
      for (const [type, handle] of Object.entries(handlers)) {
        const taking = byType.get(type) ?? new Set();
        byType.set(type, taking.add(handle));
      }
      return () => {
        for (const [type, handle] of Object.entries(handlers)) byType.get(type)?.delete(handle);
      };
    },
    /** Starts routing the window's messages; gives back what stops it. */
    listen: () => {
      window.addEventListener("message", onMessage);
      return () => window.removeEventListener("message", onMessage);
    },
  };
}

/** The messages from the slide previews in what `areaRef` holds, routed while the caller is mounted. */
export function useFrameMessages(areaRef: RefObject<HTMLElement | null>): FrameMessages {
  const messages = useMemo(() => frameMessages(() => areaRef.current), [areaRef]);
  useEffect(() => messages.listen(), [messages]);
  return messages;
}
