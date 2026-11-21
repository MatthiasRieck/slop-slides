import type { ComponentProps } from "react";

import { cn } from "../lib/utils";

/**
 * An on/off switch, for a setting that takes effect as it is flipped. `label` names it for screen
 * readers; a click, Space or Enter flips it. Disabled, it shows its state but cannot be changed:
 * say why beside it. `className` is for placing it, not for its look.
 */
export function Switch({
  checked,
  onChange,
  label,
  className,
  ...rest
}: Omit<ComponentProps<"button">, "onChange" | "role" | "type"> & {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      {...rest}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-default disabled:opacity-50",
        checked ? "bg-primary" : "bg-muted-foreground/40",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "block size-4 rounded-full bg-background shadow-sm transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
