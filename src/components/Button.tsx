import { Loader2 } from "lucide-react";
import type { ComponentProps } from "react";

import { formatKeys } from "../lib/keys";
import { cn } from "../lib/utils";
import { TIP_KEYS, TIP_LABEL } from "./Tooltip";

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
 * How a disabled button looks, unless its variant says otherwise: its icon and text in the text
 * color, faded to where they are plainly off but can still be read (an already muted icon faded
 * further all but vanishes), under a plain cursor. It still takes the pointer, so its tooltip
 * shows and says why; the hover looks are for enabled buttons only.
 */
const DISABLED = "disabled:cursor-default disabled:text-foreground disabled:opacity-45";

/**
 * How a disabled button with a fill or a color of its own looks (`primary`, `destructive`): a
 * plain muted box, with nothing of the color that would make it read as a button to press.
 */
const DISABLED_FLAT = "disabled:cursor-default disabled:border-border disabled:bg-muted disabled:text-muted-foreground";

/**
 * How a toggle or a tool that is on looks, the same wherever it is: a tint of the accent color
 * with the icon in it. The fill under the pointer (`bg-accent`) is for hovering only.
 */
const ON = "bg-primary/10 text-primary enabled:hover:bg-primary/15 enabled:hover:text-primary";

const toolLook: Record<ToolButtonVariant, { base: string; active: string }> = {
  toolbar: {
    base: "text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground",
    active: ON,
  },
  panel: {
    base: "text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground",
    active: ON,
  },
  plain: { base: "enabled:hover:bg-accent enabled:hover:text-foreground", active: ON },
  presenter: {
    base: "flex size-8 items-center justify-center rounded-lg text-foreground/80 enabled:hover:bg-foreground/10 enabled:hover:text-foreground",
    active: "bg-foreground/20 text-foreground",
  },
};

/**
 * The room around the icon. The tightest (`xs`) draws a 20px box, smaller than a pointer or a
 * finger needs, so it takes presses on the 24px around its middle without looking any bigger.
 */
const toolPadding: Record<ToolButtonSize, string> = {
  xs: "relative p-0.5 after:absolute after:top-1/2 after:left-1/2 after:size-6 after:-translate-1/2",
  sm: "p-1",
  md: "p-1.5",
};

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
 * A control's tooltip, as the attributes the app's tooltips read (see `Tooltips` in ./Tooltip.tsx):
 * the whole of it as the `title`, the keys apart so they are set apart, and for a disabled control
 * with a `reason`, the reason as the `title` and what the control is called beside it.
 */
function tooltipProps(text: string | undefined, shortcut: string | undefined, reason?: string) {
  if (reason !== undefined) return { title: reason, [TIP_LABEL]: text };
  return {
    title: withShortcut(text, shortcut),
    [TIP_KEYS]: text !== undefined && shortcut ? formatKeys(shortcut) : undefined,
  };
}

/**
 * A button showing just an icon. `label` names it, for screen readers and as its tooltip (a
 * `title` of its own replaces the tooltip); `shortcut` (a `formatKeys` spec such as `mod+g`) is
 * the keys that do the same, shown beside the label in the tooltip. The tooltip is the app's own
 * (see ./Tooltip.tsx): it shows under the pointer after a moment and at once on keyboard focus.
 * `active` marks a toggle as on. Disabled, it still shows its tooltip, with `disabledReason`
 * under its name, to say what it waits for.
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
  const reason = rest.disabled && disabledReason ? disabledReason : undefined;
  return (
    <button
      type="button"
      aria-label={label}
      {...tooltipProps(title ?? label, shortcut, reason)}
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
 * A text button's size. Each is one of four heights, whatever the button's border or icon, so
 * buttons beside each other line up (a label that wraps makes its button taller): 24px in ribbons, footers and dense rows (`xs`, `sm` and `md`,
 * from tight to roomy), 28px in bars, forms and dialogs (`lg`, and `xl` for the deck's main
 * actions), and the tall ones of the Home screen: `2xl` (36px) beside each other, `3xl` (40px)
 * beside a field. An icon button beside them is as tall: 24px at its `sm`, 28px at its `md`.
 */
export type ButtonSize = "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";

const buttonLook: Record<ButtonVariant, string> = {
  outline: `border font-medium enabled:hover:bg-accent ${DISABLED}`,
  // The edge shows only while disabled; it is always there so the button keeps its size.
  primary: `border border-transparent bg-primary font-medium text-primary-foreground enabled:hover:opacity-90 ${DISABLED_FLAT}`,
  ghost: `enabled:hover:bg-accent enabled:hover:text-foreground ${DISABLED}`,
  destructive: `border border-destructive/40 font-medium text-destructive enabled:hover:bg-destructive/10 ${DISABLED_FLAT}`,
};

/** Small buttons: 12px text, and 14px for icons without a size of their own. */
const SMALL = "rounded-md text-xs [&_svg:not([class*='size-'])]:size-3.5";
/** The Home screen's: 14px text and 16px icons. */
const LARGE = "rounded-lg text-sm [&_svg:not([class*='size-'])]:size-4";

const buttonSize: Record<ButtonSize, string> = {
  xs: `${SMALL} min-h-6 gap-1 px-1.5`,
  sm: `${SMALL} min-h-6 gap-1 px-2`,
  md: `${SMALL} min-h-6 gap-1 px-2.5`,
  lg: `${SMALL} min-h-7 gap-1.5 px-2.5`,
  xl: `${SMALL} min-h-7 gap-1.5 px-3`,
  "2xl": `${LARGE} h-9 gap-1.5 px-3`,
  "3xl": `${LARGE} h-10 gap-1.5 px-4`,
};

/** The classes of a text button. */
export function buttonClass(variant: ButtonVariant = "outline", size: ButtonSize = "md") {
  return cn("flex items-center", buttonSize[size], buttonLook[variant]);
}

/**
 * A button with text, and maybe an icon before it. While `busy` it shows a spinner before its
 * text and cannot be pressed, for an action that is under way. A `title` is its tooltip, with the
 * keys of `shortcut` (a `formatKeys` spec) beside it. `className` is for placing it, not for its look.
 */
export function Button({
  variant,
  size,
  busy = false,
  shortcut,
  className,
  disabled,
  title,
  children,
  ...rest
}: ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize; busy?: boolean; shortcut?: string }) {
  return (
    <button
      type="button"
      {...(title !== undefined && tooltipProps(title, shortcut))}
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
