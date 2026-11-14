import { api } from "../../lib/api";
import { imageSize } from "../../lib/drop";
import { noteAssetsWritten } from "../../lib/ownAssets";
import { deckFileUrl } from "../../lib/utils";

/** An image of the deck's, as the editor puts it on the slide: its source and its natural size. */
export interface SizedImage {
  src: string;
  w?: number;
  h?: number;
}

/** The deck's images at `sources`, each with its size (none when it cannot be measured). */
export function measureImages(deckId: string, sources: string[]): Promise<SizedImage[]> {
  return Promise.all(sources.map(async (src) => ({ src, ...(await imageSize(deckFileUrl(deckId, src))) })));
}

/** Copies the image files at `paths` into the deck's assets, measured for the editor. */
export async function importImages(deckId: string, paths: string[]): Promise<SizedImage[]> {
  return measureImages(deckId, noteAssetsWritten(deckId, await api.importAssets(deckId, paths)));
}
