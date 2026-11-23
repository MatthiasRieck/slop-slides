// The few looks of the app's own that no shadcn/ui component has a variant for, as class lists:
// one place for each, so the same thing looks the same in every panel.

/**
 * The name of a field in a compact panel (a ribbon popover, an inspector, the export options):
 * smaller and quieter than shadcn's `Label` and `FieldLabel`, whose `className` it is.
 */
export const QUIET_LABEL = "text-xs font-normal text-muted-foreground";

/** The heading over a group of things in a panel or a list: small capitals, muted. */
export const SECTION_HEADING = "text-2xs font-medium uppercase tracking-wide text-muted-foreground";
