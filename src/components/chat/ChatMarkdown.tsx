import { openUrl } from "@tauri-apps/plugin-opener";
import { type ComponentProps, isValidElement, memo, useMemo, useRef } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@/components/ui/code-block";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { useSeen } from "../../hooks/useSeen";
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

/**
 * Code of a reply set off from its text (a fence, or lines indented): a block that scrolls,
 * names its language, colors the ones the app knows (see lib/highlighter.tsx) and copies itself.
 * While the reply comes in, only the lines that are new are colored; and a block is only colored
 * once it has come near what shows, so a long chat that opens does not color all its code at once.
 */
function CodeFence({ children }: ComponentProps<"pre">) {
  // react-markdown hands over the `<code>` of the block, whose class names the language.
  const code = isValidElement<ComponentProps<"code">>(children) ? children.props : null;
  const text = typeof code?.children === "string" ? code.children : "";
  const language = /(?:^|\s)language-(\S+)/.exec(code?.className ?? "")?.[1] ?? "";
  const block = useRef<HTMLDivElement>(null);
  const lines = useHighlightedCode(text, language, useSeen(block));
  // The line break that ends the block is the fence's, not the code's.
  const copy = <CodeBlockCopyButton value={text.replace(/\n$/, "")} />;
  return (
    <CodeBlock ref={block} size="sm" data-language={language || undefined}>
      {language ? (
        <CodeBlockHeader>
          <CodeBlockTitle className="font-mono font-normal text-muted-foreground">{language}</CodeBlockTitle>
          <CodeBlockActions>{copy}</CodeBlockActions>
        </CodeBlockHeader>
      ) : (
        <CodeBlockActions>{copy}</CodeBlockActions>
      )}
      <CodeBlockContent tabIndex={0}>
        {lines.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines only come in at the end
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}

/**
 * What the chat's Markdown is read with, the same objects for every text: given new ones each
 * time, react-markdown would have every text of the chat parsed again.
 */
export const CHAT_COMPONENTS: Components = { a: ChatLink, pre: CodeFence };
const REMARK_PLUGINS = [remarkGfm];

/** One piece of a text (see `splitBlocks`), parsed again only when it changes. */
const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={REMARK_PLUGINS} components={CHAT_COMPONENTS}>
      {text}
    </Markdown>
  );
});

/**
 * Text of the agent's as Markdown, with links that open outside the app's window and code in
 * blocks of its own.
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
