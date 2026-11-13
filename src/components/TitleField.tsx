import { useEffect, useRef, useState } from "react";

import { cn } from "../lib/utils";

/**
 * A deck's title as a field. Enter commits what is typed (`onCommit`, which says whether it
 * took), and so does leaving the field with a title in it; Escape takes the typing back and
 * calls `onCancel`. An empty title is not committed: Enter says so, and leaving the field puts
 * the title back. With `selectOnMount` it takes the focus as it shows, its text selected.
 */
export function TitleField(props: {
  title: string;
  onCommit: (title: string) => Promise<boolean>;
  /** After Escape, or after leaving the field with nothing to commit. */
  onCancel?: () => void;
  /** After the title was committed (or was unchanged). */
  onDone?: () => void;
  selectOnMount?: boolean;
  id?: string;
  "aria-label"?: string;
  className?: string;
}) {
  const { title, onCommit, onCancel, onDone } = props;
  const [draft, setDraft] = useState(title);
  const [empty, setEmpty] = useState(false);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  /** Escape or a commit under way: leaving the field after it does nothing more. */
  const settled = useRef(false);

  // The title changed elsewhere (the agent, an undo): the field follows, unless it is being typed in.
  useEffect(() => {
    if (document.activeElement !== ref.current) setDraft(title);
  }, [title]);

  useEffect(() => {
    if (!props.selectOnMount) return;
    ref.current?.focus();
    ref.current?.select();
  }, [props.selectOnMount]);

  const commit = async () => {
    const next = draft.trim();
    if (next === title) {
      setDraft(title);
      return onDone?.();
    }
    settled.current = true;
    setSaving(true);
    const took = await onCommit(next);
    setSaving(false);
    settled.current = false;
    if (took) onDone?.();
    else setDraft(title);
  };

  const cancel = () => {
    setDraft(title);
    setEmpty(false);
    onCancel?.();
  };

  return (
    <input
      ref={ref}
      id={props.id}
      aria-label={props["aria-label"]}
      aria-invalid={empty || undefined}
      title={empty ? "A deck needs a title" : undefined}
      value={draft}
      // Not disabled, which would take the focus away: the field keeps it while the title is saved.
      readOnly={saving}
      placeholder="Deck title"
      onChange={(event) => {
        setDraft(event.target.value);
        setEmpty(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          if (saving) return;
          if (draft.trim()) void commit();
          else setEmpty(true);
        } else if (event.key === "Escape") {
          // The field's own: nothing open around it closes on the same key.
          event.preventDefault();
          event.stopPropagation();
          settled.current = true;
          cancel();
          event.currentTarget.blur();
          settled.current = false;
        }
      }}
      onBlur={() => {
        if (settled.current) return;
        if (draft.trim()) void commit();
        else cancel();
      }}
      className={cn(
        "min-w-0 rounded-md border bg-background px-1.5 outline-none focus:border-input focus:ring-2 focus:ring-primary/20",
        empty && "border-destructive focus:border-destructive",
        props.className,
      )}
    />
  );
}
