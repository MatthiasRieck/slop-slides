import { openUrl } from "@tauri-apps/plugin-opener";
import { type ComponentProps, memo, useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { linkTarget, splitBlocks } from "../../lib/markdown";
import { showError, useApp } from "../../store";

/**
 * A link in a chat message. It never takes the app's window anywhere: a web address opens in the
 * system's browser, a file of the workspace opens in the app, and anything else does nothing.
 */
function ChatLink({ href, children, title }: ComponentProps<"a">) {
  const open = (event: React.MouseEvent) => {
    event.preventDefault();
    const target = linkTarget(href, useApp.getState().workspace?.path ?? null);
    if (target?.kind === "url") void openUrl(target.url).catch(showError);
    else if (target?.kind === "file") void useApp.getState().openPath(target.path);
  };
  return (
    <a href={href} title={title ?? href} onClick={open} onAuxClick={open}>
      {children}
    </a>
  );
}

// What the Markdown is read with, the same objects for every text: given new ones each time,
// react-markdown would have every text of the chat parsed again.
const COMPONENTS = { a: ChatLink };
const REMARK_PLUGINS = [remarkGfm];

/** One piece of a text (see `splitBlocks`), parsed again only when it changes. */
const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
      {text}
    </Markdown>
  );
});

/**
 * Text of the agent's as Markdown, with links that open outside the app's window.
 *
 * It is read piece by piece: a reply still being written grows at its end, so all but its last
 * piece stay as they are, and reading it costs what the last piece does, not what the reply does.
 */
export const ChatMarkdown = memo(function ChatMarkdown({ children }: { children: string }) {
  const blocks = useMemo(() => splitBlocks(children), [children]);
  // Pieces only come in at the end, so a piece's place tells it from the others.
  // biome-ignore lint/suspicious/noArrayIndexKey: see above
  return blocks.map((block, index) => <MarkdownBlock key={index} text={block} />);
});
