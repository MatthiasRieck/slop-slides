import { Search, SearchX } from "lucide-react";
import { Fragment, useState } from "react";

import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";

import { formatKeys } from "../../lib/keys";
import { SECTION_HEADING } from "../styles";
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
      // biome-ignore lint/suspicious/noArrayIndexKey: the template is fixed
      <Kbd key={index} className="border align-middle text-2xs text-foreground tabular-nums">
        {formatKeys(part)}
      </Kbd>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: the template is fixed
      <Fragment key={index}>{part}</Fragment>
    ),
  );
}

/**
 * The settings' Keyboard shortcuts section: every shortcut of the app, to read, in a table for
 * each place it works in, and a box on top that keeps the rows whose keys or description have
 * what is typed. The box takes the focus when the settings open here (on `?`), so typing filters
 * at once (it is marked `data-autofocus`, which ./SettingsDialog.tsx looks for).
 */
export function KeyboardSection() {
  const [filter, setFilter] = useState("");
  const sections = filterShortcuts(SECTIONS, filter);
  return (
    <div className="flex flex-col gap-4">
      {/* Stays in sight over the list. A sticky box stops at the pane's content edge, below its padding,
          so it is held that padding higher (`-top-5`) and covers it: no row shows above the box. */}
      <div className="sticky -top-5 z-10 -mt-5 bg-background pb-1 pt-5">
        <InputGroup>
          <InputGroupInput
            type="search"
            aria-label="Filter shortcuts"
            placeholder="Filter by keys or by what they do"
            data-autofocus
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            className="text-xs"
          />
          <InputGroupAddon>
            <Search aria-hidden="true" className="size-3.5" />
          </InputGroupAddon>
        </InputGroup>
      </div>
      {sections.map((section) => (
        <section key={section.title} className="flex flex-col gap-2">
          <h4 className={SECTION_HEADING}>{section.title}</h4>
          <div className="overflow-hidden rounded-lg border bg-card">
            <Table className="text-xs">
              <TableBody>
                {section.rows.map(([keys, what]) => (
                  <TableRow key={keys}>
                    <TableCell className="px-3 py-1.5 whitespace-normal">{keysLabel(what)}</TableCell>
                    <TableCell className="max-w-[55%] px-3 py-1.5 text-right leading-6 whitespace-normal text-muted-foreground">
                      <Keys template={keys} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ))}
      {sections.length === 0 && (
        <Empty role="status">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchX aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No shortcut matches “{filter.trim()}”.</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}
