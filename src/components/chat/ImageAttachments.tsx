import { X } from "lucide-react";
import { useRef } from "react";

import { basename, cn, isSessionFile, workspaceChatFileUrl } from "../../lib/utils";
import { ToolButton } from "../Button";
import { useDismiss } from "../Popover";
import { SectionLabel } from "../SectionLabel";

const assetName = (path: string) => (isSessionFile(path) ? "Slide screenshot" : basename(path));

/** How many previews the fan shows; the rest are counted on a badge. */
const FAN_SIZE = 4;

/**
 * Attached images as a fan of cards tucked behind the composer, peeking up above its top
 * edge. Clicking it opens {@link ImageGrid}.
 */
export function ImageFan(props: { workspacePath: string; images: string[]; onOpen: () => void }) {
  const { workspacePath, images } = props;
  const shown = images.slice(-FAN_SIZE);
  const mid = (shown.length - 1) / 2;
  const label = `${images.length} attached image${images.length === 1 ? "" : "s"}`;
  return (
    <div className="relative h-10">
      <button
        type="button"
        onClick={props.onOpen}
        title={`${label} · click to review`}
        aria-label={`Show ${label}`}
        className="group absolute right-10 top-0 h-16 w-32"
      >
        {shown.map((path, i) => {
          const offset = i - mid;
          return (
            <img
              key={path}
              src={workspaceChatFileUrl(workspacePath, path)}
              alt={assetName(path)}
              draggable={false}
              style={{ "--x": `${offset * 18}px`, "--r": `${offset * 8}deg` } as React.CSSProperties}
              className={cn(
                "absolute left-1/2 top-0 size-14 -ml-7 rounded-lg border-2 border-card bg-muted object-cover shadow-md transition-transform duration-200",
                "origin-bottom [transform:translateX(var(--x))_rotate(var(--r))]",
                "group-hover:[transform:translateX(calc(var(--x)*1.6))_translateY(-6px)_rotate(calc(var(--r)*1.5))]",
              )}
            />
          );
        })}
        {images.length > shown.length && (
          <span className="absolute -right-1 top-0 z-10 rounded-full bg-foreground px-1.5 text-2xs font-medium text-background tabular-nums">
            +{images.length - shown.length}
          </span>
        )}
      </button>
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
  useDismiss(true, ref, onClose, { escape: true, capture: true });
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
