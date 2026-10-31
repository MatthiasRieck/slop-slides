import { Eye, Pencil } from "lucide-react";
import Markdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";

/** Where notes are shown, a click must not leave the app, and paths mean nothing. */
const NOT_SHOWN = ["a", "img"];

/** Speaker notes or narration, formatted: sized by what holds it, its lines kept as typed. */
export function ScriptMarkdown(props: { text: string; rehypePlugins?: Options["rehypePlugins"] }) {
  return (
    <div className="markdown script">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={props.rehypePlugins}
        disallowedElements={NOT_SHOWN}
        unwrapDisallowed
      >
        {props.text}
      </Markdown>
    </div>
  );
}

/** Switches a script's editor between the Markdown it is written in and how that looks. */
export function ScriptPreviewToggle(props: { preview: boolean; onChange: (preview: boolean) => void }) {
  const Icon = props.preview ? Pencil : Eye;
  return (
    <button
      type="button"
      aria-pressed={props.preview}
      title="Written in Markdown"
      onClick={() => props.onChange(!props.preview)}
      className="flex shrink-0 items-center gap-1 hover:text-foreground"
    >
      <Icon className="size-3" />
      {props.preview ? "Edit" : "Preview"}
    </button>
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
    <textarea
      aria-label={props.label}
      value={props.draft}
      readOnly={props.readOnly}
      onChange={(event) => props.onChange(event.target.value)}
      onBlur={props.onBlur}
      placeholder={props.placeholder}
      className={`${box} resize-none outline-none focus:border-primary`}
    />
  );
}
