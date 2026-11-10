import { useRef, useState } from "react";

import { useDismiss } from "../components/Popover";

/**
 * A button's dropdown: whether its panel is open, and `ref` for the box around the button and
 * the panel, a press outside which closes it (after `onClose`); with `escape`, so does Escape
 * (`capture`: see `useDismiss`). While `disabled` it stays closed, as when what it works on goes away.
 */
export function useDropdown<E extends HTMLElement = HTMLDivElement>(
  options: { disabled?: boolean; onClose?: () => void; escape?: boolean; capture?: boolean } = {},
) {
  const [open, setOpen] = useState(false);
  const ref = useRef<E>(null);
  useDismiss(
    open,
    ref,
    () => {
      options.onClose?.();
      setOpen(false);
    },
    { escape: options.escape, capture: options.capture },
  );
  if (options.disabled && open) setOpen(false);
  return { open, setOpen, ref, toggle: () => setOpen(!open) };
}
