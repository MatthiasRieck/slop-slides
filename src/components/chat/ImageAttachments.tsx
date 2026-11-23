import { X } from "lucide-react";
import type { RefObject } from "react";

import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { basename, cn, isSessionFile, workspaceChatFileUrl } from "../../lib/utils";

const assetName = (path: string) => (isSessionFile(path) ? "Slide screenshot" : basename(path));

/** How many previews the fan shows; the rest are counted on a badge. */
const FAN_SIZE = 4;

/** Where a card of the fan sits, and how the fan spreads under the pointer. */
const CARD =
  "absolute left-1/2 top-0 size-14 -ml-7 origin-bottom transition-transform duration-200 [transform:translateX(var(--x))_rotate(var(--r))] group-hover/fan:[transform:translateX(calc(var(--x)*1.6))_translateY(-6px)_rotate(calc(var(--r)*1.5))]";

/** The round button on a picture that takes it out of the message. */
const REMOVE = "rounded-full bg-overlay text-overlay-foreground hover:bg-overlay hover:text-overlay-foreground";

/**
 * Attached images as a fan of cards tucked behind the composer, peeking up above its top
 * edge. Clicking it opens {@link ImageGrid}. While the fan shows every image, each card has its
 * own button that removes it, so a wrong image is one click away.
 */
export function ImageFan(props: {
  workspacePath: string;
  images: string[];
  onOpen: () => void;
  onRemove: (path: string) => void;
}) {
  const { workspacePath, images } = props;
  const shown = images.slice(-FAN_SIZE);
  const mid = (shown.length - 1) / 2;
  const label = `${images.length} attached image${images.length === 1 ? "" : "s"}`;
  const removable = images.length <= FAN_SIZE;
  return (
    <div className="relative h-10">
      <div className="group/fan absolute right-10 top-0 h-16 w-32">
        <Button
          variant="ghost"
          aria-label={`Show ${label}`}
          tooltip={`${label} · click to review`}
          onClick={props.onOpen}
          className="absolute inset-0 size-full rounded-xl hover:bg-transparent dark:hover:bg-transparent"
        />
        {shown.map((path, i) => {
          const offset = i - mid;
          return (
            // The cards lie over the button, which takes the clicks through them.
            <div
              key={path}
              style={{ "--x": `${offset * 18}px`, "--r": `${offset * 8}deg` } as React.CSSProperties}
              className={cn(CARD, "pointer-events-none")}
            >
              <img
                src={workspaceChatFileUrl(workspacePath, path)}
                alt={assetName(path)}
                draggable={false}
                className="size-full rounded-lg border-2 border-card bg-muted object-cover shadow-md"
              />
              {removable && (
                <Button
                  variant="ghost"
                  size="icon-2xs"
                  tooltip={`Remove ${assetName(path)}`}
                  onClick={() => props.onRemove(path)}
                  className={cn(
                    REMOVE,
                    "pointer-events-auto absolute -right-2 -top-2 opacity-0 hover:opacity-100 focus-visible:opacity-100 group-hover/fan:opacity-90",
                  )}
                >
                  <X />
                </Button>
              )}
            </div>
          );
        })}
        {images.length > shown.length && (
          <Badge className="pointer-events-none absolute -right-1 top-0 z-10 h-4 bg-foreground px-1.5 text-2xs text-background tabular-nums">
            +{images.length - shown.length}
          </Badge>
        )}
      </div>
    </div>
  );
}

/**
 * Every attached image as a preview, each with a way to remove it: a popover over the composer
 * (`anchor`), which a press beside it or Escape closes.
 */
export function ImageGrid(props: {
  anchor: RefObject<HTMLElement | null>;
  workspacePath: string;
  images: string[];
  onRemove: (path: string) => void;
  onClose: () => void;
}) {
  const { workspacePath, images, onClose } = props;
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <PopoverContent
        anchor={props.anchor}
        aria-label="Attached images"
        side="top"
        align="center"
        className="w-[calc(var(--anchor-width)-1.5rem)] gap-2 rounded-xl p-2"
      >
        <div className="flex items-center justify-between px-1">
          <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            {images.length} image{images.length === 1 ? "" : "s"}
          </p>
          <Button variant="tool" size="icon-2xs" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </div>
        <div className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto">
          {images.map((path) => (
            <Attachment
              key={path}
              orientation="vertical"
              size="xs"
              className="w-auto has-data-[slot=attachment-content]:w-auto"
            >
              <AttachmentMedia variant="image">
                <img src={workspaceChatFileUrl(workspacePath, path)} alt={assetName(path)} draggable={false} />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle className="text-2xs font-normal text-muted-foreground">
                  {assetName(path)}
                </AttachmentTitle>
              </AttachmentContent>
              <AttachmentActions className="group-data-[orientation=vertical]/attachment:top-2 group-data-[orientation=vertical]/attachment:right-2">
                <AttachmentAction
                  size="icon-2xs"
                  aria-label={`Remove ${assetName(path)}`}
                  tooltip="Remove"
                  onClick={() => props.onRemove(path)}
                  className={cn(REMOVE, "opacity-80 hover:opacity-100 group-hover/attachment:opacity-100")}
                >
                  <X />
                </AttachmentAction>
              </AttachmentActions>
            </Attachment>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
