import { type ComponentType, lazy, type ReactNode, Suspense, useState } from "react";

/** A component whose code loads when it first renders, or ahead of that with `preload`. */
export interface LazyPart<P> {
  (props: P): ReactNode;
  /** Loads the component's code; once done, it renders at once, without its fallback. */
  preload: () => Promise<void>;
}

/**
 * A part of the app kept out of the code the window starts with: `load` imports it. Until its
 * code is there, `fallback` holds its place, which should take the room the part will, so
 * nothing around it moves. Preloaded (see `preloadWhenIdle` in ./idle.ts), it renders like any
 * other component: no fallback, no extra frame. Call it once per part, at module level.
 */
export function lazyPart<P extends object>(
  load: () => Promise<ComponentType<P>>,
  fallback: ReactNode = null,
): LazyPart<P> {
  let loaded: ComponentType<P> | null = null;
  let loading: Promise<ComponentType<P>> | null = null;
  const fetch = () => {
    loading ??= load().then((component) => {
      loaded = component;
      return component;
    });
    return loading;
  };
  const Deferred = lazy(() => fetch().then((component) => ({ default: component }))) as unknown as ComponentType<P>;

  // biome-ignore lint/correctness/noComponentHookFactories: a part is made once, at module level, as with React's `lazy`
  function Part(props: P) {
    // Chosen as it mounts and kept: switching over once the code arrives would mount it anew.
    const [Component] = useState<ComponentType<P>>(() => loaded ?? Deferred);
    if (Component !== Deferred) return <Component {...props} />;
    return (
      <Suspense fallback={fallback}>
        <Deferred {...props} />
      </Suspense>
    );
  }
  Part.preload = () => fetch().then(() => undefined);
  return Part;
}
