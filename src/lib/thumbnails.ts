// Pictures of slides, made and kept by the backend (see src-tauri/src/thumbnails.rs): a list of
// slides shows each as an image rather than as a document of its own.

import { api } from "./api";

/** Where the backend serves previews; a picture of one is under {@link PICTURE_PREFIX} there. */
const SERVED = /^(slop:\/\/localhost|http:\/\/slop\.localhost)\//;

/** First path segment of a slide's picture, followed by its preview's own path. */
export const PICTURE_PREFIX = ".thumb";

/**
 * The address of the picture of the slide preview at `previewUrl` (see `slideUrl`,
 * `templateSlideUrl`, `headSlideUrl`); null where there are no pictures, as in the browser
 * preview, which has no backend to make them: the preview itself is shown there.
 */
export function pictureUrl(previewUrl: string): string | null {
  const served = SERVED.exec(previewUrl);
  if (!served) return null;
  return `${served[0]}${PICTURE_PREFIX}/${previewUrl.slice(served[0].length)}`;
}

/**
 * The picture at `url` (see {@link pictureUrl}) is no longer shown where it was asked for,
 * before it came: unless it is shown elsewhere too, the backend does not make it when its turn
 * comes, so that the slides in view are not kept waiting behind those scrolled past.
 */
export function forgetPicture(url: string): void {
  Promise.resolve(api.forgetThumbnail(url)).catch(() => {
    // Only a hint: at worst the picture is made, and kept for later.
  });
}
