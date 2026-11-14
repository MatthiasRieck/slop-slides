import { FileText, Pencil } from "lucide-react";
import { memo, useState } from "react";

import { isImage } from "../../lib/drop";
import { slideNumber as slideNumberOf } from "../../lib/slideNumbers";
import { basename, cn, workspaceChatFileUrl } from "../../lib/utils";
import { type UserMessage, useApp } from "../../store";
import { CopyButton } from "./CopyButton";
import { MESSAGE, ON_HOVER } from "./messageStyles";

/** What a picture sent along with a message shows, for those who cannot see it. */
type Picture = { path: string; alt: string };

/** The pictures that went along with a message: its screenshot, its sketch and its attached images. */
function picturesOf(message: UserMessage): Picture[] {
  return [
    ...(message.screenshot ? [{ path: message.screenshot, alt: "Slide screenshot" }] : []),
    ...(message.sketch?.image ? [{ path: message.sketch.image, alt: "Slide with your sketch" }] : []),
    ...message.attachments.filter(isImage).map((path) => ({ path, alt: basename(path) })),
  ];
}

/** A picture sent along with a message, small; nothing once its file is gone. */
function Thumbnail({ picture, workspace }: { picture: Picture; workspace: string }) {
  const [missing, setMissing] = useState(false);
  if (missing) return null;
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: a failed load is not an interaction
    <img
      src={workspaceChatFileUrl(workspace, picture.path)}
      alt={picture.alt}
      title={picture.alt}
      loading="lazy"
      draggable={false}
      onError={() => setMissing(true)}
      className="size-14 rounded-lg border bg-muted object-cover"
    />
  );
}

/**
 * A message of the user's, long ones folded, with what went along with it. Of the deck, which
 * changes with every save, it takes only the number of the slide it was about.
 */
export const UserBubble = memo(function UserBubble({ message }: { message: UserMessage }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = message.text.length > 900 || message.text.split("\n").length > 12;
  const workspace = useApp((s) => s.workspace?.path ?? "");
  const slideNumber = useApp((s) => slideNumberOf(s.deck, message.slide));
  const pictures = picturesOf(message);
  const files = message.attachments.filter((a) => !isImage(a));
  return (
    <div className={cn(MESSAGE, "items-end gap-1")}>
      {pictures.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {pictures.map((picture) => (
            <Thumbnail key={picture.path} picture={picture} workspace={workspace} />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <ul className="flex max-w-[85%] flex-wrap justify-end gap-1">
          {files.map((file) => (
            <li
              key={file}
              title={file}
              className="flex h-6 min-w-0 max-w-full items-center gap-1 rounded-md border px-1.5 text-xs text-muted-foreground"
            >
              <FileText className="size-3 shrink-0" />
              <span className="truncate">{file.replace(/^assets\//, "")}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="selectable min-w-0 max-w-[85%] rounded-2xl bg-accent p-3 text-sm leading-relaxed">
        {/* What the user typed is shown as typed: marks in it are not formatting. */}
        <p
          className={cn(
            "whitespace-pre-wrap break-words",
            collapsible &&
              !expanded &&
              "max-h-44 overflow-hidden [mask-image:linear-gradient(to_bottom,black_75%,transparent)]",
          )}
        >
          {message.text}
        </p>
        {collapsible && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            className="mt-2 text-xs text-muted-foreground hover:text-foreground"
          >
            {expanded ? "Show less" : "Show full message"}
          </button>
        )}
      </div>
      <div className="flex items-center">
        {!message.command && (
          <button
            type="button"
            aria-label="Edit message"
            title="Edit: put this text back into the message box"
            onClick={() => useApp.getState().fillComposer(message.text)}
            className={cn("rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground", ON_HOVER)}
          >
            <Pencil className="size-3" />
          </button>
        )}
        <CopyButton text={message.text} label="Copy message" className={ON_HOVER} />
      </div>
      {(slideNumber > 0 ||
        message.sketch ||
        !!message.comments?.length ||
        message.screenshot ||
        message.element ||
        message.reverted) && (
        <div className="flex flex-wrap justify-end gap-1 text-2xs text-muted-foreground">
          {message.reverted && <span title="You undid what this turn changed in the deck">changes undone ·</span>}
          {slideNumber > 0 && <span>on slide {slideNumber}</span>}
          {message.sketch && <span>· with sketch</span>}
          {!!message.comments?.length && (
            <span>
              · with {message.comments.length} comment{message.comments.length === 1 ? "" : "s"}
            </span>
          )}
          {message.element && <span>· about {message.element.name}</span>}
          {message.screenshot && <span>· with screenshot</span>}
        </div>
      )}
    </div>
  );
});
