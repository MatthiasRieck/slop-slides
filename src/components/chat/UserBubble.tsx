import { FileText, Pencil } from "lucide-react";
import { memo, useState } from "react";

import { isImage } from "../../lib/drop";
import { slideNumbers } from "../../lib/slideNumbers";
import { basename, cn, workspaceChatFileUrl } from "../../lib/utils";
import { type UserMessage, useApp } from "../../store";
import { sendOptionsOf } from "../../store/messages";
import { Dialog } from "../Dialog";
import { timeLabel } from "./activity";
import { CopyButton } from "./CopyButton";
import { slideLabel, slideRanges } from "./mentions";
import { actionsShown, MESSAGE } from "./messageStyles";

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

/** A picture sent along with a message, small, that opens large; nothing once its file is gone. */
function Thumbnail({ picture, workspace }: { picture: Picture; workspace: string }) {
  const [missing, setMissing] = useState(false);
  const [open, setOpen] = useState(false);
  if (missing) return null;
  const src = workspaceChatFileUrl(workspace, picture.path);
  return (
    <>
      <button
        type="button"
        title={`${picture.alt} · click to view larger`}
        aria-label={`View ${picture.alt} larger`}
        onClick={() => setOpen(true)}
        className="rounded-lg hover:opacity-90"
      >
        {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: a failed load is not an interaction */}
        <img
          src={src}
          alt={picture.alt}
          loading="lazy"
          draggable={false}
          onError={() => setMissing(true)}
          className="size-14 rounded-lg border bg-muted object-cover"
        />
      </button>
      {open && (
        <Dialog
          label={picture.alt}
          onClose={() => setOpen(false)}
          closeOnBackdrop
          closeButton
          heading={<h2 className="truncate text-sm font-medium">{picture.alt}</h2>}
          className="flex max-h-[90vh] w-auto max-w-[90vw] flex-col gap-3 rounded-xl border bg-card p-4 shadow-lg"
        >
          <img
            src={src}
            alt={picture.alt}
            draggable={false}
            className="max-h-[78vh] max-w-full self-center rounded-md border bg-muted object-contain"
          />
        </Dialog>
      )}
    </>
  );
}

/**
 * The slide a message was about and the others it referred to, as their numbers in the deck now
 * ("0" for one gone since), in one text: a save of the deck that leaves them where they are
 * renders nothing.
 */
function useMessageSlides(message: UserMessage): { slide: number; others: number[] } {
  const text = useApp((s) => {
    const numbers = s.deck ? slideNumbers(s.deck.slides) : null;
    const of = (id: string | null) => (id && numbers?.get(id)) || 0;
    return [of(message.slide), ...(message.slides ?? []).map(of)].join(",");
  });
  const [slide = 0, ...others] = text.split(",").map(Number);
  return { slide, others: others.filter((n) => n > 0) };
}

/**
 * A message of the user's, long ones folded, with what went along with it: its pictures open
 * larger, and the slide it was about is a way to that slide. `latest` is on for the chat's
 * newest message, whose actions always show; the others show them on hover. Edit hands the
 * message back to the composer with all that went with it, to be sent in its own place (see
 * `ChatSlice.editMessage`). Of the deck, which changes with every save, it takes only the
 * numbers of the slides it was about.
 */
export const UserBubble = memo(function UserBubble({
  message,
  latest = false,
}: {
  message: UserMessage;
  latest?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = message.text.length > 900 || message.text.split("\n").length > 12;
  const workspace = useApp((s) => s.workspace?.path ?? "");
  const running = useApp((s) => s.running);
  const { slide: slideNumber, others } = useMessageSlides(message);
  const pictures = picturesOf(message);
  const files = message.attachments.filter((a) => !isImage(a));
  const comments = message.comments?.length ?? 0;
  const edit = () => {
    const app = useApp.getState();
    // The slide it was about is the one on show again, so that it goes along as it did.
    if (message.slide && slideNumber > 0) app.select(message.slide);
    const sent = sendOptionsOf(message);
    app.fillComposer(message.text, {
      edit: message.id,
      attachments: sent.attachments,
      slides: sent.slides,
      includeSlide: slideNumber > 0,
      screenshot: sent.screenshot,
      element: sent.element,
    });
  };
  const meta = [
    message.reverted && (
      <span key="reverted" title="You undid what this turn changed in the deck">
        changes undone
      </span>
    ),
    slideNumber > 0 && message.slide && (
      <button
        key="slide"
        type="button"
        title={`Go to ${slideLabel(slideNumber, message.slide)}`}
        onClick={() => message.slide && useApp.getState().select(message.slide)}
        className="rounded underline decoration-border underline-offset-2 hover:text-foreground hover:decoration-foreground"
      >
        on slide {slideNumber}
      </button>
    ),
    others.length > 0 && <span key="slides">about {slideRanges(others).toLowerCase()}</span>,
    message.sketch && <span key="sketch">with sketch</span>,
    comments > 0 && (
      <span key="comments">
        with {comments} comment{comments === 1 ? "" : "s"}
      </span>
    ),
    message.element && <span key="element">about {message.element.name}</span>,
    message.screenshot && <span key="screenshot">with screenshot</span>,
  ].filter(Boolean);
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
      <div
        title={`Sent ${timeLabel(message.createdAt)}`}
        className="selectable min-w-0 max-w-[85%] rounded-2xl bg-accent p-3 text-sm leading-relaxed"
      >
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
        {!message.command && !running && (
          <button
            type="button"
            aria-label="Edit message"
            title="Edit: change this message and send it again from here; the replies after it go"
            onClick={edit}
            className={cn(
              "rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground",
              actionsShown(latest),
            )}
          >
            <Pencil className="size-3" />
          </button>
        )}
        <CopyButton text={message.text} label="Copy message" className={actionsShown(latest)} />
      </div>
      {meta.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1 text-2xs text-muted-foreground">
          {meta.map((part, at) => (
            <span key={(part as React.ReactElement).key} className="flex gap-1">
              {at > 0 && <span aria-hidden>·</span>}
              {part}
            </span>
          ))}
        </div>
      )}
    </div>
  );
});
