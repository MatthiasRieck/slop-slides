import { useRef, useState } from "react";

import { useDismiss } from "../components/Popover";

/**
 * A button's dropdown: whether its panel is open, and `ref` for the box around the button and
 * the panel. A press outside that box closes it (after `onClose`), and so does Escape, unless
 * `escape` is false (see `useDismiss`). While `disabled` it stays closed, as when what it works
 * on goes away. A panel that is a menu takes `useMenuKeys` for its keys.
 */
export function useDropdown<E extends HTMLElement = HTMLDivElement>(
  options: { disabled?: boolean; onClose?: () => void; escape?: boolean } = {},
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
    { escape: options.escape },
  );
  if (options.disabled && open) setOpen(false);
  return { open, setOpen, ref, toggle: () => setOpen(!open) };
}
