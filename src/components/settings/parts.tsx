import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { SectionLabel } from "../SectionLabel";

/**
 * A group of settings in one card, a line between its rows; `title` goes over it as a small
 * heading, when the group needs naming.
 */
export function SettingsGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      {title && <SectionLabel as="h4">{title}</SectionLabel>}
      <div className="divide-y overflow-hidden rounded-lg border bg-card">{children}</div>
    </section>
  );
}

/**
 * One setting in a group: its name and a line saying what it does, with its control beside them,
 * or under them when `stacked` (a control that needs the row's width).
 */
export function SettingRow(props: { title: string; hint?: ReactNode; stacked?: boolean; children: ReactNode }) {
  return (
    <div
      className={cn("flex gap-x-6 gap-y-3 px-4 py-3.5", props.stacked ? "flex-col" : "items-center justify-between")}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <h4 className="text-sm font-medium">{props.title}</h4>
        {props.hint && <p className="text-xs text-muted-foreground">{props.hint}</p>}
      </div>
      {props.children}
    </div>
  );
}
