import { api, errorMessage } from "../lib/api";

/** Marks the slide on the stage to screenshot when sending a sketch. */
export const SKETCH_TARGET_ATTR = "data-sketch-target";

/** Screenshot of the slide on the stage, ink included; null when it cannot be taken. */
export async function captureSlide(deckId: string): Promise<string | null> {
  const target = document.querySelector(`[${SKETCH_TARGET_ATTR}]`);
  if (!target) return null;
  const { x, y, width, height } = target.getBoundingClientRect();
  try {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    return await api.captureSketch(deckId, { x, y, width, height }, viewport);
  } catch (error) {
    // The marked area still tells the agent where to look.
    console.warn("slide screenshot failed:", errorMessage(error));
    return null;
  }
}
