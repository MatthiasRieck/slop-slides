// jsdom lays nothing out, so it has no IntersectionObserver. This stand-in is installed for every
// test (see ./setup.ts): by default everything observed is in view, which is what a test that is
// not about scrolling wants. A test about it says where the elements are with `placeElements`.

/**
 * Where an element is: how many screenfuls below what its scroller shows its middle lies (0 when
 * in view, 0.5 when it starts right under the edge), or null when it takes no space at all
 * (`display: none`).
 */
export type Place = number | null;

let placeOf: (element: Element) => Place = () => 0;
const observers = new Set<FakeIntersectionObserver>();

/** The side of the square a scroller shows, in the stand-in's px. */
const SCREEN = 100;

/** Reads a root margin such as "100%" as screenfuls; anything else counts as none. */
const screenfuls = (margin: string | undefined) => (margin?.endsWith("%") ? Number.parseFloat(margin) / 100 : 0);

class FakeIntersectionObserver {
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly thresholds = [0];
  private readonly targets = new Set<Element>();
  private readonly margin: number;

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options: IntersectionObserverInit = {},
  ) {
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? "0px";
    this.margin = screenfuls(options.rootMargin);
    observers.add(this);
  }

  /** Says where the element is right away, as a browser does a frame later. */
  observe(target: Element) {
    this.targets.add(target);
    this.report([target]);
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
    observers.delete(this);
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  reportAll() {
    this.report([...this.targets]);
  }

  private report(targets: Element[]) {
    if (targets.length === 0) return;
    // The scroller shows a screenful of 100 by 100; an element is half as tall.
    const reach = SCREEN * this.margin;
    const rootBounds = new DOMRect(-reach, -reach, SCREEN + 2 * reach, SCREEN + 2 * reach);
    const entries = targets.map((target) => {
      const place = placeOf(target);
      const top = place ? SCREEN * (place + 0.5) : 0;
      const hit = place !== null && top < rootBounds.bottom;
      return {
        target,
        rootBounds,
        isIntersecting: hit,
        intersectionRatio: hit ? 1 : 0,
        boundingClientRect: place === null ? new DOMRect(0, 0, 0, 0) : new DOMRect(0, top, SCREEN, SCREEN / 2),
      } as unknown as IntersectionObserverEntry;
    });
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}

/** Makes `IntersectionObserver` the stand-in, with everything in view. */
export function installIntersectionObserver() {
  globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
}

/**
 * Puts every observed element where `place` says and tells the observers, as a scroll does. Wrap
 * it in `act` when components follow it.
 */
export function placeElements(place: (element: Element) => Place) {
  placeOf = place;
  for (const observer of [...observers]) observer.reportAll();
}

/** Everything in view again, for the next test. */
export function resetPlaces() {
  placeOf = () => 0;
}

/** How many observers are at work, to check that elements share them. */
export const observerCount = () => observers.size;
