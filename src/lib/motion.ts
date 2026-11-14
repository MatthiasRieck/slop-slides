// Motion in the app that scripts start, which the styles cannot tone down (see the
// `prefers-reduced-motion` block in src/index.css for what they can).

/** Whether the user asked their system for less motion. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** How scrolling something into place goes: smoothly, or at once for those who asked for less motion. */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}
