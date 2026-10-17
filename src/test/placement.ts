/**
 * Where the pasteboard puts the deck on screen, as one translate (screen px) then scale. It zooms
 * the deck with `zoom` and pans it in zoomed px (pasteboard.js), so the pan comes back multiplied
 * by the zoom, rounded off.
 */
export function placement(deck: HTMLElement): string {
  const k = deck.style.zoom || "1";
  const pan = /^translate\((-?[\d.e+-]+)px, ?(-?[\d.e+-]+)px\)$/.exec(deck.style.transform);
  if (!pan) return `unexpected transform: ${deck.style.transform}`;
  const screen = (v: string) => Math.round(Number(v) * Number(k) * 1e6) / 1e6;
  return `translate(${screen(pan[1]!)}px,${screen(pan[2]!)}px) scale(${k})`;
}
