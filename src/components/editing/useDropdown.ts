import { useRef, useState } from "react";

import { useDismiss } from "../Popover";

/**
 * A toolbar button's dropdown: whether its panel is open, and `ref` for the box around the button
 * and the panel, a press outside which closes it (after `onClose`). While `disabled` it stays
 * closed, as when what it works on goes away.
 */
export function useDropdown(options: { disabled?: boolean; onClose?: () => void } = {}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, () => {
    options.onClose?.();
    setOpen(false);
  });
  if (options.disabled && open) setOpen(false);
  return { open, setOpen, ref, toggle: () => setOpen(!open) };
}
