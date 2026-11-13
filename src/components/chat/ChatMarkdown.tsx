import { openUrl } from "@tauri-apps/plugin-opener";
import type { ComponentProps } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { linkTarget } from "../../lib/markdown";
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

const COMPONENTS = { a: ChatLink };

/** Text of the agent's as Markdown, with links that open outside the app's window. */
export function ChatMarkdown({ children }: { children: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
      {children}
    </Markdown>
  );
}
