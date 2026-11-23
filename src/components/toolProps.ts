// What the icon buttons of the editing toolbars and their popovers have in common, as props of
// the shadcn/ui `Button`.

/**
 * A toolbar's icon button that works on what is selected in the slide: pressing it leaves the
 * keyboard focus, and with it the text selection, where they are (the `keepFocus` of `Button`,
 * which holds for a tool that is off too).
 */
export const SLIDE_TOOL = { variant: "tool", size: "icon-xs", keepFocus: true } as const;

/**
 * What a tool that can be off says in its tooltip: `reason`, what it waits for, while it is
 * `off`; else what it does (`tooltip`), with the keys that do the same (`shortcut`, a
 * `formatKeys` spec). Off, the button still takes the pointer and the focus, to say so.
 */
export function unlessOff(off: boolean, reason: string, tooltip: string, shortcut?: string) {
  return off ? { disabled: true, tooltip: reason } : { disabled: false, tooltip, ...(shortcut && { shortcut }) };
}
