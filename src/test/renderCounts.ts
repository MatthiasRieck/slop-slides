/** How often each component rendered, by its name, since the counts were last emptied. */
export interface RenderCounts {
  /** How many times the component called `name` rendered (a memoized one: not counting the times it was skipped). */
  of: (name: string) => number;
  /** Empties the counts. */
  reset: () => void;
  /** Stops counting. */
  stop: () => void;
}

/** A fiber of React's tree, as much of it as the counting reads. */
interface Fiber {
  tag: number;
  type: unknown;
  flags: number;
  alternate: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
}

// React's work tags for the components that render: function, class, forwardRef, simple memo.
// A memo with a comparison of its own (14) renders its inner component as a fiber of its own (0).
const COMPONENTS = new Set([0, 1, 11, 15]);
// The flag a fiber carries when it rendered in the commit (`PerformedWork`).
const PERFORMED_WORK = 1;

/** What hears each tree React commits, while a test counts. */
let onCommit: ((root: Fiber) => void) | null = null;

/**
 * Puts up the hook React's DevTools use, which React looks for once, as it loads: the test setup
 * does this before it loads React DOM. It does nothing until a test counts (see `countRenders`).
 */
export function installRenderHook() {
  const renderers = new Map<number, unknown>();
  (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers,
    supportsFiber: true,
    isDisabled: false,
    checkDCE() {},
    inject(renderer: unknown) {
      renderers.set(renderers.size + 1, renderer);
      return renderers.size;
    },
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    setStrictMode() {},
    onCommitFiberRoot(_id: number, root: { current: Fiber }) {
      onCommit?.(root.current);
    },
  };
}

function nameOf(fiber: Fiber): string | null {
  const type = fiber.type as { displayName?: string; name?: string } | null;
  if (!type || typeof type === "string") return null;
  return type.displayName || type.name || null;
}

/**
 * Counts the renders of every component in the trees React commits from now on, as React's
 * DevTools see them, by the components' names: for pinning how much a change renders, down to
 * components that are not the test's to reach.
 */
export function countRenders(): RenderCounts {
  const renders = new Map<string, number>();
  onCommit = (root) => {
    const stack: (Fiber | null)[] = [root.child];
    while (stack.length > 0) {
      const fiber = stack.pop();
      if (!fiber) continue;
      const before = fiber.alternate;
      const name = COMPONENTS.has(fiber.tag) ? nameOf(fiber) : null;
      if (name && (!before || (fiber.flags & PERFORMED_WORK) !== 0)) renders.set(name, (renders.get(name) ?? 0) + 1);
      stack.push(fiber.sibling);
      // A subtree that did not render is the one of the commit before.
      if (fiber.child && (!before || fiber.child !== before.child)) stack.push(fiber.child);
    }
  };
  return {
    of: (name) => renders.get(name) ?? 0,
    reset: () => renders.clear(),
    stop: () => {
      onCommit = null;
    },
  };
}
