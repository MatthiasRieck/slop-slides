import type { ComponentProps } from "react";

import { cn } from "../lib/utils";

/** Keeps focus (and the text selection) in the slide when a toolbar button is pressed. */
export function keepFocus(event: React.MouseEvent) {
  event.preventDefault();
}

/**
 * How an icon button looks: `toolbar` in the editing toolbars, `panel` in the headers and bars of
 * the panels (fainter when disabled), `plain` where the row around it sets the text color, and
 * `presenter` on the dark tools floating over a slide show.
 */
export type ToolButtonVariant = "toolbar" | "panel" | "plain" | "presenter";

/** How much room an icon button leaves around its icon. The presenter's buttons are one size. */
export type ToolButtonSize = "xs" | "sm" | "md";

const toolLook: Record<ToolButtonVariant, { base: string; active: string }> = {
  toolbar: {
    base: "text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30",
    active: "bg-accent text-foreground",
  },
  panel: {
    base: "text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40",
    active: "bg-accent text-foreground",
  },
  plain: { base: "hover:bg-accent hover:text-foreground disabled:opacity-30", active: "bg-accent text-foreground" },
  presenter: {
    base: "flex size-8 items-center justify-center rounded-lg text-foreground/80 hover:bg-foreground/10 hover:text-foreground disabled:opacity-35",
    active: "bg-foreground/20 text-foreground",
  },
};

const toolPadding: Record<ToolButtonSize, string> = { xs: "p-0.5", sm: "p-1", md: "p-1.5" };

/**
 * The classes of an icon button. Icons without a size of their own get a 16px one; a disabled
 * button takes no hover.
 */
export function toolButtonClass(variant: ToolButtonVariant = "toolbar", size: ToolButtonSize = "sm", active = false) {
  const look = toolLook[variant];
  return cn(
    "rounded-md disabled:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
    variant !== "presenter" && toolPadding[size],
    look.base,
    active && look.active,
  );
}

/**
 * A button showing just an icon. `label` names it, for screen readers and as its tooltip (a
 * `title` of its own replaces the tooltip); `active` marks a toggle as on. With `keepFocus`,
 * pressing it leaves keyboard focus and the text selection where they were. `className` is for
 * placing it, not for its look.
 */
export function ToolButton({
  label,
  active,
  variant,
  size,
  keepFocus: keep = false,
  className,
  title,
  ...rest
}: ComponentProps<"button"> & {
  label?: string;
  active?: boolean;
  variant?: ToolButtonVariant;
  size?: ToolButtonSize;
  keepFocus?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      aria-pressed={active}
      onMouseDown={keep ? keepFocus : undefined}
      {...rest}
      className={cn(toolButtonClass(variant, size, active), className)}
    />
  );
}

/**
 * How a text button looks: `outline` for most actions, `primary` for the one a form or bar is
 * for, and `ghost` for quiet actions in a row of text.
 */
export type ButtonVariant = "outline" | "primary" | "ghost";

/** A text button's padding, from the tight timeline buttons to the deck's main actions. */
export type ButtonSize = "xs" | "sm" | "md" | "lg" | "xl";

const buttonLook: Record<ButtonVariant, string> = {
  outline: "border font-medium hover:bg-accent disabled:hover:bg-transparent",
  primary: "bg-primary font-medium text-primary-foreground hover:opacity-90",
  ghost: "hover:bg-accent hover:text-foreground disabled:pointer-events-none",
};

const buttonPadding: Record<ButtonSize, string> = {
  xs: "gap-1 px-1.5 py-0.5",
  sm: "gap-1 px-1.5 py-1",
  md: "gap-1 px-2 py-1",
  lg: "gap-1.5 px-2.5 py-1",
  xl: "gap-1.5 px-2.5 py-1.5",
};

/** The classes of a text button. Icons without a size of their own get a 14px one. */
export function buttonClass(variant: ButtonVariant = "outline", size: ButtonSize = "md") {
  return cn(
    "flex items-center rounded-md text-xs disabled:opacity-40 [&_svg:not([class*='size-'])]:size-3.5",
    buttonPadding[size],
    buttonLook[variant],
  );
}

/** A button with text, and maybe an icon before it. `className` is for placing it, not for its look. */
export function Button({
  variant,
  size,
  className,
  ...rest
}: ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type="button" {...rest} className={cn(buttonClass(variant, size), className)} />;
}
