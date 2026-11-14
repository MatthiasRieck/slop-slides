import { useMemo, useRef } from "react";

type Handler = (...args: never[]) => unknown;

/**
 * `handlers` as functions that stay the same from one render to the next, each calling the one
 * given last. For what is handed to memoised children: they need not render again because their
 * parent did, and still act on what the parent knows now.
 */
export function useHandlers<T extends Record<string, Handler>>(handlers: T): T {
  const latest = useRef(handlers);
  latest.current = handlers;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Made once; each looks up the latest when called.
  return useMemo(() => {
    const stable: Record<string, Handler> = {};
    for (const name of Object.keys(handlers)) {
      stable[name] = (...args) => (latest.current[name] as Handler)(...args);
    }
    return stable as T;
  }, []);
}
