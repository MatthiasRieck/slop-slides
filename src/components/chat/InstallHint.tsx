import { Fragment } from "react";

import { codeSpans } from "../../lib/codeSpans";
import { CopyButton } from "./CopyButton";

/**
 * How to install an agent's CLI (see `PROVIDERS` in lib/models.ts): the sentence, with each
 * command in it set as code and a button beside it that copies it.
 */
export function InstallHint({ text }: { text: string }) {
  return (
    <>
      {codeSpans(text).map((span, index) =>
        span.code ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the sentence is fixed
          <span key={index} className="inline-flex items-center gap-0.5 align-baseline">
            <code className="selectable rounded bg-foreground/10 px-1 py-0.5 font-mono text-[0.95em] text-foreground">
              {span.text}
            </code>
            <CopyButton text={span.text} label={`Copy ${span.text}`} className="p-0.5" />
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the sentence is fixed
          <Fragment key={index}>{span.text}</Fragment>
        ),
      )}
    </>
  );
}
