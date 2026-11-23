import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { keepFocus as holdFocus } from "@/lib/focus";
import { formatKeys } from "@/lib/keys";
import { cn } from "@/lib/utils";

/*
 * shadcn/ui's button, tuned to the app:
 * - `tool` (the quiet icon buttons of the toolbars and panel headers) and `presenter` (the tools
 *   floating over a slide show, in a `dark` subtree) beside shadcn's variants;
 * - the compact sizes of a desktop app: `2xs` and `icon-2xs` (20px) under shadcn's, `xl` (40px)
 *   over them, and 14px icons in the `xs` ones;
 * - a toggle is a button with `aria-pressed`: pressed, it is filled;
 * - disabled with a tooltip, it stays focusable and under the pointer (`aria-disabled`), so the
 *   tooltip can say why; it looks disabled either way;
 * - `keepFocus` for the tools that work on what is selected elsewhere (the slide), which a press
 *   on the button must not take the focus from.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:not-aria-disabled:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-default aria-disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80 aria-disabled:hover:bg-primary",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground aria-disabled:hover:bg-background dark:border-input dark:bg-input/30 dark:hover:bg-input/50 dark:aria-disabled:hover:bg-input/30",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground aria-disabled:hover:bg-secondary",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground aria-disabled:hover:bg-transparent aria-disabled:hover:text-inherit dark:hover:bg-muted/50",
        tool: "text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground",
        presenter:
          "text-foreground/80 hover:bg-foreground/10 hover:text-foreground aria-expanded:bg-foreground/20 aria-expanded:text-foreground aria-pressed:bg-foreground/20 aria-pressed:text-foreground aria-disabled:hover:bg-transparent aria-disabled:hover:text-foreground/80",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 aria-disabled:hover:bg-destructive/10 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40 dark:aria-disabled:hover:bg-destructive/20",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        "2xs":
          "h-5 gap-1 rounded-[min(var(--radius-md),8px)] px-1.5 text-xs in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xl: "h-10 gap-1.5 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "size-8",
        "icon-2xs": "size-5 rounded-[min(var(--radius-md),8px)] in-data-[slot=button-group]:rounded-lg",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonProps = ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    /**
     * What the button's tooltip says. On an icon button (an `icon…` size) a tooltip that is
     * plain text also names the button, unless it has an `aria-label` of its own.
     */
    tooltip?: React.ReactNode;
    /** The keys that do the same, as a `formatKeys` spec (`mod+g`): shown after the tooltip. */
    shortcut?: string;
    /** The side of the button its tooltip opens on; the top unless given. */
    tooltipSide?: React.ComponentProps<typeof TooltipContent>["side"];
    /**
     * Pressing the button leaves the keyboard focus (and the text selection) where it is. The
     * press is caught on its way down: a button that is off but still focusable, to show its
     * tooltip, gets no `onMouseDown` of its own, and would take the focus all the same.
     */
    keepFocus?: boolean;
  };

function Button({
  className,
  variant = "default",
  size = "default",
  tooltip,
  shortcut,
  tooltipSide,
  keepFocus = false,
  ...props
}: ButtonProps) {
  const hasTooltip = tooltip !== undefined && tooltip !== null && tooltip !== false && tooltip !== "";
  const iconOnly = typeof size === "string" && size.startsWith("icon");
  // Only what applies is passed on: a prop that is there but undefined would take the place of
  // the one a trigger this button is the `render` of hands down.
  const named = iconOnly && hasTooltip && typeof tooltip === "string" && props["aria-label"] === undefined;
  const button = (
    <ButtonPrimitive
      data-slot="button"
      // Disabled, it still shows its tooltip, which says what it waits for.
      {...(hasTooltip && props.disabled && { focusableWhenDisabled: true })}
      {...(named && { "aria-label": tooltip })}
      {...(keepFocus && { onMouseDownCapture: holdFocus })}
      {...props}
      className={cn(buttonVariants({ variant, size, className }))}
    />
  );
  if (!hasTooltip) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent side={tooltipSide}>
        {tooltip}
        {shortcut && <Kbd>{formatKeys(shortcut)}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

export { Button, type ButtonProps, buttonVariants };
