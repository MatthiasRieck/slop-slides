import { useMemo, useSyncExternalStore } from "react";

import { loadVideoOptions, onVideoOptions, type VideoOptions } from "../../lib/video";
import { useNarration } from "../../narrationStore";

/**
 * The options the deck `deckId` plays with wherever it plays by itself (see `deckVideoOptions`):
 * the times the deck keeps for itself over what this computer last exported with, following
 * every change to either. The same object until one of them changes.
 */
export function useDeckVideoOptions(deckId: string | undefined): VideoOptions {
  const stored = useSyncExternalStore(onVideoOptions, loadVideoOptions);
  const timing = useNarration((s) =>
    deckId !== undefined && s.settingsDeck === deckId ? s.settings.timing : undefined,
  );
  return useMemo(() => (timing ? { ...stored, ...timing } : stored), [stored, timing]);
}
