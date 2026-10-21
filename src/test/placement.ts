/**
 * Where the pasteboard puts the deck on screen, as one translate (screen px) then scale. It zooms
 * the deck in with `zoom`, pans it in zoomed px and shrinks it with a trailing `scale()`
 * (pasteboard.js), so the pan comes back multiplied by the zoom, rounded off.
 */
export function placement(deck: HTMLElement): string {
  const z = Number(deck.style.zoom || "1");
  const pan = /^translate\((-?[\d.e+-]+)px, ?(-?[\d.e+-]+)px\)(?: scale\(([\d.e+-]+)\))?$/.exec(deck.style.transform);
  if (!pan) return `unexpected transform: ${deck.style.transform}`;
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  const k = pan[3] ? round(z * Number(pan[3])) : z;
  return `translate(${round(Number(pan[1]) * z)}px,${round(Number(pan[2]) * z)}px) scale(${k})`;
}
