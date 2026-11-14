// One IntersectionObserver for all the elements watched in the same scroller with the same margin:
// a rail of a hundred thumbnails is one observer's work, not a hundred's.

type Told = (entry: IntersectionObserverEntry) => void;
type Shared = { observer: IntersectionObserver; told: Map<Element, Told> };

/** The observers by what they watch in (a scroller, or the window) and their margin. */
const shared = new Map<Element | null, Map<string, Shared>>();

/** The nearest element around `element` that scrolls its content, null when the window does. */
export function scrollerOf(element: Element): Element | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(parent);
    if (/auto|scroll/.test(`${overflowX} ${overflowY}`)) return parent;
  }
  return null;
}

/**
 * Tells `told` whenever `target` starts or stops showing in `root` grown by `margin` on every
 * side (a CSS margin, such as "100%" for one more of the root's size). Returns how to stop.
 */
export function watchIntersection(target: Element, root: Element | null, margin: string, told: Told): () => void {
  const margins = shared.get(root) ?? new Map<string, Shared>();
  shared.set(root, margins);
  let watch = margins.get(margin);
  if (!watch) {
    const listeners = new Map<Element, Told>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) listeners.get(entry.target)?.(entry);
      },
      { root, rootMargin: margin },
    );
    watch = { observer, told: listeners };
    margins.set(margin, watch);
  }
  const { observer, told: listeners } = watch;
  listeners.set(target, told);
  observer.observe(target);
  return () => {
    listeners.delete(target);
    observer.unobserve(target);
    if (listeners.size > 0) return;
    observer.disconnect();
    margins.delete(margin);
    if (margins.size === 0) shared.delete(root);
  };
}
