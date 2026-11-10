import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";

/**
 * Listens to the backend's `event` while `enabled`, handing each payload to `handler` (the one
 * given last, so it may change without listening again). Stops listening when disabled or
 * unmounted; what comes after that is not handed on.
 */
export function useTauriEvent<T>(event: string, handler: (payload: T) => void, enabled = true) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const off = listen<T>(event, (e) => {
      if (!disposed) latest.current(e.payload);
    });
    return () => {
      disposed = true;
      void off.then((fn) => fn());
    };
  }, [event, enabled]);
}
