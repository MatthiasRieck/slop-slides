/**
 * What a message of the conversation adds to its `MessageScrollerItem`, which lets the browser
 * leave out the layout and the paint of those out of view (`content-visibility: auto`): nothing
 * is painted outside a message's own box, so the padding, taken back by the margin, is room for
 * the focus ring of a button at the message's edge.
 */
export const MESSAGE_ITEM = "-m-1 p-1";

/** Shows on hovering its message (a `Message`), or with the keyboard focus on it. */
export const ON_HOVER = "opacity-0 transition-opacity group-hover/message:opacity-100 focus-visible:opacity-100";

/**
 * An `Attachment` as small as a chip: one line, 24px tall, as wide as its name and no wider than
 * what holds it. (The paddings are set for the same states the component sets its own for.)
 */
export const CHIP =
  "h-6 min-w-0 gap-1 rounded-md bg-transparent has-data-[slot=attachment-content]:py-0 has-data-[slot=attachment-media]:px-1.5 has-data-[slot=attachment-media]:py-0";

/** What a chip's `AttachmentMedia` takes to be its icon alone, in the chip's color. */
export const CHIP_ICON = "rounded-none bg-transparent text-current group-data-[size=xs]/attachment:w-3";
