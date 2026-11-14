import type { RefObject } from "react";

import { useApp } from "../../store";
import { Popover } from "../Popover";
import { LayoutPicker, useTemplates } from "../Templates";

/**
 * The layouts to add a slide on, under `anchor`, while they are asked for (`addingSlide`): by the
 * slide list's "+", by "New slide…" in a menu and by ⇧⌘N, which are one thing. "Blank" comes first
 * and has the focus, so Enter adds a blank slide; the new slide goes after the one on the stage.
 */
export function NewSlide({ anchor }: { anchor: RefObject<HTMLElement | null> }) {
  const open = useApp((s) => s.addingSlide);
  return open ? <Layouts anchor={anchor} /> : null;
}

function Layouts({ anchor }: { anchor: RefObject<HTMLElement | null> }) {
  const templates = useTemplates();
  const close = () => useApp.getState().setAddingSlide(false);
  // The panel takes the focus as it shows, so it shows once "Blank" is there to take it.
  if (templates === undefined) return null;
  return (
    <Popover anchor={anchor} placement="below" width={560} label="New slide" portal onClose={close}>
      <LayoutPicker mode="add" onBlank={() => void useApp.getState().addSlide()} onDone={close} />
    </Popover>
  );
}
