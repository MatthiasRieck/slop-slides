import type { ComponentProps, MouseEvent, ReactElement, ReactNode } from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { keepFocus } from "@/lib/focus";
import { formatKeys } from "@/lib/keys";

/**
 * A tooltip of the show's own chrome, which is dark in either theme: the tooltip opens in the
 * page's body, outside that dark subtree, so it takes the `dark` class itself. `children` is the
 * one element it is the tooltip of.
 */
export function ShowTooltip(props: {
  text: ReactNode;
  /** The keys that do the same, as a `formatKeys` spec: shown after the text. */
  shortcut?: string;
  side?: ComponentProps<typeof TooltipContent>["side"];
  children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.children} />
      <TooltipContent side={props.side} className="dark">
        {props.text}
        {props.shortcut && <Kbd>{formatKeys(props.shortcut)}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A button of the show: over the slide, or in the presenter view. It is shadcn's `Button` (the
 * `presenter` look and 32px unless said otherwise) with two things of the show's own: its tooltip
 * is dark like the chrome it belongs to (see `ShowTooltip`), and pressing it leaves the keyboard
 * focus where it was, so Space still advances the slide instead of pressing the button again.
 *
 * As with `Button`, a plain-text `tooltip` names an icon button that has no `aria-label`, and a
 * disabled button with a tooltip still shows it, to say what it waits for.
 */
export function ShowButton({
  tooltip,
  shortcut,
  tooltipSide,
  variant = "presenter",
  size = "icon",
  onMouseDown,
  ...props
}: ButtonProps) {
  const hasTooltip = tooltip !== undefined && tooltip !== null && tooltip !== false && tooltip !== "";
  const iconOnly = typeof size === "string" && size.startsWith("icon");
  const named = iconOnly && typeof tooltip === "string" && tooltip !== "" && props["aria-label"] === undefined;
  const button = (
    <Button
      variant={variant}
      size={size}
      {...(hasTooltip && props.disabled && { focusableWhenDisabled: true })}
      {...(named && { "aria-label": tooltip })}
      {...props}
      onMouseDown={(event: MouseEvent<HTMLButtonElement>) => {
        keepFocus(event);
        onMouseDown?.(event as Parameters<NonNullable<typeof onMouseDown>>[0]);
      }}
    />
  );
  if (!hasTooltip) return button;
  return (
    <ShowTooltip text={tooltip} shortcut={shortcut} side={tooltipSide}>
      {button}
    </ShowTooltip>
  );
}
