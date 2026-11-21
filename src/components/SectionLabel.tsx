import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/utils";

/** The small uppercase label over a list or panel section: a heading (`h2` to `h4`) or plain text (`span`). */
export function SectionLabel({
  as: Tag = "span",
  className,
  ...props
}: { as?: "h2" | "h3" | "h4" | "span" } & ComponentPropsWithoutRef<"span">) {
  return (
    <Tag {...props} className={cn("text-2xs font-medium uppercase tracking-wide text-muted-foreground", className)} />
  );
}
