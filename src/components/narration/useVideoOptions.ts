import { useSyncExternalStore } from "react";

import { loadVideoOptions, onVideoOptions, type VideoOptions } from "../../lib/video";

/** The stored video options (see `loadVideoOptions`), following every change to them. */
export function useVideoOptions(): VideoOptions {
  return useSyncExternalStore(onVideoOptions, loadVideoOptions);
}
