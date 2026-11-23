/**
 * What a message of the conversation adds to its `MessageScrollerItem`, which lets the browser
 * leave out the layout and the paint of those out of view (`content-visibility: auto`): nothing
 * is painted outside a message's own box, so the padding, taken back by the margin, is room for
 * the focus ring of a button at the message's edge.
 */
export const MESSAGE_ITEM = "-m-1 p-1";

/** The tint of a chip (an `Attachment` of size `chip`) whose thing goes along with the next message. */
export const CHIP_SENT = "border-primary/30 bg-primary/10 text-primary";

/** Shows on hovering its message (a `Message`), or with the keyboard focus on it. */
export const ON_HOVER = "opacity-0 transition-opacity group-hover/message:opacity-100 focus-visible:opacity-100";
