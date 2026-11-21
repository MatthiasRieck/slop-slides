import { Search } from "lucide-react";
import { Fragment, useState } from "react";

import { formatKeys } from "../../lib/keys";
import { cn } from "../../lib/utils";
import { inputClass } from "../Field";
import { SectionLabel } from "../SectionLabel";
import { keysLabel, SECTIONS, type ShortcutRow, type ShortcutSection } from "./shortcuts";

/** Whether a row has `query` (in lower case) in its keys, as shown or as named (`shift`, `enter`), or in what they do. */
function rowMatches([keys, what]: ShortcutRow, query: string): boolean {
  return [keysLabel(keys), keys.replace(/[{}]/g, ""), keysLabel(what)].some((text) =>
    text.toLowerCase().includes(query),
  );
}

/** The sections with the rows that match `filter`, those left with none dropped; all of them for an empty filter. */
export function filterShortcuts(sections: ShortcutSection[], filter: string): ShortcutSection[] {
  const query = filter.trim().toLowerCase();
  if (!query) return sections;
  return sections
    .map((section) => ({ ...section, rows: section.rows.filter((row) => rowMatches(row, query)) }))
    .filter((section) => section.rows.length > 0);
}

/** A row's keys: each `{spec}` of the template as a key cap, the words between them as they are. */
function Keys({ template }: { template: string }) {
  return template.split(/\{([^}]+)\}/).map((part, index) =>
    index % 2 === 1 ? (
      <kbd
        // biome-ignore lint/suspicious/noArrayIndexKey: the template is fixed
        key={index}
        className="inline-block min-w-5 rounded border border-b-2 bg-muted px-1 text-center font-sans text-2xs font-medium leading-4 text-foreground tabular-nums"
      >
        {formatKeys(part)}
      </kbd>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: the template is fixed
      <Fragment key={index}>{part}</Fragment>
    ),
  );
}

/**
 * The settings' Keyboard shortcuts section: every shortcut of the app, to read, in a card for
 * each place it works in, and a box on top that keeps the rows whose keys or description have
 * what is typed. The box takes the focus when the settings open here (on `?`), so typing filters
 * at once.
 */
export function KeyboardSection() {
  const [filter, setFilter] = useState("");
  const sections = filterShortcuts(SECTIONS, filter);
  return (
    <div className="flex flex-col gap-4">
      {/* Stays in sight over the list, covering the pane's padding above it. */}
      <div className="sticky top-0 z-10 -mt-5 bg-background pb-1 pt-5">
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            aria-label="Filter shortcuts"
            placeholder="Filter by keys or by what they do"
            data-autofocus
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            className={cn(inputClass, "h-8 pl-7 text-xs")}
          />
        </div>
      </div>
      {sections.map((section) => (
        <section key={section.title} className="flex flex-col gap-2">
          <SectionLabel as="h4">{section.title}</SectionLabel>
          <dl className="divide-y rounded-lg border bg-card">
            {section.rows.map(([keys, what]) => (
              <div key={keys} className="flex items-baseline justify-between gap-6 px-3 py-1.5 text-xs">
                <dt className="order-last max-w-[55%] shrink-0 text-right leading-6 text-muted-foreground">
                  <Keys template={keys} />
                </dt>
                <dd className="min-w-0">{keysLabel(what)}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      {sections.length === 0 && (
        <p role="status" className="py-8 text-center text-xs text-muted-foreground">
          No shortcut matches “{filter.trim()}”.
        </p>
      )}
    </div>
  );
}
