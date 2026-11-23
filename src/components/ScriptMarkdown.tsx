import { Eye, Pencil } from "lucide-react";
import { memo } from "react";
import Markdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/** Where notes are shown, a click must not leave the app, and paths mean nothing. */
const NOT_SHOWN = ["a", "img"];

/** What the Markdown is read with: the same list each time, so that only another text is read again. */
const REMARK_PLUGINS = [remarkGfm];

/**
 * Speaker notes or narration, formatted: sized by what holds it, its lines kept as typed. Read
 * again only when the text or the `rehypePlugins` are others than before.
 */
export const ScriptMarkdown = memo(function ScriptMarkdown(props: {
  text: string;
  rehypePlugins?: Options["rehypePlugins"];
}) {
  return (
    <div className="markdown script">
      <Markdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={props.rehypePlugins}
        disallowedElements={NOT_SHOWN}
        unwrapDisallowed
      >
        {props.text}
      </Markdown>
    </div>
  );
});

/** Switches a script's editor between the Markdown it is written in and how that looks. */
export function ScriptPreviewToggle(props: { preview: boolean; onChange: (preview: boolean) => void }) {
  const Icon = props.preview ? Pencil : Eye;
  return (
    <Button
      variant="ghost"
      size="2xs"
      aria-pressed={props.preview}
      tooltip="Written in Markdown"
      onClick={() => props.onChange(!props.preview)}
      className="shrink-0 px-1 font-normal aria-pressed:bg-transparent aria-pressed:text-current aria-pressed:hover:bg-muted aria-pressed:hover:text-foreground"
    >
      <Icon data-icon="inline-start" />
      {props.preview ? "Edit" : "Preview"}
    </Button>
  );
}

/** The text box of a script's editor, or how the text looks in `preview`. */
export function ScriptField(props: {
  label: string;
  draft: string;
  preview: boolean;
  readOnly: boolean;
  placeholder: string;
  onChange: (text: string) => void;
  onBlur: () => void;
}) {
  const box = "selectable min-h-0 flex-1 rounded-md border bg-card p-3 text-sm leading-relaxed";
  if (props.preview)
    return (
      <div role="document" aria-label={`${props.label} preview`} className={`${box} overflow-y-auto`}>
        {props.draft.trim() ? (
          <ScriptMarkdown text={props.draft} />
        ) : (
          <span className="text-muted-foreground">{props.placeholder}</span>
        )}
      </div>
    );
  return (
    <Textarea
      aria-label={props.label}
      value={props.draft}
      readOnly={props.readOnly}
      onChange={(event) => props.onChange(event.target.value)}
      onBlur={props.onBlur}
      placeholder={props.placeholder}
      // As tall as the room it is given, not as its text: it scrolls.
      className={`${box} field-sizing-fixed resize-none border-border dark:bg-card`}
    />
  );
}
