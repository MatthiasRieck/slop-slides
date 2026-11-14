import { useEffect, useRef } from "react";

import { useApp } from "../store";
import type { EditPanel } from "../store/editing";
import { useRibbonReveal } from "./Ribbon";

/**
 * Opens a popover of the edit toolbar when it is asked for from outside the toolbar (⌘K, the
 * context menu; see `askForEditPanel`): calls `open` once for each time `panel` is asked for,
 * after bringing its ribbon section into view. An ask made before the popover's button was there
 * is not answered late, and with no `panel` none is answered. With `reveal` false the section
 * stays as it is: for what opens outside the ribbon, like the picker for another image.
 */
export function useEditPanelAsk(panel: EditPanel | null, open: () => void, options: { reveal?: boolean } = {}) {
  const ask = useApp((s) => s.editPanelAsk);
  const reveal = useRibbonReveal();
  const shows = options.reveal ?? true;
  const answered = useRef(ask?.rev ?? 0);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (!ask || ask.rev === answered.current) return;
    answered.current = ask.rev;
    if (!panel || ask.panel !== panel) return;
    if (shows) reveal();
    openRef.current();
  }, [ask, panel, reveal, shows]);
}
