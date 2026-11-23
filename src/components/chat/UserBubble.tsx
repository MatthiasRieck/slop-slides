import { ChevronDown, FileText, Pencil } from "lucide-react";
import { memo, useId, useState } from "react";

import {
  Attachment,
  AttachmentContent,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Message, MessageContent, MessageFooter } from "@/components/ui/message";
import { isImage } from "../../lib/drop";
import { slideNumber as slideNumberOf } from "../../lib/slideNumbers";
import { basename, cn, workspaceChatFileUrl } from "../../lib/utils";
import { type UserMessage, useApp } from "../../store";
import { CopyButton } from "./CopyButton";
import { ON_HOVER } from "./messageStyles";

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

/**
 * What goes along with a message, in a row at the message's side that wraps (and so neither
 * scrolls nor fades at its ends, as a row of attachments does by itself).
 */
const ALONG = "max-w-[85%] flex-wrap justify-end gap-1.5 overflow-visible py-0 mask-none!";

/** A picture sent along with a message, small; nothing once its file is gone. */
function Thumbnail({ picture, workspace }: { picture: Picture; workspace: string }) {
  const [missing, setMissing] = useState(false);
  if (missing) return null;
  return (
    <Attachment size="xs" className="min-w-0 has-data-[slot=attachment-media]:p-0.5">
      <AttachmentMedia variant="image" className="group-data-[size=xs]/attachment:w-14">
        {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: a failed load is not an interaction */}
        <img
          src={workspaceChatFileUrl(workspace, picture.path)}
          alt={picture.alt}
          title={picture.alt}
          loading="lazy"
          draggable={false}
          onError={() => setMissing(true)}
        />
      </AttachmentMedia>
    </Attachment>
  );
}

/** What the user typed, as typed: marks in it are not formatting. */
const TYPED = "whitespace-pre-wrap break-words";

/**
 * The text of a message. A long one is folded to its start, which fades out, with a trigger
 * under it that shows the rest (the `Collapsible` of a `Bubble`, whose start stays in view). The
 * whole text is in the page either way, to be selected and found.
 */
function UserText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  if (text.length <= 900 && text.split("\n").length <= 12) return <p className={TYPED}>{text}</p>;
  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <p
        id={id}
        className={cn(
          TYPED,
          !expanded && "max-h-44 overflow-hidden [mask-image:linear-gradient(to_bottom,black_75%,transparent)]",
        )}
      >
        {text}
      </p>
      <CollapsibleTrigger
        aria-controls={id}
        render={
          <Button
            variant="link"
            size="2xs"
            className="mt-2 gap-1 px-0 font-normal text-muted-foreground hover:text-foreground"
          />
        }
      >
        {expanded ? "Show less" : "Show full message"}
        <ChevronDown data-icon="inline-end" className="group-data-panel-open/button:rotate-180" />
      </CollapsibleTrigger>
    </Collapsible>
  );
}

/**
 * A message of the user's, long ones folded, with what went along with it. Of the deck, which
 * changes with every save, it takes only the number of the slide it was about.
 */
export const UserBubble = memo(function UserBubble({ message }: { message: UserMessage }) {
  const workspace = useApp((s) => s.workspace?.path ?? "");
  const slideNumber = useApp((s) => slideNumberOf(s.deck, message.slide));
  const pictures = picturesOf(message);
  const files = message.attachments.filter((a) => !isImage(a));
  return (
    <Message align="end">
      <MessageContent className="gap-1">
        {pictures.length > 0 && (
          <AttachmentGroup className={ALONG}>
            {pictures.map((picture) => (
              <Thumbnail key={picture.path} picture={picture} workspace={workspace} />
            ))}
          </AttachmentGroup>
        )}
        {files.length > 0 && (
          <AttachmentGroup role="list" className={cn(ALONG, "gap-1")}>
            {files.map((file) => (
              <Attachment key={file} role="listitem" size="chip" title={file} className="text-muted-foreground">
                <AttachmentMedia>
                  <FileText className="size-3" />
                </AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle className="font-normal">{file.replace(/^assets\//, "")}</AttachmentTitle>
                </AttachmentContent>
              </Attachment>
            ))}
          </AttachmentGroup>
        )}
        <Bubble variant="secondary" align="end" className="max-w-[85%]">
          <BubbleContent className="selectable rounded-2xl p-3">
            <UserText text={message.text} />
          </BubbleContent>
        </Bubble>
        <MessageFooter className="px-0">
          {/* Every message has these: they tell what they do as `CopyButton` does when it is `plain`. */}
          {!message.command && (
            <Button
              variant="tool"
              size="icon-xs"
              aria-label="Edit message"
              title="Edit: put this text back into the message box"
              onClick={() => useApp.getState().fillComposer(message.text)}
              className={ON_HOVER}
            >
              <Pencil />
            </Button>
          )}
          <CopyButton plain text={message.text} label="Copy message" className={ON_HOVER} />
        </MessageFooter>
        {(slideNumber > 0 ||
          message.sketch ||
          !!message.comments?.length ||
          message.screenshot ||
          message.element ||
          message.reverted) && (
          <MessageFooter className="flex-wrap gap-1 px-0 text-2xs font-normal">
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
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  );
});
