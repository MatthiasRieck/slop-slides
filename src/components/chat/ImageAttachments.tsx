import { X } from "lucide-react";
import { useRef } from "react";

import { basename, cn, isSessionFile, workspaceChatFileUrl } from "../../lib/utils";
import { ToolButton } from "../Button";
import { useDismiss } from "../Popover";
import { SectionLabel } from "../SectionLabel";

const assetName = (path: string) => (isSessionFile(path) ? "Slide screenshot" : basename(path));

/** How many previews the fan shows; the rest are counted on a badge. */
const FAN_SIZE = 4;

/** Where a card of the fan sits, and how the fan spreads under the pointer. */
const CARD =
  "absolute left-1/2 top-0 size-14 -ml-7 origin-bottom transition-transform duration-200 [transform:translateX(var(--x))_rotate(var(--r))] group-hover:[transform:translateX(calc(var(--x)*1.6))_translateY(-6px)_rotate(calc(var(--r)*1.5))]";

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
      <div className="group absolute right-10 top-0 h-16 w-32">
        <button
          type="button"
          onClick={props.onOpen}
          title={`${label} · click to review`}
          aria-label={`Show ${label}`}
          className="absolute inset-0 size-full"
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
                <button
                  type="button"
                  aria-label={`Remove ${assetName(path)}`}
                  title={`Remove ${assetName(path)}`}
                  onClick={() => props.onRemove(path)}
                  className="pointer-events-auto absolute -right-2 -top-2 flex size-5 items-center justify-center rounded-full bg-overlay text-overlay-foreground opacity-0 hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-90"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          );
        })}
        {images.length > shown.length && (
          <span className="pointer-events-none absolute -right-1 top-0 z-10 rounded-full bg-foreground px-1.5 text-2xs font-medium text-background tabular-nums">
            +{images.length - shown.length}
          </span>
        )}
      </div>
    </div>
  );
}

/** Every attached image as a preview, each with a way to remove it. */
export function ImageGrid(props: {
  workspacePath: string;
  images: string[];
  onRemove: (path: string) => void;
  onClose: () => void;
}) {
  const { workspacePath, images, onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(true, ref, onClose);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Attached images"
      className="absolute bottom-full left-3 right-3 z-20 mb-1 rounded-xl border bg-card p-2 shadow-composer"
    >
      <div className="flex items-center justify-between px-1 pb-2">
        <SectionLabel>
          {images.length} image{images.length === 1 ? "" : "s"}
        </SectionLabel>
        <ToolButton variant="panel" size="xs" aria-label="Close" onClick={onClose}>
          <X className="size-3.5" />
        </ToolButton>
      </div>
      <div className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto">
        {images.map((path) => (
          <figure key={path} className="group relative m-0">
            <img
              src={workspaceChatFileUrl(workspacePath, path)}
              alt={assetName(path)}
              draggable={false}
              className="aspect-square w-full rounded-lg border bg-muted object-cover"
            />
            <figcaption className="truncate pt-0.5 text-2xs text-muted-foreground">{assetName(path)}</figcaption>
            <button
              type="button"
              aria-label={`Remove ${assetName(path)}`}
              title="Remove"
              onClick={() => props.onRemove(path)}
              className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-overlay text-overlay-foreground opacity-80 hover:opacity-100 group-hover:opacity-100"
            >
              <X className="size-3" />
            </button>
          </figure>
        ))}
      </div>
    </div>
  );
}
