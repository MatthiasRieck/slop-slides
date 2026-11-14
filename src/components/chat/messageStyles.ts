/**
 * What holds one message of the conversation. `chat-message` (see index.css) lets the browser
 * leave out the layout of those out of view.
 */
export const MESSAGE = "chat-message group flex min-w-0 flex-col";

/** Shows on hovering its message, or with the keyboard focus on it. */
export const ON_HOVER = "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100";

/**
 * When the actions of a message show: always on the newest exchange (`latest`), where they are
 * most likely wanted and nothing below them moves, else on hovering the message.
 */
export const actionsShown = (latest: boolean) => (latest ? "" : ON_HOVER);
