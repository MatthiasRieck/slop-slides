import { Loader2 } from "lucide-react";
import type { ComponentProps } from "react";

import { formatKeys } from "../lib/keys";
import { cn } from "../lib/utils";

/** Keeps focus (and the text selection) in the slide when a toolbar button is pressed. */
export function keepFocus(event: React.MouseEvent) {
  event.preventDefault();
}

/**
 * How an icon button looks: `toolbar` in the editing toolbars, `panel` in the headers and bars of
 * the panels, `plain` where the row around it sets the text color, and `presenter` on the dark
 * tools floating over a slide show.
 */
export type ToolButtonVariant = "toolbar" | "panel" | "plain" | "presenter";

/** How much room an icon button leaves around its icon. The presenter's buttons are one size. */
export type ToolButtonSize = "xs" | "sm" | "md";

/**
 * How every disabled button looks: faint, under a plain cursor. It still takes the pointer, so its
 * tooltip shows and says why; the hover looks are for enabled buttons only.
 */
const DISABLED = "disabled:cursor-default disabled:opacity-40";

const toolLook: Record<ToolButtonVariant, { base: string; active: string }> = {
  toolbar: {
    base: "text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground",
    active: "bg-accent text-foreground",
  },
  panel: {
    base: "text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground",
    active: "bg-accent text-foreground",
  },
  plain: { base: "enabled:hover:bg-accent enabled:hover:text-foreground", active: "bg-accent text-foreground" },
  presenter: {
    base: "flex size-8 items-center justify-center rounded-lg text-foreground/80 enabled:hover:bg-foreground/10 enabled:hover:text-foreground",
    active: "bg-foreground/20 text-foreground",
  },
};

const toolPadding: Record<ToolButtonSize, string> = { xs: "p-0.5", sm: "p-1", md: "p-1.5" };

/**
 * The classes of an icon button. Icons without a size of their own get a 16px one; a disabled
 * button takes no hover; a `destructive` one turns red under the pointer.
 */
export function toolButtonClass(
  variant: ToolButtonVariant = "toolbar",
  size: ToolButtonSize = "sm",
  active = false,
  destructive = false,
) {
  const look = toolLook[variant];
  return cn(
    "rounded-md [&_svg:not([class*='size-'])]:size-4",
    DISABLED,
    variant !== "presenter" && toolPadding[size],
    look.base,
    active && look.active,
    destructive && "enabled:hover:text-destructive",
  );
}

/** A tooltip with the keys that do the same after it: "Group (⌘G)". */
export function withShortcut(text: string | undefined, shortcut: string | undefined): string | undefined {
  return text !== undefined && shortcut ? `${text} (${formatKeys(shortcut)})` : text;
}

/**
 * A button showing just an icon. `label` names it, for screen readers and as its tooltip (a
 * `title` of its own replaces the tooltip); `shortcut` (a `formatKeys` spec such as `mod+g`) is
 * the keys that do the same, added to the tooltip as "Label (⌘G)". `active` marks a toggle as on.
 * Disabled, it still shows its tooltip, or `disabledReason` instead, to say what it waits for.
 * `destructive` is for what deletes or discards. With `keepFocus`, pressing it leaves keyboard
 * focus and the text selection where they were. `className` is for placing it, not for its look.
 */
export function ToolButton({
  label,
  shortcut,
  disabledReason,
  active,
  destructive,
  variant,
  size,
  keepFocus: keep = false,
  className,
  title,
  ...rest
}: ComponentProps<"button"> & {
  label?: string;
  shortcut?: string;
  disabledReason?: string;
  active?: boolean;
  destructive?: boolean;
  variant?: ToolButtonVariant;
  size?: ToolButtonSize;
  keepFocus?: boolean;
}) {
  const tooltip = rest.disabled && disabledReason ? disabledReason : withShortcut(title ?? label, shortcut);
  return (
    <button
      type="button"
      aria-label={label}
      title={tooltip}
      aria-pressed={active}
      onMouseDown={keep ? keepFocus : undefined}
      {...rest}
      className={cn(toolButtonClass(variant, size, active, destructive), className)}
    />
  );
}

/**
 * How a text button looks: `outline` for most actions, `primary` for the one a form or bar is
 * for, `ghost` for quiet actions in a row of text, and `destructive` for what deletes or discards.
 */
export type ButtonVariant = "outline" | "primary" | "ghost" | "destructive";

/**
 * A text button's size, from the tight timeline buttons (`xs`) to the deck's main actions (`xl`),
 * and the tall ones of the Home screen: `2xl` (36px) beside each other, `3xl` (40px) beside a field.
 */
export type ButtonSize = "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";

const buttonLook: Record<ButtonVariant, string> = {
  outline: "border font-medium enabled:hover:bg-accent",
  primary: "bg-primary font-medium text-primary-foreground enabled:hover:opacity-90",
  ghost: "enabled:hover:bg-accent enabled:hover:text-foreground",
  destructive: "border border-destructive/40 font-medium text-destructive enabled:hover:bg-destructive/10",
};

/** Small buttons: 12px text, and 14px for icons without a size of their own. */
const SMALL = "rounded-md text-xs [&_svg:not([class*='size-'])]:size-3.5";
/** The Home screen's: 14px text and 16px icons. */
const LARGE = "rounded-lg text-sm [&_svg:not([class*='size-'])]:size-4";

const buttonSize: Record<ButtonSize, string> = {
  xs: `${SMALL} gap-1 px-1.5 py-0.5`,
  sm: `${SMALL} gap-1 px-1.5 py-1`,
  md: `${SMALL} gap-1 px-2 py-1`,
  lg: `${SMALL} gap-1.5 px-2.5 py-1`,
  xl: `${SMALL} gap-1.5 px-2.5 py-1.5`,
  "2xl": `${LARGE} h-9 gap-1.5 px-3`,
  "3xl": `${LARGE} h-10 gap-1.5 px-4`,
};

/** The classes of a text button. */
export function buttonClass(variant: ButtonVariant = "outline", size: ButtonSize = "md") {
  return cn("flex items-center", DISABLED, buttonSize[size], buttonLook[variant]);
}

/**
 * A button with text, and maybe an icon before it. While `busy` it shows a spinner before its
 * text and cannot be pressed, for an action that is under way. `className` is for placing it,
 * not for its look.
 */
export function Button({
  variant,
  size,
  busy = false,
  className,
  disabled,
  children,
  ...rest
}: ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize; busy?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cn(buttonClass(variant, size), className)}
    >
      {busy && <Loader2 aria-hidden="true" className="animate-spin" />}
      {children}
    </button>
  );
}
