import { useApp } from "../store";
import { Dialog } from "./Dialog";
import { NewDeckForm } from "./Home";

/**
 * Starting a deck in the open folder from the file menu, with a deck open or not: the start
 * screen's form in a dialog. It closes once the new deck is open (see `createDeck`), on Escape,
 * or on its Close button.
 */
export function NewDeckDialog() {
  const open = useApp((s) => s.newDeckOpen);
  const folder = useApp((s) => s.workspace?.name ?? "the folder");
  if (!open) return null;
  return (
    <Dialog label="New deck" size="lg" closeButton onClose={() => useApp.getState().setNewDeckOpen(false)}>
      <NewDeckForm heading="New deck" hint={`It goes in a new folder in ${folder}.`} autoFocus />
    </Dialog>
  );
}
